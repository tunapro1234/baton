// SQLite store. The plan, people and windows come from the fixture and stay read-only;
// only care events, observations, corrections and request results are written.
import Database from 'better-sqlite3';
import type { CareEvent, Fixture, Observation } from '@baton/contract';

export type StoredEvent = CareEvent & { requestId?: string };
export type Correction = { correctionId: string; eventId: string; at: string; reason: string; memberId?: string };

type EventRow = {
  event_id: string;
  at: string;
  member_id: string;
  med_id: string;
  window_id: string | null;
  heard_text: string | null;
  note: string | null;
  deleted: number;
  request_id: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  member_id TEXT NOT NULL,
  med_id TEXT NOT NULL,
  window_id TEXT,
  heard_text TEXT,
  note TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE TABLE IF NOT EXISTS observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  member_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corrections (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,
  member_id TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
`;

function toEvent(r: EventRow): StoredEvent {
  const e: StoredEvent = { eventId: r.event_id, at: r.at, memberId: r.member_id, medId: r.med_id };
  if (r.window_id) e.windowId = r.window_id;
  if (r.heard_text) e.heardText = r.heard_text;
  if (r.note) e.note = r.note;
  if (r.deleted) e.deleted = true;
  if (r.request_id) e.requestId = r.request_id;
  return e;
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /** Loads the fixture history into an empty database. Returns false when data was already there. */
  seed(fx: Fixture): boolean {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    if (n.n > 0) return false;
    this.db.transaction(() => {
      for (const e of fx.events) this.insertEvent(e);
      for (const o of fx.observations) this.insertObservation(o);
    })();
    return true;
  }

  insertEvent(e: StoredEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (event_id, at, member_id, med_id, window_id, heard_text, note, deleted, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.eventId, e.at, e.memberId, e.medId, e.windowId ?? null, e.heardText ?? null, e.note ?? null, e.deleted ? 1 : 0, e.requestId ?? null);
  }

  insertObservation(o: Observation): void {
    this.db
      .prepare('INSERT INTO observations (observation_id, at, member_id, text) VALUES (?, ?, ?, ?)')
      .run(o.observationId, o.at, o.memberId, o.text);
  }

  /** Events whose time falls in [fromIso, toIso). Soft-deleted rows only when asked. */
  events(opts: { from?: string; to?: string; includeDeleted?: boolean } = {}): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE at >= ? AND at < ? ${opts.includeDeleted ? '' : 'AND deleted = 0'} ORDER BY at, seq`,
      )
      .all(opts.from ?? '0000', opts.to ?? '9999') as EventRow[];
    return rows.map(toEvent);
  }

  event(eventId: string): StoredEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as EventRow | undefined;
    return r && toEvent(r);
  }

  observations(opts: { from?: string; to?: string } = {}): Observation[] {
    const rows = this.db
      .prepare('SELECT observation_id, at, member_id, text FROM observations WHERE at >= ? AND at < ? ORDER BY at, seq')
      .all(opts.from ?? '0000', opts.to ?? '9999') as { observation_id: string; at: string; member_id: string; text: string }[];
    return rows.map((r) => ({ observationId: r.observation_id, at: r.at, memberId: r.member_id, text: r.text }));
  }

  corrections(opts: { from?: string; to?: string } = {}): Correction[] {
    const rows = this.db
      .prepare('SELECT correction_id, event_id, at, reason, member_id FROM corrections WHERE at >= ? AND at < ? ORDER BY at, seq')
      .all(opts.from ?? '0000', opts.to ?? '9999') as { correction_id: string; event_id: string; at: string; reason: string; member_id: string | null }[];
    return rows.map((r) => ({
      correctionId: r.correction_id,
      eventId: r.event_id,
      at: r.at,
      reason: r.reason,
      ...(r.member_id ? { memberId: r.member_id } : {}),
    }));
  }

  /** Soft delete with an audit row. Returns false if the event is missing or already deleted. */
  softDelete(eventId: string, at: string, reason: string, memberId?: string): boolean {
    return this.db.transaction(() => {
      const res = this.db.prepare('UPDATE events SET deleted = 1 WHERE event_id = ? AND deleted = 0').run(eventId);
      if (res.changes === 0) return false;
      this.db
        .prepare('INSERT INTO corrections (correction_id, event_id, at, reason, member_id) VALUES (?, ?, ?, ?, ?)')
        .run(this.nextId('c', at, 'corrections'), eventId, at, reason, memberId ?? null);
      return true;
    })();
  }

  requestResult(requestId: string): unknown | undefined {
    const r = this.db.prepare('SELECT result FROM requests WHERE request_id = ?').get(requestId) as { result: string } | undefined;
    return r ? JSON.parse(r.result) : undefined;
  }

  saveRequest(requestId: string, result: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO requests (request_id, result) VALUES (?, ?)').run(requestId, JSON.stringify(result));
  }

  /** Readable, ordered ids such as "e-20261020-0003". */
  nextId(prefix: 'e' | 'o' | 'c', at: string, table: 'events' | 'observations' | 'corrections'): string {
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return `${prefix}-${at.slice(0, 10).replaceAll('-', '')}-${String(n.n + 1).padStart(4, '0')}`;
  }

  /** Runs fn in one transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
