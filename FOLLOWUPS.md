# Followups

Deferred work, in priority order. Add new entries with date + concrete observations from the session that surfaced them. Don't prune — entries move to a `Done` section with completion date when shipped.

---

## Onboarding cleanup (2026-05-23)

**Severity:** medium → high. Functional install path exists but isn't usable without the author standing next to you.

Current install requires too many things to go right manually. Specific friction we hit driving the first real install end-to-end:

### Problems

1. **`bun install` doesn't run in the cache.** Claude Code copies the plugin source into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, but `server/node_modules/` is gitignored and not copied. First attach of the MCP server fails silently — the server process can't import `@modelcontextprotocol/sdk`, exits, port never binds, `/mcp` shows "Failed to connect" with no obvious cause. **Workaround today:** manually `cd ~/.claude/plugins/cache/marklubin/claude-gh-channel/<v>/server && bun install`.

2. **Self-published channels always need `--dangerously-load-development-channels`.** The channels allowlist is Anthropic-curated. Plain `--channels plugin:<name>@<marketplace>` fails with "not on the approved allowlist." Watcher attachment is therefore a long, scary-looking command with an interactive "I am using this for local development" confirmation prompt every time.

3. **Cache refresh requires a version bump.** Edit `plugin.json`, push, run `/plugin marketplace update <name>` — the marketplace updates but the installed cache silently stays on the old version. Symptom: changes don't take effect. Discovered by hand only after several "why isn't this working" cycles. The version bump should probably either be automatic or there should be an obvious user-side `/plugin reinstall` that forces re-copy.

4. **`/gh-channel-setup` hasn't been driven end-to-end against the restructured plugin yet.** Every smoke test in `spike/M2-M5-INTEGRATION-EVIDENCE.md` was ad-hoc — tunnel started manually via `cloudflared tunnel --url ...`, webhook registered via `gh api`, config.yaml hand-written/sed'd from the example. The setup-command markdown brief is correct in shape but unvalidated. First user to run it on a fresh machine will be the QA.

5. **Multi-tool prerequisites with no install check.** Setup assumes `gh`, `cloudflared`, `bun`, `jq`, `openssl` all present and recent. README mentions them but doesn't gate on them. Setup-command's preconditions step is a good start but only the watcher Claude can run it, not the plain-shell user.

6. **Config lives in four files in two directories with no unified inspector.** `~/.config/claude-gh-channel/{config.yaml, config.json, secret, tunnel-url}` + `~/.local/share/claude-gh-channel/{events.db, server.log}`. `/gh-channel-status` should be the single answer to "what's configured + what's running" but currently nobody's verified it works in the post-restructure layout.

7. **The watcher attach syntax is non-obvious.** Three near-identical forms exist:
   - `--channels plugin:<name>:<channel>` ← wrong (old syntax)
   - `--channels plugin:<name>@<marketplace>` ← right syntax, fails allowlist
   - `--dangerously-load-development-channels plugin:<name>@<marketplace>` ← the one that actually works
   The README's quick-start should show the correct one prominently with a callout about the dev-channels requirement, not bury it in "how it actually works."

8. **Roadmap callouts undersell the friction.** README's "Known limitations" lists "macOS only", "tunnel URL rotates", etc. — fine. But "you'll need to manually install dependencies in the cache directory after every version bump and answer a dev-channels confirmation prompt every time you launch the watcher" is not mentioned anywhere a prospective installer would look first.

### Possible fixes (rough sizing)

| Fix | Size | Impact |
|---|---|---|
| Bundle the server with `bun build --compile` so cache install is self-contained, no `bun install` needed | medium (need to verify bun:sqlite + MCP SDK survive the compile; ship a per-platform binary) | high — removes the biggest install failure mode |
| Add an `install.sh` script in the plugin that runs `bun install` in `server/`, and have setup-command invoke it | small | medium — workaround for the bundling cost |
| Write a one-shot bootstrap command (e.g. `npx claude-gh-channel-init`) that handles deps + tunnel + webhook + config in one shot, callable from a single `curl | sh` | medium | high — collapses 4 manual steps into one |
| Add an `install-verified` E2E test to CI that exercises `/plugin install` against the marketplace and validates the post-install steps work | small-medium (GitHub Actions runner can do it) | high — catches regressions in the path that's hardest to manually verify |
| Add `/gh-channel-doctor` that checks: dep versions, file presence, webhook live status, tunnel URL match between config + GH, watcher attached, queue depth | small (extends `/gh-channel-status`) | medium — gives users a single command to debug |
| Rewrite README quick-start section to lead with the actually-correct watcher launch command (`--dangerously-load-development-channels` form) | tiny | medium — current state actively misleads readers |
| Document the cache-refresh-requires-version-bump rule in CONTRIBUTING.md and call it out in the changelog format | tiny | small — informational, helps future-self |

### Suggested cohort to ship together

Probably (a) bundle the server, (b) doctor command, (c) README rewrite. Together that's about a day's worth of work and would let someone unfamiliar install from scratch without help. The dev-channels confirmation prompt is on Anthropic's side; we live with it.

### Watch for

- If/when Anthropic opens the channels allowlist to community marketplaces, problem (2) goes away — the plain `--channels` form would work. Until then, problem (2) is structural and out of our control.
- If `claude plugin validate` ever gains a "verify install on a fresh cache" mode, that's the CI integration point for problem (4).
