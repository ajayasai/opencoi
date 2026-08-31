# Changelog

All notable changes to OpenCOI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Follow the evidence-driven priorities in the [roadmap](ROADMAP.md); entries here are not delivery commitments.

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

[Unreleased]: https://github.com/ajayasai/opencoi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ajayasai/opencoi/releases/tag/v0.1.0
