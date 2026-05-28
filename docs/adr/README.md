# Architecture Decision Records

Lightweight ADR process for `claude-gh-channel`. The goal is to have an anchor for substantive architectural decisions so issues, PRs, and future-us all build against a stable framing instead of re-deriving the design in chat each session.

## When to write an ADR

Write one when a change is **directional, not tactical** — i.e. it affects:

- The shape of a contract that multiple downstream pieces will bind to (event models, config schemas, public APIs, plugin manifests).
- Trust or security boundaries (auth model, isolation, scope of `--dangerously-skip-permissions`).
- A choice that's expensive to reverse later (data format, persistent on-disk layout, naming conventions).
- A path that closes off other paths (e.g. "we use cmux primitives, not a cmux extension" — that's a foreclosure worth recording).

Don't write one for:

- Single-file refactors with no external surface change.
- Pure implementation choices that can be swapped without touching callers (which sort algorithm, which yaml library).
- Bug fixes.
- Docs.

When in doubt: if you'd want to read it in 6 months to remember *why* something is the way it is, write the ADR.

## Where they live

```
docs/adr/
├── README.md                      ← this file (process)
├── 0001-system-architecture.md
├── 0002-...
└── template.md                    ← copy when starting a new one
```

## Naming

`NNNN-short-kebab-title.md`, four-digit zero-padded, monotonically increasing. The number is permanent — even rejected and superseded ADRs keep their number (they're the historical record).

## Lifecycle

```
Draft  →  Proposed  →  Accepted  →  Superseded (by NNNN)
                   ↘  Rejected
```

- **Draft** — being written; not yet open for review.
- **Proposed** — ready for review; ideally on a branch with the PR open for discussion.
- **Accepted** — merged to `main`. The decision is in effect.
- **Rejected** — closed without merging, with a brief rejection note in the ADR itself for posterity.
- **Superseded by NNNN** — an Accepted ADR that's been replaced by a later one. The old one isn't deleted; it stays as the historical record. The new ADR explicitly references which it supersedes.

For a personal-use repo this is mostly a self-discipline ritual — but writing it down forces the thinking and leaves a trail.

## Template

```markdown
# ADR-NNNN: <title>

**Status:** Draft | Proposed | Accepted | Rejected | Superseded by ADR-MMMM
**Date:** YYYY-MM-DD
**Supersedes:** (none) | ADR-NNNN
**Related issues:** #N, #N

## Context

What is the situation we're addressing? What forces are in play (constraints, requirements, observed pain, opportunities)? Be concrete — point at code, issues, real incidents. Avoid abstract framing.

## Decision

What are we deciding to do? State it plainly. If the decision has multiple parts, list them.

## Consequences

What becomes possible? What costs do we pay? What does this close off? Be honest about the negatives — that's the value of writing this down.

## Alternatives considered

The serious alternatives we looked at, and why we didn't pick them. One short paragraph each. This is where future-us learns "we already thought about that, here's why not."

## Open follow-ups

Decisions deferred to future ADRs, or implementation items tracked as issues. Reference them.

## Notes

Anything else — links, transcripts, prior discussions worth preserving.
```

(There's a copy at `template.md` ready to duplicate.)

## How ADRs relate to issues + PRs

- **ADRs frame the why and the shape.** They don't track work — issues do.
- **Issues track the work.** Each issue references the ADR(s) that frame it.
- **PRs implement.** A PR may reference both an issue (what's being shipped) and an ADR (what shape it's being shipped in).
- If a PR ends up *changing* the shape an ADR established, the ADR gets an amendment or a successor — not the PR silently drifting from the recorded decision.

## Review

For a single-maintainer repo, "review" of an ADR is mostly the act of writing it (forces the thinking) + a brief sit-with-it pause before flipping Draft → Proposed → Accepted. If/when there are collaborators, the PR introducing the ADR is the review surface; merge = Accepted.

## What ADRs are not

- They're not Linear tickets. (Issues are.)
- They're not RFCs. (RFCs propose; ADRs *record*. An ADR can summarize the outcome of an RFC-style discussion, but the ADR itself is shorter and is the artifact that lives long-term.)
- They're not design docs. (Design docs can exist in `docs/design/` and be referenced from an ADR. ADRs are short, decision-focused.)
