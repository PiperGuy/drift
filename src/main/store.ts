import { DatabaseSync } from 'node:sqlite'
import { parseRef } from './fs'
import type { DriftReceipt } from '@shared/drift'
import type { HistoryEvent, HistoryKind, Snapshot, Workspace } from '@shared/channels'

/**
 * Local store: one SQLite file in userData, opened with `node:sqlite` (built into
 * the Node that Electron ships, no native module). Holds metadata, redacted
 * receipts and an append-only event log. Never a value, never a file body.
 *
 * Schema follows docs/system-design.md §3.1. Only the tables something writes
 * today exist; the rest arrive with the features that need them.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE roots (
     id INTEGER PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     granted_at INTEGER NOT NULL,
     last_scan_at INTEGER
   );
   CREATE TABLE receipts (
     id INTEGER PRIMARY KEY,
     left_ref TEXT NOT NULL,
     right_ref TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     rows_json TEXT NOT NULL,
     counts_json TEXT NOT NULL
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     subject_json TEXT NOT NULL,
     detail_json TEXT NOT NULL
   );
   CREATE INDEX events_at ON events (at DESC);`,
  // v2: file snapshots for rollback. blob is safeStorage-encrypted file bytes, NULL when
  // no keyring could seal it (then the row is a shape-only record and cannot be restored).
  `CREATE TABLE file_history (
     id INTEGER PRIMARY KEY,
     path TEXT NOT NULL,
     at INTEGER NOT NULL,
     reason TEXT NOT NULL,
     mtime INTEGER NOT NULL,
     size INTEGER NOT NULL,
     keys_json TEXT NOT NULL,
     blob BLOB
   );
   CREATE INDEX file_history_path ON file_history (path, at DESC);`,
  // v3: a root may be a local folder or ssh://host/path; label shown in the sidebar.
  `ALTER TABLE roots ADD COLUMN label TEXT;`,
  // v4: named workspaces, each a set of roots. Existing roots join "Default".
  `CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
   INSERT INTO workspaces (name, created_at) VALUES ('Default', strftime('%s','now') * 1000);
   ALTER TABLE roots ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
   INSERT OR IGNORE INTO meta (key, value) VALUES ('active_workspace', '1');`,
  // v5: provider connections (docs/system-design.md §3.1). config_json is non-secret;
  // secret_blob is safeStorage-sealed or NULL for session-only connections.
  `CREATE TABLE connections (
     id INTEGER PRIMARY KEY,
     provider TEXT NOT NULL,
     label TEXT NOT NULL,
     config_json TEXT NOT NULL,
     secret_blob BLOB,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );`,
  // v6: a receipt doubles as a plan. guard is a digest of both redacted shapes at compare
  // time; an apply quoting the receipt is refused when either side's shape moved since.
  `ALTER TABLE receipts ADD COLUMN guard TEXT;`
]

export type ConnectionRow = {
  id: number
  provider: string
  label: string
  config: Record<string, unknown>
  secretBlob: Buffer | null
}

export type Store = ReturnType<typeof openStore>

export function openStore(file: string): {
  getMeta: (key: string) => string | null
  setMeta: (key: string, value: string) => void
  rememberRoot: (path: string, label?: string) => void
  forgetRoot: (path: string) => void
  /** Roots of the active workspace. */
  listRoots: () => { path: string; label: string | null }[]
  /** Every root of every workspace, for cross-source comparison. */
  listAllRoots: () => { path: string; label: string | null; workspaceId: number }[]
  listWorkspaces: () => Workspace[]
  activeWorkspace: () => number
  setActiveWorkspace: (id: number) => void
  createWorkspace: (name: string) => Workspace
  renameWorkspace: (id: number, name: string) => void
  /** Also deletes connections referenced by the workspace's vault/provider roots; returns their ids. */
  deleteWorkspace: (id: number) => number[]
  touchRoot: (path: string) => void
  /** Wipes roots, receipts, events, snapshots AND provider connections; returns connection ids. */
  forgetAll: () => number[]
  clearCache: () => void
  /** `refs` are the exact ordered refs compared; they bind the receipt to that pair for applies. */
  saveReceipt: (
    receipt: DriftReceipt,
    guard?: string,
    refs?: { left: string; right: string }
  ) => number
  receiptGuard: (id: number) => { left: string; right: string; guard: string } | null
  logEvent: (kind: HistoryKind, subject: object, detail?: object) => void
  listEvents: (limit?: number) => HistoryEvent[]
  saveSnapshot: (s: Omit<Snapshot, 'id' | 'restorable'> & { blob: Buffer | null }) => number
  listSnapshots: (limit?: number) => Snapshot[]
  snapshotBlob: (id: number) => { path: string; blob: Buffer | null } | null
  addConnection: (
    provider: string,
    label: string,
    config: Record<string, unknown>,
    secretBlob: Buffer | null
  ) => number
  getConnection: (id: number) => ConnectionRow | null
  updateConnectionSecret: (id: number, secretBlob: Buffer | null) => void
  deleteConnection: (id: number) => void
  touchConnection: (id: number) => void
  close: () => void
} {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0)
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    db.exec(MIGRATIONS[v])
    db.exec(`PRAGMA user_version = ${v + 1}`)
    db.exec('COMMIT')
  }

  const q = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    upsertRoot: db.prepare(
      'INSERT INTO roots (path, granted_at, label, workspace_id) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET granted_at = excluded.granted_at, label = excluded.label, workspace_id = excluded.workspace_id'
    ),
    deleteRoot: db.prepare('DELETE FROM roots WHERE path = ? AND workspace_id = ?'),
    listRoots: db.prepare(
      'SELECT path, label FROM roots WHERE workspace_id = ? ORDER BY granted_at ASC'
    ),
    listAllRoots: db.prepare(
      'SELECT path, label, workspace_id FROM roots ORDER BY workspace_id ASC, granted_at ASC'
    ),
    listWorkspaces: db.prepare(
      'SELECT w.id, w.name, (SELECT COUNT(*) FROM roots r WHERE r.workspace_id = w.id) AS roots, (SELECT path FROM roots r WHERE r.workspace_id = w.id ORDER BY granted_at ASC LIMIT 1) AS path FROM workspaces w ORDER BY w.created_at ASC'
    ),
    insertWorkspace: db.prepare('INSERT INTO workspaces (name, created_at) VALUES (?, ?)'),
    renameWorkspace: db.prepare('UPDATE workspaces SET name = ? WHERE id = ?'),
    deleteWorkspace: db.prepare('DELETE FROM workspaces WHERE id = ?'),
    deleteWorkspaceRoots: db.prepare('DELETE FROM roots WHERE workspace_id = ?'),
    touchRoot: db.prepare('UPDATE roots SET last_scan_at = ? WHERE path = ?'),
    insertReceipt: db.prepare(
      'INSERT INTO receipts (left_ref, right_ref, created_at, rows_json, counts_json, guard) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    receiptGuard: db.prepare('SELECT left_ref, right_ref, guard FROM receipts WHERE id = ?'),
    insertEvent: db.prepare(
      'INSERT INTO events (at, kind, subject_json, detail_json) VALUES (?, ?, ?, ?)'
    ),
    listEvents: db.prepare(
      'SELECT id, at, kind, subject_json, detail_json FROM events ORDER BY at DESC, id DESC LIMIT ?'
    ),
    insertSnapshot: db.prepare(
      'INSERT INTO file_history (path, at, reason, mtime, size, keys_json, blob) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    listSnapshots: db.prepare(
      'SELECT id, path, at, reason, mtime, size, keys_json, blob IS NOT NULL AS restorable FROM file_history ORDER BY at DESC, id DESC LIMIT ?'
    ),
    snapshotBlob: db.prepare('SELECT path, blob FROM file_history WHERE id = ?'),
    insertConnection: db.prepare(
      'INSERT INTO connections (provider, label, config_json, secret_blob, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    getConnection: db.prepare(
      'SELECT id, provider, label, config_json, secret_blob FROM connections WHERE id = ?'
    ),
    updateConnectionSecret: db.prepare('UPDATE connections SET secret_blob = ? WHERE id = ?'),
    deleteConnection: db.prepare('DELETE FROM connections WHERE id = ?'),
    touchConnection: db.prepare('UPDATE connections SET last_used_at = ? WHERE id = ?')
  }

  const active = (): number => Number(q.getMeta.get('active_workspace')?.['value'] ?? 1)

  /** Connection ids referenced by vault:// and provider roots — of one workspace, or of every workspace. */
  const connIds = (workspaceId?: number): number[] => {
    const rows = (
      workspaceId === undefined
        ? (db.prepare('SELECT path FROM roots').all() as { path: string }[])
        : (q.listRoots.all(workspaceId) as { path: string }[])
    ).map((r) => parseRef(r.path))
    return rows.flatMap((r) => ('connectionId' in r ? [r.connectionId] : []))
  }

  return {
    getMeta: (key) => (q.getMeta.get(key)?.['value'] as string | undefined) ?? null,
    setMeta: (key, value) => void q.setMeta.run(key, value),
    rememberRoot: (path, label) => void q.upsertRoot.run(path, Date.now(), label ?? null, active()),
    forgetRoot: (path) => void q.deleteRoot.run(path, active()),
    listRoots: () =>
      (q.listRoots.all(active()) as { path: string; label: string | null }[]).map((r) => ({
        ...r
      })),
    listAllRoots: () =>
      (q.listAllRoots.all() as { path: string; label: string | null; workspace_id: number }[]).map(
        (r) => ({ path: r.path, label: r.label, workspaceId: Number(r.workspace_id) })
      ),
    listWorkspaces: () =>
      (
        q.listWorkspaces.all() as { id: number; name: string; roots: number; path: string | null }[]
      ).map((w) => ({ ...w })),
    activeWorkspace: active,
    setActiveWorkspace: (id) => void q.setMeta.run('active_workspace', String(id)),
    createWorkspace: (name) => {
      const id = Number(q.insertWorkspace.run(name, Date.now()).lastInsertRowid)
      return { id, name, roots: 0, path: null }
    },
    renameWorkspace: (id, name) => void q.renameWorkspace.run(name, id),
    deleteWorkspace: (id) => {
      // A root's credentials must not outlive the root (Codex review P1).
      const ids = connIds(id)
      for (const c of ids) q.deleteConnection.run(c)
      q.deleteWorkspaceRoots.run(id)
      q.deleteWorkspace.run(id)
      return ids
    },
    touchRoot: (path) => void q.touchRoot.run(Date.now(), path),
    // Wipes everything except the fingerprint key, so old receipts stay comparable if re-run.
    // Connections go too: a sealed token must never outlive "Forget data" (Codex review P1).
    forgetAll: () => {
      const ids = connIds()
      db.exec(
        'DELETE FROM roots; DELETE FROM receipts; DELETE FROM events; DELETE FROM file_history; DELETE FROM connections;'
      )
      return ids
    },
    clearCache: () =>
      db.exec('DELETE FROM receipts; DELETE FROM events; DELETE FROM file_history;'),
    saveReceipt: (r, guard, refs) =>
      Number(
        q.insertReceipt.run(
          refs?.left ?? r.left,
          refs?.right ?? r.right,
          Date.now(),
          JSON.stringify(r.rows),
          JSON.stringify(r.counts),
          guard ?? null
        ).lastInsertRowid
      ),
    receiptGuard: (id) => {
      const r = q.receiptGuard.get(id) as
        { left_ref: string; right_ref: string; guard: string | null } | undefined
      return r?.guard ? { left: r.left_ref, right: r.right_ref, guard: r.guard } : null
    },
    logEvent: (kind, subject, detail = {}) =>
      void q.insertEvent.run(Date.now(), kind, JSON.stringify(subject), JSON.stringify(detail)),
    listEvents: (limit = 200) =>
      (q.listEvents.all(limit) as Record<string, unknown>[]).map((row) => ({
        id: Number(row['id']),
        at: Number(row['at']),
        kind: String(row['kind']),
        subject: JSON.parse(row['subject_json'] as string),
        detail: JSON.parse(row['detail_json'] as string)
      })),
    saveSnapshot: (s) =>
      Number(
        q.insertSnapshot.run(
          s.path,
          s.at,
          s.reason,
          s.mtime,
          s.size,
          JSON.stringify(s.keys),
          s.blob
        ).lastInsertRowid
      ),
    listSnapshots: (limit = 200) =>
      (q.listSnapshots.all(limit) as Record<string, unknown>[]).map((r) => ({
        id: Number(r['id']),
        path: r['path'] as string,
        at: Number(r['at']),
        reason: r['reason'] as Snapshot['reason'],
        mtime: Number(r['mtime']),
        size: Number(r['size']),
        keys: JSON.parse(r['keys_json'] as string),
        restorable: Boolean(r['restorable'])
      })),
    snapshotBlob: (id) => {
      const r = q.snapshotBlob.get(id) as { path: string; blob: Uint8Array | null } | undefined
      return r ? { path: r.path, blob: r.blob ? Buffer.from(r.blob) : null } : null
    },
    addConnection: (provider, label, config, secretBlob) =>
      Number(
        q.insertConnection.run(provider, label, JSON.stringify(config), secretBlob, Date.now())
          .lastInsertRowid
      ),
    getConnection: (id) => {
      const r = q.getConnection.get(id) as
        | {
            id: number
            provider: string
            label: string
            config_json: string
            secret_blob: Uint8Array | null
          }
        | undefined
      if (!r) return null
      return {
        id: Number(r.id),
        provider: r.provider,
        label: r.label,
        config: JSON.parse(r.config_json),
        secretBlob: r.secret_blob ? Buffer.from(r.secret_blob) : null
      }
    },
    updateConnectionSecret: (id, secretBlob) => void q.updateConnectionSecret.run(secretBlob, id),
    deleteConnection: (id) => void q.deleteConnection.run(id),
    touchConnection: (id) => void q.touchConnection.run(Date.now(), id),
    close: () => db.close()
  }
}
