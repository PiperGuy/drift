import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  FileKey2,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Lock,
  RotateCw
} from 'lucide-react'
import type { VaultDiscovery, VaultHistory, VaultListing, VaultMount } from '@shared/channels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { VersionChip } from '@/components/app/VaultVersions'
import { versionState } from '@/lib/status'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const err = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e)

export type VaultPick = { mount: string; path: string; kind: 'folder' | 'secret' }

type Listing = VaultListing | { state: 'loading'; ticket: number }
type Row =
  | {
      id: string
      kind: 'mount' | 'folder' | 'secret'
      level: number
      label: string
      mount: string
      path: string
      note?: string
    }
  | {
      id: string
      kind: 'status'
      level: number
      label: string
      mount: string
      path: string
      tone: 'busy' | 'muted' | 'bad'
      retry?: boolean
    }

const keyOf = (mount: string, folder: string): string => `${mount}\u0000${folder}`
/** Row id of a folder (or mount root): one id per place in Vault, never per route to it. */
const folderId = (mount: string, folder: string): string => `${mount}/${folder ? folder + '/' : ''}`

/** A top-level row: a mount, or a typed folder or secret (constrained tokens). */
type Root = { mount: VaultMount; folder: string; secret?: boolean }
/** Whether a folder root already shows `folder` of `mount` somewhere beneath it (or is it). */
const covers = (r: Root, mount: string, folder: string): boolean =>
  !r.secret &&
  r.mount.path === mount &&
  (r.folder === '' || folder === r.folder || folder.startsWith(`${r.folder}/`))
const sameRoot = (a: Root, b: Root): boolean =>
  a.mount.path === b.mount.path && a.folder === b.folder && !a.secret === !b.secret

/**
 * Browse Vault: KV v2 mounts → folders (apps, groups) → secrets, one level per
 * expansion. Names and version metadata only; main holds the token and never
 * reads secret data here. A WAI-ARIA tree with roving focus: ↑/↓ move,
 * →/← open/close (or step in/out), Enter/Space picks, Home/End jump.
 */
export function VaultBrowser({
  discovery,
  picked,
  onPick,
  onReadyChange
}: {
  discovery: VaultDiscovery
  picked: VaultPick | null
  onPick: (p: VaultPick) => void
  /**
   * Whether the pick can be connected: a secret always; a folder only once its
   * listing succeeded with at least one secret directly inside (connectVault
   * refuses anything else, so Connect must not be offered for it).
   */
  onReadyChange: (ready: boolean) => void
}): React.JSX.Element {
  const session = discovery.session
  // Typed roots come first, newest first (constrained tokens), then every
  // enumerated mount. A typed path is revealed inside a root that covers it when
  // every step down is listable; otherwise it becomes a root of its own.
  const [typed, setTyped] = useState<Root[]>([])
  const roots: Root[] = [
    ...typed,
    ...(discovery.mounts ?? [])
      .filter((m) => !typed.some((t) => covers(t, m.path, '')))
      .map((mount) => ({ mount, folder: '' }))
  ]
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const [jump, setJump] = useState('')
  const [jumpBusy, setJumpBusy] = useState(false)
  const [jumpError, setJumpError] = useState<string | null>(null)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const ticket = useRef(0)
  /** Rows to focus once rendered (a revealed path appears only after its listings load). */
  const pendingFocus = useRef<string[]>([])
  useEffect(() => {
    const id = pendingFocus.current.find((c) => refs.current.has(c))
    if (id) {
      pendingFocus.current = []
      refs.current.get(id)!.focus()
    }
  })

  const load = (mount: string, folder: string): void => {
    const k = keyOf(mount, folder)
    const t = ++ticket.current
    setListings((l) => ({ ...l, [k]: { state: 'loading', ticket: t } }))
    window.plumbr
      .vaultDiscoverList({ session, mount, folder })
      .catch((e): VaultListing => ({ state: 'error', denied: false, message: err(e) }))
      .then((res) =>
        // A collapse cancels: a reply for a request no longer pending is dropped.
        setListings((l) => {
          const cur = l[k]
          return cur?.state === 'loading' && cur.ticket === t ? { ...l, [k]: res } : l
        })
      )
  }

  const toggle = (mount: string, folder: string, id: string): void => {
    const k = keyOf(mount, folder)
    const next = new Set(open)
    if (next.has(id)) {
      next.delete(id)
      if (listings[k]?.state === 'loading')
        setListings((l) => {
          const rest = { ...l }
          delete rest[k]
          return rest
        })
    } else {
      next.add(id)
      if (!listings[k] || listings[k].state === 'error') load(mount, folder)
    }
    setOpen(next)
  }

  // Flatten what is visible into rows. Status lines are rows too, so keyboard
  // and screen-reader users meet "loading", "empty" and "no permission" in place.
  const rows: Row[] = []
  // Each place in Vault is drawn once, whichever root reaches it first (typed
  // roots come first), so row ids and React keys stay unique.
  const seen = new Set<string>()
  const walk = (mount: string, folder: string, level: number, parentId: string): void => {
    if (!open.has(parentId)) return
    const l = listings[keyOf(mount, folder)]
    const status = (label: string, tone: 'busy' | 'muted' | 'bad', retry = false): void => {
      rows.push({
        id: `${parentId}#status`,
        kind: 'status',
        level,
        label,
        mount,
        path: folder,
        tone,
        retry
      })
    }
    if (!l || l.state === 'loading') return status('Listing… (← to cancel)', 'busy')
    if (l.state === 'empty')
      return status('Nothing listed here (empty, or this token may not list it)', 'muted')
    if (l.state === 'error')
      return status(l.denied ? l.message : `${l.message} · Enter to retry`, 'bad', !l.denied)
    for (const n of l.nodes) {
      const id = `${mount}/${n.path}${n.kind === 'folder' ? '/' : ''}`
      if (seen.has(id)) continue
      seen.add(id)
      rows.push({ id, kind: n.kind, level, label: n.name, mount, path: n.path })
      if (n.kind === 'folder') walk(mount, n.path, level + 1, id)
    }
    if (l.truncated) status('More entries not shown: open a deeper path below', 'muted')
  }
  for (const r of roots) {
    const id = r.secret ? `${r.mount.path}/${r.folder}` : folderId(r.mount.path, r.folder)
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({
      id,
      kind: r.secret ? 'secret' : r.folder ? 'folder' : 'mount',
      level: 1,
      label: r.folder ? `${r.mount.path}/${r.folder}` : r.mount.path,
      mount: r.mount.path,
      path: r.folder,
      note: r.mount.description || undefined
    })
    if (!r.secret) walk(r.mount.path, r.folder, 2, id)
  }

  const current = rows.find((r) => r.id === focus) ?? rows[0]
  useEffect(() => {
    if (focus) refs.current.get(focus)?.focus()
  }, [focus])

  const pick = (r: Row): void => {
    if (r.kind === 'secret' || (r.kind === 'folder' && r.path))
      onPick({ mount: r.mount, path: r.path, kind: r.kind })
  }
  const activate = (r: Row): void => {
    if (r.kind === 'status') {
      if (r.retry) load(r.mount, r.path)
      return
    }
    if (r.kind !== 'secret') toggle(r.mount, r.path, r.id)
    pick(r)
  }

  const onKey = (e: React.KeyboardEvent, r: Row): void => {
    const i = rows.indexOf(r)
    const go = (j: number): void => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, j))]
      if (t) setFocus(t.id)
    }
    const expandable = r.kind === 'mount' || r.kind === 'folder'
    const parent = (): Row | undefined =>
      rows
        .slice(0, i)
        .reverse()
        .find((p) => p.level === r.level - 1)
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1)
        break
      case 'ArrowUp':
        go(i - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (expandable && !open.has(r.id)) toggle(r.mount, r.path, r.id)
        else if (expandable) go(i + 1)
        break
      case 'ArrowLeft':
        if (expandable && open.has(r.id)) toggle(r.mount, r.path, r.id)
        else {
          const p = parent()
          if (p) {
            setFocus(p.id)
            // ← on a loading line cancels that listing.
            if (r.kind === 'status' && r.tone === 'busy') toggle(p.mount, p.path, p.id)
          }
        }
        break
      case 'Enter':
      case ' ':
        activate(r)
        break
      default:
        return
    }
    e.preventDefault()
  }

  /** A folder's listing, reusing a loaded one; awaited so a reveal can check each step. */
  const listingOf = async (mount: string, folder: string): Promise<VaultListing> => {
    const have = listings[keyOf(mount, folder)]
    if (have && have.state !== 'loading' && have.state !== 'error') return have
    const res = await window.plumbr
      .vaultDiscoverList({ session, mount, folder })
      .catch((e): VaultListing => ({ state: 'error', denied: false, message: err(e) }))
    setListings((l) => ({ ...l, [keyOf(mount, folder)]: res }))
    return res
  }

  /**
   * Reveal `folder` of `mount` inside `host`: list each step down (already loaded
   * ones are reused) and open it. Returns the row id to focus, or null when a step
   * is denied, empty, truncated or missing, so the caller adds a root instead.
   */
  const reveal = async (host: Root, mount: string, folder: string): Promise<string | null> => {
    const segs = folder
      .slice(host.folder ? host.folder.length + 1 : 0)
      .split('/')
      .filter(Boolean)
    const chain = [host.folder]
    let target = folderId(mount, folder)
    for (const [i, seg] of segs.entries()) {
      const cur = chain.at(-1)!
      const l = await listingOf(mount, cur)
      const next = cur ? `${cur}/${seg}` : seg
      const node = l.state === 'ok' ? l.nodes.find((n) => n.path === next) : undefined
      if (!node || (node.kind === 'secret' && i < segs.length - 1)) return null
      if (node.kind === 'secret')
        target = `${mount}/${next}` // the secret row itself
      else chain.push(next)
    }
    setOpen((o) => new Set([...o, ...chain.map((f) => folderId(mount, f))]))
    const last = chain.at(-1)!
    const st = listings[keyOf(mount, last)]
    if (!st || st.state === 'error') void listingOf(mount, last)
    return target
  }

  const openTyped = async (): Promise<void> => {
    setJumpBusy(true)
    setJumpError(null)
    pendingFocus.current = []
    try {
      const res = await window.plumbr.vaultDiscoverMount({ session, path: jump })
      const mount = res.mount.path
      // A secret is revealed through its parent folder (the mount root at top level).
      const parent = res.secret ? res.folder.split('/').slice(0, -1).join('/') : res.folder
      // Try every root that covers it, narrowest first: an unlistable broader root
      // must not stop a narrower one from showing the path.
      const hosts = roots
        .filter((r) => covers(r, mount, parent))
        .sort((x, y) => y.folder.length - x.folder.length)
      let id: string | null = null
      for (const h of hosts) if ((id = await reveal(h, mount, res.folder)) !== null) break
      if (id === null) {
        // Not reachable inside an existing root: show it as a root of its own.
        // Overlapping roots are all kept (a broader one may be unlistable); the
        // render-time `seen` set draws each place once. A KV v2 path can be a
        // secret and a folder at once: then both are shown, the folder focused.
        const asFolder = !res.secret || (await listingOf(mount, res.folder)).state === 'ok'
        const added: Root[] = [
          ...(asFolder ? [{ mount: res.mount, folder: res.folder }] : []),
          ...(res.secret ? [{ mount: res.mount, folder: res.folder, secret: true }] : [])
        ]
        setTyped((t) => [...added.filter((r) => !t.some((x) => sameRoot(x, r))), ...t])
        id = asFolder ? folderId(mount, res.folder) : `${mount}/${res.folder}`
        if (asFolder) {
          setOpen((o) => new Set(o).add(id!))
          if (!res.secret) void listingOf(mount, res.folder)
        }
      }
      pendingFocus.current = [id]
      setFocus(id)
      setJump('')
    } catch (e) {
      setJumpError(err(e))
    } finally {
      setJumpBusy(false)
    }
  }

  const pickedId = picked
    ? `${picked.mount}/${picked.path}${picked.kind === 'folder' ? '/' : ''}`
    : null
  const pickedFolder =
    picked?.kind === 'folder' ? listings[keyOf(picked.mount, picked.path)] : undefined
  const directSecrets =
    pickedFolder?.state === 'ok' ? pickedFolder.nodes.filter((x) => x.kind === 'secret').length : 0
  const ready = picked !== null && (picked.kind === 'secret' || directSecrets > 0)
  useEffect(() => onReadyChange(ready), [ready, onReadyChange])

  return (
    <div className="space-y-2">
      {discovery.mountsNote && (
        <p
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-[11px]',
            discovery.mounts === null
              ? 'border-warn/30 bg-warn-soft text-warn'
              : 'text-muted-foreground'
          )}
        >
          {discovery.mountsNote}
        </p>
      )}
      <div className="flex gap-2">
        <Input
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (jump.trim() && !jumpBusy) void openTyped()
            }
          }}
          placeholder={
            discovery.mounts === null
              ? 'secret or secret/apps'
              : 'Open a path, e.g. secret/apps/api'
          }
          aria-label="Open a mount or path"
          className="h-8 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!jump.trim() || jumpBusy}
          onClick={() => void openTyped()}
        >
          {jumpBusy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
          Open
        </Button>
      </div>
      {jumpError && (
        <p role="alert" className="text-[11px] text-bad">
          {jumpError}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          {discovery.mounts === null
            ? 'Mount listing is not allowed for this token. Open a mount or path you know above.'
            : 'This token can see no KV v2 mounts. Open a path above if you know one.'}
        </p>
      ) : (
        <ul
          role="tree"
          aria-label="Vault KV v2 mounts and secrets"
          className="vault-tree max-h-56 overflow-auto rounded-lg border bg-background p-1"
        >
          {rows.map((r) => {
            const expandable = r.kind === 'mount' || r.kind === 'folder'
            const expanded = expandable ? open.has(r.id) : undefined
            const Icon =
              r.kind === 'mount'
                ? HardDrive
                : r.kind === 'folder'
                  ? expanded
                    ? FolderOpen
                    : Folder
                  : r.kind === 'secret'
                    ? FileKey2
                    : r.kind === 'status' && r.tone === 'bad'
                      ? Lock
                      : r.kind === 'status' && r.tone === 'busy'
                        ? Loader2
                        : null
            return (
              <li
                key={r.id}
                ref={(el) => {
                  if (el) refs.current.set(r.id, el)
                  else refs.current.delete(r.id)
                }}
                role="treeitem"
                aria-level={r.level}
                aria-expanded={expanded}
                aria-selected={r.kind === 'status' ? undefined : r.id === pickedId}
                aria-disabled={r.kind === 'status' ? true : undefined}
                title={r.kind === 'status' ? r.label : undefined}
                aria-busy={r.kind === 'status' && r.tone === 'busy' ? true : undefined}
                tabIndex={r.id === current?.id ? 0 : -1}
                onKeyDown={(e) => onKey(e, r)}
                onFocus={() => setFocus(r.id)}
                onClick={() => {
                  setFocus(r.id)
                  activate(r)
                }}
                style={{ paddingLeft: `${(r.level - 1) * 14 + 4}px` }}
                className={cn(
                  'flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 text-xs outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  r.kind === 'status'
                    ? cn(
                        'text-[11px]',
                        r.tone === 'bad' ? 'text-bad' : 'text-muted-foreground',
                        r.retry && 'cursor-pointer'
                      )
                    : r.id === pickedId
                      ? 'bg-lemon-soft font-medium text-foreground'
                      : 'hover:bg-accent'
                )}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
                    !expandable && 'invisible',
                    expanded && 'rotate-90'
                  )}
                />
                {Icon && (
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 shrink-0',
                      r.kind === 'secret' ? 'text-lemon-ink' : 'text-muted-foreground',
                      r.kind === 'status' &&
                        r.tone === 'busy' &&
                        'animate-spin motion-reduce:animate-none'
                    )}
                  />
                )}
                <span className={cn('min-w-0 flex-1 truncate', r.kind !== 'status' && 'font-mono')}>
                  {r.label}
                </span>
                {r.kind === 'status' && r.retry && (
                  <RotateCw aria-hidden="true" className="size-3 shrink-0" />
                )}
                {'note' in r && r.note && (
                  <span className="truncate text-[10px] text-muted-foreground">{r.note}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {picked && (
        <div className="rounded-lg border bg-background p-2.5" aria-live="polite">
          <p className="truncate font-mono text-xs">
            <span className="text-muted-foreground">
              {picked.kind === 'folder' ? 'App folder' : 'Secret'} ·{' '}
            </span>
            {picked.mount}/{picked.path}
          </p>
          {picked.kind === 'folder' ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {!pickedFolder
                ? 'Open this folder to check it has secrets directly inside.'
                : pickedFolder.state === 'loading'
                  ? 'Checking for secrets directly inside…'
                  : pickedFolder.state === 'ok' && directSecrets > 0
                    ? `${directSecrets} secret${directSecrets === 1 ? '' : 's'} directly inside become environments of one source. Subfolders are not included.`
                    : pickedFolder.state === 'ok'
                      ? 'No secrets directly inside, so it cannot be connected as a folder. Open a subfolder and pick a secret or folder there.'
                      : pickedFolder.state === 'empty'
                        ? 'Nothing listed directly inside (empty, or no list permission), so it cannot be connected as a folder. Pick a secret instead.'
                        : 'This folder could not be listed, so it cannot be connected as a folder. Pick a secret instead.'}
            </p>
          ) : (
            <PickedVersions session={session} mount={picked.mount} path={picked.path} />
          )}
        </div>
      )}
    </div>
  )
}

/** Version timeline of the picked secret: metadata only, loaded on pick. */
function PickedVersions({
  session,
  mount,
  path
}: {
  session: string
  mount: string
  path: string
}): React.JSX.Element {
  const [state, setState] = useState<{ key: string; hist?: VaultHistory; error?: string } | null>(
    null
  )
  const key = `${mount}/${path}`
  useEffect(() => {
    let live = true
    window.plumbr
      .vaultDiscoverVersions({ session, mount, path })
      .then((hist) => live && setState({ key, hist }))
      .catch((e) => live && setState({ key, error: err(e) }))
    return () => {
      live = false
    }
  }, [session, mount, path, key])

  if (!state || state.key !== key)
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Reading versions…
      </p>
    )
  if (state.error)
    return (
      <p className="mt-1 text-[11px] text-bad" role="alert">
        {state.error} You can still connect it if the token may read the data.
      </p>
    )
  const h = state.hist!
  return (
    <>
      <ol className="mt-1.5 max-h-24 space-y-0.5 overflow-auto" aria-label={`Versions of ${key}`}>
        {h.versions.slice(0, 20).map((v) => (
          <li key={v.version} className="flex items-center gap-2 text-[11px]">
            <span className="w-8 shrink-0 font-mono">v{v.version}</span>
            <VersionChip state={versionState(v, h.currentVersion)} />
            <span className="truncate text-muted-foreground">
              {v.createdTime ? fmtAgo(Date.parse(v.createdTime)) : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {h.versions.length} version{h.versions.length === 1 ? '' : 's'} · values are not read while
        browsing. After connecting, Versions compares and restores them safely.
      </p>
    </>
  )
}
