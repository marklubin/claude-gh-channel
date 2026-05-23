---
name: pr-triage
description: Use when a GitHub pull_request channel event arrives with action=opened AND the PR author is the user (Mark) in a repo the user maintains. Reads the diff via `gh`, flags risks (migrations, security-adjacent files, large surface), suggests labels, and drafts a short triage summary. Does NOT fire on review_requested (that's pr-review-prep) or on PRs authored by other people. Does NOT post.
version: 0.1.0
---

# pr-triage

You were activated because a `pull_request` channel event arrived with `action=opened` AND the PR author is the user. Your job: produce a short triage summary so the user sees risks/labels/todo-worthiness at a glance, before anyone else gets to the PR.

Read `../_shared/handler-contract.md` first. Everything in that file applies here.

## Hard rules

1. **Do not post.** This skill drafts only. Output goes to the local drafts dir via `channel_reply`.
2. **Do not approve, request changes, merge, push, or label the PR on GitHub.** Suggestions go in the draft for the user to apply manually.
3. **Read-only on GitHub.** Allowed `gh` commands are listed in the handler contract.
4. If the diff is > 1000 lines OR > 30 changed files OR contains security-adjacent paths: `channel_reply` action_type=flagged with a one-line reason, write a minimal stub draft (title + size + the flag), and STOP. Don't auto-draft a full triage on something that big.

## Inputs you have

From the channel event meta:
- `repo` (e.g. `kinelo/kinelo`)
- `number` (PR number — may also appear as `pr_number`)
- `html_url`
- `author` (PR author — should equal the user's github_username)
- `title`
- `delivery_id`

## Procedure

### 1. Confirm the trigger condition

Two gates, both must pass:

```bash
gh pr view ${number} --repo ${repo} --json author,state
```

- `author.login` must equal the user's GitHub username (`${user.github_username}` from the brief).
- `state` must be `OPEN`.

Also confirm the repo is one the user maintains. Cheap proxy: `gh api repos/${repo} --jq '.permissions.admin'` returns `true`, OR the repo owner equals the user's GitHub username, OR the repo is in the brief's maintained-repos list.

If any gate fails:

```ts
channel_reply({
  action_type: "flagged",
  delivery_id: meta.delivery_id,
  text: "pr-triage activated but trigger gate failed: <reason>"
})
```

Then STOP.

### 2. Fetch PR shape (cheap call first)

```bash
gh pr view ${number} --repo ${repo} --json title,body,additions,deletions,changedFiles,baseRefName,headRefName,files,labels
```

Cache to `/tmp/gh-channel-pr-triage-<repo-slug>-<n>/meta.json`.

Check the size gate before fetching the full diff:

- `additions + deletions > 1000` OR `changedFiles > 30` → size-bail (see step 5).
- Any file path matching `auth`, `permission`, `rls`, `credentials`, `secret`, `.env` → security-bail (see step 5).

### 3. Fetch the diff (only if size gate passed)

```bash
gh pr diff ${number} --repo ${repo}
```

Cache to `/tmp/gh-channel-pr-triage-<repo-slug>-<n>/diff.patch`.

### 4. Fetch existing repo labels

```bash
gh label list --repo ${repo} --json name,description --limit 200
```

You'll use this to suggest labels that actually exist in the repo — don't invent ones.

### 5. Scan the diff for risk signals

Walk the file list. Flag in the draft (and stop early if any tripped the bail thresholds above):

- **Migrations** — `*/migrations/*.sql`, `*/db/migrations/*`, `*/alembic/versions/*`
- **Security-adjacent** — `*auth*`, `*permission*`, `*rls*`, `*credentials*`, `*secret*`, `**/.env*`
- **Large surface** — `changedFiles > 30` OR `additions + deletions > 1000`
- **Config / infra** — `*.tf`, `Dockerfile`, `*.yml` under `.github/workflows`, `package.json` dep changes
- **No tests when source changed** — diff touches source files but no `*.test.*` / `*.spec.*` / `tests/`

### 6. Pick label suggestions

From the repo's existing labels, suggest 1-4 that match this PR's content. Common patterns:

- Touches `*/migrations/*` → `migration` or `db` if such a label exists
- Touches docs only (`*.md` only) → `docs`
- Touches CI config → `ci` or `infra`
- New feature directory → existing area labels (e.g. `area/api`, `area/web`)
- Bugfix wording in title/body → `bug`

If no good match exists in the label list, say so — do NOT invent labels.

### 7. Decide todo.md worthiness

Should this PR get a line in `~/command-center/todo.md`?

- **Yes** if: PR is non-trivial (>200 lines OR touches >5 files), AND it's not already represented (best-effort check via grep on the PR number).
- **Yes** if: PR is blocking on review or has a deadline implied in the description.
- **No** if: PR is a trivial dep bump, a docs-only fix, or a < 50-line refactor.

You will NOT modify todo.md from this skill — only suggest in the draft.

### 8. Draft the triage file via channel_reply

```ts
channel_reply({
  action_type: "triage",
  repo: meta.repo,
  number: meta.number,
  delivery_id: meta.delivery_id,
  text: "<the markdown below>"
})
```

Draft structure:

```markdown
# PR triage: <repo>#<number>

**Title:** <title>
**Author:** <author>
**Branch:** <head> → <base>
**Size:** +<additions> / −<deletions> across <changedFiles> files
**URL:** <html_url>

## Intent
<one paragraph distilled from the PR body — what this is trying to do and why. If body is empty, say so.>

## File / risk highlights
<bulleted list from step 5; include file paths. "none flagged" is a valid answer.>

## Suggested labels
<bulleted list from step 6, each label name in backticks. "none of the existing repo labels obviously fit" is valid.>

## Add to todo.md?
**<yes/no>** — <one-sentence reason>
<if yes, propose the exact line:>
- [ ] Land <repo>#<number>: <terse title> — [<project>] [<YYYY-MM-DD>]
```

### 9. Size-bail / security-bail variant

If you stopped early in step 2:

```ts
channel_reply({
  action_type: "flagged",
  delivery_id: meta.delivery_id,
  text: "<repo>#<number>: <size or security reason> — manual triage needed"
})
```

Then also write a minimal stub draft (title + size + the flag) via `channel_reply` action_type=triage so the user has something at the expected path. The stub should explicitly say "auto-triage skipped — see flag reason."

### 10. Done

Per the handler contract: one event = one draft (or one flag) + stop. Do not chain into pr-review-prep, do not pre-fetch reviewer assignments, do not post anywhere.

## Anti-patterns

- **Running on PRs the user didn't author.** That's a different skill (or a different policy decision). The author gate is non-negotiable.
- **Inventing labels that don't exist in the repo.** Only suggest from `gh label list`.
- **Drafting a code review.** Triage is about *what is this and is it risky*, not *is the implementation good*. Save the review for pr-review-prep (which fires on a different event anyway).
- **Auto-adding to todo.md.** This skill suggests; the user adds.
- **Fetching the full diff for a 4000-line PR.** Bail at the size gate. The user will look at it manually.
- **Confusing this with pr-review-prep.** This fires on `opened`; pr-review-prep fires on `review_requested`. Wrong event = trigger gate fails = flag + stop.
