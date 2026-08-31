# Deploying OpenCOI

OpenCOI is a single-process Node.js application backed by SQLite and local document storage. The supported low-complexity deployment is one application container with one persistent data volume. Do not run multiple replicas against the same database or data volume.

OpenCOI evaluates uploaded documents against configured requirements. A healthy deployment does not prove that an insurer still considers a policy active.

## Prerequisites

- Docker Engine with the Docker Compose v2 plugin
- A host with persistent storage and a working backup destination
- A DNS name and TLS-terminating reverse proxy for any internet-accessible deployment
- At least 2 GB of memory is recommended for OCR workloads

Deploy a tagged release rather than an arbitrary branch for production. Review the release notes and `SECURITY.md` before exposing the service.

## Configure the environment

Docker Compose reads substitutions from an untracked `.env` file in the repository directory. Create `.env` locally and restrict it to the service administrator. Do not commit it or paste the output of `docker compose config` into an issue because the rendered output contains secrets.

```dotenv
OPENCOI_APP_ORIGIN=https://coi.example.com
COOKIE_SECURE=true
OPENCOI_BIND_ADDRESS=127.0.0.1
OPENCOI_PORT=4174
TRUST_PROXY_HOPS=1

TOKEN_PEPPER=replace-with-at-least-32-random-bytes
BOOTSTRAP_ORG_NAME=Example Construction
BOOTSTRAP_ORG_SLUG=example-construction
BOOTSTRAP_ADMIN_NAME=Initial Administrator
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-unique-long-password

MAX_UPLOAD_MB=15
SESSION_TTL_HOURS=12
UPLOAD_LINK_TTL_DAYS=14
REMINDERS_ENABLED=true
REMINDER_POLL_MINUTES=360
```

Generate `TOKEN_PEPPER` with a cryptographically secure generator, for example `openssl rand -base64 32`. Keep it stable in a password manager or secret store; changing it invalidates token-derived credentials and makes encrypted webhook, queued-request, and evidence-signing private material unreadable. Use a separate, randomly generated administrator password. On Linux, restrict the environment file with `chmod 600 .env`.

The bootstrap values are read only when the user table is empty. After the initial administrator can sign in, remove the five `BOOTSTRAP_*` values from `.env` and recreate the container with `docker compose up -d`. Keep the administrator credential in a password manager, not in the deployment directory.

For local evaluation without TLS, use `OPENCOI_APP_ORIGIN=http://localhost:4174` and `COOKIE_SECURE=false`. Never use that cookie setting for a public deployment.

### Optional OpenID Connect SSO

OpenCOI can use one OpenID Connect provider for one explicit organization while retaining local password sign-in as a break-glass path. Register this exact redirect URI at the provider, substituting the public origin configured in `OPENCOI_APP_ORIGIN`:

```text
https://coi.example.com/api/auth/oidc/callback
```

Add all required values together:

```dotenv
OIDC_ISSUER=https://identity.example.com/tenant-id
OIDC_CLIENT_ID=opencoi
OIDC_CLIENT_SECRET=replace-with-the-provider-issued-secret
OIDC_ORGANIZATION_SLUG=example-construction
OIDC_CLIENT_AUTH_METHOD=client_secret_basic
OIDC_DISPLAY_NAME=Company SSO
OIDC_TRANSACTION_TTL_MINUTES=10
```

`OIDC_ISSUER` must be the provider's exact HTTPS issuer identifier, not merely its login-page URL or discovery-document URL. `client_secret_basic` is the default; use `client_secret_post` only when the provider requires it. Store the client secret in the deployment secret manager and prevent it from appearing in rendered Compose output, logs, support bundles, or issue reports.

The configured organization must already exist and its slug must exactly match `OIDC_ORGANIZATION_SLUG`. OpenCOI does not create users or assign roles from OIDC claims. On a user's first SSO login, the provider must return `email` and `email_verified: true`, and one active pre-provisioned OpenCOI user in that organization must have the same email address. OpenCOI then binds that user to the validated `(issuer, subject)` pair. Later logins use that immutable binding rather than email. The initial bootstrap administrator can be bound this way; provision other users through the deployment's controlled account process before they attempt SSO.

The requested scopes are `openid email profile`. Provider access, refresh, and ID tokens are not retained after OpenCOI creates its own session. Authorization Code, PKCE S256, state, nonce, issuer/audience/signature checks, and a short-lived one-use database transaction protect the flow. The provider remains responsible for MFA and its own account-recovery policy.

After enabling SSO, verify the public login page shows the configured button, complete a test login, sign out, and test the local administrator password. Do not disable or discard the break-glass credential until its recovery procedure has been tested. Removing the OIDC environment values disables new SSO attempts without deleting prior identity bindings.

### Optional SMTP delivery

Without SMTP, OpenCOI can record reminder work and create manually shared certificate requests, but it cannot deliver either type of email. Add the following values when mail delivery is required:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=opencoi
SMTP_PASSWORD=replace-with-an-app-password
SMTP_FROM=OpenCOI <no-reply@example.com>
```

`SMTP_SECURE=false` requires STARTTLS and fails closed if the server does not
offer it, normally on port 587. Use `SMTP_SECURE=true` for implicit TLS,
commonly on port 465. Both modes require TLS 1.2 or newer. Prefer a scoped mail
credential that can send only from the configured identity.

Transient network failures, timeouts, SMTP `4xx` responses, and unclassified transport exceptions remain on one deduplicated reminder row and retry after minimum backoffs of 15 minutes and then 60 minutes. The next scheduled or manual cycle performs the eligible retry, so the actual delay can be longer than the minimum. Delivery stops after three total attempts. SMTP `5xx` responses are terminal; without a transient `4xx` response, known authentication, envelope, or message errors are also not retried. Attempt count, latest error, and next eligible time remain visible in reminder history. This is not bounce processing or suppression-list management.

A reminder delivery claim has a 30-minute lease, while SMTP connection,
greeting, socket, and application deadlines are at most 30 seconds. Completion
uses the exact claim timestamp and attempt number, so a stale worker cannot
complete a newer claim. Messages retain one stable `Message-ID` across retries.
After a process restart or worker crash, the next cycle may atomically reclaim
a stale claim while attempts remain; an abandoned third attempt becomes
terminally failed. Delivery is therefore **at least once**, not exactly once:
if the SMTP server accepted a message but OpenCOI crashed before recording
success, stale-claim recovery can send that reminder again. The dedupe key
prevents a second reminder row, but it cannot prevent this post-crash duplicate
email.

Certificate-request messages use a separate worker and a two-minute claim lease. A queued upload token is encrypted with `TOKEN_PEPPER`, retained only while a bounded retry remains, and erased after SMTP acceptance, cancellation, submission, terminal failure, or the first worker cycle that observes expiry. The application records provider acceptance, not inbox delivery or opening. Both email workflows can send more than once after an ambiguous crash, so invitation links remain single-use. Cancellation revokes the upload link but cannot recall a message already handed to SMTP.

## Start and verify

Validate the Compose model without printing resolved configuration, build the image, and start the service:

```sh
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:4174/api/health
```

The service is ready only when Compose reports `healthy` and `/api/health` returns a successful response. Review startup failures with `docker compose logs --tail=200 opencoi`, redacting document and account data before sharing logs.

The image runs as an unprivileged user, drops Linux capabilities, uses a read-only root filesystem, and writes durable state only to `/app/data`. `/tmp` is an ephemeral, size-limited filesystem used during processing. The named volume contains both the SQLite database and uploaded documents; losing either part can make records incomplete.

## Reverse proxy and TLS

The Compose default publishes OpenCOI only on host loopback. Put Caddy, nginx, Traefik, or an equivalent proxy on the same host and forward HTTPS traffic to `127.0.0.1:4174`. The proxy should:

- enforce modern TLS and redirect HTTP to HTTPS;
- preserve the original `Host` and overwrite client-supplied forwarding headers with trusted values;
- set a request-body limit no smaller than `MAX_UPLOAD_MB` plus protocol overhead;
- apply conservative connection and request timeouts suitable for OCR uploads;
- avoid logging query strings, cookies, authorization headers, upload-link tokens, or document bodies.

Set `OPENCOI_APP_ORIGIN` to the exact browser-visible origin, with no path or trailing slash, and keep `COOKIE_SECURE=true`. Compose passes this value to the container as `APP_ORIGIN` without colliding with the development setting in `.env.example`.

Set `TRUST_PROXY_HOPS` to the exact number of controlled proxy hops between the browser and OpenCOI (`1` for the single same-host proxy topology above). This lets audit records and application throttles use the real client address without trusting arbitrary forwarding headers. The default is `0`; keep it at `0` for direct access. Every trusted proxy must discard or overwrite inbound `X-Forwarded-For` rather than appending to an untrusted client-supplied chain. A wrong value can either collapse all clients into one rate-limit bucket or let callers spoof their address.

OpenCOI permits at most 300 requests per minute for one resolved client address,
with stricter limits on sign-in and public-upload routes. This in-process control
is a last line of defense, not an edge protection service. Keep proxy or gateway
connection limits, body limits, timeouts, and abuse controls enabled as well.

If direct network exposure is unavoidable, explicitly set `OPENCOI_BIND_ADDRESS=0.0.0.0`, leave `TRUST_PROXY_HOPS=0`, and provide TLS and network access controls elsewhere; loopback is the safer default.

## Persistent storage

Compose creates the `opencoi-data` named volume and mounts it at `/app/data`. Store that volume on encrypted, monitored storage. Certificates can contain personal and commercially sensitive information, and the database contains authentication and audit data.

- Do not mount the same volume into two running OpenCOI instances.
- Monitor free space and inode availability.
- Restrict host and Docker-daemon access; membership in the Docker administrative group is effectively root access to the data.
- Follow [BACKUP_RESTORE.md](BACKUP_RESTORE.md) and test restores on a separate host.

## Evidence-signing key operations

The first signed export for an organization creates one Ed25519 key. Its private key is encrypted in SQLite using `TOKEN_PEPPER`; its public key and SHA-256 fingerprint are included in exports. Back up the database and preserve the pepper together. Publish the fingerprint through a separately controlled channel when another party needs to authenticate the signer, rather than only verify self-contained integrity. v0.4 has no UI key-rotation workflow; document any emergency key replacement outside the application before changing deployment key material.

## Webhook worker

Webhook endpoints require a stable `TOKEN_PEPPER` of at least 32 bytes. OpenCOI
uses it to encrypt signing secrets at rest; losing or changing it makes existing
webhook secrets unreadable and also invalidates peppered bearer-token digests.

Run one independently supervised delivery worker against the same data volume:

```sh
docker compose --profile webhooks up --build -d
docker compose ps
docker compose logs --tail=100 webhook-worker
```

The profile starts the normal web service and one non-root, read-only-root
worker. `WEBHOOK_POLL_SECONDS` defaults to 15 and accepts 1–3600. Do not run
multiple webhook workers in the bundled SQLite topology as a claim of
horizontal scale. The lease logic recovers a crashed claim and protects against
two workers taking the same due row, but SQLite and the local upload directory
remain a single-host data plane.

Without Compose, use `npm run webhooks:run -- --watch` under a process
supervisor. Alert on worker exits and on visible dead-letter rows. Receivers
must deduplicate the stable `webhook-id`; delivery is at least once.

## Certificate-request worker

Manual certificate requests do not require a worker. To send queued requests by SMTP, configure SMTP and a stable `TOKEN_PEPPER` of at least 32 bytes, then run one supervised worker against the same data volume:

```sh
docker compose --profile requests up --build -d
docker compose ps
docker compose logs --tail=100 request-worker
```

Without Compose, use `npm run requests:run -- --watch`. The worker polls every 30 seconds, claims at most one due request per organization per round, and submits at most 100 messages per cycle. It retries transient failure after minimum 15-minute and 60-minute backoffs and stops after three attempts. The application also limits one user to 30, one recipient to 5, and one workspace to 200 SMTP requests in a rolling 24-hour window, with at most three active SMTP requests per vendor; the endpoint has a separate hourly throttle. Reviewers may send only to the vendor's configured contact email. Do not run multiple request workers as a horizontal-scale claim; the lease prevents simultaneous ownership of a row, but the supported data plane remains one SQLite database on one host.

To run both optional outbound workers with Compose, enable both profiles:

```sh
docker compose --profile webhooks --profile requests up --build -d
```

## Upgrades

1. Read the target release notes and compatibility notices.
2. Take and verify a stopped-service backup.
3. Check out the target release tag.
4. Build the target image and preview its database migration plan.
5. Apply the migrations explicitly while the service and workers are stopped.
6. Start the target release and confirm the migration check, health endpoint,
   sign-in, a synthetic upload, and reminder status.

```sh
git fetch --tags --prune
git checkout vX.Y.Z
docker compose build --pull
docker compose stop
docker compose run --rm --no-deps opencoi node dist/server/cli/migrate.js --plan
docker compose run --rm --no-deps opencoi node dist/server/cli/migrate.js
docker compose up -d
docker compose ps
docker compose exec opencoi node dist/server/cli/migrate.js --check
curl --fail --silent --show-error http://127.0.0.1:4174/api/health
```

Application startup invokes the same checksummed migration runner for backward
compatibility, but the explicit stopped-service procedure makes the plan and
failure boundary visible before traffic resumes. See
[DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md). A container-image rollback
does not reverse a schema change; restore the pre-upgrade data backup when
release notes do not explicitly declare backward schema compatibility.

## Operational security

- Apply host, container-base, and OpenCOI security updates promptly.
- Limit administrator accounts and review audit events and approved exceptions regularly.
- Set retention rules for expired certificates, exports, backups, and logs.
- Treat vendor upload links as bearer credentials; use short lifetimes and revoke or replace exposed links.
- Put rate limiting and abuse monitoring at the edge for an internet-facing service.
- Never use production COIs as issue attachments, test fixtures, screenshots, or demo data.
- Review dependencies and the CycloneDX SBOM attached to each tagged GitHub release.
- Verify downloaded assets with `sha256sum -c SHA256SUMS`, then verify GitHub's
  signed build provenance with
  `gh attestation verify opencoi-<version>.tar.gz --repo ajayasai/opencoi`.

The default image tag is local and is built from the checked-out source. It is not a substitute for a managed secrets service, encrypted storage, centralized monitoring, or an independently reviewed production architecture.

OpenCOI is licensed under `AGPL-3.0-only`. Operators who modify it and make it available over a network must preserve the license notices and provide remote users the Corresponding Source as required by the license, including section 13. Keep the deployed version's source link accurate and consult qualified counsel for licensing questions.
