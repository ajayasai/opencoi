# Changelog

All notable changes to OpenCOI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Follow the evidence-driven priorities in the [roadmap](ROADMAP.md); entries here are not delivery commitments.

## [0.2.2] - 2026-08-31

### Fixed

- Centralized the version shown by the health endpoint and application shell,
  and added a release gate that requires it to match `package.json`.

## [0.2.1] - 2026-08-31

### Fixed

- Isolated the Vite client build from server-only `.env` settings so its JSX
  transform and React runtime cannot select incompatible development/production
  variants.
- Extended production-build verification to reject both React's development
  runtime and development JSX transform before an archive or container can ship.

## [0.2.0] - 2026-08-31

### Added

- Optional tenant-bound OpenID Connect sign-in using Authorization Code, PKCE S256, state, nonce, verified pre-provisioned-user binding, one-use login transactions, and the existing strict application sessions.
- Page-aware OCR proposals for named insured, certificate holder, policy fields, exact limits, and endorsements, with the original line, page, confidence, immutable proposal, and manual-correction distinction exposed to reviewers.
- Authenticated inline PDF view links that open the original at a cited evidence page.
- Vendor-neutral extraction corpus, prediction, score, and comparison schemas; six original CC0 synthetic page-text cases; deterministic fact, warning, exact-document, and citation scoring; published results/failure cases; and benchmark CI.
- Tenant-bound, scoped service accounts with one-time tokens, digest-only storage, overlapping rotation, revocation, disabling, and an administrator UI.
- Stable `/api/v1` endpoints for vendors, requirements, uploaded-document compliance, and ordered events with OpenAPI 3.1, Problem Details, request IDs, cursor pagination, idempotent writes, and ETag preconditions.
- Transactional domain-event outbox and Standard Webhooks-compatible signed delivery with encrypted signing secrets, public-HTTPS and DNS-rebinding controls, bounded retries, dead letters, explicit replay, and an external worker/Compose profile.
- Shared form accessibility contracts for labels/descriptions/errors, skip-to-content and route focus, keyboard account menu, and focus-managed inert mobile navigation with regression tests.
- Preregistered, privacy-safe usability study kit with eight synthetic tasks, consent/moderator materials, a strict no-free-text data dictionary, deterministic analyzer, synthetic fixture, and explicit no-participant-results status.
- Hardware-labelled 100/1,000/10,000-vendor workload and a query-count regression for the vendor-summary projection.

### Changed

- Replaced per-vendor summary query growth with one aggregate SQL projection while preserving document-check, lifecycle, exception, and reminder semantics.
- Capped every machine-detected endorsement at `MENTIONED`; an “attached” or human-verified level now requires a person to supply that evidence.

### Security

- Encrypted webhook signing secrets with AES-256-GCM and tenant/record-bound authenticated context.
- Restricted webhook delivery to public HTTPS, rejects mixed private/public DNS answers and URL credentials, pins a validated address for each attempt, follows no redirects, and limits time and response size.
- Kept machine credentials separate from browser sessions and derived organization context only from the authenticated service-account record.
- Pinned the container base by digest and added release dependency/license gates,
  checksummed archives and SBOMs, post-transfer checksum verification, signed
  build-provenance attestations, and a production-bundle guard.

### Evidence boundaries

- Published OpenCOI's synthetic text-parser score, not a browser OCR or real-world score. Commercial comparator rows remain explicitly “not tested” until an authorized identical run exists.
- Published a usability protocol and synthetic analyzer tests, not participant results. No ease-of-use or time-saved claim is made.
- The 10k-vendor result is hardware-specific, document-free, and single-process; the bundled deployment is still not horizontally scalable.

## [0.1.2] - 2026-08-31

### Security

- Applied a global per-client request limit before health checks, API handlers, and static-file reads while retaining stricter login and public-upload limits.
- Replaced cookie-name writes to a plain object with a `Map`, preventing attacker-controlled cookie names from reaching object properties.

### Tests

- Added regression coverage for prototype-like cookie names, malformed cookie values, and the global request ceiling.

## [0.1.1] - 2026-08-31

### Fixed

- Made the application archive self-contained by including the tagged source tree alongside the compiled application.
- Added fail-closed third-party license auditing, runtime notices, and a machine-readable license inventory to release artifacts and container images.
- Generated the production-only CycloneDX SBOM before pruning development dependencies so npm can validate the complete installed dependency tree.

## [0.1.0] - 2026-08-31

### Added

- Self-hosted vendor and contractor directory with reusable vendor types, search, filtering, and document-check and lifecycle views.
- Versioned coverage requirements for policy types, minimum limits, required document periods, and endorsement evidence.
- Staff and vendor PDF intake with browser-side PDF.js text extraction, English Tesseract OCR fallback, editable proposals, PDF preview, and mandatory human confirmation before a document can satisfy a check.
- Deterministic, typed document evaluator with `PASS`, `FAIL`, `UNKNOWN`, and `NOT_APPLICABLE` findings; stable reason codes; expected and observed values; and persisted evaluation context.
- Warnings for missing coverage and policy fields, inadequate or absent limits, policy-period deficiencies, and missing or insufficient endorsement evidence.
- Expiring, revocable vendor upload links that require no vendor account and place submissions into the authenticated review workflow.
- Finding-scoped, expiring exception requests and approval or rejection decisions that preserve the underlying base finding.
- Renewal queue and deduplicated reminder worker with optional SMTP delivery, bounded transient-failure retries, 30-minute stale-claim recovery, visible attempt/error state, and dates taken from confirmed documents.
- Filter-aware compliance CSV export with spreadsheet-formula neutralization.
- Dashboard, review queue, original PDF download, document SHA-256 display, and separate document-check and lifecycle statuses.
- Local-password sessions, organization-scoped data access, role checks, trusted-origin enforcement, double-submit CSRF protection, and rate limits on sensitive and public endpoints.
- Append-only, per-organization SHA-256-linked audit events with integrity verification.
- Node.js 24 development workflow, hardened single-container Docker Compose deployment, CI, CodeQL, release automation, backup and restore instructions, threat model, security policy, governance, and contributor guidance.

### Security

- Passwords use salted, memory-hard scrypt; bearer session and upload-link tokens are stored only as SHA-256 or optional HMAC-SHA-256 digests.
- PDF ingestion validates the file signature and rejects encrypted PDFs, common active-content markers, oversized uploads, and documents above the page safety limit before storage.
- Filesystem document keys are generated server-side, path-constrained, stored with owner-only permissions, and served through organization-authorized download routes.
- SQLite foreign keys, strict tables, organization-qualified relationships, and immutable audit triggers protect core data boundaries.

### Known boundaries

- Results concern an uploaded document and configured rules only. There is no insurer, broker, carrier, or agency-management-system connectivity and no live policy-status claim.
- OCR is heuristic, English-only in v0.1, and always subject to human review. It is not policy-language interpretation.
- The bundled topology is a single Node.js process with SQLite and local filesystem storage; it is not a horizontally scaled deployment.
- PDF triage is not antivirus or content disarm/reconstruction. Internet-facing operators should add controls appropriate to their threat model.
- Local accounts are included; SSO, MFA, and managed identity provisioning are not.

[Unreleased]: https://github.com/ajayasai/opencoi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ajayasai/opencoi/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ajayasai/opencoi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ajayasai/opencoi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ajayasai/opencoi/releases/tag/v0.1.0
