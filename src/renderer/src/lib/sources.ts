import {
  Box,
  Cloud,
  Container,
  FolderOpen,
  KeyRound,
  Server,
  Vault,
  type LucideIcon
} from 'lucide-react'
import { siCoolify, siGithub, siRailway, siRender, siVercel } from 'simple-icons'
import { PROVIDERS, type RootKind } from '@shared/channels'

/** The kind of a root or file ref, from its scheme. Mirrors src/main/fs.ts parseRef. */
export function rootKind(path: string | null | undefined): RootKind {
  const m = /^([a-z][a-z0-9-]*):\/\//.exec(path ?? '')
  if (!m) return 'local'
  if (m[1] === 'ssh' || m[1] === 'docker' || m[1] === 'vault') return m[1]
  return (PROVIDERS as readonly string[]).includes(m[1]) ? (m[1] as RootKind) : 'local'
}

/** Provider refs are not edited as files: the viewer hides format / edit / add key for them. */
export const isReadOnlyPath = (path: string | null | undefined): boolean =>
  (PROVIDERS as readonly string[]).includes(rootKind(path))

/**
 * Why Apply to B is unavailable for a target, or null when it can be written.
 * Mirrors main's refusal branches so the button explains itself before a round trip.
 */
export function applyBlocker(path: string | null | undefined): string | null {
  if (rootKind(path) !== 'ecs') return null
  if (/\/fs(\/|$)/.test(path ?? ''))
    return 'Files inside a running ECS task are replaced on the next deployment. Add the service without a directory to write its task definition instead.'
  if (/\/task:/.test(path ?? ''))
    return 'An ECS task is replaced on every deployment. Add the service that runs it as a source and apply there.'
  return null
}

/** What an approved write does on each platform, shown in the approval dialog. */
export const WRITE_CONSEQUENCE: Record<RootKind, string> = {
  local: 'The file is snapshotted first and rewritten atomically; roll back from History.',
  ssh: 'The remote file is snapshotted first and rewritten atomically over ssh; roll back from History.',
  docker:
    'The file in the container is snapshotted first and rewritten atomically; roll back from History.',
  vault: 'A new KV v2 version is written with check-and-set; earlier versions stay in Vault.',
  ecs: 'A new task definition revision is registered with only this container\u2019s environment changed, then the service is updated: ECS starts a rolling deployment. Keys that come from secrets are refused.',
  'aws-sm':
    'A new secret version is written holding the current JSON with only the ticked keys replaced; consumers pick it up on their next fetch.',
  vercel:
    'Only this target (and branch) changes; a variable shared across targets is split first. New values apply to future deployments. Sensitive variables cannot be read back.',
  github:
    'Existing secrets are re-sealed with the scope public key, variables updated in place, new keys created as secrets (never readable again). Workflows use them on their next run.',
  railway:
    'One upsert for the ticked keys in this environment and service; Railway redeploys the service.',
  render:
    'Each variable is set on this service or env group; Render redeploys affected services unless auto-deploy is off.',
  dokploy:
    'The application\u2019s env text is patched in place and saved; redeploy the application to use it.',
  coolify:
    'Each variable is updated or created for this application (preview scope kept); redeploy the application to use it.'
}

export type Brand = { path: string; hex: string }
export const SOURCE_META: Record<RootKind, { label: string; icon: LucideIcon | Brand }> = {
  local: { label: 'Local folder', icon: FolderOpen },
  ssh: { label: 'SSH server', icon: Server },
  docker: { label: 'Docker container', icon: Container },
  vault: { label: 'HashiCorp Vault', icon: Vault },
  ecs: { label: 'ECS container', icon: Box },
  'aws-sm': { label: 'AWS Secrets Manager', icon: KeyRound },
  vercel: { label: 'Vercel', icon: siVercel },
  github: { label: 'GitHub Actions', icon: siGithub },
  railway: { label: 'Railway', icon: siRailway },
  render: { label: 'Render', icon: siRender },
  dokploy: { label: 'Dokploy', icon: Cloud },
  coolify: { label: 'Coolify', icon: siCoolify }
}
