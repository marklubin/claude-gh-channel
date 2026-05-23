# Handler contract

Shared contract for every channel-event handler skill in `claude-gh-channel`. Each handler skill (pr-triage, pr-review-prep, pr-comment-respond, pr-merge-followup, future siblings) MUST conform to this document. Link to it from the first section of every skill.

## Trigger gate

The watcher session may activate the wrong skill — a `suggested_skill` hint is advisory and skill auto-activation is keyword-driven. **Every handler skill must verify its own trigger condition before doing any work.**

Trigger gate procedure:

1. Read the channel event `meta` block from your context.
2. Confirm `event_type` and `action` match this skill's declared trigger.
3. Confirm any actor identity preconditions (e.g. PR author == user, requested reviewer == user, commenter != user). Use `gh api` to read fields the meta block doesn't already carry.
4. If the gate fails: call `channel_reply` with `action_type=flagged`, a short reason like `"pr-triage activated but author is not user"`, and STOP. Do not fall through into the procedure.

A failed gate is not an error — it's a normal outcome. Log it, flag it, move on. Multiple skills can match the same event; only the one whose gate passes should do work.

## Reading the event

What you have inline (from the channel notification body and `meta`):

- `content` — one-line human summary
- `meta.source` (always `"github"`), `meta.event_type`, `meta.action`
- `meta.delivery_id` — webhook delivery UUID, use this for audit
- `meta.repo` — `owner/name`
- `meta.number` — PR or issue number (called `pr_number` in some events; check both)
- `meta.sender`, `meta.author` — GitHub logins
- `meta.html_url`, `meta.title`
- `meta.summary_kind` — internal categorization
- `meta.suggested_skill` — advisory hint, may be absent or wrong
- `meta.priority` — `low` / `normal` / `high`

What you do NOT have inline:

- The diff, file list, PR description body, comment thread, labels, requested reviewers list, prior reviews, CI status. **Fetch these via `gh`.**

There is no inline payload — the watcher session is intentionally light on context. Fetch only what you need; do not pre-fetch broadly.

## Read-only on GitHub

This plugin is strictly read-only on GitHub. Allowed commands:

- `gh pr view <n> --repo <r> --json ...`
- `gh pr diff <n> --repo <r>`
- `gh pr list --repo <r> ...`
- `gh issue view <n> --repo <r> --json ...`
- `gh api repos/<r>/pulls/<n>` (and similar GET-only paths)
- `gh api repos/<r>/pulls/<n>/comments`, `/reviews`, `/files`
- `gh api repos/<r>/issues/<n>/comments`
- `gh label list --repo <r>`
- `gh repo view <r> --json ...`

Forbidden (do not invoke, even with user confirmation in-band — the user must do these manually outside the channel):

- `gh pr review` (approve, request-changes, comment)
- `gh pr merge`, `gh pr close`, `gh pr reopen`
- `gh pr comment`, `gh issue comment`
- `gh pr edit`, `gh issue edit`, `gh label create/edit/delete`
- `git push`, `git push --force`, `git merge`, `git rebase` against any pushed branch
- Anything that writes to GH state, period.

If a skill thinks it needs to post, the answer is always: draft locally, surface via `channel_reply`, let the user post.

## Output via channel_reply

All output goes through the `channel_reply` MCP tool. Do not use `Write` to put files anywhere — the tool handles paths, slug normalization, audit headers, and cmux mirroring.

Action types:

| action_type | Purpose | Side effects |
|---|---|---|
| `triage` | New-PR triage summary | Writes `<drafts_dir>/<repo-slug>-<n>-triage.md`; cmux status "draft ready" |
| `review_draft` | Review-prep notes | Writes `<drafts_dir>/<repo-slug>-<n>-review_draft.md`; cmux status |
| `comment_draft` | Drafted reply to a comment | Writes `<drafts_dir>/<repo-slug>-<n>-comment_draft.md`; cmux status |
| `flagged` | Trigger gate failed, or skill is bailing out on size/risk | cmux set-status (red) + cmux log warn; no file |
| `notify` | High-priority surface that needs a banner | cmux notify (use sparingly) |
| `status` | Transient progress / "done" without a draft | cmux set-status only |

Required args by action:

- `triage` / `review_draft` / `comment_draft`: `text`, `repo`, `number`, `delivery_id`
- `flagged`: `text`, `delivery_id` (text is the reason)
- `notify`: `text`, optional `notify_title`
- `status`: `text`, optional `status_key`, `status_icon`, `status_color`

Example: drafting a triage summary

```ts
channel_reply({
  action_type: "triage",
  repo: "kinelo/kinelo",
  number: 4321,
  delivery_id: meta.delivery_id,
  text: "# PR triage: kinelo/kinelo#4321\n\n..."
})
```

Example: bailing out because the diff is too large

```ts
channel_reply({
  action_type: "flagged",
  delivery_id: meta.delivery_id,
  text: "kinelo/kinelo#4321: diff is 4200 lines / 87 files — needs manual triage"
})
```

## Idempotency

The server may replay the same `delivery_id` on SessionStart drain or via the `/replay` endpoint. Skills should be safe to run more than once for the same event:

- Drafts are written by `channel_reply` with the same filename for the same `(repo, number, action_type)` — replays will overwrite, which is fine. The audit header records the new timestamp; older history is in git/backups if the user kept any.
- Do not append to external state (no Linear ticket creation, no Slack post, no second todo.md line) without checking whether the prior run already did it.
- For `pr-merge-followup` specifically: before adding lines to `todo.md`, grep the file for the PR number — if there are already todos referencing it, treat the event as already-handled and `channel_reply` with `action_type=status` (`"already processed"`) instead of duplicating.

## Cost discipline

The watcher session is long-lived and accumulates context. Don't burn tokens on speculative fetches.

- Read `meta` first. Decide what you actually need before any `gh` call.
- Bail early on size. If `gh pr view --json additions,deletions,changedFiles` shows `additions + deletions > 1000` OR `changedFiles > 30`: do NOT fetch the full diff. Flag and stop.
- Bail early on security-adjacent files. If `gh pr view --json files` returns paths matching `auth`, `permission`, `rls`, `credentials`, `secret`, or `.env`: flag, write a one-line note, and stop. The user does the actual review.
- Cache fetched data to `/tmp/gh-channel-<skill>-<repo-slug>-<n>/` if multiple steps in the same skill need it. Do not refetch.
- One handler invocation = one event = one draft (or one flag). Don't pipeline.

## What "done" means

A handler skill is done when it has either:

1. Written exactly one draft via `channel_reply` and called `status` (or let the draft action's auto-status stand), OR
2. Called `flagged` with a reason and stopped.

Done explicitly means:

- No follow-on skill invocation. Do not chain into another handler from inside a handler.
- No additional `gh` calls after the draft is written.
- No "let me also check…" — the user reviews the draft and drives next steps.
- No posting anywhere except the local drafts dir and cmux sidebar (both via `channel_reply`).

The next event is the next event. Each handler invocation is independent.
