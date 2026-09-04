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

/** Provider refs have no write path: the viewer and receipt hide edit/apply for them. */
export const isReadOnlyPath = (path: string | null | undefined): boolean =>
  (PROVIDERS as readonly string[]).includes(rootKind(path))

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
