import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Guard the delivery intent of the GitHub workflows without snapshotting their
 * text: CI runs the full quality gate plus desktop E2E; a merge to main ships
 * exactly macOS (.dmg/.zip) and Linux (.AppImage/.deb) installers as Actions
 * artifacts; a release stays a draft until its tag's commit passed the gate and
 * every installer is on it; and nothing in the automated pipeline builds or ships
 * Windows.
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
  needs?: string | string[]
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
  const { build, publish } = wf.jobs

  it('builds tags for exactly macOS and Linux', () => {
    const rows = jobs(wf).flatMap((j) => j.strategy?.matrix?.include ?? [])
    expect(rows.map((r) => r.os).sort()).toEqual(['macos-latest', 'ubuntu-latest'])
  })

  it('gates and packages the tagged commit itself, with no way to publish from a build', () => {
    // Read-only token; electron-builder's GitHub publisher skips silently in
    // several cases (electron-publish gitHubPublisher), so it never uploads.
    expect(wf.permissions).toEqual({ contents: 'read' })
    expect(build.permissions).toBeUndefined()
    // No `ref` override: the run is pinned to the commit the tag named at dispatch.
    expect(build.steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with).toBeUndefined()
    const order = build.steps.map((s) => s.run ?? '')
    const gate = order.indexOf('npm run check')
    expect(order.indexOf('npm ci')).toBeGreaterThanOrEqual(0)
    expect(gate).toBeGreaterThan(order.indexOf('npm ci'))
    expect(order.findIndex((r) => r.includes('--publish never'))).toBeGreaterThan(gate)
    expect(matrixRuns(wf).filter((r) => r.includes('--publish'))).toEqual([
      'npm run build:linux -- --publish never',
      'npm run build:mac -- --publish never'
    ])
    for (const s of build.steps) {
      expect(s.if).toBeUndefined()
      expect(s).not.toHaveProperty('continue-on-error')
      expect(s.env ?? {}).not.toHaveProperty('GH_TOKEN')
    }
    for (const up of uploads(wf)) expect(up.with?.['if-no-files-found']).toBe('error')
  })

  it('publishes only from a tag, only after every build leg succeeded', () => {
    expect(publish.needs).toBe('build')
    // A status function (always(), failure(), !cancelled()) would drop the implied success().
    expect(publish.if).toBe("${{ github.ref_type == 'tag' }}")
    expect(publish).not.toHaveProperty('continue-on-error')
    expect(publish.permissions).toEqual({ contents: 'write' })
    for (const s of publish.steps) {
      expect(s.if).toBeUndefined()
      expect(s).not.toHaveProperty('continue-on-error')
    }
    // The only place any workflow makes a release public.
    const all = readdirSync(DIR).flatMap((f) => runs(load(f)))
    expect(all.filter((r) => /draft=false|gh release (create|edit)/.test(r))).toEqual([
      publish.steps.at(-1)?.run
    ])
  })

  describe('publish script', () => {
    const SHA = 'a'.repeat(40)
    const BUILT = [
      'drift-0.2.2.dmg',
      'Drift-0.2.2-arm64-mac.zip',
      'latest-mac.yml',
      'drift-0.2.2.AppImage',
      'drift_0.2.2_amd64.deb',
      'latest-linux.yml'
    ]
    const GH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  'api '*) echo "$STUB_TAG_SHA" ;;
  'release view')
    case "$*" in
      *isDraft*) echo "$STUB_IS_DRAFT" ;;
      *assets*) cat "$STUB_ASSETS" ;;
      *) [ "$STUB_EXISTS" = 1 ] ;;
    esac ;;
  'release upload')
    shift 3
    for f in "$@"; do
      [ "$f" = --clobber ] && continue
      # What a best-effort uploader does: skip one and still exit 0.
      [ -n "$STUB_DROP" ] && [[ $f == *"$STUB_DROP" ]] && continue
      echo "$(basename "$f") $(($(wc -c <"$f")))" >> "$STUB_ASSETS"
    done ;;
esac
`
    /** Runs the workflow's own script text against a stub `gh`; returns exit code and gh calls. */
    const run = (
      opts: { built?: string[]; env?: Record<string, string> } = {}
    ): { status: number | null; calls: string[]; out: string } => {
      const script = publish.steps.at(-1)?.run ?? ''
      // Inputs arrive through `env:` only, so this is the exact text Actions runs.
      expect(script).not.toContain('${{')
      const dir = mkdtempSync(join(tmpdir(), 'drift-publish-'))
      mkdirSync(join(dir, 'dist'))
      mkdirSync(join(dir, 'bin'))
      for (const f of opts.built ?? BUILT) writeFileSync(join(dir, 'dist', f), `bytes of ${f}`)
      writeFileSync(join(dir, 'bin', 'gh'), GH)
      chmodSync(join(dir, 'bin', 'gh'), 0o755)
      writeFileSync(join(dir, 'assets'), '')
      const res = spawnSync('bash', ['-c', script], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          TAG: 'v0.2.2',
          GH_REPO: 'PiperGuy/drift',
          GITHUB_SHA: SHA,
          STUB_LOG: join(dir, 'log'),
          STUB_ASSETS: join(dir, 'assets'),
          STUB_TAG_SHA: SHA,
          STUB_EXISTS: '1',
          STUB_IS_DRAFT: 'true',
          STUB_DROP: '',
          ...opts.env
        }
      })
      const calls = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')
      return { status: res.status, calls, out: res.stdout + res.stderr }
    }
    const touched = (calls: string[]): string[] =>
      calls.filter((c) => /^release (upload|edit|create)/.test(c))

    it('checks the tag, uploads everything, reads it back, and publishes last', () => {
      const { status, calls, out } = run()
      expect(out).toBe('')
      expect(status).toBe(0)
      expect(calls[0]).toBe('api repos/PiperGuy/drift/commits/tags/v0.2.2 --jq .sha')
      const upload = calls.findIndex((c) => c.startsWith('release upload v0.2.2 '))
      const readBack = calls.findIndex((c) => c.includes('--json assets'))
      expect(upload).toBeGreaterThan(0)
      for (const f of BUILT) expect(calls[upload]).toContain(`dist/${f}`)
      expect(readBack).toBeGreaterThan(upload)
      expect(calls.indexOf('release edit v0.2.2 --draft=false')).toBe(calls.length - 1)
      expect(calls.at(-1)).toBe('release edit v0.2.2 --draft=false')
      expect(touched(calls)).toHaveLength(2)
    })

    it.each(BUILT)('publishes and uploads nothing when the builds produced no %s', (missing) => {
      const { status, calls, out } = run({ built: BUILT.filter((f) => f !== missing) })
      expect(status).not.toBe(0)
      expect(out).toContain('::error::')
      expect(touched(calls)).toEqual([])
    })

    it('stays a draft when the tag moved off the commit this run checked', () => {
      const { status, calls } = run({ env: { STUB_TAG_SHA: 'b'.repeat(40) } })
      expect(status).not.toBe(0)
      expect(calls).toHaveLength(1)
    })

    it('stays a draft when an upload was silently skipped', () => {
      const { status, calls, out } = run({ env: { STUB_DROP: '.deb' } })
      expect(status).not.toBe(0)
      expect(out).toContain('drift_0.2.2_amd64.deb is missing or incomplete')
      expect(touched(calls).map((c) => c.split(' ')[1])).toEqual(['upload'])
    })

    it('refuses to replace the assets of an already published release', () => {
      const { status, calls } = run({ env: { STUB_IS_DRAFT: 'false' } })
      expect(status).not.toBe(0)
      expect(touched(calls)).toEqual([])
    })

    it('creates the draft itself for a manually pushed tag, then the same sequence', () => {
      const { status, calls } = run({ env: { STUB_EXISTS: '0' } })
      expect(status).toBe(0)
      expect(touched(calls).map((c) => c.split(' ').slice(1).join(' '))).toEqual([
        'create v0.2.2 --draft --verify-tag --generate-notes',
        expect.stringMatching(/^upload v0\.2\.2 /),
        'edit v0.2.2 --draft=false'
      ])
    })
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

  it('leaves a draft release and a real tag, and never makes anything public', () => {
    // Published here, v0.2.0 and v0.2.1 went public before release.yml's gate
    // failed and stayed empty. A draft has no git tag until it is published, and
    // both release-please and the dispatch below need one: force-tag-creation.
    const config = JSON.parse(
      readFileSync(join(__dirname, '..', 'release-please-config.json'), 'utf8')
    ) as Record<string, unknown>
    expect(config.draft).toBe(true)
    expect(config['force-tag-creation']).toBe(true)
    expect(runs(wf).join('\n')).not.toMatch(/gh release|draft=false/)
  })

  it('hands the new tag to the existing release workflow, only once one exists', () => {
    // A GITHUB_TOKEN-created tag does not fire `on: push: tags`, so the tag is
    // handed to release.yml via workflow_dispatch — the one event that works.
    const job = jobs(wf).find((j) =>
      j.steps.some((s) => s.run?.includes('gh workflow run release.yml'))
    )
    expect(job).toBeDefined()
    expect(job?.if).toContain('release_created')
    // At the tag ref, so release.yml's GITHUB_SHA is the tagged commit, not main's head.
    expect(job?.steps[0].run).toContain('--ref "$TAG"')
    expect(job?.steps[0].env?.TAG).toBe('${{ needs.release-please.outputs.tag_name }}')
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
        'actions/download-artifact': 'v4',
        'actions/cache': 'v4',
        'googleapis/release-please-action': 'v4'
      }
      if (action in expected) expect(`${action}@${version}`).toBe(`${action}@${expected[action]}`)
    }
  })
})
