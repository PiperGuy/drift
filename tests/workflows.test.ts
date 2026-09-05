import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Guard the delivery intent of the GitHub workflows without snapshotting their
 * text: CI runs the full quality gate plus desktop E2E; a merge to main ships
 * exactly macOS (.dmg/.zip) and Linux (.AppImage/.deb) installers as Actions
 * artifacts; and nothing in the automated pipeline builds or ships Windows.
 */

const DIR = join(__dirname, '..', '.github', 'workflows')
type Step = {
  uses?: string
  run?: string
  with?: Record<string, unknown>
  if?: string
  env?: Record<string, string>
}
type Job = {
  'runs-on'?: string
  permissions?: Record<string, string>
  if?: string
  steps: Step[]
  strategy?: { matrix?: { include?: Record<string, string>[] } }
}
type Workflow = {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const load = (file: string): Workflow => parse(readFileSync(join(DIR, file), 'utf8')) as Workflow
const jobs = (wf: Workflow): Job[] => Object.values(wf.jobs)
const steps = (wf: Workflow): Step[] => jobs(wf).flatMap((j) => j.steps)
const runs = (wf: Workflow): string[] => steps(wf).flatMap((s) => (s.run ? [s.run] : []))
/** Matrix rows expanded into each job's steps, so `${{ matrix.x }}` can be resolved. */
const matrixRuns = (wf: Workflow): string[] =>
  jobs(wf).flatMap((j) =>
    (j.strategy?.matrix?.include ?? [{}]).flatMap((row) =>
      j.steps.flatMap((s) =>
        s.run ? [s.run.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, k) => row[k] ?? '')] : []
      )
    )
  )
const uploads = (wf: Workflow): Step[] =>
  steps(wf).filter((s) => s.uses?.startsWith('actions/upload-artifact@v4'))

describe('ci.yml', () => {
  const wf = load('ci.yml')

  it('runs on pull requests and pushes to main', () => {
    expect(wf.on).toHaveProperty('pull_request')
    expect(wf.on.push).toEqual({ branches: ['main'] })
  })

  it('needs no write permissions', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
  })

  it('runs install, the regression gate, a production build and headless E2E', () => {
    const all = runs(wf).join('\n')
    expect(all).toContain('npm ci')
    for (const gate of ['typecheck', 'lint', 'format:check', 'test']) {
      expect(all).toMatch(new RegExp(`npm (run )?${gate}`))
    }
    expect(all).toContain('npm run build')
    expect(all).toMatch(/xvfb-run .*npm run test:e2e/)
  })

  it('keeps E2E failure output, and only on failure', () => {
    const up = uploads(wf).find((s) => String(s.with?.path).includes('e2e-results'))
    expect(up).toBeDefined()
    expect(up?.if).toMatch(/failure\(\)/)
  })
})

describe('main-artifacts.yml', () => {
  const wf = load('main-artifacts.yml')

  it('runs only on pushes to main and needs no write permissions', () => {
    expect(wf.on).toEqual({ push: { branches: ['main'] } })
    expect(wf.permissions).toEqual({ contents: 'read' })
  })

  it('builds exactly macOS and Linux', () => {
    const rows = jobs(wf).flatMap((j) => j.strategy?.matrix?.include ?? [])
    expect(rows.map((r) => r.os).sort()).toEqual(['macos-latest', 'ubuntu-latest'])
    expect(rows.map((r) => r.script).sort()).toEqual(['build:linux', 'build:mac'])
  })

  it('checks before packaging and never publishes', () => {
    const all = matrixRuns(wf).join('\n')
    expect(all).toContain('npm run check')
    expect(all).toMatch(/--publish never/)
  })

  it('uploads all four installer formats as artifacts that fail when missing', () => {
    const rows = jobs(wf).flatMap((j) => j.strategy?.matrix?.include ?? [])
    const paths = rows.map((r) => r.files ?? '').join('\n')
    for (const glob of ['dist/*.dmg', 'dist/*.zip', 'dist/*.AppImage', 'dist/*.deb']) {
      expect(paths).toContain(glob)
    }
    for (const up of uploads(wf)) {
      expect(up.with?.['if-no-files-found']).toBe('error')
      expect(up.with?.['retention-days']).toBeGreaterThan(0)
      expect(String(up.with?.name)).toContain('drift')
    }
    expect(uploads(wf).length).toBeGreaterThan(0)
  })
})

describe('release.yml', () => {
  const wf = load('release.yml')

  it('builds tags for exactly macOS and Linux', () => {
    const rows = jobs(wf).flatMap((j) => j.strategy?.matrix?.include ?? [])
    expect(rows.map((r) => r.os).sort()).toEqual(['macos-latest', 'ubuntu-latest'])
  })

  it('uploads into the published release that release-please created, re-runs included', () => {
    // A `releaseType: draft` publisher refuses an existing published release,
    // and without EP_GH_IGNORE_TIME a re-run >2h after publishing silently
    // skips the upload (electron-publish gitHubPublisher.getOrCreateRelease).
    const eb = parse(readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')) as {
      publish: { provider: string; releaseType: string }
    }
    expect(eb.publish.releaseType).toBe('release')
    const publish = steps(wf).find((s) => s.run?.includes('--publish onTagOrDraft'))
    expect(publish?.env?.EP_GH_IGNORE_TIME).toBe('true')
  })
})

describe('release-please.yml', () => {
  const wf = load('release-please.yml')

  it('runs only on pushes to main', () => {
    expect(wf.on).toEqual({ push: { branches: ['main'] } })
  })

  it('uses the release-please action at the pinned major, manifest-driven', () => {
    const step = steps(wf).find((s) => s.uses?.startsWith('googleapis/release-please-action'))
    expect(step?.uses).toBe('googleapis/release-please-action@v4')
    // Manifest mode (config files in the repo), not an inline release-type.
    expect(step?.with?.['release-type']).toBeUndefined()
  })

  it('scopes write permissions per job instead of workflow-wide', () => {
    expect(wf.permissions).toBeUndefined()
    const perms = jobs(wf).map((j) => j.permissions)
    // What the action itself documents as required: release PR + tag/release + labels.
    expect(perms).toContainEqual({
      contents: 'write',
      'pull-requests': 'write',
      issues: 'write'
    })
    // The hand-off job may only start other workflows.
    expect(perms).toContainEqual({ actions: 'write' })
  })

  it('hands the new tag to the existing release workflow, only once one exists', () => {
    // A GITHUB_TOKEN-created tag does not fire `on: push: tags`, so the tag is
    // handed to release.yml via workflow_dispatch — the one event that works.
    const job = jobs(wf).find((j) =>
      j.steps.some((s) => s.run?.includes('gh workflow run release.yml'))
    )
    expect(job).toBeDefined()
    expect(job?.if).toContain('release_created')
    expect(JSON.stringify(job)).toContain('tag_name')
  })

  it('builds nothing and publishes nothing itself', () => {
    const all = runs(wf).join('\n')
    expect(all).not.toMatch(/npm publish|electron-builder|npm run build/)
  })
})

describe('every workflow', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

  it('has workflows to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  it.each(files)('%s builds no Windows artifact', (file) => {
    // Parsed YAML (comments dropped), so prose about Windows cannot trip this.
    const doc = JSON.stringify(parse(readFileSync(join(DIR, file), 'utf8')))
    expect(doc).not.toMatch(/windows-latest|build:win|nsis|-setup\.exe|WIN_CSC/i)
  })

  it.each(files)('%s pins actions at the majors this repo uses', (file) => {
    const wf = load(file)
    for (const s of steps(wf)) {
      if (!s.uses) continue
      const [action, version] = s.uses.split('@')
      const expected: Record<string, string> = {
        'actions/checkout': 'v4',
        'actions/setup-node': 'v4',
        'actions/upload-artifact': 'v4',
        'actions/cache': 'v4',
        'googleapis/release-please-action': 'v4'
      }
      if (action in expected) expect(`${action}@${version}`).toBe(`${action}@${expected[action]}`)
    }
  })
})
