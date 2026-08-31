# OpenCOI usability study kit

**Evidence status:** protocol and tooling published; no participant sessions or participant results
have been collected by this repository.

This directory makes formative usability work reproducible without pretending that a protocol is
evidence. The checked-in CSV is synthetic and exists only to verify the analyzer. It must never be
quoted as a usability result.

## Study registration

- Protocol: OpenCOI formative workflow study v1.1
- Registered: 2026-08-31
- Protocol baseline: the protocol files committed in the `v0.2.0` release tag
- Product build under test: record the exact full commit before recruitment and in every row
- Amendments: add a dated entry to the protocol before collecting affected sessions

The fixed questions, role-by-task allocation, outcomes, task-level stopping rule, exclusions, and analysis are in
[protocol.md](protocol.md). Study conduct is described in [moderator-guide.md](moderator-guide.md),
and [tasks.md](tasks.md) contains the synthetic scenarios.

## Files

- `protocol.md` — preregistered method and decision rules
- `moderator-guide.md` — neutral session script and incident handling
- `tasks.md` — role-specific tasks with success criteria
- `consent-template.md` — template requiring local legal/ethics review
- `data-dictionary.md` — the only accepted analysis columns and enumerations
- `session-template.csv` — blank, privacy-reviewed observation template
- `analysis.ts` — strict parser, privacy checks, small-cell suppression, and deterministic summaries
- `analysis.test.ts` — analyzer and privacy regression tests
- `fixtures/synthetic-observations.csv` — synthetic-only analyzer fixture
- `results/README.md` — authoritative result status and publication checklist

## Analyze a reviewed dataset

Use Node.js 24 and the repository's locked development dependencies:

```text
npx tsx research/usability/analysis.ts research/usability/fixtures/synthetic-observations.csv
npx tsx research/usability/analysis.ts research/usability/fixtures/synthetic-observations.csv --markdown
npx vitest run research/usability/analysis.test.ts
```

The analyzer accepts no names, email fields, notes, filenames, URLs, policy identifiers, or free
text. Participant IDs must be locally generated random pseudonyms. The session-level scope answer is
repeated consistently on each task row so the analyzer can validate the join, but it is counted only
once per participant. Output removes pseudonyms and suppresses any cohort with fewer than five
participants.

## Publication boundary

Only aggregate analyzer output that passes the publication checklist may enter `results/`.
Moderation notes, recordings, consent records, recruitment messages, and row-level participant data
remain in an approved private research location and follow the operator's retention policy.

This study cannot establish universal superiority, policy accuracy, insurer-side status, cost
savings, or production outcomes. A comparative claim requires a separate randomized protocol and
lawful access to the comparator.
