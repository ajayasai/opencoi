# Threat model

- **Status:** living design and release document
- **Last reviewed:** 2026-08-31

This threat model defines the security properties OpenCOI should preserve. It
is not a claim that every deployment implements every production control.
Operators must compare their release, configuration, infrastructure, and data
flows with this document before accepting untrusted documents.

## System purpose and critical boundary

OpenCOI stores uploaded insurance documents, helps a reviewer confirm extracted
facts, and compares a confirmed document revision with requirements configured
by an organization.

OpenCOI does **not** contact insurers, prove that a policy is active, determine
the complete meaning of an insurance policy or endorsement, or guarantee
coverage or claim payment. A stale, altered, incomplete, or inaccurate
certificate can produce an accurate assessment of the document and still fail
to describe current coverage. The interface and exports must keep this
limitation visible.

## Assets to protect

- original PDFs, rendered previews, OCR text, and field-level corrections;
- vendor and contact details, policy numbers, coverage dates, and limits;
- organization membership, roles, sessions, credentials, and recovery data;
- requirement versions, findings, exception decisions, and audit events;
- public upload invitations and document-download URLs;
- exports, notification history, provider identifiers, and backups; and
- application secrets, signing keys, storage credentials, and deployment
  configuration.

Availability and integrity matter alongside confidentiality. A silent rule
change, erased deficiency, duplicated reminder, or substituted document can be
as consequential as disclosure.

## Actors and assumptions

Expected actors include organization owners, administrators, reviewers,
exception approvers, auditors, vendor contacts using limited upload links,
background workers, and deployment operators.

Adversaries may include an unauthenticated internet user, a malicious or
compromised vendor contact, a user attempting to cross organization boundaries,
an insider abusing legitimate access, a malicious document author, a
compromised dependency or notification provider, and an attacker who obtains a
link from email, browser history, logs, or referrer data.

The model assumes the host, database, object storage, identity provider, mail
provider, and backup system are configured and patched by their operators. A
fully compromised host or organization owner can access that organization's
data; controls should still limit lateral movement, persistence, and unnoticed
tampering.

## Data flow and trust boundaries

The intended high-level flow is:

1. An authenticated user configures vendors, assignments, and requirements.
2. A user or narrowly authorized vendor link uploads a PDF.
3. The service validates and isolates the file before parsing or OCR.
4. Extraction produces untrusted field candidates with source evidence.
5. A reviewer confirms, corrects, or rejects the candidates.
6. A deterministic evaluator compares the confirmed revision with the
   applicable requirement version as of a stated date.
7. The service records findings, exceptions, reminders, audit events, and
   authorized exports without mutating prior evidence.

Important trust boundaries are the browser-to-service connection, public upload
link, application authorization layer, document parser/OCR boundary, private
storage, database, notification provider, export/download path, operator
console, dependency supply chain, and backup/restore process. Every document,
filename, OCR string, CSV cell, email address, and URL received across these
boundaries is untrusted.

## Security objectives

OpenCOI should provide:

- organization and role isolation on every record, job, object, and export;
- authenticity and traceability of confirmed values and decisions;
- bounded, revocable vendor access that reveals no unrelated data;
- safe handling of hostile or resource-exhausting PDFs;
- deterministic evaluation that fails to review, not to pass, on ambiguity;
- minimum necessary collection, disclosure, logging, and retention; and
- enough audit evidence to investigate consequential actions without logging
  document contents or credentials.

## Threats and required controls

The controls below are release requirements or deployment responsibilities, not
a security certification.

| ID | Threat | Required controls and acceptance criteria |
| --- | --- | --- |
| T1 | Cross-organization access or insecure direct object reference | Authorize every record, search, job, export, and object download server-side. Scope foreign keys and storage keys to the organization; use unguessable public IDs and row-level security where available. Test every route and worker with two organizations. |
| T2 | Upload-link guessing, leakage, replay, or privilege expansion | Generate at least 256 random bits, store only a digest, bind the token to organization, vendor, engagement, and purpose, and make it short-lived and revocable. A scanner-followed `GET` must not consume it; explicit `POST` performs exchange or use. Rate-limit atomically, redact tokens from all logs, return indistinguishable failures, and set `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. |
| T3 | Malicious, malformed, oversized, encrypted, polyglot, or active PDF | Validate signature and detected type, not extension; use random private object names; cap bytes, pages, embedded objects, render/OCR time, memory, and tenant quota. Parse in a patched, non-root, networkless sandbox with an ephemeral workspace. Reject or isolate encrypted files, embedded files, JavaScript, and malformed structures. Use malware scanning and content disarm hooks in production; serve inert previews rather than active inline PDFs. |
| T4 | Code, markup, query, log, or prompt injection through document content | Treat extracted text and metadata as attacker-controlled. Parameterize queries, encode output by context, bound string sizes, neutralize control characters in logs, and never execute document instructions. Any future AI integration must isolate document text as data, use a fixed output schema, have no ambient tools, and require human confirmation. |
| T5 | OCR error or ambiguous mapping creates a false successful result | Preserve raw candidates, confidence, page and location, corrections, reviewer, and timestamps. Require confirmation for identity, dates, policy mapping, monetary limits, and endorsement evidence. Missing, contradictory, or incomparable data is `UNKNOWN`/`Needs review`, never zero or pass. |
| T6 | Requirement or evaluation tampering | Limit draft, publish, and assignment actions by role. Version published requirements immutably, snapshot canonical inputs and engine version, hash where practical, and record safe audit events. Identical canonical inputs must produce identical base findings. |
| T7 | Exception abuse hides a deficiency | Keep base findings immutable. Record requester, approver, rationale, scope, compensating controls, and effective dates separately. Support separation of duties and prevent self-approval when configured. An expired or wrong-scope exception has no effect. |
| T8 | Unauthorized or dangerous exports | Reauthorize at generation and download, audit both, minimize columns, use short-lived private artifacts, and neutralize cells beginning with `=`, `+`, `-`, or `@`. Never place bearer tokens or hidden document text in exports. |
| T9 | Reminder leakage, spam, or duplicate delivery | Put a link—not a COI or detailed deficiency—in email; keep subject lines neutral. Use deterministic idempotency keys, recipient and tenant rate caps, bounded retries, bounce/suppression handling, and cancellation of obsolete reminders after a renewal. |
| T10 | Sensitive data appears in telemetry, logs, temporary files, or backups | Never log raw tokens, session IDs, PDFs, full OCR text, credentials, or email bodies. Encrypt transport and managed storage, restrict operational access, define retention for each derivative and backup, and test deletion and restoration. Exclude documents from crash reports and support bundles. |
| T11 | Session theft, credential attacks, OIDC mix-up, login CSRF, or privilege persistence | For OIDC, pin the exact issuer and organization, use Authorization Code with PKCE, state, nonce, one-use transactions, and exact callback URLs; bind immutable issuer/subject identities only to pre-provisioned active users and never derive roles from untrusted claims. If local passwords are supported, use a modern memory-hard password hash and breached-password screening. Use Secure, HttpOnly, SameSite cookies, CSRF defenses, rotation, short privileged sessions, rate limits, MFA for sensitive roles, and reauthentication for role, export, and exception changes. A role downgrade must invalidate privileged sessions. |
| T12 | Parser, package, build, or release supply-chain compromise | Pin dependencies with a lockfile, minimize parser and OCR dependencies, run automated vulnerability and secret scanning, review install scripts, publish an SBOM, protect release credentials, and sign or attest releases where practical. |
| T13 | Resource exhaustion through uploads, OCR, searches, exports, or reminders | Apply per-request and per-organization quotas, concurrency caps, timeouts, pagination, job backpressure, and cost monitoring. A failure must not leave an invitation consumed, partial document trusted, or reminder duplicated. |
| T14 | A document assessment is mistaken for live policy status | Use the bounded status vocabulary, show the document issue/revision and evaluation dates, retain the source, and display the product disclaimer beside results and exports. Never infer cancellation status or current coverage from silence. |
| T15 | Audit history is altered or becomes a second sensitive-data store | Separate business audit events from security/operational logs. Make events append-only using database permissions or triggers, record actor, action, target, request ID, reason, and safe field paths, and prevent direct update/delete. Use references instead of copying documents or complete field values. |
| T16 | File or data from one vendor is deliberately or accidentally assigned to another | Show organization and vendor context throughout upload and review, validate expected identity as a finding, require explicit reassignment with audit history, deduplicate by content hash without crossing tenant boundaries, and never expose match candidates to public uploaders. |

## Domain integrity requirements

The evaluator is a security-sensitive decision component. It should:

- resolve one explicit, published requirement version for the vendor,
  engagement, and evaluation date;
- compare exact types for dates, amounts, currency, coverage basis, and evidence
  level;
- model `statutory`, `unlimited`, and `not shown` as semantic values rather than
  invented numbers;
- require an actual endorsement when the rule requires endorsement evidence;
- keep `expired`, `expiring soon`, and `future-dated` as lifecycle facts rather
  than overloading the document-check result;
- avoid adding primary and excess limits unless a named strategy and policy
  relationship were explicitly confirmed; and
- apply exceptions as a separate disposition after base findings are recorded.

Rule configuration must be constrained data. Arbitrary JavaScript, SQL, shell
commands, or unbounded regular expressions are not acceptable extension
mechanisms.

## Privacy and retention

The default data model should not require Social Security numbers, dates of
birth, bank details, driver's-license data, payment information, or complete
insurance policies. Free text can still contain unexpected personal data and
must receive the same protections as structured fields.

Operators should set retention separately for originals, previews, OCR
candidates, confirmed revisions, temporary exports, notification history, audit
events, and backups. Deletion must cover temporary workspaces, indexes, cached
previews, and queued jobs. Legal holds must be explicit, scoped, audited, and
separate from ordinary retention.

Cloud OCR, AI, analytics, or error-reporting services must be disabled by
default unless the operator makes an informed choice about region, retention,
model-training use, subprocessors, and contractual terms. Manual entry must
remain possible when external processing is unavailable or prohibited.

### Service API and outbound webhook boundary

Machine credentials are separate from browser sessions. A service-account
token determines its organization and scopes from the stored record; clients
cannot supply a tenant selector. Tokens contain 256 bits of random secret
material, are displayed once, stored only as digests, can overlap during
rotation, and can be individually revoked or disabled as a group. Operators
must still keep tokens out of source control, URLs, browser storage, and logs.

Webhook destinations are attacker-influenced outbound network targets and a
potential document-data exfiltration path. Only owners/admins can configure
them. Every attempt requires public HTTPS, rejects URL credentials and
private/special or mixed DNS answers, pins the validated address, follows no
redirects, and bounds time and response bytes. Network egress policy should
still restrict the container; application SSRF checks are not a firewall.

Webhook bodies use a stable event ID and attempt timestamp with an HMAC-SHA256
signature. Receivers must verify the exact raw body, enforce a timestamp
tolerance, and deduplicate IDs. Signing secrets are AES-256-GCM encrypted with
record-bound context derived from stable deployment key material. Compromise of
the application host or `TOKEN_PEPPER` defeats this at-rest boundary.

## Verification plan

At minimum, security tests should cover:

- Tenant A attempting every read, write, job, search, export, and object access
  against Tenant B;
- expired, revoked, replayed, malformed, leaked, scanner-followed, and
  concurrently used invitations;
- path traversal, spoofed MIME, polyglot, encrypted, huge-page, embedded-file,
  JavaScript-bearing, malformed, and decompression-bomb PDFs;
- parser/OCR attempts to reach the network, secrets, host filesystem, or
  another job's workspace;
- OCR-derived XSS, formula injection, log injection, SQL-like strings, and
  prompt-injection text;
- signed URL expiry, session rotation, role downgrade, CSRF, and rate-limit
  boundaries;
- OIDC discovery and callback failures, issuer/audience/signature/nonce/state/PKCE validation, transaction expiry and replay, disabled or unprovisioned users, and cross-organization identity collisions;
- service-account scope, tenant confusion, expiration, rotation, revocation, disabled-account, idempotency-key, and stale-ETag behavior;
- webhook signatures, stable retry IDs, dead-letter replay, delivery leasing, DNS rebinding, mixed DNS, private IPv4/IPv6, redirects, timeouts, and oversized responses;
- direct audit-event update/delete and exception self-approval restrictions;
- deterministic evaluation and `UNKNOWN` behavior for missing or incomparable
  values;
- reminder retry, concurrency, renewal suppression, and provider outage; and
- retention deletion and backup restoration without breaking organization
  isolation or immutable decision history.

## Residual risks

No control can make a certificate equivalent to the underlying policy or a live
insurer record. Human reviewers can make mistakes, configured requirements can
be incomplete, documents can be fraudulent, endorsements can conflict with
certificate indications, and a policy can change after issue. Local operators
can misconfigure infrastructure, and sophisticated parser vulnerabilities may
exist despite isolation.

The appropriate response is layered controls, bounded language, preserved
evidence, professional review where warranted, and a deployment-specific risk
assessment—not a stronger marketing claim.

Report security issues privately under [SECURITY.md](../SECURITY.md).
