/**
 * Zod schemas for every payload the renderer sends to main. Main validates
 * with these before touching the file system (renderer input is untrusted).
 */
import { z } from 'zod'

export * from './channels'

export const SshRootRequest = z.object({
  host: z.string().regex(/^[A-Za-z0-9._@-]+$/),
  path: z.string().regex(/^\//)
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
  expectedMtime: z.number()
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
export const LicenseKey = z.string().min(1).max(4096)
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
