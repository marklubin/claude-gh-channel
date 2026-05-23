---
name: pr-review-prep
description: Use when a GitHub pull_request channel event arrives with action=review_requested AND the requested reviewer is the user (Mark). Reads the PR diff via `gh`, drafts review notes locally, surfaces 2-3 key questions to a scratch file. Does NOT post the review.
version: 0.1.0
---

# pr-review-prep

You were activated because a `pull_request` channel event arrived with `action=review_requested` AND the requested reviewer is the user. Your job: prepare review material so the user walks into the actual review with context already loaded.

## Hard rules

1. **Do not post.** This skill drafts only. The user reviews and posts manually (or via a future `pr-review-post` skill).
2. **Do not approve, request changes, merge, or push.** Read-only on GitHub.
3. **Local scratch only.** Write your draft to `~/.config/claude-gh-channel/drafts/<repo-slug>-<pr-number>-review-prep.md`. Never to the PR itself.
4. If anything is unclear or risky (security-adjacent diff, migration files, very large diff > 1000 lines), surface a `cmux set-status` flag with the concern and STOP — don't draft a half-baked review.

## Inputs you have

From the channel event meta:
- `repo` (e.g. `kinelo/kinelo`)
- `number` (PR number)
- `html_url`
- `author` (PR author, not the reviewer)
- `title`

From the event payload (already in your context as the channel notification body): the PR title and basic shape.

## Procedure

### 1. Confirm the trigger condition

Check that the event payload actually has the user as a requested reviewer. The simplest gate:

```bash
gh api repos/${repo}/pulls/${number} --jq '.requested_reviewers[].login'
```

If the user's GitHub login is NOT in that list, abort — this skill was activated incorrectly. Log via `cmux log --level warn --source claude "pr-review-prep activated but user is not requested reviewer on ${repo}#${number}"` and stop.

### 2. Fetch the diff + PR description

```bash
gh pr view ${number} --repo ${repo} --json title,body,additions,deletions,changedFiles,author,baseRefName,headRefName,files
gh pr diff ${number} --repo ${repo}
```

Cache both to `/tmp/pr-prep-${repo-slug}-${number}/{meta.json,diff.patch}`.

### 3. Scan for risk signals

Walk the file list. Flag (don't block, but call out in the draft):

- **Migrations** (`*/migrations/*.sql`, `*/db/migrations/*`)
- **Security-adjacent files** (`*auth*`, `*permission*`, `*rls*`, `*credentials*`, `*secret*`, anything matching `**/.env*`)
- **Large surface** (changedFiles > 30 OR additions + deletions > 1000)
- **Unfamiliar areas** — directories the author doesn't usually touch (best-effort; skip if you can't tell)
- **No tests** when source code changed (no `*.test.*` / `*.spec.*` / `tests/` in the diff)

### 4. Draft the review-prep file

Write to `~/.config/claude-gh-channel/drafts/<repo-slug>-<pr-number>-review-prep.md` with this structure:

```markdown
# PR review prep: <repo>#<number>

**Title:** <title>
**Author:** <author>
**Branch:** <head> → <base>
**Size:** +<additions> / −<deletions> across <changedFiles> files
**URL:** <html_url>
**Drafted:** <ISO timestamp>

## What this PR claims to do
<2-3 sentence summary based on PR description + diff overview>

## Risk flags
<bulleted list from step 3, or "none flagged">

## Key questions to ask
<2-3 specific questions, each grounded in a file:line reference from the diff>

1. **<question>** — see `<file>:<line>` <one-sentence rationale>
2. **<question>** — see `<file>:<line>` ...
3. ...

## Suggested review path
<bulleted order to read files in, longest/highest-risk first>

## Decision-deferred notes
<things you noticed but aren't asking about — context for the user, e.g. "uses lodash.merge here; rest of repo uses ramda — minor inconsistency">
```

### 5. Surface the draft to cmux sidebar

```bash
cmux set-status pr-review-prep "ready: <repo>#<number>" --icon "checkmark.bubble" --color "#22cc88"
cmux log --level info --source claude "PR review prep drafted to ~/.config/claude-gh-channel/drafts/<repo-slug>-<pr-number>-review-prep.md"
```

If the diff was too large or had hard blockers:
```bash
cmux set-status pr-review-prep "blocked: <repo>#<number> — <one-line reason>" --icon "exclamationmark.triangle" --color "#dc2626"
```

### 6. Done

Do not chain into another skill. Do not post anything. Wait for the next channel event or the user's next instruction.

## Anti-patterns to avoid

- **Drafting a "summary that reads like a review"** — questions only. The user does the reviewing.
- **Posting the draft anywhere except the local scratch file.** Not GH, not Slack, not Linear.
- **Inventing concerns to fill the "key questions" section.** If you only have one real question, write one. Three is a ceiling, not a quota.
- **Ignoring the requested-reviewer gate.** If the user isn't tagged, this skill should not run, even if the event arrived.
- **Treating large diffs as "more important to draft fully."** Large diffs are MORE likely to deserve a status flag + manual triage, not a longer auto-draft.

## Future siblings (not in this skill)

- `pr-review-post` — takes a drafted prep file + user confirmation, posts the review via `gh pr review`.
- `pr-comment-respond` — drafts replies to comments on the user's PRs.
- `pr-merge-followup` — checks the user's merged PRs for follow-up tasks referenced in the description.
