---
description: Manage the watchlist — the set of GitHub PRs the watcher is actively focused on. Watchlist has a list-level mode (`hard` filters out non-watched events, `soft` decorates watched-PR events with `watched: true` + `priority: critical`). Persists to disk across watcher restarts. Auto-removes an entry when its PR closes. Subcommands: `add`, `remove`, `show`, `clear`, `mode`.
---

# /gh-channel-watch

Maintain a set of PRs the watcher cares about right now. Generalization of `/gh-channel-pin` — pin is the single-entry shorthand; watchlist is the same mechanism with N entries.

## Syntax

```
/claude-gh-channel:gh-channel-watch add pr <pr-url> [--as <skill-name>]
/claude-gh-channel:gh-channel-watch remove pr <pr-url>
/claude-gh-channel:gh-channel-watch show
/claude-gh-channel:gh-channel-watch clear
/claude-gh-channel:gh-channel-watch mode hard|soft
```

## Semantics

- **Mode** is list-level, not per-entry. Whole watchlist is either hard or soft. Switch with `mode hard` or `mode soft`. Default on a fresh install is `soft`.
- **Hard mode**: server drops every event whose PR isn't on the watchlist. Other PRs (even in the same subscribed repo) are silenced.
- **Soft mode**: every event still flows. Events on watched PRs arrive with `watched: true`, `watch_mode: soft`, `priority: critical`, and (if the entry has `--as <skill>`) `suggested_skill: <skill>` in their meta.
- **Empty watchlist**: no gate, no decoration, regardless of mode. Adding the first entry turns the mode on.
- **Auto-remove**: when a watched PR closes (`pull_request.closed`, merged or not), that entry is removed automatically. Mode is preserved.
- **Persists**: stored at `~/.config/claude-gh-channel/watchlist.json`. Survives watcher restart, unlike the older in-memory pin.
- **Back-compat**: the older `pinned: true` / `pin_mode` meta keys are still emitted alongside the new `watched` / `watch_mode` keys, so skills written against the 0.1.x pin model keep working without changes.

## Procedure

### `add pr <url> [--as <skill>]`

1. Parse the URL. Must match `https://github.com/<owner>/<repo>/pull/<number>` (trailing path components like `/files` are fine).
2. Validate the repo appears in `~/.config/claude-gh-channel/config.yaml`'s `subscriptions:` list. If not, refuse with "add `repo:` to `subscriptions:` first" — a watchlist entry on a non-subscribed repo would never match.
3. Confirm the PR is open. `gh api repos/<owner>/<repo>/pulls/<number> --jq '.state'` should return `"open"`. If closed, ask before adding (auto-remove will fire on the close event but only if the close happens AFTER you add).
4. POST to the server:
   ```bash
   curl -sf -X POST localhost:8788/watch \
     -H 'content-type: application/json' \
     -d "$(jq -n --arg repo "<owner>/<repo>" --argjson n <number> --arg skill "<skill-or-empty>" \
       '{repo:$repo, number:$n, as_skill:(if $skill=="" then null else $skill end)}')"
   ```
5. Confirm: show the user the added entry + the full updated watchlist (mode + count + entries).

### `remove pr <url>`

1. Parse URL.
2. DELETE to the server:
   ```bash
   curl -sf -X DELETE localhost:8788/watch \
     -H 'content-type: application/json' \
     -d "$(jq -n --arg repo "<owner>/<repo>" --argjson n <number> '{repo:$repo, number:$n}')"
   ```
3. If the response is 404, tell the user the entry wasn't on the list.

### `show`

```bash
curl -s localhost:8788/watch | jq
```

Print the current mode + entries. Format the table prettily (repo, number, as_skill, added_at).

### `clear`

```bash
curl -sf -X DELETE localhost:8788/watch
```

(No body → clears all entries. Mode is preserved.) Confirm the previous count.

### `mode hard|soft`

```bash
curl -sf -X POST localhost:8788/watch/mode \
  -H 'content-type: application/json' \
  -d '{"mode":"hard"}'   # or "soft"
```

Print the new mode. If the list is empty, mention that the mode only takes effect once entries are added.

## Edge cases

- **Watcher not running**: server lives inside the watcher Claude's MCP subprocess. If no watcher is attached, you can still see the on-disk watchlist (`cat ~/.config/claude-gh-channel/watchlist.json`), but you can't mutate it via slash command since the HTTP server isn't bound. Tell the user.
- **Duplicate add**: re-adding an entry that's already there is a no-op. Server returns the existing entry, doesn't update `added_at`.
- **Same PR re-watched after auto-remove**: fine, just `add` again. The previous `added_at` is gone.
- **Mode change with non-empty list**: takes effect immediately for new events. In-flight events already past the gate aren't affected.
- **`--as <skill>` only useful in soft mode**: in hard mode the skill suggestion isn't applied since the gate happens first. Still stored; will activate if mode is later switched to soft.

## What this command does NOT do

- It does not modify `config.yaml`. The watchlist is operational state.
- It does not gate the GitHub-side webhook. Webhooks still fire on every PR event in subscribed repos; watchlist gates at the server's filter stage after subscription matching.
- It does not auto-add PRs based on activity. Adding is always explicit.

## Examples

```
/claude-gh-channel:gh-channel-watch mode soft
/claude-gh-channel:gh-channel-watch add pr https://github.com/kinelo/kinelo/pull/345 --as pr-review-prep
/claude-gh-channel:gh-channel-watch add pr https://github.com/kinelo/kinelo/pull/352
# Both PRs flagged with priority=critical in their event meta. Other PRs flow normally.

/claude-gh-channel:gh-channel-watch mode hard
# Now only events on #345 + #352 reach the watcher. Everything else dropped.

/claude-gh-channel:gh-channel-watch show
# Lists both entries + current mode.

/claude-gh-channel:gh-channel-watch remove pr https://github.com/kinelo/kinelo/pull/345
# #345 dropped from list. #352 still watched.

/claude-gh-channel:gh-channel-watch clear
# Empty the list. Mode preserved (still hard) but no gating until entries return.
```

## Relationship to `/gh-channel-pin`

`/claude-gh-channel:gh-channel-pin pr <url> --hard|--soft [--as <skill>]` is a one-shot shorthand: it clears the watchlist, sets the mode, and adds the one entry. Useful for quick "tunnel-vision on this PR" — but `/gh-channel-watch` is the more flexible primary tool now.
