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
  const upload = build.steps.find((s) => s.run?.includes('gh release upload'))
  const rows = build.strategy?.matrix?.include ?? []

  it('builds tags for exactly macOS and Linux', () => {
    expect(rows.map((r) => r.os).sort()).toEqual(['macos-latest', 'ubuntu-latest'])
  })

  it('gates and packages the tagged commit itself, then uploads, in that order', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
    // No `ref` override: the run is pinned to the commit the tag named at dispatch.
    // No persisted credentials: npm and electron-builder never see the write token.
    expect(build.steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with).toEqual({
      'persist-credentials': false
    })
    const order = build.steps.map((s) => s.run ?? '')
    const gate = order.indexOf('npm run check')
    const pack = order.findIndex((r) => r.includes('--publish never'))
    expect(order.indexOf('npm ci')).toBeGreaterThanOrEqual(0)
    expect(gate).toBeGreaterThan(order.indexOf('npm ci'))
    expect(pack).toBeGreaterThan(gate)
    expect(build.steps.indexOf(upload as Step)).toBeGreaterThan(pack)
    // electron-builder's GitHub publisher skips silently in several cases
    // (electron-publish gitHubPublisher), so it never uploads.
    const publishing = runs(wf).flatMap((r) => r.split('\n').filter((l) => l.includes('--publish')))
    expect(publishing.map((l) => l.trim())).toEqual(['npm run "$SCRIPT" -- --publish never'])
    expect(build.steps[pack].env?.SCRIPT).toBe('${{ matrix.script }}')
    expect(rows.map((r) => r.script).sort()).toEqual(['build:linux', 'build:mac'])
    for (const s of build.steps) {
      expect(s).not.toHaveProperty('continue-on-error')
      if (s !== upload) expect(s.env ?? {}).not.toHaveProperty('GH_TOKEN')
      expect(s.if).toBeUndefined()
    }
    // Branch dispatches validate installers in the build step, but never touch
    // Actions artifact storage; tag releases upload directly to the draft.
    expect(build.steps.some((s) => s.uses?.startsWith('actions/upload-artifact'))).toBe(false)
    expect(JSON.stringify(wf)).not.toContain('download-artifact')
  })

  it('requires all four installer formats and both updater manifests', () => {
    const files = rows.map((r) => r.files).join(' ')
    for (const glob of [
      '*.dmg',
      '*.zip',
      'latest-mac.yml',
      '*.AppImage',
      '*.deb',
      'latest-linux.yml'
    ]) {
      expect(files).toContain(`dist/${glob}`)
      expect(publish.steps.at(-1)?.run).toContain(glob)
    }
    expect(upload?.env?.FILES).toBe('${{ matrix.files }}')
  })

  it('publishes only from a tag, only after every build leg succeeded', () => {
    expect(publish.needs).toBe('build')
    // A status function (always(), failure(), !cancelled()) would drop the implied success().
    expect(publish.if).toBe("${{ github.ref_type == 'tag' }}")
    expect(publish).not.toHaveProperty('continue-on-error')
    for (const s of publish.steps) {
      expect(s.if).toBeUndefined()
      expect(s).not.toHaveProperty('continue-on-error')
    }
    // The only place any workflow creates or un-drafts a release.
    const all = readdirSync(DIR).flatMap((f) => runs(load(f)))
    expect(all.filter((r) => /draft=false|gh release (create|edit)/.test(r))).toEqual([
      publish.steps.at(-1)?.run
    ])
  })

  describe('release scripts', () => {
    const SHA = 'a'.repeat(40)
    const LINUX = ['drift-0.2.2.AppImage', 'drift_0.2.2_amd64.deb', 'latest-linux.yml']
    const MAC = [
      'drift-0.2.2.dmg',
      'drift-0.2.2.dmg.blockmap',
      'Drift-0.2.2-arm64-mac.zip',
      'Drift-0.2.2-arm64-mac.zip.blockmap',
      'latest-mac.yml'
    ]
    const size = (f: string): number => `bytes of ${f}`.length
    const GH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  'api '*) echo "$STUB_TAG_SHA" ;;
  'release view')
    [ "$STUB_IS_DRAFT" = missing ] && exit 1
    case "$*" in
      *isDraft*) echo "$STUB_IS_DRAFT" ;;
      *'size > 0'*) cut -d' ' -f1 "$STUB_ASSETS" ;;
      *) cat "$STUB_ASSETS" ;;
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
    // Records what electron-builder would see: a variable that is set, even to '', or not at all.
    const NPM = `#!/usr/bin/env bash
echo "npm $* CSC_LINK=\${CSC_LINK-<unset>} APPLE_ID=\${APPLE_ID-<unset>}" >> "$STUB_LOG"
`
    /** Runs a workflow step's own script text against stub `gh`/`npm`; returns exit code and their calls. */
    const run = (
      script: string,
      opts: { built?: string[]; assets?: string[]; env?: Record<string, string> } = {}
    ): { status: number | null; calls: string[]; out: string } => {
      // Inputs arrive through `env:` only, so this is the exact text Actions runs.
      expect(script).not.toBe('')
      expect(script).not.toContain('${{')
      const dir = mkdtempSync(join(tmpdir(), 'drift-release-'))
      mkdirSync(join(dir, 'dist'))
      mkdirSync(join(dir, 'bin'))
      for (const f of opts.built ?? []) writeFileSync(join(dir, 'dist', f), `bytes of ${f}`)
      writeFileSync(join(dir, 'bin', 'gh'), GH)
      writeFileSync(join(dir, 'bin', 'npm'), NPM)
      for (const bin of ['gh', 'npm']) chmodSync(join(dir, 'bin', bin), 0o755)
      writeFileSync(
        join(dir, 'assets'),
        (opts.assets ?? []).map((f) => `${f} ${size(f)}\n`).join('')
      )
      writeFileSync(join(dir, 'log'), '')
      // Node hands children a socket as stdin, and bash sources ~/.bashrc when
      // stdin is a socket; on the macOS runner that reorders PATH past the stub.
      // So: no stdin, Actions' own bash flags, and a HOME that proves it.
      writeFileSync(join(dir, '.bashrc'), 'echo "::error::.bashrc was sourced"; exit 97\n')
      const res = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          HOME: dir,
          TAG: 'v0.2.2',
          GH_REPO: 'PiperGuy/drift',
          GITHUB_SHA: SHA,
          GITHUB_REF_TYPE: 'tag',
          STUB_LOG: join(dir, 'log'),
          STUB_ASSETS: join(dir, 'assets'),
          STUB_TAG_SHA: SHA,
          STUB_IS_DRAFT: 'true',
          STUB_DROP: '',
          ...opts.env
        }
      })
      const calls = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean)
      return { status: res.status, calls, out: res.stdout + res.stderr }
    }
    const wrote = (calls: string[]): string[] =>
      calls
        .filter((c) => /^release (upload|edit|create|delete)/.test(c))
        .map((c) => c.split(' ')[1])

    it('packages unsigned when the signing secrets are unset, signed when they are set', () => {
      // v0.2.0/v0.2.1 never got this far. An unset secret is exported as '', and
      // electron-builder reads an empty CSC_LINK as a path: "<cwd> not a file".
      const script = build.steps.find((s) => s.run?.includes('--publish never'))?.run ?? ''
      const secrets = { CSC_KEY_PASSWORD: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '' }
      const unset = run(script, {
        env: { SCRIPT: 'build:mac', CSC_LINK: '', APPLE_ID: '', ...secrets }
      })
      expect(unset.status).toBe(0)
      expect(unset.calls).toEqual([
        'npm run build:mac -- --publish never CSC_LINK=<unset> APPLE_ID=<unset>'
      ])
      const set = run(script, {
        env: { SCRIPT: 'build:mac', CSC_LINK: 'cert', APPLE_ID: 'id', ...secrets }
      })
      expect(set.calls).toEqual(['npm run build:mac -- --publish never CSC_LINK=cert APPLE_ID=id'])
    })

    describe.each(rows)('build upload ($script)', (row) => {
      const built = row.script === 'build:mac' ? MAC : LINUX
      const env = { FILES: row.files }
      const script = upload?.run ?? ''

      it('checks for the draft, uploads every file, then reads it back', () => {
        const { status, calls, out } = run(script, { built, env })
        expect(out).not.toContain('::error::')
        expect(status).toBe(0)
        expect(calls[0]).toContain('--json isDraft')
        expect(calls[1]).toMatch(/^release upload v0\.2\.2 .* --clobber$/)
        for (const f of built) expect(calls[1]).toContain(`dist/${f}`)
        expect(calls[2]).toContain('--json assets')
        expect(wrote(calls)).toEqual(['upload'])
      })

      // One blockmap still satisfies dist/*.blockmap; every other glob names one file.
      const sole = built.filter((f) => !f.endsWith('.blockmap'))
      it.each(sole)('fails before touching the release when %s was not built', (missing) => {
        const { status, calls, out } = run(script, {
          built: built.filter((f) => f !== missing),
          env
        })
        expect(status).not.toBe(0)
        expect(out).toContain('::error::the build produced no ')
        expect(calls).toEqual([])
      })

      it('fails when an upload was silently skipped', () => {
        const drop = built[1]
        const { status, out } = run(script, { built, env: { ...env, STUB_DROP: drop } })
        expect(status).not.toBe(0)
        expect(out).toContain(`${drop} is missing or incomplete`)
      })

      it.each(['false', 'missing'])('uploads nothing when the draft is %s', (state) => {
        const { status, calls } = run(script, { built, env: { ...env, STUB_IS_DRAFT: state } })
        expect(status).not.toBe(0)
        expect(wrote(calls)).toEqual([])
      })

      it('on a branch it still requires the installers but never calls gh', () => {
        const branch = { ...env, GITHUB_REF_TYPE: 'branch' }
        expect(run(script, { built, env: branch })).toMatchObject({ status: 0, calls: [] })
        expect(run(script, { built: built.slice(1), env: branch }).status).not.toBe(0)
      })
    })

    describe('publish', () => {
      const script = publish.steps.at(-1)?.run ?? ''
      const assets = [...MAC, ...LINUX]

      it('checks the tag, the draft and the assets, and un-drafts last', () => {
        const { status, calls, out } = run(script, { assets })
        expect(out).not.toContain('::error::')
        expect(status).toBe(0)
        expect(calls).toEqual([
          'api repos/PiperGuy/drift/commits/tags/v0.2.2 --jq .sha',
          expect.stringContaining('--json isDraft'),
          expect.stringContaining('--json assets'),
          'release edit v0.2.2 --draft=false'
        ])
      })

      it.each(['.dmg', '.zip', 'latest-mac.yml', '.AppImage', '.deb', 'latest-linux.yml'])(
        'stays a draft when the release has no %s',
        (ext) => {
          const { status, calls, out } = run(script, {
            assets: assets.filter((f) => !f.endsWith(ext))
          })
          expect(status).not.toBe(0)
          expect(out).toContain('::error::release v0.2.2 has no uploaded ')
          expect(wrote(calls)).toEqual([])
        }
      )

      it('stays a draft when the tag moved off the commit this run checked', () => {
        const { status, calls } = run(script, { assets, env: { STUB_TAG_SHA: 'b'.repeat(40) } })
        expect(status).not.toBe(0)
        expect(calls).toHaveLength(1)
      })

      it.each(['false', 'missing'])('does nothing when the draft is %s', (state) => {
        const { status, calls } = run(script, { assets, env: { STUB_IS_DRAFT: state } })
        expect(status).not.toBe(0)
        expect(wrote(calls)).toEqual([])
      })
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
        'actions/cache': 'v4',
        'googleapis/release-please-action': 'v4'
      }
      if (action in expected) expect(`${action}@${version}`).toBe(`${action}@${expected[action]}`)
    }
  })
})
