/**
 * Zod schemas for every payload the renderer sends to main. Main validates
 * with these before touching the file system (renderer input is untrusted).
 */
import { z } from 'zod'

export * from './channels'

/** An absolute remote directory: no `.` or `..` segments (they would escape the granted root remotely). */
export const RemoteDir = z
  .string()
  .regex(/^\//)
  .max(1024)
  .refine((p) => !p.split('/').some((seg) => seg === '.' || seg === '..'), {
    message: 'Path must not contain "." or ".." segments'
  })
export const SshRootRequest = z.object({
  host: z.string().regex(/^[A-Za-z0-9._@-]+$/),
  path: RemoteDir
})
export const WorkspaceName = z.string().trim().min(1).max(60)
export const WorkspaceId = z.number().int().positive()
export const WorkspaceRename = z.object({ id: WorkspaceId, name: WorkspaceName })
export const RootPath = z.string().min(1)
export const ScanRequest = z.object({ root: z.string().min(1) })
export const SettingsPatch = z.object({
  mcpEnabled: z.boolean().optional(),
  onboarded: z.boolean().optional()
})
export const RevealRequestSchema = z.object({ path: z.string().min(1), key: z.string().min(1) })
export const ApplyRequestSchema = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1).max(5000),
  expectedMtime: z.number(),
  expectedVersion: z.number().int().positive().optional(),
  receipt: z.number().int().positive().optional()
})
const ProjectSideSchema = z.object({
  root: z.string().min(1).max(4096),
  project: z.string().min(1).max(1024).nullable()
})
export const ProjectCompareRequestSchema = z.object({
  left: ProjectSideSchema,
  right: ProjectSideSchema
})
export const VaultSourceSpecSchema = z.object({
  name: z.string().max(60).default(''),
  address: z.string().min(1).max(2048),
  namespace: z.string().max(256).optional(),
  caPem: z.string().max(65536).optional(),
  path: z.string().min(1).max(1024),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('token'), token: z.string().min(1).max(4096) }),
    z.object({
      kind: z.literal('approle'),
      roleId: z.string().min(1).max(512),
      secretId: z.string().min(1).max(4096)
    })
  ]),
  storage: z.enum(['session', 'keychain'])
})
export const VaultPathSchema = z.object({ path: z.string().min(1) })
export const VaultShapeAtSchema = z.object({
  path: z.string().min(1),
  version: z.number().int().positive()
})
export const VaultRestoreSchema = z.object({
  path: z.string().min(1),
  version: z.number().int().positive(),
  expectedVersion: z.number().int().positive()
})
export const ViewRequestSchema = z.object({ path: z.string().min(1) })
export const FormatRequestSchema = z.object({ path: z.string().min(1), expectedMtime: z.number() })
export const SetRequestSchema = z.object({
  path: z.string().min(1),
  expectedMtime: z.number(),
  entries: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
        value: z.string().max(65536)
      })
    )
    .min(1)
    .max(500)
})
export const SnapshotId = z.number().int().positive()
export const McpClientIdSchema = z.enum([
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'copilot',
  'windsurf',
  'gemini'
])
export const ShapeRequest = z.object({ path: z.string().min(1) })
export const CompareRequest = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  ignore: z.array(z.string()).default([])
})

const Storage = z.enum(['session', 'keychain'])
const Name = z.string().max(60).default('')
const Token = z.string().min(1).max(8192)
const Address = z.string().min(1).max(2048)
const CaPem = z.string().max(65536).optional()
export const AwsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/)
export const AwsProfile = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9._@+-]*$/)
  .optional()
export const ProviderConnectSpecSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('vercel'),
    name: Name,
    token: Token,
    teamId: z.string().max(256).optional(),
    project: z.string().min(1).max(256),
    storage: Storage
  }),
  z.object({
    provider: z.literal('github'),
    name: Name,
    token: Token,
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .optional(),
    storage: Storage
  }),
  z.object({
    provider: z.literal('railway'),
    name: Name,
    token: Token,
    project: z.string().min(1).max(256),
    storage: Storage
  }),
  z.object({ provider: z.literal('render'), name: Name, token: Token, storage: Storage }),
  z.object({
    provider: z.literal('dokploy'),
    name: Name,
    token: Token,
    address: Address,
    caPem: CaPem,
    storage: Storage
  }),
  z.object({
    provider: z.literal('coolify'),
    name: Name,
    token: Token,
    address: Address,
    caPem: CaPem,
    storage: Storage
  }),
  z.object({
    provider: z.literal('aws-sm'),
    name: Name,
    region: AwsRegion,
    profile: AwsProfile,
    secret: z.string().min(1).max(512)
  }),
  z.object({
    provider: z.literal('ecs'),
    name: Name,
    region: AwsRegion,
    profile: AwsProfile,
    cluster: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
    selector: z.string().regex(/^(service:[A-Za-z0-9_-]{1,255}|task:[a-f0-9-]{8,64})$/),
    container: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
    path: RemoteDir.optional()
  })
])
export const DockerSourceSpecSchema = z.object({
  host: z
    .string()
    .regex(/^[A-Za-z0-9._@-]+$/)
    .optional(),
  container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  path: RemoteDir
})
export const DockerHost = DockerSourceSpecSchema.shape.host
export const EcsDiscoverSchema = z.object({
  region: AwsRegion,
  profile: AwsProfile,
  cluster: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,255}$/)
    .optional()
})
