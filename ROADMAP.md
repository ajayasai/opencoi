# Roadmap

This roadmap states direction, not delivery dates or a guarantee. The issue
tracker and release notes are the source of truth for shipped behavior. Scope
may change after usability, security, and domain review.

## v0.1: useful document tracking

The first public release is intended to make a complete small-team workflow
usable without a commercial COI platform:

- vendor and contractor directory, including vendor types;
- configurable required coverages and limits by vendor type;
- PDF upload with safe type and size handling;
- OCR-assisted extraction of insurer, policy number, coverage dates, and
  limits;
- a human confirmation step with the original proposal preserved;
- deterministic warnings for missing coverage or endorsement evidence,
  inadequate limits, and expiration;
- renewal reminders and reminder history;
- scoped, expiring self-service upload links;
- an exception request and approval trail that does not erase the underlying
  deficiency; and
- portable compliance-status export with safe spreadsheet handling.

Every result should use bounded language and show that it is based on a
document, configured requirements, and an evaluation date.

## v0.x: hardening and operational maturity

Priorities after the first usable release include:

- field-level extraction provenance and document-page evidence;
- immutable certificate revisions, requirement versions, and evaluation
  snapshots;
- project, location, or contract-specific requirement assignments;
- stronger role separation for reviewers, exception approvers, and auditors;
- append-only business audit history and retention controls;
- upload quarantine, parser resource limits, malware scanning hooks, and inert
  document previews;
- idempotent reminder delivery, bounce handling, and configurable escalation;
- documented backup, restore, deletion, and upgrade procedures;
- accessibility testing, localization foundations, and timezone-safe dates;
- a stable, typed rule specification and documented export schema; and
- performance and tenant-isolation test suites for larger deployments.

Security requirements are not deferred merely because they appear in this
section. A deployment exposed to untrusted files or multiple organizations must
meet the applicable controls in [the threat model](docs/THREAT_MODEL.md).

## Later, with evidence and community demand

Potential directions include:

- pluggable local and explicitly opted-in cloud extraction providers;
- requirement import from contracts with source citations and mandatory human
  confirmation;
- integrations through a documented API and event model;
- custom coverage vocabularies and safe rule-extension packages;
- stronger audit integrity, signed exports, and reproducible decision bundles;
- reusable, independently designed synthetic fixture packs; and
- insurer or broker data adapters only where licensing, consent, provenance,
  failure semantics, and security boundaries are clear.

An external policy-data adapter would be an additional evidence source. It must
not cause a PDF-only assessment to be relabeled as live policy verification.

## Explicitly outside the initial release

- real-time insurer, carrier, broker, or agency-management-system monitoring;
- a proprietary broker or carrier network;
- automatic approval of unconfirmed OCR or ambiguous endorsement language;
- insurance, legal, underwriting, or claims advice;
- a guarantee that a policy is active, sufficient, enforceable, or will pay a
  claim;
- reproducing or redistributing third-party certificate forms, logos, or
  proprietary application designs; and
- claims of universal superiority over commercial products.

## How priorities are chosen

Maintainers weigh safety, clarity of the document-assessment boundary, user
impact, evidence from real workflows, interoperability, maintenance cost, and
community capacity. A feature that increases automation but makes a decision
harder to explain or review will require a particularly strong design case.
