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

## v0.2: evidence and interoperability (shipped)

- page-aware field and endorsement proposal provenance with original-PDF links;
- a public vendor-neutral synthetic text benchmark, scorer, citations, failure cases, and CI;
- optional tenant-bound OpenID Connect with a local break-glass path;
- scoped service accounts, versioned API, OpenAPI description, ordered events, and durable signed webhooks;
- constant-query vendor summaries and a published hardware-labelled 10k-vendor workload;
- tested keyboard/form interaction contracts and accessibility documentation; and
- a preregistered privacy-safe usability study kit with no fabricated participant results.

## v0.3: verifiable collection and decisions (shipped)

- tracked initial and renewal certificate requests with exact invitation-to-submission lineage, cancellation, manual sharing, and optional bounded SMTP delivery;
- a public, versioned evidence-bundle schema with organization-specific Ed25519 signatures, source-PDF digests, and a strict offline verifier;
- mandatory exception separation of duties: a requester cannot approve their own exception;
- unambiguous local sign-in when the same email belongs to multiple workspaces; and
- safer outbound-worker leasing so concurrent or stale webhook workers cannot overwrite another worker's result.

## v0.x: remaining hardening and operational maturity

Priorities after the first usable release include:

- immutable certificate revisions, requirement versions, and evaluation
  snapshots;
- project, location, or contract-specific requirement assignments;
- stronger role separation for reviewers, exception approvers, and auditors;
- append-only business audit history and retention controls;
- upload quarantine, parser resource limits, malware scanning hooks, and inert
  document previews;
- idempotent reminder delivery, bounce handling, and configurable escalation;
- documented backup, restore, deletion, and upgrade procedures;
- browser/assistive-technology accessibility testing, localization foundations, and timezone-safe dates;
- a stable, typed rule specification and broader machine-to-machine export coverage; and
- concurrent-write, storage-volume, failover, and tenant-isolation test suites for larger deployments.

Security requirements are not deferred merely because they appear in this
section. A deployment exposed to untrusted files or multiple organizations must
meet the applicable controls in [the threat model](docs/THREAT_MODEL.md).

## Later, with evidence and community demand

Potential directions include:

- pluggable local and explicitly opted-in cloud extraction providers;
- requirement import from contracts with source citations and mandatory human
  confirmation;
- packaged integrations built on the documented API and event model;
- custom coverage vocabularies and safe rule-extension packages;
- independently witnessed or transparency-log-backed signing-key publication and rotation;
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
