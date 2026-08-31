# Usability results

**Status: no participant results collected or published.**

The repository currently contains a preregistered protocol, collection schema, deterministic
analyzer, privacy regression tests, and a synthetic fixture. The synthetic fixture is test data; it
is not evidence about OpenCOI users or workflows.

Do not replace this status until all publication checks below are satisfied.

## Publication checklist

- [ ] The protocol and any pre-session amendments were public before affected sessions.
- [ ] The exact tested product commit and synthetic fixture pack are recorded.
- [ ] Consent and local legal/privacy/ethics review are documented outside the repository.
- [ ] Role minimums and accessibility quotas are met, or shortfalls are reported.
- [ ] Every frozen role-by-task cell has at least five unique participants; missing or stopped tasks
      remain visible rather than being silently dropped.
- [ ] Valid, excluded, stopped, and withdrawn session counts are reported with fixed reasons.
- [ ] The strict analyzer accepts the reviewed private CSV without schema exceptions.
- [ ] Only analyzer-generated aggregates are published; row-level participant data is not committed.
- [ ] Every cell below five participants is suppressed.
- [ ] Noncompletion, assistance, critical incidents, protocol deviations, and unresolved blockers are
      reported prominently.
- [ ] Scope comprehension uses one answer per unique participant, and its Wilson interval is included.
- [ ] Allocated role-by-task completion, intervals, median/mean confidence, errors, critical
      incidents, fixed issue counts, and accessibility-mode cohorts are included.
- [ ] Moderation notes, consent, recordings, recruitment records, and identity mappings remain out
      of Git and follow the approved retention/deletion policy.
- [ ] Claims are limited to this build, sample, tasks, and environment.
- [ ] No claim of accessibility conformance, accuracy, time savings, insurer connectivity,
      production outcomes, or universal/comparative superiority is inferred.

## Required result package

When evidence exists, create a versioned subdirectory containing:

- analyzer-generated JSON and Markdown from the same reviewed input;
- the exact protocol and product commit identifiers;
- aggregate sample/exclusion/deviation accounting;
- device, browser, and assistive-technology categories at publishable cell sizes;
- a limitations and unresolved-findings section; and
- hashes of the private input and synthetic product fixture manifest, not the private files.

Reviewers should be able to reproduce every published number from the authorized private input and
the public analyzer. They should not need access to a participant's identity or document content.
