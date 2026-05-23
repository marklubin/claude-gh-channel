---
description: Focus the watcher on a single GitHub PR. Hard mode drops every event that isn't on the pinned PR; soft mode keeps everything but decorates the pinned PR's events with `pinned: true` + `priority: critical` (and optionally a forced `suggested_skill`). Pin auto-clears when the pinned PR closes. Subcommands: `show`, `clear`.
---

# /gh-channel-pin

Narrow the watcher's attention to one PR. Useful when you're heads-down on something and don't want noise from other PRs in the same subscribed repo.

## Syntax

```
/claude-gh-channel:gh-channel-pin pr <pr-url> --hard|--soft [--as <skill-name>]
/claude-gh-channel:gh-channel-pin show
/claude-gh-channel:gh-channel-pin clear
```

- **--hard**: server filters out (drops, doesn't emit) every webhook that isn't on the pinned PR. Even other PRs in the same subscribed repo are silenced.
- **--soft**: every event still flows, but events on the pinned PR arrive with `pinned: true`, `priority: critical`, and (if `--as` is set) `suggested_skill: <skill>` in their meta. The watcher's brief is then expected to drop-everything-and-handle-pinned for these.
- **--as `<skill>`**: only meaningful with `--soft`. Overrides the routing hints' suggested_skill for events on the pinned PR. Common values: `pr-review-prep`, `pr-triage`, `pr-comment-respond`.

Exactly one of `--hard` or `--soft` must be specified — there is no default mode. Forcing the choice avoids silent assumptions about how aggressive the pin should be.

## Procedure

### 1. Parse the args

Read the user's input. Three shapes:

- `pr <url> --hard` or `pr <url> --soft [--as <skill>]` — set/replace pin
- `show` — print current pin state
- `clear` — remove pin

For the `pr <url>` form, parse the URL. Accept exactly the GitHub PR URL format `https://github.com/<owner>/<repo>/pull/<number>` (with or without trailing path components like `/files`). Reject anything else with a clear error.

Extract `<owner>/<repo>` as `repo` and `<number>` as an integer.

### 2. Validate

- The repo must already appear in `~/.config/claude-gh-channel/config.yaml`'s `subscriptions:` list. If not, refuse and tell the user to add the subscription first (a pin on a non-subscribed repo would be a no-op since events would already be filtered out by the subscription gate).
- The PR must exist and be open. Check with `gh api repos/<owner>/<repo>/pulls/<number> --jq '.state'` — if it's `closed` or returns 404, ask the user to confirm before setting a pin that will probably auto-clear or never match.
- If a pin is already set, show the existing pin and ask whether to replace it.

### 3. Set the pin

POST the pin to the server:

```bash
curl -sf -X POST localhost:8788/pin \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg repo "<owner>/<repo>" --argjson n <number> --arg mode "<hard|soft>" --arg skill "<skill-or-empty>" \
    '{repo:$repo, number:$n, mode:$mode, as_skill:(if $skill=="" then null else $skill end)}')"
```

If the server isn't running (curl fails), tell the user the pin can't take effect without an attached watcher and the daemon up.

### 4. Confirm

Show the user:
- What was pinned (repo + number + mode + skill)
- Current `/health` (so they can see the pin in the JSON)
- Reminder about auto-clear: the pin will be removed automatically when the pinned PR closes (merged or not).

## Subcommands

### `show`

```bash
curl -s localhost:8788/pin | jq
```

Print the current pin or `{ pin: null }` if none.

### `clear`

```bash
curl -sf -X DELETE localhost:8788/pin
```

Remove the pin. Tell the user what was cleared (the response includes the previous pin in `was:`).

## Edge cases to handle

- **Watcher not running**: server is in the watcher Claude's MCP subprocess. If no watcher is attached, the pin can be set in config but won't take effect. Currently we only store the pin in-memory, so without a watcher it can't be set at all. Tell the user.
- **Same PR re-pinned**: replace silently if mode + skill match the existing; otherwise show the diff and ask.
- **Pin on a repo not in subscriptions**: refuse with a clear "add `repo:` to `subscriptions:` in config.yaml first" message.
- **Pin in soft mode with --as <skill> that doesn't exist in the plugin's skill catalog**: warn but allow — there's no enforced list, the user might be wiring up a skill from another plugin.

## What this command does NOT do

- It does not modify `config.yaml`. The pin is operational state, not declarative config.
- It does not survive a watcher restart. If you restart the watcher, you'll need to re-pin. This is intentional — pins should reflect *current* active focus, and a restart usually means context has shifted.
- It does not gate the GitHub-side webhook. Webhooks still fire on every event; pin gates at the server's filter stage. To gate at GH, use `/claude-gh-channel:gh-channel-pause pause-repo <r>` (which is repo-scoped, not PR-scoped).

## Examples

```
/claude-gh-channel:gh-channel-pin pr https://github.com/kinelo/kinelo/pull/345 --hard
# Drops everything except PR #345 events. Other PRs in kinelo/kinelo also filtered.

/claude-gh-channel:gh-channel-pin pr https://github.com/kinelo/kinelo/pull/345 --soft --as pr-review-prep
# All events still flow. Events on PR #345 arrive with priority=critical and suggested_skill=pr-review-prep.

/claude-gh-channel:gh-channel-pin show
# {"pin":{"repo":"kinelo/kinelo","number":345,"mode":"soft","as_skill":"pr-review-prep","set_at":"..."}}

/claude-gh-channel:gh-channel-pin clear
# Removes the pin. Watcher resumes seeing everything per subscriptions.
```
