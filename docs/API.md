# OpenCOI API v1 and webhooks

OpenCOI v0.2 exposes a versioned machine-to-machine API at `/api/v1`. It is
separate from the browser's cookie-authenticated `/api` routes. The served
OpenAPI 3.1 description is available without authentication at
`/api/v1/openapi.json`; the source description is in
[`api/openapi-v1.yaml`](api/openapi-v1.yaml).

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
| `requirements:read` | Read vendor types and their active rules. |
| `compliance:read` | Read the latest uploaded-document result, findings, and policy facts. |
| `events:read` | Read the tenant's ordered domain-event feed. |

## Stable behavior

- Every response includes `X-Request-ID` and `OpenCOI-Version`. The latter is the
  date-based API contract revision, not the package release version.
- Errors use `application/problem+json` with `type`, `title`, `status`,
  `detail`, `instance`, and `requestId`.
- Collection endpoints use opaque/cursor pagination with a maximum page of 100.
- `POST` and `PATCH` require an `Idempotency-Key` of 8–128 permitted
  characters. The same key and exact request return the original response for
  24 hours; reusing it for different input returns `409`.
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

## Domain events and webhooks

Business events are appended in an organization-scoped sequence and fanned out
through a transactional outbox. Current v0.2 workflows emit:

- `vendor.created`
- `vendor.updated`
- `certificate.submitted`
- `certificate.confirmed`
- `certificate.rejected`
- `exception.requested`
- `exception.approved`
- `exception.rejected`
- `exception.revoked`

The model accepts additional exact event types as workflows adopt it. An
endpoint can subscribe to exact types or `*`.

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
