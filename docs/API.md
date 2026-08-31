# OpenCOI API v1 and webhooks

OpenCOI v0.4 exposes a versioned machine-to-machine API at `/api/v1`. It is
separate from the browser's cookie-authenticated `/api` routes. The served
OpenAPI 3.1 description is available without authentication at
`/api/v1/openapi.json`; the source description is in
[`api/openapi-v1.yaml`](api/openapi-v1.yaml). The checked-in file is
deterministically generated as JSON, which is valid YAML 1.2, from the exact
runtime document. `npm run openapi:verify` rejects drift and
`npm run openapi:generate` intentionally refreshes it.

## Authentication and tenant boundary

An owner or administrator creates a service account from **Integrations** and
selects its scopes. OpenCOI displays each token once. Tokens begin with
`ocoi_sk_`; only an HMAC-SHA-256 digest is stored when `TOKEN_PEPPER` is set.

```http
Authorization: Bearer ocoi_sk_…
```

The token's database record determines the organization. There is no tenant or
organization header and a caller cannot select another tenant. Disable a
service account to stop all its credentials immediately. Rotation creates an
overlapping credential so a client can switch without downtime; explicitly
revoke the old secret after deployment.

Scopes are deliberately small:

| Scope | Operations |
| --- | --- |
| `vendors:read` | List and get vendors. |
| `vendors:write` | Create and update vendors. |
| `certificates:read` | Read a certificate assessment, including facts, evidence, and findings. |
| `certificates:write` | Submit a PDF and extraction proposal into mandatory human review. |
| `requests:read` | List and read tracked initial or renewal requests. |
| `requests:write` | Create and cancel tracked initial or renewal requests. |
| `evidence:read` | Export a signed, portable evidence bundle. |
| `requirements:read` | Read vendor types and their active rules. |
| `compliance:read` | Read the latest uploaded-document result, findings, and policy facts. |
| `events:read` | Read the tenant's ordered domain-event feed. |

Creating a request normally needs only `requests:write`. If the request names
`sourceCertificateId`, it also needs `certificates:read`; this prevents the
write operation from becoming a certificate-existence oracle.

Vendor create/update, certificate-upload, and certificate-request cancellation
operations return non-sensitive mutation receipts. Reading the resulting
resource requires the corresponding read scope; idempotent replays preserve the
receipt and cannot recover a fuller response after a scope downgrade.

## Stable behavior

- Every response includes `X-Request-ID` and `OpenCOI-Version`. The latter is the
  date-based API contract revision, not the package release version.
- Errors use `application/problem+json` with `type`, `title`, `status`,
  `detail`, `instance`, and `requestId`.
- Collection endpoints use opaque/cursor pagination with a maximum page of 100.
- `POST` and `PATCH` require an `Idempotency-Key` of 8–128 permitted
  characters. The same key and exact request return the original response for
  24 hours; reusing it for different input returns `409`. A replay includes
  `Idempotent-Replayed: true`.
- Multipart certificate idempotency covers the canonical metadata, original
  filename, byte size, and SHA-256 of the exact PDF bytes—not merely its form
  fields. When `TOKEN_PEPPER` is configured, stored replay bodies are encrypted
  with record-bound authenticated encryption. This keeps a manual request's
  one-time upload URL out of plaintext idempotency storage.
- A vendor `GET` supplies an `ETag`. `PATCH` requires that value in `If-Match`;
  missing and stale preconditions return `428` and `412`, respectively.
- Dates are ISO 8601 strings and monetary limits are non-negative integer minor
  units, consistent with the rule engine.
- Compliance results concern an uploaded document. API access does not turn
  them into live-policy verification.

Example:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $OPENCOI_TOKEN" \
  "https://coi.example.com/api/v1/vendors?limit=50"

curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $OPENCOI_TOKEN" \
  -H "Idempotency-Key: erp-vendor-18421-v1" \
  -H "Content-Type: application/json" \
  --data '{"vendorTypeId":"…","legalName":"Example Electrical LLC"}' \
  https://coi.example.com/api/v1/vendors
```

Submit a PDF from another system. Even if metadata claims `CONFIRMED`, the API
forces it to `UNCONFIRMED`; a human reviewer must compare it with the original
before it can satisfy a rule.

```sh
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $OPENCOI_TOKEN" \
  -H "Idempotency-Key: erp-certificate-18421-v1" \
  -F 'metadata={"namedInsured":"Example Electrical LLC","policies":[]}' \
  -F 'document=@certificate.pdf;type=application/pdf' \
  https://coi.example.com/api/v1/vendors/00000000-0000-4000-8000-000000000001/certificates
```

Tracked requests are also available through the stable API:

```sh
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $OPENCOI_TOKEN" \
  -H "Idempotency-Key: erp-renewal-18421-v1" \
  -H "Content-Type: application/json" \
  --data '{"kind":"renewal","deliveryMethod":"manual","ttlDays":14}' \
  https://coi.example.com/api/v1/vendors/00000000-0000-4000-8000-000000000001/certificate-requests
```

The returned manual upload URL is a bearer secret. Its token is in the URL
fragment, which browsers do not send in the HTTP request target; OpenCOI's
public page removes the fragment from history and uses an `Authorization:
UploadLink …` header against a fixed API path. OpenCOI encrypts its idempotent
replay response and makes that exact response available for 24 hours; clients
must still restrict response/body and authorization-header logs and share the
URL only with the intended recipient. SMTP responses mean acceptance by the
configured SMTP service, not inbox delivery or opening.

Signed evidence bundles are available from
`GET /api/v1/certificates/{certificateId}/evidence-bundle`. The response covers
the source-document hash, exact page-addressed endorsement attestations,
reviewed facts, rule snapshot, findings, exceptions, and audit checkpoint with
an Ed25519 signature. Export requires `TOKEN_PEPPER` of at least 32 bytes and
returns `503` when secure signing-key protection is unavailable.

## Domain events and webhooks

Business events are appended in an organization-scoped sequence and fanned out
through a transactional outbox. Current v0.4 workflows emit:

- `vendor.created`
- `vendor.updated`
- `certificate.submitted`
- `certificate.confirmed`
- `certificate.rejected`
- `certificate_request.created`
- `certificate_request.cancelled`
- `certificate_request.submitted`
- `certificate_request.email_accepted`
- `certificate_request.email_failed`
- `exception.requested`
- `exception.approved`
- `exception.rejected`
- `exception.revoked`

The model accepts additional exact event types as workflows adopt it. An
endpoint can subscribe to exact types or `*`.

Certificate submission, certificate-request management, certificate reads, and
signed evidence-bundle export are stable `/api/v1` operations in v0.4. Browser
routes remain available to the first-party client but are not the integration
contract.

Delivery follows the [Standard Webhooks](https://www.standardwebhooks.com/)
signature convention over the exact UTF-8 JSON body:

```text
webhook-id: <stable domain event UUID>
webhook-timestamp: <Unix seconds for this attempt>
webhook-signature: v1,<base64 HMAC-SHA256>
signed bytes: <webhook-id>.<webhook-timestamp>.<raw JSON body>
```

The signing secret is displayed once and encrypted at rest with AES-256-GCM
using deployment key material plus record-bound authenticated context. A stable
`TOKEN_PEPPER` of at least 32 bytes is therefore required for webhooks.

Delivery is at least once. The event ID remains stable across attempts, so a
receiver must deduplicate it. OpenCOI:

- resolves the destination before every attempt;
- permits public HTTPS destinations only;
- rejects credentials in URLs, private/special IPs, mixed public/private DNS
  answers, redirects, oversized responses, and slow responses;
- pins the checked IP for that attempt to resist DNS rebinding;
- uses bounded exponential retry intervals and an atomic delivery lease;
- claims each row immediately before outbound I/O, rechecks endpoint status
  after DNS validation, and lets only the current claim token complete it;
- records the actual attempt and completion timestamps rather than a scan-cycle
  timestamp;
- moves the eighth failed attempt to a visible dead letter; and
- requires an administrator to replay a failed/dead-letter delivery.

Run the independently deployable worker once or continuously:

```sh
npm run webhooks:run
npm run webhooks:run -- --watch
```

Set `WEBHOOK_POLL_SECONDS` from 1 through 3600 for watch mode. In Compose, use
the optional `webhooks` profile described in [deployment](DEPLOYMENT.md).

## Compatibility

Paths below `/api/v1` are the stable third-party surface. Additive response
fields and new event types may appear in minor releases. Removing/renaming a
field, changing its meaning, or making an optional field required needs a new
major API path. Browser routes under unversioned `/api` are not this contract.
