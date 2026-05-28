# ADR-0002: Development process — ADR-driven design, milestone-grouped PRs, design-vs-code review separation

**Status:** Proposed
**Date:** 2026-05-27
**Supersedes:** (none)
**Related issues:** #10 (epic — first workstream this process is applied to)

## Context

The conversational sessions that produced ADR-0001 and the existing issue backlog (#10–#19) made one thing obvious: without a written-down process, every session re-derives the framework from scratch — what an ADR is, when to write one, where design discussion lives vs implementation discussion, how PRs map to issues, what the right PR-sizing is. That re-derivation is expensive and inconsistent.

There are also two structural pains from the typical "open a PR, get review, merge" model that surfaced explicitly in that conversation:

1. **PRs are the wrong surface for design review.** Diffs are good for "does this implement the agreed shape correctly" but bad for "is this the right shape." Forcing both through the PR review surface conflates the two and is the primary reason PRs feel slow for substantive work.

2. **PR granularity matters.** A PR per commit creates churn; a PR per "all of v2" is unreviewable. The right granularity is a **functional milestone** — a coherent unit that can be evaluated as a thing.

ADR-0001 was written without this process being formally defined. That's tolerable as a one-time bootstrap — the process being formalized now is the one we already started using. This ADR makes it explicit so future contributors (including future-us) don't have to reconstruct it.

## Decision

Adopt a three-layer development chain with explicit separation of review surfaces:

### The chain: ADR → issue → PR

- **ADR (`docs/adr/NNNN-*.md`)** — frames a directional decision: the *why* and the shape. Lives in `docs/adr/` per the process doc at `docs/adr/README.md`. Written when a change is directional, not tactical (see that doc for the full gate). The ADR is the *durable artifact* of design — it survives long after the conversation that produced it.

- **Issue (`gh issue`)** — tracks a single functional milestone of work that implements (some part of) an ADR's decision. Each issue is a coherent shipping unit: complete-enough to be reviewed, ship-able, and evaluated on its own. Issues reference the ADR(s) they implement.

- **PR (`gh pr`)** — implements an issue. The *default* is **one PR per issue**, opened only when the issue is functionally complete (or split if the issue is large enough to warrant sub-milestones — see PR sizing below). The PR description writes itself: "implements #N." References both the issue and (transitively) the ADR.

### Separation of review surfaces

Design review and code review are different problems with different right answers, and conflating them is the primary source of perceived PR slowness:

| Review kind | Question being answered | Surface | Outcome |
|---|---|---|---|
| **Design review** | Is this the right shape? | ADR comments, issue threads, live docs (HackMD/Notion/etc.), GitHub Discussions | Updated ADR + agreement |
| **Code review** | Does this correctly implement the agreed shape? | PR | Merge or revisions |

The expectation: **by the time a PR opens, the design is settled** (in an ADR or — for smaller-than-ADR work — in an issue thread). The PR review is then narrowly "does this implement what we agreed?" That makes PR review fast in a way that design-review-inside-PR never can be.

For solo + occasional-collaborator work (this repo's current state), "design review" can be self-review during ADR-writing + a brief sit-with-it pause. When real collaborators arrive, design review moves into issue threads / live docs / GitHub Discussions — *not* into long PR threads.

### PR sizing convention

The default scope for a PR is **one functional milestone**, typically matching one issue:

- **Wait until the issue is functionally complete** before opening the PR. Don't open a WIP PR for partial progress, except as a "checkpoint discussion" PR that's explicitly marked draft and not intended to merge.
- **Don't open a PR per commit.** A PR is a unit of *review and merge*, not a unit of *work-in-progress visibility*. Local commits within a PR are author-shaped (intermediate state, scratch, etc.); the PR is what reviewers see.
- **Refactor escape hatch:** if an issue's implementation requires a non-trivial refactor that's mechanically separable from the behavior change, split it into "mechanical refactor first" + "behavior change second" PRs against the same issue. Sometimes splitting *reduces* review burden even if it grows PR count.
- **Long-running spec work** (e.g. issue #11 canonical events): split into natural sub-milestones within the issue — "type + adapter contract," then "GH webhook migrated onto it," then "GH poll using it." Each is a milestone within the issue, not its own issue.
- **Out-of-band exceptions:** single-line typo fixes, docs touch-ups, dependency bumps, urgent rollbacks. These don't need an issue and don't need to wait for milestone framing.

The escape hatches are real, but the **default** is one issue = one PR, opened when functionally complete.

### Where each kind of discussion lives

- **"Is this the right approach?"** → ADR (or its draft / its associated issue comments before it's written)
- **"What's the plan to implement decision X?"** → issue tied to the ADR
- **"Why doesn't this code do Y?"** / **"What did you mean here?"** → PR review comments
- **"Should we even do this?"** / open-ended exploration → GitHub Discussions, or a draft ADR (better — forces the thinking)
- **"How do I get started with this repo?"** / "How do I run X?" → README / docs
- **"How does the developer here build/review/ship?"** → CLAUDE.md (contributor guide) and this ADR

`FOLLOWUPS.md` predates this process and is functionally an issue tracker living in a markdown file. It should migrate to issues with the `onboarding` label so triage and discussion happen in one place. Not blocking but worth doing when the next pass of onboarding work starts.

## Consequences

**Enabling (the upside):**

- PR cycle time drops because design isn't being re-litigated inside the PR.
- New contributors (and future-us) have a discoverable entry point: read the ADRs, pick an issue, ship a PR — without needing to reverse-engineer the project's mental model.
- The "why" of past decisions stays accessible long after the chat session that produced them is forgotten. ADRs are the institutional memory.
- Issue triage is meaningful: each issue is a real milestone, not a TODO note disguised as an issue.

**Costs (the downside, honestly):**

- Writing an ADR is real overhead — wasted if applied to small decisions that didn't need one. Mitigated by the gates in `docs/adr/README.md` ("when to write an ADR") and the principle "if in doubt, prefer a short ADR over no ADR."
- The "open the PR when the issue is complete" rule trades visibility-during-work for unit-of-review clarity. Solo work absorbs this fine; teams with strong "watch each other's WIP" culture may want sub-milestone draft PRs.
- This is a process tax on small repos. For a personal-use plugin like `claude-gh-channel`, the tax may feel high relative to the work — but the alternative (re-deriving the framework each session, as observed pre-process) is also a tax, just less visible.

**Foreclosed:**

- Opening a PR as the *first* artifact for substantive design work. From now on, ADR or issue comes first.
- "WIP PRs" as the primary way to get feedback on direction. Direction feedback belongs in the design surface, not the PR.
- Implicit conventions. If a convention isn't written down (here, in CLAUDE.md, or in `docs/adr/README.md`), it doesn't exist — verbal conventions don't survive context resets.

## Alternatives considered

**A. Pure ad-hoc PRs, no issues, no ADRs.** What this repo did before. Fast for solo work, breaks down the moment collaborators arrive or a session ends and the next one starts cold. Already empirically a problem: every session re-derives the framework.

**B. Heavy RFC process (Rust/IETF-style).** Pre-design RFC with formal review, decision phase, then implementation tracked separately. Better rigor than ADRs but far too much ceremony for a personal-use repo. ADRs are the lightweight cousin.

**C. Trunk-based with post-merge review only.** Push to main, async post-merge comments for anything substantive. Works in some shops with strong test/CI culture and tight feedback loops. Loses the design-review-before-code value that's the whole point of separating review surfaces. Wrong fit for our current shape.

**D. Tiny atomic PRs (per-commit).** Each commit is its own PR. Easy individual reviews but high per-PR overhead and lots of context-switching for the reviewer. Doesn't compose to functional milestones cleanly.

**E. One huge PR per "release."** All of a milestone (or larger) in one PR. Hard to review, easy to drop pieces. Already empirically known not to work.

## Open follow-ups

- **Migrate `FOLLOWUPS.md` to issues** with the `onboarding` label so triage lives in one place. Not blocking; do it when the next onboarding pass starts.
- **Tooling for ADR ↔ issue ↔ PR cross-linking** (e.g. a script that ensures every PR references an issue, every issue references an ADR or marks itself "no ADR needed"). Nice-to-have, not required for v1 of the process.
- **Re-evaluate after 5-10 ADRs and 20-30 issues.** If the process is actually slowing things down or producing artifacts no one reads, revise. ADRs are not sacred — superseding one with a process change is fine.
- **Collaborator-mode review semantics.** When/if this repo gets actual second-pair-of-eyes review, the "merge = Accepted" assumption for ADRs needs revisiting. Probably the right model: collaborator review of the ADR-introducing PR is the review surface. Defer until we have a collaborator.

## Notes

- This ADR emerged from chat session 2026-05-27 (the same session that produced ADR-0001). The conversation explicitly observed that PR-slowness comes from doing design review inside the PR surface, and the right fix is to separate the surfaces — formalized here.
- ADR-0001 was written *before* this process was formalized, but in retrospect followed it exactly. That's the test that says this ADR is describing the right process: it matches what someone deliberately doing the right thing already did.
- This ADR is process-foundational in the sense that everything downstream development of this repo binds to it. ADR-0001 is architecture-foundational in the parallel sense for *what* gets built. Together they're the two roots of the project's institutional memory.
