---
description: Temporary, scoped quieting of claude-gh-channel — pause emissions for a duration, toggle quiet_mode, mute a single repo, or resume. Events still queue to SQLite; only emission is suppressed. Idempotent.
---

# /gh-channel-pause

Soft controls that sit between "fully on" and `/claude-gh-channel:gh-channel-disable`. Events keep flowing into the SQLite queue — only the live emit-to-attached-Claude path is gated. When the pause/quiet/mute lifts, queued events are still there for replay.

This command takes a **subcommand argument**. Parse `$ARGUMENTS` and route:

| Form                                  | Meaning                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `<duration>` (e.g. `30m`, `2h`, `1d`) | Set `runtime.pause_until` to now + duration                            |
| `until-tomorrow`                      | Set `runtime.pause_until` to **tomorrow 09:00 local time**             |
| `quiet`                               | Set `runtime.quiet_mode = true` (drop low-signal events; design doc M3)|
| `unquiet`                             | Set `runtime.quiet_mode = false`                                       |
| `pause-repo <owner/name>`             | Append `<owner/name>` to `runtime.disabled_repos`                      |
| `unpause-repo <owner/name>`           | Remove from `runtime.disabled_repos`                                   |
| `resume`                              | Clear `pause_until`, `quiet_mode=false`, `disabled_repos=[]`           |
| `status` or empty                     | Print current pause/quiet/disabled state and exit                      |

If the argument doesn't match any of the above, print the table and exit. Don't guess.

## Step 1 — Preconditions

```bash
test -f ~/.config/claude-gh-channel/config.json || { echo "Not configured — run /gh-channel-setup first"; exit 1; }
```

## Step 2 — Compute the new state

Helpers for duration parsing — handle `Nm`, `Nh`, `Nd`:

```bash
parse_duration() {
  local d="$1"
  case "$d" in
    *m) date -u -v+"${d%m}M" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${d%m} minutes" +%Y-%m-%dT%H:%M:%SZ ;;
    *h) date -u -v+"${d%h}H" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${d%h} hours" +%Y-%m-%dT%H:%M:%SZ ;;
    *d) date -u -v+"${d%d}d" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${d%d} days" +%Y-%m-%dT%H:%M:%SZ ;;
    *)  echo ""; return 1 ;;
  esac
}

# until-tomorrow → tomorrow at 09:00 local, converted to UTC ISO
tomorrow_9am() {
  date -v+1d -v9H -v0M -v0S -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "tomorrow 09:00" +%Y-%m-%dT%H:%M:%SZ
}
```

Decision: **`until-tomorrow` resolves to 09:00 local on the next calendar day**, not a literal +24h. The intent is "pick this up in the morning."

## Step 3 — Apply the change with jq

All mutations go through a temp file + atomic rename. The `runtime` object gets created lazily if missing.

```bash
apply() {
  local expr="$1"
  local TMP=$(mktemp)
  jq "$expr" ~/.config/claude-gh-channel/config.json > "$TMP" && mv "$TMP" ~/.config/claude-gh-channel/config.json
  chmod 600 ~/.config/claude-gh-channel/config.json
}
```

Examples:

- `pause 30m`:
  ```bash
  UNTIL=$(parse_duration 30m)
  apply ".runtime = (.runtime // {}) | .runtime.pause_until = \"$UNTIL\""
  ```
- `until-tomorrow`:
  ```bash
  UNTIL=$(tomorrow_9am)
  apply ".runtime = (.runtime // {}) | .runtime.pause_until = \"$UNTIL\""
  ```
- `quiet` / `unquiet`:
  ```bash
  apply '.runtime = (.runtime // {}) | .runtime.quiet_mode = true'   # or false
  ```
- `pause-repo owner/name`:
  ```bash
  apply '.runtime = (.runtime // {}) | .runtime.disabled_repos = ((.runtime.disabled_repos // []) + ["owner/name"] | unique)'
  ```
- `unpause-repo owner/name`:
  ```bash
  apply '.runtime.disabled_repos = ((.runtime.disabled_repos // []) - ["owner/name"])'
  ```
- `resume`:
  ```bash
  apply 'del(.runtime.pause_until) | .runtime.quiet_mode = false | .runtime.disabled_repos = []'
  ```

## Step 4 — Nudge the running server (best-effort)

If a watcher is attached on 8788, POST a reload hint so it picks up the new state without waiting for its config-poll tick:

```bash
curl -fsS -X POST --max-time 2 "http://localhost:8788/reload" >/dev/null 2>&1 || true
```

If there's no `/reload` endpoint (early-milestone server), this is a no-op — the server will re-read on its next poll cycle. Either way, don't fail the command on this.

## Step 5 — Report current state

Always end by printing the post-change snapshot:
```bash
jq '.runtime' ~/.config/claude-gh-channel/config.json
```
Plus a plain-English line: e.g. "Paused until 2026-05-23T16:00:00Z (~14h from now)" or "Resumed: no pause, quiet_mode off, 0 disabled repos." If `pause_until` is in the past, mention that it's already expired and behaves as resumed.
