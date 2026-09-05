import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the version-management intent: release-please owns SemVer bumps from
 * conventional commits (manifest anchored to package.json), no npm script can
 * push versions or tags on its own, and the README explains the rules.
 */

const root = join(__dirname, '..')
const json = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), 'utf8')) as T

type PackageJson = { version: string; scripts: Record<string, string> }

describe('release-please config', () => {
  it('releases the repo root as a node package with plain v-prefixed tags', () => {
    const cfg = json<{
      'release-type'?: string
      'include-component-in-tag'?: boolean
      packages: Record<string, Record<string, unknown>>
    }>('release-please-config.json')
    const rootPkg = cfg.packages['.']
    expect(rootPkg).toBeDefined()
    expect(rootPkg['release-type'] ?? cfg['release-type']).toBe('node')
    // Tags must stay `vX.Y.Z` so release.yml's `v*` filter and electron-builder match.
    expect(cfg['include-component-in-tag']).toBe(false)
  })

  it('manifest tracks the exact version in package.json', () => {
    const manifest = json<Record<string, string>>('.release-please-manifest.json')
    expect(manifest['.']).toBe(json<PackageJson>('package.json').version)
  })
})

describe('package.json scripts', () => {
  it('no script bumps the version or pushes to git; release-please owns both', () => {
    for (const [name, script] of Object.entries(json<PackageJson>('package.json').scripts)) {
      expect(script, `script "${name}"`).not.toMatch(/npm version|git push/)
    }
  })
})

describe('README versioning docs', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')

  it('documents the release lifecycle and SemVer rules', () => {
    expect(readme).toContain('## Versioning and releases')
    for (const term of [
      'Release Please',
      'release PR',
      'CHANGELOG',
      'fix:',
      'feat:',
      'feat!:',
      'BREAKING CHANGE',
      'patch',
      'minor',
      'major'
    ]) {
      expect(readme, `README should mention "${term}"`).toContain(term)
    }
  })

  it('no longer points contributors at the removed release scripts', () => {
    expect(readme).not.toContain('npm run release:')
  })
})
