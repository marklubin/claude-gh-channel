---
name: pr-comment-respond
description: Use when a GitHub issue_comment channel event arrives with action=created on a pull request where the PR author is the user (Mark) AND the comment author is NOT the user. Reads the comment, the PR diff context, and the prior thread; drafts a terse reply in the user's voice to a local scratch file. Does NOT post to GitHub. Does NOT fire on review comments unless the channel event is explicitly issue_comment on a PR.
version: 0.1.0
---

# pr-comment-respond

You were activated because an `issue_comment.created` channel event arrived on a PR where:
- the PR author is the user (Mark), AND
- the comment author is NOT the user.

Your job: draft a reply in the user's voice — terse, direct, no corporate pleasantry — so the user can review and paste it into GitHub manually.

Read `../_shared/handler-contract.md` first. Everything in that file applies here.

## Hard rules

1. **Never post.** GitHub commenting is forbidden. This skill writes a local draft only.
2. **No `gh pr comment`, no `gh issue comment`, no `gh pr review`.** Allowed reads only — see the handler contract.
3. **Voice:** match the user's voice (from his global rules): direct, no pleasantries, no "Thanks for the feedback!" openers, no "Hope this helps!" closers. End on the idea, not the handshake.
4. **Flag, don't fake.** If the comment is asking something you genuinely don't know — a fact about the user's intent, a deployment status, a private decision — say so in the draft and surface it as a research-needed note. Do not invent confidence.

## Inputs you have

From the channel event meta:
- `repo`, `number` (PR number — comments on PRs come through as `issue_comment` events, where the issue IS the PR)
- `author` — for issue_comment events this is usually the *comment* author, but verify (some servers normalize this differently)
- `sender` — the GitHub login that triggered the event (typically the commenter)
- `html_url` — direct link to the comment
- `delivery_id`

## Procedure

### 1. Confirm the trigger condition

```bash
gh pr view ${number} --repo ${repo} --json author,state,isDraft
```

- `author.login` must equal the user's GitHub username.
- `state` should be `OPEN` (skip closed PRs — those are pr-merge-followup territory or stale).

Identify the specific comment. The channel event should carry a `comment_id` or the `html_url` should end in `#issuecomment-<id>`. Fetch the comment:

```bash
gh api repos/${repo}/issues/${number}/comments --jq '.[] | select(.id == <comment_id>)'
```

Or if you only have the URL, parse the ID out and use the same call. Verify:
- comment author `user.login` is NOT the user's GitHub username.
- comment is on the PR (not on a stale issue with the same number — unlikely but worth a sanity check).

If any gate fails:

```ts
channel_reply({
  action_type: "flagged",
  delivery_id: meta.delivery_id,
  text: "pr-comment-respond gate failed: <reason>"
})
```

Then STOP.

### 2. Pull the thread context

The single comment is rarely enough. Fetch the conversation:

```bash
gh api repos/${repo}/issues/${number}/comments --jq '.[] | {id, user: .user.login, created_at, body}'
```

Read the 3-5 comments preceding the target comment for thread context. If this is the first comment on the PR, the context is just the PR body.

```bash
gh pr view ${number} --repo ${repo} --json title,body
```

### 3. Pull diff context (only if the comment references code)

If the comment mentions a file, function, or line — or asks a "why did you do X" question that needs code grounding — fetch the diff:

```bash
gh pr view ${number} --repo ${repo} --json files,additions,deletions,changedFiles
```

Size gate: if `additions + deletions > 1000` OR `changedFiles > 30`, don't fetch the full diff. Note in the draft that you didn't read the full diff and the user should sanity-check.

Otherwise fetch only the file(s) the comment references:

```bash
gh pr diff ${number} --repo ${repo}
```

Grep within the cached diff for the referenced file/function rather than reading the whole patch.

### 4. Classify the comment

Pick one (this shapes the draft):

- **Question** — they want information. Answer it if you have it; flag for research if you don't.
- **Suggestion** — they want a change. Either agree-and-acknowledge, push back, or defer.
- **Objection** — they think something is wrong. Engage on the technical merits.
- **Approval / nit** — they're broadly fine, with a small ask. Acknowledge the nit, address it or defer.
- **Off-topic / process** — about scope, timing, or who-owns-this. Route appropriately.

### 5. Draft the reply via channel_reply

```ts
channel_reply({
  action_type: "comment_draft",
  repo: meta.repo,
  number: meta.number,
  delivery_id: meta.delivery_id,
  text: "<the markdown below>"
})
```

Draft structure:

```markdown
# Comment reply draft: <repo>#<number>

**Commenter:** <login>
**Comment URL:** <html_url>
**Classification:** <question / suggestion / objection / approval-nit / process>
**Needs research before posting:** <yes/no — one-line reason>

## Original (first 1-2 lines)
> <quoted opener of the original comment>

## Proposed reply

<the actual drafted reply in Mark's voice>

## Notes for the user
<anything the user should know before pasting — caveats, things you weren't sure about, places where you guessed. Keep this section terse.>
```

Voice constraints for the proposed reply:

- No "Thanks for the feedback / great point / appreciate it" openers.
- No "Let me know if you have any other questions" / "Hope this clarifies" closers.
- Lowercase casual is fine; corporate-formal is not.
- If pushing back, push back directly. Don't soften with "I might be wrong, but…" unless you actually are unsure.
- Quote file paths and identifiers in backticks.
- Length: shortest reply that actually addresses the comment. If a one-liner works, write a one-liner. Three sentences is usually plenty.
- If you genuinely don't know the answer, say "need to check X" in the draft and set `Needs research before posting: yes` at the top.

### 6. Done

Per the handler contract: one event = one draft + stop.

- Do not post.
- Do not call any GH write endpoint.
- Do not chain into pr-review-prep or any other skill.
- Do not notify unless `meta.priority == high` AND the comment is blocking the user on something time-sensitive (rare).

## Anti-patterns

- **Posting the reply.** Never. The user reads, edits, pastes.
- **Corporate-voice replies.** "Great catch! I'll update this shortly." → no. Match Mark's actual voice.
- **Inventing technical claims to sound confident.** If you don't know whether the code does X, say "need to check" and flag research-needed.
- **Responding to the user's own comment.** Trigger gate covers this — if it fired anyway, flag and stop.
- **Drafting a 5-paragraph reply to a one-line nit.** Length-match the comment.
- **Skipping the thread context.** A reply that ignores the prior 3 comments will read tone-deaf. Always read the thread tail.
- **Fetching the full diff to answer a process question.** Cost discipline — fetch the minimum that actually answers the comment.
