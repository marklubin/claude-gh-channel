/**
 * SQLite event queue.
 *
 * Persists every accepted event (after subscription/author/ignore_if filtering,
 * before emit). The queue holds:
 *   - in-flight events during quiet/pause modes
 *   - all-time audit log for replay (`/gh-channel-replay <delivery_id>`)
 *   - drain backlog for the next session attach
 *
 * What v1 does NOT do (acknowledged limitation):
 *   The MCP server only runs while a Claude session is attached (server is a
 *   subprocess of Claude). When no session is attached, the HTTP listener is
 *   not bound, so GH webhook POSTs fail at the tunnel hop. GH will retry for
 *   ~8h on its side, but events that never deliver in that window are lost
 *   from the server's perspective. The v2 daemon architecture in
 *   spike/0.4-multi-session/EVIDENCE.md is the path to fix that. For v1 the
 *   guidance is: keep a watcher session attached, and accept the gap.
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type QueuedEvent = {
  delivery_id: string;
  event_type: string;
  action: string;
  repo: string;
  sender: string;
  received_at: string;
  content: string;
  meta_json: string;
  emitted: number;
  emitted_at: string | null;
};

export class EventQueue {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        delivery_id  TEXT PRIMARY KEY,
        event_type   TEXT NOT NULL,
        action       TEXT,
        repo         TEXT,
        sender       TEXT,
        received_at  TEXT NOT NULL,
        content      TEXT NOT NULL,
        meta_json    TEXT NOT NULL,
        emitted      INTEGER NOT NULL DEFAULT 0,
        emitted_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_unemitted ON events (emitted, received_at);
      CREATE INDEX IF NOT EXISTS idx_events_repo ON events (repo, received_at);
    `);
  }

  /** Insert (or no-op if delivery_id already present — GH dedup). Returns true if newly inserted. */
  enqueue(args: {
    delivery_id: string;
    event_type: string;
    action: string;
    repo: string;
    sender: string;
    content: string;
    meta: Record<string, string>;
  }): boolean {
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO events
         (delivery_id, event_type, action, repo, sender, received_at, content, meta_json, emitted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        args.delivery_id,
        args.event_type,
        args.action,
        args.repo,
        args.sender,
        new Date().toISOString(),
        args.content,
        JSON.stringify(args.meta),
      );
    return result.changes > 0;
  }

  markEmitted(delivery_id: string): void {
    this.db
      .query(`UPDATE events SET emitted = 1, emitted_at = ? WHERE delivery_id = ?`)
      .run(new Date().toISOString(), delivery_id);
  }

  pending(limit = 100): QueuedEvent[] {
    return this.db
      .query<QueuedEvent, []>(
        `SELECT * FROM events WHERE emitted = 0 ORDER BY received_at ASC LIMIT ${limit}`,
      )
      .all();
  }

  get(delivery_id: string): QueuedEvent | null {
    return this.db
      .query<QueuedEvent, [string]>(`SELECT * FROM events WHERE delivery_id = ?`)
      .get(delivery_id);
  }

  recent(limit = 50): QueuedEvent[] {
    return this.db
      .query<QueuedEvent, []>(
        `SELECT * FROM events ORDER BY received_at DESC LIMIT ${limit}`,
      )
      .all();
  }

  stats(): {
    total: number;
    pending: number;
    emitted: number;
    by_event_type: Record<string, number>;
  } {
    const total = (this.db.query(`SELECT COUNT(*) as c FROM events`).get() as any).c as number;
    const pending = (this.db.query(`SELECT COUNT(*) as c FROM events WHERE emitted = 0`).get() as any).c as number;
    const emitted = total - pending;
    const rows = this.db
      .query<{ event_type: string; c: number }, []>(
        `SELECT event_type, COUNT(*) as c FROM events GROUP BY event_type`,
      )
      .all();
    const by_event_type: Record<string, number> = {};
    for (const r of rows) by_event_type[r.event_type] = r.c;
    return { total, pending, emitted, by_event_type };
  }

  close(): void {
    this.db.close();
  }
}
