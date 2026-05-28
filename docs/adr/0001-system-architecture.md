# ADR-0001: System architecture — canonical events, multi-source ingestion, dispatch layer

**Status:** Proposed
**Date:** 2026-05-27
**Supersedes:** (none)
**Related issues:** #10 (epic), #11, #12, #13, #14, #15, #16, #17, #18

## Context

`claude-gh-channel` shipped as a single-purpose plugin: GitHub webhooks delivered to one global Claude watcher session, with most of the pipeline coupled directly to GitHub's wire shape. That was the right starting point — it proved the channels mechanic end-to-end (see `spike/0.5-gh-roundtrip/EVIDENCE.md` and `spike/M2-M5-INTEGRATION-EVIDENCE.md`). But three pressures push us past that starting shape:

1. **We need to watch repos we can't admin.** GitHub webhooks require **Admin** on the repo, which we don't have for the org repos we actually work in daily (e.g. `uni-industries/kinelo`, where we're collaborators with push/triage but no admin — confirmed via `gh api repos/uni-industries/kinelo` in chat session 2026-05-27). Polling `/repos/{o}/{r}/events` with our existing `repo`-scoped PAT works for these. But polling can't slot into the current code without payload-shape coupling getting in the way.

2. **One global watcher is the wrong default routing target.** When a coding agent is already running on PR #345 in a cmux pane, that's where comments on #345 should land. Today everything goes to a single watcher who has no context on any specific PR. The watcher Claude can do a lot, but it shouldn't be the *only* place events surface — that conflates "ambient awareness" with "active work on this PR."

3. **The design contemplates sibling adapters** (Linear, Slack, Recall) that share the same downstream pipeline. They only fall out cleanly if the model the pipeline operates on is decoupled from any one source's wire format.

The current architecture has the right halves of these built (a watchlist + auto-watch + cmux-notify path already exists), but the *plumbing* is GitHub-shaped end-to-end. That's the bottleneck.

Probed `cmux capabilities` in the same session (2026-05-27): cmux already exposes `notification.create_for_surface` (per-pane targeted notifications) and `surface.resume.*` (per-surface metadata storage). So the routing destinations + session-tagging needed for a dispatcher are buildable on existing cmux primitives — no cmux extension required for the initial cut.

## Decision

Adopt a source-agnostic, dispatch-aware event pipeline organized around five contracts:

### 1. Canonical event model

Define a `CanonicalEvent` type that adapters map *into* and everything downstream operates *on*. Source-agnostic field set (`source`, `kind`, `action`, `context`, `actor`, `subject`, `body`, `occurred_at`, `source_ref`), with a fine-grained `kind` taxonomy (`pr.opened`, `pr.review_requested`, `pr.comment.created`, `pr.inline_comment`, `pr.review.submitted`, ...) that future sources extend with their own namespaces (`linear.issue.*`, `slack.thread.*`).

Filters, routing hints, watchlist matches, and summarizers all bind to canonical fields — not to GitHub payload paths. (Tracked in issue #11; sub-ADR may follow for taxonomy details.)

### 2. Adapter pattern at the ingestion edge

Every event source is an adapter that produces `CanonicalEvent`s. The current GitHub webhook handler becomes one adapter (`gh-webhook`). Poll-mode becomes another (`gh-poll`, tracked in #13) — independent of this architectural decision, but a consumer of the canonical model. Future Linear/Slack/Recall sources are siblings, not special cases.

Adapters are the *only* code that sees source-specific payloads.

### 3. Per-repo config in a structured, scalable format

Move per-repo configuration to TOML, one file per repo at `~/.config/claude-gh-channel/repos/<slug>.toml`. Each file specifies the source (`webhook | poll`), event-kinds subscribed, filters, routing hints, and dispatch rules for that repo. Global concerns (agent_brief, runtime knobs, auto_watch defaults) stay in a top-level config file.

This is structural, not aesthetic — as the config grows (multi-repo × source × kinds × routing × dispatch × claims), keeping it in one YAML file becomes opaque. One file per repo also makes interactive management + visualization (skills #17, #18) tractable. (Tracked in #12.)

### 4. Dispatcher + multi-surface delivery

A dispatcher stage sits between event-accept and event-deliver. It consults dispatch rules + a session-to-context registry to pick destination(s) for each event. Destinations include:

- The global watcher pane (today's default — `notifications/claude/channel`)
- A specific cmux pane tagged with the relevant context (via `notification.create_for_surface`)
- A cmux notification (sidebar/dock, no pane required)
- A pane spawned on demand, with session resume where possible (`claude --resume <id>`)
- An inbox file an external agent polls
- A no-op (event acknowledged, no surface)

The dispatcher contract is a small expression language matching on canonical event fields, evaluated against a per-repo TOML config block. (Tracked in #14, #16.)

### 5. Session-to-context registry

A registry of `cmux surface → {repo, pr, branch, claim_kind, session_id?}` populated by:

- **Explicit claim** (an agent registers itself as owner of a PR it just created — the primary use case driving this whole architecture).
- **Inferred claim** (auto-detect from a pane's cwd + git state for ambient PR awareness).

Persistence: lean on `surface.resume.*` for the per-surface association; promote to a SQLite table if/when we outgrow cmux's metadata. (Tracked in #15.)

### Skills for managing the surface area

As the config + claim state grow, manage them through skills, not hand-edits of TOML:

- **Manage skill** — interactive repo config add/edit/remove (#17).
- **Visualize skill** — single rendered view of all repos × sources × subscriptions × routing × watchlist × claims × health (#18).

## Ideal end state

```
SOURCES (adapters)              CANONICAL                    DISPATCH                        DESTINATIONS
═══════════════════              ═════════                    ═════════                       ════════════
                                                                                              
gh-webhook ──┐                                                                                ┌─► global watcher pane
gh-poll      ├──► CanonicalEvent ──► filter/watchlist/route ──► dispatcher ──► registry ──┬──► claimed cmux pane (PR-tagged)
linear       │                          ▲                          ▲                       ├──► cmux notification (no pane)
slack (future)─┘                          │                          │                       ├──► spawned pane (revive)
                                          │                          │                       └──► inbox file / no-op
                                   TOML per-repo config        dispatch rules + claims
                                                                                              
                                   ──────── operations skills ─────────
                                   manage-config | visualize-state | claim-pr
```

Properties this enables:

- **Any source → any destination.** New sources slot in as adapters; new destinations slot in as dispatcher outputs.
- **Coding-agent-aware routing.** A pane that created a PR can self-claim and receive events back, including across session restarts via Claude Code's session-resume.
- **Repos without admin become first-class.** Poll-mode covers them; the rest of the pipeline doesn't care.
- **Configuration scales.** Per-repo TOML + management/visualization skills keep N repos × M concerns tractable.
- **Observable state.** The visualize skill makes "what is the system doing" a single command, not a dig through three files + the cmux topology.

## Consequences

**Enabling (the upside):**

- Linear / Slack / Recall adapters become near-free additions later — they're just new adapter modules producing `CanonicalEvent`s.
- Watching repos we don't admin becomes a config flag (`source = "poll"`), not an unsolvable permission problem.
- The "self-claim by PR-creating agent" pattern (the immediate motivating use case) drops out as the simplest end-to-end test of the architecture — it exercises the registry + dispatcher + multi-surface delivery in their minimum-viable form.
- Routing rules become declarative and per-repo, not hard-coded.

**Costs (the downside, honestly):**

- The current webhook handler + filter expression layer + summarizer + auto-watch logic all need to rebase onto canonical events. Real refactor cost, real risk of regression. Mitigated by the existing E2E smoke (`spike/M2-M5-INTEGRATION-EVIDENCE.md`) — every refactor stage must still pass it.
- More moving parts to maintain: the `kind` taxonomy must be versioned + documented; dispatch rules need their own evaluator (or reuse the existing expression evaluator); registry needs lifecycle handling (auto-release on PR close, surface death, etc.).
- The TOML migration is a config break for existing users. A converter helps; backward-compat reading (accept both YAML and TOML for a release) is the gentlest path.
- The visualize skill becomes a hard requirement, not a nice-to-have — without it the multi-file TOML setup is *worse* than the current single YAML.

**Foreclosed (things this decision rules out):**

- Building source-specific shortcuts that bypass the canonical model. From this point forward, every new source pays the cost of the adapter; no in-line GitHub-shaped reaches into downstream code.
- Routing decisions baked into the channel server in C-with-config style. Routing is a declarative layer with its own contract.
- "Just add poll-mode to the existing GH-shaped pipeline" — explicitly rejected (alternative C below).

## Alternatives considered

**A. Stay GitHub-coupled. Add poll-mode and a dispatcher as bolt-ons.**
Cheapest path to "watch kinelo + route events." But every future source (Linear, Slack) re-pays the coupling cost, and the dispatcher would still bind to GitHub-shape fields. Forecloses the sibling-adapter pattern the design doc explicitly contemplates. Punts the same decision to the second source instead of resolving it now.

**B. Build the dispatcher in cmux itself (a cmux extension).**
The "tagged-pane event inbox" mental model could live in cmux as a generic primitive (any agent ecosystem could use it). Cleaner separation of concerns: cmux becomes the agent-coordination layer. But: (1) cmux already exposes `notification.create_for_surface` + `surface.resume.*` — what we'd need from a cmux extension is mostly already there, just used unconventionally; (2) doing this requires cmux upstream work, which is a substantially bigger commitment + cross-codebase coordination; (3) we can revisit promoting the pattern up into cmux later if it proves valuable beyond this plugin. Rejected for v1, on the table for later.

**C. Skip the canonical event model. Build the dispatcher + multi-source ingestion directly on GitHub payload shapes.**
Faster to working v1, no refactor of existing code. But every adapter then either fakes GitHub payloads (Linear pretending to be a PR) or adds a parallel code path. Within ~2 sources this becomes the dominant maintenance cost. Rejected — short-term speed, long-term tax.

**D. Stay with the global watcher as the only delivery target; just add poll-mode for ingestion.**
Solves the "watch repos we can't admin" half. But the coding-agent-routing half — the actual reason the dispatcher discussion started — goes unaddressed. Half a fix that doesn't deliver the use case driving this.

**E. Wait until we have a real second source (Linear) before generalizing.**
The standard "don't generalize until you've seen the pattern twice" wisdom. Tempting, but: (i) we *have* seen the pattern twice already — webhook and poll are two sources right now, and they're being shoehorned into the same code; (ii) the GH-coupling we'd carry forward is genuinely painful — filter expressions reference `payload.pull_request.user.login`, not a portable identifier. The cost of pulling the canonical model out later is higher than doing it now. Rejected, but with the acknowledgement that this is a judgment call.

## Open follow-ups

Tracked as issues, not in this ADR:

- The exact `kind` taxonomy — fine-grained vs coarse, versioning (#11 + potential ADR-0002).
- TOML schema specifics — scope (whole config vs per-repo), validator, migration script (#12).
- Dispatcher rule language — reuse the existing JS-expression evaluator, or a dedicated mini-DSL (#14).
- Re-instantiation semantics — when to spawn vs notify when a claimed surface is dead (within #15, possibly its own ADR if it gets gnarly).
- Standalone-daemon split (separate concern; will get its own ADR when we tackle it). Out of scope for this one.
- Prompt-injection hardening on the watcher (#19; touches trust boundaries, may warrant a security ADR).

## Notes

- The motivating chat session is 2026-05-27 (long thread covering security audit → named-tunnel setup → kinelo permission discovery → polling → architecture pivot). Worth keeping in mind that this ADR is the *outcome* of a meandering conversation; future-us should not assume every component here was equally rigorously analyzed. The shape is solid; the details are the work.
- The "self-claim by PR-creating agent" loop (the concrete use case Mark surfaced last) is the simplest possible test of the architecture — if that works end-to-end, every other component has been exercised at least at v1 fidelity. It's a natural first integration milestone.
- The probe of cmux capabilities (2026-05-27) materially shrank the proposed scope by ruling out "cmux extension required." This is the kind of finding worth re-confirming if the cmux surface changes substantially.
