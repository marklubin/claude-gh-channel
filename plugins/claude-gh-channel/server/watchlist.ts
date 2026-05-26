/**
 * Watchlist — set of PRs the user is actively focused on.
 *
 * Generalization of the old single-PR `pin`. The watchlist has a
 * list-level mode (`hard` or `soft`):
 *
 *   hard: events on watched PRs pass; everything else dropped
 *   soft: every event flows, but watched-PR events get
 *         `watched: true`, `priority: critical`, and optionally
 *         a per-entry `as_skill` override.
 *
 * Persisted to `~/.config/claude-gh-channel/watchlist.json` so it
 * survives watcher restart. Saved on every mutation.
 *
 * Auto-clear: when a `pull_request.closed` event arrives for a
 * watched entry, that entry is removed. The list's mode is kept.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type WatchEntry = {
  repo: string;
  number: number;
  as_skill: string | null;
  added_at: string;
};

export type WatchMode = "hard" | "soft";

export type WatchlistState = {
  mode: WatchMode;
  entries: WatchEntry[];
  updated_at: string;
};

const DEFAULT_PATH = join(homedir(), ".config", "claude-gh-channel", "watchlist.json");
const PATH = process.env.GH_CHANNEL_WATCHLIST ?? DEFAULT_PATH;

const log = (...args: unknown[]) => console.error("[gh-channel:watchlist]", ...args);

function emptyState(): WatchlistState {
  return { mode: "soft", entries: [], updated_at: new Date().toISOString() };
}

export class Watchlist {
  private state: WatchlistState;

  constructor() {
    this.state = this.load();
  }

  private load(): WatchlistState {
    if (!existsSync(PATH)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(PATH, "utf8")) as Partial<WatchlistState>;
      if (raw.mode !== "hard" && raw.mode !== "soft") return emptyState();
      if (!Array.isArray(raw.entries)) return emptyState();
      // Filter entries for shape
      const entries = raw.entries.filter(
        (e: any) =>
          typeof e === "object" &&
          typeof e.repo === "string" &&
          typeof e.number === "number" &&
          /^[^/]+\/[^/]+$/.test(e.repo),
      ) as WatchEntry[];
      log(`loaded ${entries.length} entries from ${PATH}; mode=${raw.mode}`);
      return {
        mode: raw.mode,
        entries,
        updated_at: raw.updated_at ?? new Date().toISOString(),
      };
    } catch (err) {
      log(`load failed: ${err}; starting empty`);
      return emptyState();
    }
  }

  private save(): void {
    this.state.updated_at = new Date().toISOString();
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
  }

  get(): WatchlistState {
    return { ...this.state, entries: [...this.state.entries] };
  }

  isEmpty(): boolean {
    return this.state.entries.length === 0;
  }

  mode(): WatchMode {
    return this.state.mode;
  }

  setMode(mode: WatchMode): void {
    this.state.mode = mode;
    this.save();
    log(`mode set: ${mode}`);
  }

  /** Returns true if (repo, number) is on the watchlist. */
  matches(repo: string, number: number): boolean {
    return this.state.entries.some((e) => e.repo === repo && e.number === number);
  }

  find(repo: string, number: number): WatchEntry | null {
    return this.state.entries.find((e) => e.repo === repo && e.number === number) ?? null;
  }

  /** Add an entry. If already present, returns the existing one without modification. */
  add(repo: string, number: number, as_skill: string | null = null): WatchEntry {
    const existing = this.find(repo, number);
    if (existing) return existing;
    const entry: WatchEntry = {
      repo,
      number,
      as_skill,
      added_at: new Date().toISOString(),
    };
    this.state.entries.push(entry);
    this.save();
    log(`added ${repo}#${number}${as_skill ? ` (as ${as_skill})` : ""}`);
    return entry;
  }

  /** Remove an entry. Returns the removed entry or null if not present. */
  remove(repo: string, number: number): WatchEntry | null {
    const idx = this.state.entries.findIndex((e) => e.repo === repo && e.number === number);
    if (idx < 0) return null;
    const [removed] = this.state.entries.splice(idx, 1);
    this.save();
    log(`removed ${repo}#${number} (${this.state.entries.length} entries remain)`);
    return removed;
  }

  /** Drop every entry. Mode is kept. */
  clear(): number {
    const n = this.state.entries.length;
    this.state.entries = [];
    this.save();
    log(`cleared ${n} entries`);
    return n;
  }
}
