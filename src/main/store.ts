import { DatabaseSync } from 'node:sqlite'
import type { DriftReceipt } from '@shared/drift'
import type { HistoryEvent, HistoryKind } from '@shared/channels'

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
   CREATE INDEX events_at ON events (at DESC);`
]

export type Store = ReturnType<typeof openStore>

export function openStore(file: string): {
  getMeta: (key: string) => string | null
  setMeta: (key: string, value: string) => void
  rememberRoot: (path: string) => void
  lastRoot: () => string | null
  touchRoot: (path: string) => void
  forgetAll: () => void
  clearCache: () => void
  saveReceipt: (receipt: DriftReceipt) => number
  logEvent: (kind: HistoryKind, subject: object, detail?: object) => void
  listEvents: (limit?: number) => HistoryEvent[]
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
      'INSERT INTO roots (path, granted_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET granted_at = excluded.granted_at'
    ),
    lastRoot: db.prepare('SELECT path FROM roots ORDER BY granted_at DESC LIMIT 1'),
    touchRoot: db.prepare('UPDATE roots SET last_scan_at = ? WHERE path = ?'),
    insertReceipt: db.prepare(
      'INSERT INTO receipts (left_ref, right_ref, created_at, rows_json, counts_json) VALUES (?, ?, ?, ?, ?)'
    ),
    insertEvent: db.prepare(
      'INSERT INTO events (at, kind, subject_json, detail_json) VALUES (?, ?, ?, ?)'
    ),
    listEvents: db.prepare(
      'SELECT id, at, kind, subject_json, detail_json FROM events ORDER BY at DESC, id DESC LIMIT ?'
    )
  }

  return {
    getMeta: (key) => (q.getMeta.get(key)?.['value'] as string | undefined) ?? null,
    setMeta: (key, value) => void q.setMeta.run(key, value),
    rememberRoot: (path) => void q.upsertRoot.run(path, Date.now()),
    lastRoot: () => (q.lastRoot.get()?.['path'] as string | undefined) ?? null,
    touchRoot: (path) => void q.touchRoot.run(Date.now(), path),
    // Wipes everything except the fingerprint key, so old receipts stay comparable if re-run.
    forgetAll: () => db.exec('DELETE FROM roots; DELETE FROM receipts; DELETE FROM events;'),
    clearCache: () => db.exec('DELETE FROM receipts; DELETE FROM events;'),
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
    close: () => db.close()
  }
}
