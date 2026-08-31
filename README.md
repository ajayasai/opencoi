# OpenCOI

[![CI](https://github.com/ajayasai/opencoi/actions/workflows/ci.yml/badge.svg)](https://github.com/ajayasai/opencoi/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ajayasai/opencoi/actions/workflows/codeql.yml/badge.svg)](https://github.com/ajayasai/opencoi/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/ajayasai/opencoi?include_prereleases&sort=semver)](https://github.com/ajayasai/opencoi/releases)
[![License: AGPL-3.0](https://img.shields.io/github/license/ajayasai/opencoi)](LICENSE)

OpenCOI is an open-source, self-hosted certificate-of-insurance tracker. It extracts facts from uploaded COI PDFs, asks a person to confirm them, and compares the confirmed facts with versioned requirements. Every result says what was expected, what the document showed, and why the check passed, failed, or needs review.

> [!IMPORTANT]
> OpenCOI assesses an uploaded document against rules configured by its operator. It does not contact an insurer or broker, establish that a policy is currently active, interpret policy language, or guarantee coverage or claim payment.

## Why OpenCOI

Commercial COI products already cover collection, OCR, reminders, and dashboards. OpenCOI's public bar is different: make the decision path inspectable and keep the operator in control.

- **Explainable checks:** deterministic findings include stable reason codes, expected and observed values, the requirement version, and the evaluation date.
- **Human authority:** OCR proposes; a reviewer confirms. Missing or unconfirmed evidence is never allowed to produce a pass.
- **Honest exceptions:** an approval is scoped and time-bound, while the underlying failed finding stays visible.
- **Local document processing:** PDF text extraction and OCR execute in the browser with PDF.js and Tesseract.js. Worker, WebAssembly, and English language assets are served by OpenCOI itself; no runtime OCR CDN or third-party OCR API receives document pages.
- **Portable operations:** filtered compliance CSV, original-document download, and a reviewable audit trail keep data usable outside the application.
- **Self-hosting:** one Node.js process, SQLite, and filesystem document storage make a small-team deployment understandable and back-upable.

Open source does not automatically make software safer or more accurate. See the project's [competitive positioning](docs/COMPETITIVE_POSITIONING.md) for the claims OpenCOI will—and will not—make.

## v0.1 scope

| Intended capability | v0.1 status | What is included |
| --- | --- | --- |
| Vendor and contractor directory | Included | Create and edit vendor records, assign a vendor type, search and filter by document-check and lifecycle status. |
| Required coverages by vendor type | Included | Publish versioned coverage profiles with minimum limits, document-period requirements, and named endorsement-evidence requirements. |
| COI PDF upload | Included | Staff upload and scoped vendor upload links, with size, signature, encryption, active-content, and page-count checks. |
| OCR-assisted extraction | Included | Browser-side PDF text-layer extraction with English Tesseract OCR fallback for scanned pages; insurer, policy number, dates, common limits, and common endorsement indications are proposed. |
| Human confirmation | Included | Side-by-side PDF and field review for staff intake; vendor submissions remain unconfirmed until an authenticated reviewer attests to and re-evaluates the extracted facts. |
| Deficiency warnings | Included | Explainable findings for missing coverage or policy fields, inadequate or absent limits, policy-period problems, and missing or insufficient endorsement evidence. |
| Renewal reminders | Included | A due-soon queue based on dates printed on confirmed documents, plus a deduplicated reminder worker and optional SMTP delivery. Transient email failures retry on the same row after minimum 15-minute and 60-minute backoffs, stopping after three total attempts; stale delivery claims are recovered after 30 minutes. |
| Vendor self-service upload | Included | Expiring, revocable bearer links with no vendor account required; submissions enter human review. |
| Exception approval | Included | Finding-scoped request and decision workflow with rationale, expiration, and an audit trail; approval does not rewrite the base finding. |
| Compliance-status export | Included | Server-generated, filter-aware CSV with formula-injection protection and document-scoped status language. |
| Live insurer connectivity | Deliberately excluded | No carrier, broker, or agency-management-system connection and no representation of live policy status. See the [roadmap](ROADMAP.md). |

The release also includes a dashboard, review queue, separate document lifecycle state, original-file SHA-256 display, role-checked operations, and an append-only SHA-256-linked audit history.

Limit comparison in v0.1 is USD-only. Non-USD document normalization and explicit currency-mismatch findings are roadmap work; the configuration API rejects other currencies rather than making an unsafe numeric comparison.

## Status language

Document checks and policy lifecycle are separate. A document can meet configured checks and still be close to the expiration date printed on it.

| UI status | Meaning |
| --- | --- |
| **Meets configured document checks** | Confirmed facts in the selected uploaded document satisfy every applicable configured check. It is not live-policy verification. |
| **Deficient against configured document checks** | At least one base finding is `FAIL`. |
| **Needs review** | The document or a required fact is unconfirmed, missing from an unreviewed extraction, or otherwise `UNKNOWN`. `UNKNOWN` never counts as a pass. |
| **Approved exception** | A current approval disposes of one or more failed findings for workflow purposes. The failures remain recorded. |
| **Not submitted** | No certificate document has been submitted for the vendor. |

Lifecycle labels—`Current`, `Expiring`, `Expired`, `Future`, and `Unknown`—come only from dates shown on the selected document. Full evaluator semantics are in [docs/RULES.md](docs/RULES.md).

## Quick start with Node.js 24

Prerequisites: Node.js 24+, npm 11+, and a current browser.

```bat
git clone https://github.com/ajayasai/opencoi.git
cd opencoi
copy .env.example .env
```

Before continuing, edit `.env` and replace `BOOTSTRAP_ADMIN_PASSWORD` with a unique password of at least 12 UTF-8 bytes. The example credential is not safe to keep.
Production startup refuses the unchanged example password.

```bat
npm ci
npm run db:seed
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and sign in with `BOOTSTRAP_ADMIN_EMAIL` and the password you set. The development UI proxies API requests to `http://127.0.0.1:4174`.

Useful checks:

```text
npm run check
npm run build
npm run test:coverage
```

All example data is synthetic. Never use a real COI as a test fixture or issue attachment.

## Quick start with Docker

Docker Compose runs the production build as a non-root user with a read-only root filesystem and one persistent `opencoi-data` volume.

```bat
copy .env.example .env
```

For local Docker, the Compose default uses `http://localhost:4174`; set a unique bootstrap password before starting. For any shared or internet-facing deployment, set `OPENCOI_APP_ORIGIN` to the exact HTTPS public origin, set `COOKIE_SECURE=true`, and configure a stable random `TOKEN_PEPPER` of at least 32 bytes. Then run:

```text
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

Open [http://localhost:4174](http://localhost:4174). The service is ready when Compose reports it as healthy. The supported topology is one application container and one data volume; do not run multiple replicas against the same SQLite database.

For upgrades, reverse proxy guidance, and SMTP configuration, follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Production checklist

- Put the application behind HTTPS; set the exact public origin (`OPENCOI_APP_ORIGIN` in Compose or `APP_ORIGIN` for direct Node.js), set `TRUST_PROXY_HOPS` to the exact controlled proxy count, and keep secure cookies enabled. Leave the hop count at `0` for direct access.
- Generate and preserve a 32+ byte `TOKEN_PEPPER`; store bootstrap and SMTP credentials in a secrets manager.
- Sign in once, then remove the five `BOOTSTRAP_*` values and recreate the container.
- Keep `/app/data` on encrypted, access-controlled persistent storage and back up the database and uploads together.
- Test the documented [backup and restore](docs/BACKUP_RESTORE.md) procedure before accepting real documents.
- Treat upload links as bearer secrets; keep them short-lived and revoke exposed links.
- Add upstream malware scanning or content disarm/reconstruction if your risk assessment requires it. OpenCOI's PDF triage is not antivirus software.
- Configure SMTP only with a scoped credential, or operate reminders as an in-app queue; review terminal delivery errors after the bounded retry policy is exhausted.
- Apply dependency and image updates, monitor disk space and health, and review audit events and approved exceptions.
- Read [SECURITY.md](SECURITY.md) and the [threat model](docs/THREAT_MODEL.md) before exposing public uploads.

OpenCOI v0.1 does not include SSO, MFA, antivirus/CDR, object storage, multi-replica coordination, a managed review service, or live insurer connectivity. Operators are responsible for deployment controls and domain review appropriate to their use case.

## API and exports

The React client uses a same-origin JSON API under `/api`. Authenticated mutations use the session cookie, trusted-origin checks, role checks, and a double-submit CSRF token. Public upload endpoints accept only a scoped upload-link token. `/api/health` is available for health checks.

The API is an application interface, not yet a stable third-party contract: pre-1.0 endpoints may change with release notes. Compliance CSV is available from the vendor directory and honors its search and status filters. Exported statuses remain document-scoped, and untrusted cells are neutralized before spreadsheet use.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component and trust boundaries.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Rule and status semantics](docs/RULES.md)
- [OCR and human review](docs/OCR_AND_REVIEW.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Backup and restore](docs/BACKUP_RESTORE.md)
- [Security policy](SECURITY.md) and [threat model](docs/THREAT_MODEL.md)
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md), [governance](GOVERNANCE.md), and [code of conduct](CODE_OF_CONDUCT.md)

## Contributing and security

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm run check` and `npm run build` before opening a pull request. The test suite covers the deterministic evaluator, OCR parsing, CSV injection, authentication primitives, tenant-scoped repositories, PDF triage, audit-chain integrity, configuration, and HTTP workflows.

Report vulnerabilities privately through GitHub Private Vulnerability Reporting as described in [SECURITY.md](SECURITY.md). Do not put real documents, credentials, tokens, or personal data in a public report.

## License

OpenCOI is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). If you modify OpenCOI and make it available to users over a network, review the AGPL source-availability obligations that apply to your deployment.

Compiled distributions also contain third-party software under its own terms.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); release archives include a
package-specific runtime license bundle and a CycloneDX SBOM.
