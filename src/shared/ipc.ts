/**
 * Zod schemas for every payload the renderer sends to main. Main validates
 * with these before touching the file system (renderer input is untrusted).
 */
import { z } from 'zod'

export * from './channels'

export const ScanRequest = z.object({ root: z.string().min(1) })
export const SettingsPatch = z.object({ mcpEnabled: z.boolean().optional() })
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
