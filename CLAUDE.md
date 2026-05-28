# CLAUDE.md — claude-gh-channel

Project-local guidance for any Claude session working in this repo.

> **Process foundations:** development for this repo follows two documented processes — read them before substantive work:
> - [`docs/adr/README.md`](docs/adr/README.md) — when/how to write an ADR (architectural decision record).
> - [`docs/adr/0002-development-process.md`](docs/adr/0002-development-process.md) — the ADR → issue → PR chain, milestone-grouped PR sizing, design-vs-code review separation.
>
> The summary you need before opening any PR: **design is settled in an ADR or issue thread *before* the PR opens.** PRs are narrowly "implements the agreed shape, yes/no." Default scope is **one functional milestone per PR**, typically matching one issue. Don't open a PR for WIP — wait until the issue is functionally complete. Refactor escape hatch: split into "mechanical refactor first, behavior change second" if it reduces review burden. See ADR-0002 for the full convention.

## Hard rule: every change gets a real-Claude E2E through a cmux pane

Until shipping a robust install path + automated CI for this plugin is on the roadmap, **every code change** in this repo must be verified end-to-end before being called done. "Done" means:

1. Restructure / code change committed + pushed.
2. Plugin version bumped (`plugins/claude-gh-channel/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`). Cache-refresh requires the bump — without it, `/plugin install` is a silent no-op against the installed cache.
3. Drive the install through a real cmux pane (`cmux new-split right`, then `claude` in the new surface):
   - `/plugin marketplace update marklubin`
   - In the `/plugin` UI's Marketplaces tab, navigate to `marklubin`, press `u`, Enter to confirm pending update.
   - `/reload-plugins`
4. Restart the watcher pane (`/exit` the existing one or close its surface, relaunch via `ghwatch` or the equivalent `claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions`).
5. Verify the cached server is running the new code: `lsof -nP -iTCP:8788 -sTCP:LISTEN` + check the PID's command line points at `~/.claude/plugins/cache/marklubin/claude-gh-channel/<NEW-VERSION>/server/index.ts`.
6. If the change touches webhook ingress, open a real GH PR in this repo (`marklubin/claude-gh-channel`) and confirm the event lands in the watcher pane with the expected meta. Close + clean up the trigger PR/branch afterward.
7. If the change touches a slash command, run that command in the watcher pane (or another pane that has the plugin installed) and verify the observable side effect (`/health`, `/pin`, the SQLite queue, the drafts dir, the cmux sidebar — whichever applies).

No exceptions for "but the synthetic smoke passed." Synthetic smoke catches type errors and the happy path; it doesn't catch:
- `bun install` not running in the cache → MCP subprocess crashes silently
- `${CLAUDE_PLUGIN_ROOT}` not being set in standalone mode (config templating breaks)
- Channel allowlist still requiring `--dangerously-load-development-channels`
- Cache being stale because the version wasn't bumped
- The slash command sending args in a way the server doesn't actually parse

All five of those have already bitten this project. They only surface when you actually go through the install + attach + trigger flow on a real Claude session, against real cached code.

## How to write the test plan for a change

Before starting code changes, write a short E2E test plan as a list of steps. Format:

```
E2E for <feature>:
1. <user-facing trigger>
2. <expected observation in watcher pane>
3. <expected server-side state (curl localhost:8788/...)>
4. <cleanup action>
```

If the test plan only has steps 1–3, you're missing cleanup. If step 2 is "no change visible," the test is testing the wrong thing.

## Specific E2E hooks for the major surfaces

| Change touches | Minimum E2E |
|---|---|
| `server/index.ts` HTTP endpoints | curl the endpoint from the watcher pane's adjacent terminal; verify response shape |
| `server/filters.ts` subscription/routing | open a real PR matching the new filter; verify event arrives (or is correctly dropped) with expected meta |
| `server/queue.ts` | open a PR, kill the watcher mid-emit, restart, verify drain-on-attach replays the event |
| `server/reply.ts` channel_reply tool | in the watcher pane, ask Claude to call channel_reply directly; verify the draft file lands at `~/.config/claude-gh-channel/drafts/` and the cmux status / log shows the side effect |
| A new skill | trigger an event matching the skill's gate; verify the skill activates (cmux status badge, draft file, or the watcher reports running it) |
| A new slash command | run it in the watcher pane; verify the side effect; verify the command's `show` / `clear` / `dry-run` paths also work |
| `commands/gh-channel-setup.md` | run on a fresh machine state — wipe `~/.config/claude-gh-channel/` first, run setup end-to-end, verify both config files written + tunnel up + webhook active |
| `installer/launchd.plist.template` | actually install the LaunchAgent on this machine and reboot (or `launchctl kickstart`); verify the tunnel comes back up and the tunnel-url file reflects the new URL |

## Speed shortcuts that are OK

- **Code-only change inside server/index.ts that doesn't touch ingress paths** (e.g., refactoring an unused helper, renaming a const): you can skip the cmux drive and just run `bunx tsc --noEmit` from `plugins/claude-gh-channel/server/`. But mark it as such in the commit message ("non-ingress change, skipped E2E").
- **Docs-only changes**: skip the E2E. But verify the rendered Markdown reads correctly via the GitHub web view after push.

## What NOT to do

- Don't ship a change because "the synthetic smoke covered all the cases." If the change touches code that runs in the cache, the only honest verification is the cache running the new code.
- Don't bump the version without a corresponding code change. The version field is a signal to users that something changed; bumping it gratuitously dilutes that signal.
- Don't leave the test PR/branch open after E2E. Cleanup is part of the test plan.
- Don't run E2E against the live operational webhook config. If you need a tunnel for testing and Mark already has one configured for actual use, use a different port + a separate webhook (or test against a throwaway repo).

## Triggering a webhook event from the same pane that owns the watcher

Don't. The watcher pane's Claude session is busy holding the MCP subprocess + responding to channel events. Run `gh` / `curl` from this main pane (or a sibling pane). The cmux multi-pane layout is what makes this clean: watcher in surface:N, trigger-and-verify from the main surface, side-by-side.

## Where things live (quick reference)

- Repo: `/Users/mark/claude-gh-channel/`
- Plugin source: `plugins/claude-gh-channel/`
- Cached install: `~/.claude/plugins/cache/marklubin/claude-gh-channel/<version>/`
- User config: `~/.config/claude-gh-channel/{config.yaml, config.json, secret, tunnel-url}`
- SQLite queue: `~/.local/share/claude-gh-channel/events.db`
- Server log: `~/.local/share/claude-gh-channel/server.log` (when launchd plist is owning cloudflared)
- Tunnel pidfile: `~/.config/claude-gh-channel/cloudflared.pid`
