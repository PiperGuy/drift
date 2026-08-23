import { DatabaseSync } from 'node:sqlite'
import type { DriftReceipt } from '@shared/drift'
import type { HistoryEvent, HistoryKind, Snapshot } from '@shared/channels'

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
  `ALTER TABLE roots ADD COLUMN label TEXT;`
]

export type Store = ReturnType<typeof openStore>

export function openStore(file: string): {
  getMeta: (key: string) => string | null
  setMeta: (key: string, value: string) => void
  rememberRoot: (path: string, label?: string) => void
  forgetRoot: (path: string) => void
  listRoots: () => { path: string; label: string | null }[]
  touchRoot: (path: string) => void
  forgetAll: () => void
  clearCache: () => void
  saveReceipt: (receipt: DriftReceipt) => number
  logEvent: (kind: HistoryKind, subject: object, detail?: object) => void
  listEvents: (limit?: number) => HistoryEvent[]
  saveSnapshot: (s: Omit<Snapshot, 'id' | 'restorable'> & { blob: Buffer | null }) => number
  listSnapshots: (limit?: number) => Snapshot[]
  snapshotBlob: (id: number) => { path: string; blob: Buffer | null } | null
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
      'INSERT INTO roots (path, granted_at, label) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET granted_at = excluded.granted_at, label = excluded.label'
    ),
    deleteRoot: db.prepare('DELETE FROM roots WHERE path = ?'),
    listRoots: db.prepare('SELECT path, label FROM roots ORDER BY granted_at ASC'),
    touchRoot: db.prepare('UPDATE roots SET last_scan_at = ? WHERE path = ?'),
    insertReceipt: db.prepare(
      'INSERT INTO receipts (left_ref, right_ref, created_at, rows_json, counts_json) VALUES (?, ?, ?, ?, ?)'
    ),
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
    snapshotBlob: db.prepare('SELECT path, blob FROM file_history WHERE id = ?')
  }

  return {
    getMeta: (key) => (q.getMeta.get(key)?.['value'] as string | undefined) ?? null,
    setMeta: (key, value) => void q.setMeta.run(key, value),
    rememberRoot: (path, label) => void q.upsertRoot.run(path, Date.now(), label ?? null),
    forgetRoot: (path) => void q.deleteRoot.run(path),
    listRoots: () =>
      (q.listRoots.all() as { path: string; label: string | null }[]).map((r) => ({ ...r })),
    touchRoot: (path) => void q.touchRoot.run(Date.now(), path),
    // Wipes everything except the fingerprint key, so old receipts stay comparable if re-run.
    forgetAll: () =>
      db.exec(
        'DELETE FROM roots; DELETE FROM receipts; DELETE FROM events; DELETE FROM file_history;'
      ),
    clearCache: () =>
      db.exec('DELETE FROM receipts; DELETE FROM events; DELETE FROM file_history;'),
    saveReceipt: (r) =>
      Number(
        q.insertReceipt.run(
          r.left,
          r.right,
          Date.now(),
          JSON.stringify(r.rows),
          JSON.stringify(r.counts)
        ).lastInsertRowid
      ),
    logEvent: (kind, subject, detail = {}) =>
      void q.insertEvent.run(Date.now(), kind, JSON.stringify(subject), JSON.stringify(detail)),
    listEvents: (limit = 200) =>
      (q.listEvents.all(limit) as Record<string, unknown>[]).map((row) => ({
        id: Number(row['id']),
        at: Number(row['at']),
        kind: row['kind'] as HistoryKind,
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
    close: () => db.close()
  }
}
