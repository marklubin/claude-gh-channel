---
name: pr-merge-followup
description: Use when a GitHub pull_request channel event arrives with action=closed AND merged=true AND the PR author is the user (Mark). Scans the PR description for explicit follow-up markers (TODO:, Followup:, Follow-up:, Doesn't address, Out of scope), extracts referenced Linear ticket IDs, and appends new lines to ~/command-center/todo.md (path from config.vars.todo_path). Reports what was added via channel_reply action_type=status. Does NOT fire on closed-without-merge or on PRs authored by other people.
version: 0.1.0
---

# pr-merge-followup

You were activated because a `pull_request.closed` channel event arrived with `merged=true` AND the PR author is the user. Your job: read the PR description for explicit follow-up markers, append them to the user's todo list, and report what got added.

Read `../_shared/handler-contract.md` first. Everything in that file applies here.

## Hard rules

1. **Read-only on GitHub.** This skill never writes to GH. Allowed `gh` commands per the handler contract.
2. **Only append to `todo.md`** — do not rewrite existing lines, do not reorder, do not prune. Append under the `## Active` section (or whichever section the config / file structure indicates is the live list).
3. **Idempotency.** Before writing, grep `todo.md` for the PR number. If lines already reference it, treat the event as already-handled — `channel_reply` action_type=status with `"already processed: <repo>#<n>"` and stop.
4. **Explicit markers only.** Do not infer follow-ups from arbitrary prose. The user writes specific markers when he means follow-up; absence of a marker means no follow-up. Stay strict.

## Inputs you have

From the channel event meta:
- `repo`, `number`, `html_url`, `author`, `title`, `delivery_id`
- `meta.merged` (should be true; verify)

From config (provided in the agent brief via `${vars.todo_path}`):
- Path to `todo.md`. Default if unset: `~/command-center/todo.md`.

## Procedure

### 1. Confirm the trigger condition

```bash
gh pr view ${number} --repo ${repo} --json author,state,merged,mergedAt,body,title
```

Gates:
- `author.login` equals the user's GitHub username.
- `state` is `MERGED` and `merged` is `true`.

If either gate fails:

```ts
channel_reply({
  action_type: "flagged",
  delivery_id: meta.delivery_id,
  text: "pr-merge-followup gate failed: <reason>"
})
```

Then STOP.

### 2. Idempotency check

Read the todo file:

```bash
TODO_PATH="${vars.todo_path:-~/command-center/todo.md}"
grep -n "${repo}#${number}" "${TODO_PATH/#\~/$HOME}"
```

If any matches: this event has already been processed.

```ts
channel_reply({
  action_type: "status",
  delivery_id: meta.delivery_id,
  text: `pr-merge-followup: ${repo}#${number} already in todo.md, skipping`,
  status_key: "gh-channel"
})
```

Then STOP.

### 3. Extract follow-up markers from the PR body

Pull `body` from the json fetched in step 1. Scan line-by-line for these markers (case-insensitive on the marker itself, content kept verbatim):

- Lines starting with `TODO:` → follow-up task
- Lines starting with `Followup:` or `Follow-up:` → follow-up task
- Lines starting with or containing `Doesn't address`, `Doesn't fix`, `Out of scope` → deferred work
- Any `[A-Z]{2,5}-\d+` token (e.g. `ENG-296`, `KIN-1234`) in a `Followup:` / `Follow-up:` / `TODO:` line → attach as `[ticket-id]`

For each extracted item, capture:
- The raw text after the marker (one line; if the marker line is multi-line, take only the first line).
- Any Linear ticket IDs in that line.
- Classification: `followup` vs `deferred` (deferred = "Doesn't address" / "Out of scope" markers).

If you find zero markers: nothing to add. Skip to step 6 with a no-op status.

### 4. Derive the project tag

The `[project]` tag comes from the repo:

- `marklubin/kinelo` → `[kinelo]`
- `kinelo/kinelo` → `[kinelo]`
- `marklubin/claude-gh-channel` → `[claude-gh-channel]`
- General rule: take the repo's name half (after `/`); strip any `marklubin/` or `kinelo/` org prefix; if both halves are the same word, use that word once.

Today's date: format `YYYY-MM-DD` in the user's local timezone.

### 5. Append lines to todo.md

For each extracted marker, format one line:

```
- [ ] <task text> — [<project>] [<ticket-id-if-any>] [<YYYY-MM-DD>] (followup from <repo>#<number>)
```

For `deferred` items, use the same format but mark them:

```
- [ ] <task text> — [<project>] [<ticket-id-if-any>] [<YYYY-MM-DD>] (deferred from <repo>#<number>)
```

Append these lines under the `## Active` heading. If `todo.md` has a different structure (e.g. no `## Active` section), append at the end of the file with a clear separator comment.

This skill DOES write to `todo.md` directly with the file-writing tool — it's the one local-filesystem write besides `channel_reply` drafts. Use the regular Write/Edit toolchain on `${TODO_PATH}`. (Do not use `channel_reply` for this — the tool only knows about drafts and cmux.)

### 6. Report via channel_reply

```ts
channel_reply({
  action_type: "status",
  delivery_id: meta.delivery_id,
  text: `pr-merge-followup: ${repo}#${number} merged — added <N> followup(s), <M> deferred to todo.md`,
  status_key: "gh-channel",
  status_icon: "checkmark.circle",
  status_color: "#22cc88"
})
```

If zero markers were found:

```ts
channel_reply({
  action_type: "status",
  delivery_id: meta.delivery_id,
  text: `pr-merge-followup: ${repo}#${number} merged — no followup markers in PR body`,
  status_key: "gh-channel"
})
```

If the priority on the event was `high` OR the count of added items is ≥3, also notify:

```ts
channel_reply({
  action_type: "notify",
  delivery_id: meta.delivery_id,
  notify_title: `Merged: ${repo}#${number}`,
  text: `<N> followup(s) added to todo.md — review when you get a chance`
})
```

### 7. Done

Per the handler contract: one event = one outcome (added items or no-op status) + stop.

- Do not fetch the diff. This skill only reads `body` from the PR JSON.
- Do not chain into another skill.
- Do not post anywhere on GitHub.
- Do not modify any file other than `todo.md`.

## Anti-patterns

- **Inferring follow-ups from arbitrary prose.** Only the listed markers count. If the body says "I should probably also fix the auth thing later" without a marker, ignore it. False positives erode the todo list's signal.
- **Adding a generic "Review #N" line when there are no markers.** No marker = no add. The status will say "no followup markers in PR body" and that's correct.
- **Rewriting existing todo lines.** Append-only.
- **Skipping the idempotency check.** Replays and `/replay` will fire this event again; without the grep guard you'll duplicate.
- **Forgetting the project tag or the date.** Per the todo.md format rules in the user's global instructions, every item has both.
- **Notifying on every merge.** Use `notify` only for high-priority or 3+-item cases. Otherwise `status` is enough — quiet success is the desired default.
- **Treating closed-without-merge as a merge.** Trigger gate covers this; if the gate is bypassed, flag and stop.
