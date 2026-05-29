# Project status

Snapshot of where the workstream is. Updated as state changes; not exhaustive — see ADRs for design, issues for backlog, git log for detail.

**Last updated:** 2026-05-28

## Current phase

**Framing complete; implementation of the architecture pivot not yet started.**

The project went through a heavy framing pass: ADR-0001 (target architecture) and ADR-0002 (development process) are both in place, and the work backlog is filed as 10 GitHub issues (#10 epic + #11-#19 components). No code work toward the architecture pivot has begun. The currently-shipped behavior (v0.1.8) is the pre-pivot, GH-coupled, single-watcher version — fully working, with the named tunnel + watchlist + auto-watch + self-bundled server all in.

## Read these first (in this order)

1. [`README.md`](README.md) — what the project is + how to install + use
2. [`CLAUDE.md`](CLAUDE.md) — process foundations + the E2E-through-cmux policy for any change
3. [`docs/adr/0001-system-architecture.md`](docs/adr/0001-system-architecture.md) — target architecture (the *what*)
4. [`docs/adr/0002-development-process.md`](docs/adr/0002-development-process.md) — development methodology (the *how*)
5. [`docs/walkthrough.md`](docs/walkthrough.md) — install + lifecycle + named-tunnel setup deep dive

Plus the backlog: [issues on this repo](https://github.com/marklubin/claude-gh-channel/issues), anchored by [the epic (#10)](https://github.com/marklubin/claude-gh-channel/issues/10).

## What's shipped (v0.1.8, working today)

- Plugin installable via `marklubin/claude-gh-channel` marketplace
- Pre-bundled server (no `bun install` step in cache)
- Webhook-driven ingestion with HMAC verify on a loopback-only port
- Named cloudflared tunnel for stability (durable URL, KeepAlive LaunchAgent)
- Persistent watchlist + auto-watch on review-requested / opened-by-me
- 4 handler skills (pr-triage, pr-review-prep, pr-comment-respond, pr-merge-followup)
- 12 slash commands (setup / status / enable / disable / pause / reload / queue / replay / pin / watch / tunnel / uninstall)
- Self-healing tunnel via `ghwatch` / `/gh-channel-tunnel`
- Channel notifications gated by `channelsEnabled` org policy (a Team/Enterprise constraint; enabled on the author's machine)

## What's next (per ADR-0001 build order)

1. **#11 — Canonical event model.** The architectural contract. Everything else binds to it. Recommended first PR.
2. **#12 — TOML per-repo config + migration from YAML.** Refactor existing config layer onto TOML, no behavior change.
3. **#13 — Poll-mode ingestion.** Independent track from the architecture refactor; can be picked up in parallel. Unblocks watching repos where you don't have admin (e.g. `uni-industries/kinelo`).
4. **#14 + #16 — Dispatcher + multi-surface delivery.**
5. **#15 + #17 + #18 — Session registry + management/visualize skills.**
6. **#19 — Prompt-injection hardening** (orthogonal; lands when it lands).

The "self-claim by PR-creating agent" loop discussed in chat is the natural first integration milestone — it exercises #14 + #15 + #16 at their minimum-viable fidelity and is the concrete use case driving the architecture pivot.

## Running state on the author's machine

(Not part of the repo's surface, but useful context for sessions resuming work locally.)

- **Plugin installed at:** `~/.claude/plugins/cache/marklubin/claude-gh-channel/0.1.8/`
- **Named tunnel:** `https://gh-gateway.synix.dev` → `localhost:8788`, managed by `com.marklubin.claude-gh-channel.named-tunnel` (LaunchAgent, KeepAlive)
- **Webhook:** id `629439653` on `marklubin/claude-gh-channel`, points at the named tunnel, active
- **Config:** `~/.config/claude-gh-channel/` (config.yaml + config.json + secret + watchlist.json + tunnel-url)
- **Channels org policy:** `channelsEnabled: true` per `~/.claude/remote-settings.json` (synced 2026-05-26)
- **Aliases:** `ghwatch` / `ghtunnel` / `ghstatus` / `ghlog` in `~/.zshrc`

## Honest known issues

- **FOLLOWUPS.md is partially stale** and slated for migration to issues per ADR-0002 (open follow-up). Items there are kept until migration; new ones should go straight to issues.
- **Cloudflare API token shared in chat 2026-05-27**; saved in `~/.zshrc` as `CLOUDFLARE_API_TOKEN`. Should be rotated when convenient (Cloudflare dashboard → API Tokens).
- **One Claude watcher per machine** (channels are 1:1; per `spike/0.4-multi-session/EVIDENCE.md`).
- **Watcher runs with `--dangerously-skip-permissions`** — trust boundary is HMAC on webhook authenticity, not on event *content*. See #19 for hardening options.
