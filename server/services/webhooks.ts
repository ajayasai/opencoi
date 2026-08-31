import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { OpenCoiDatabase } from "../db.js";
import { decryptSecret, encryptSecret } from "../security/secrets.js";
import { type DomainEvent, domainEventFromRow } from "./domainEvents.js";

const MAX_ATTEMPTS = 8;
const RESPONSE_BODY_LIMIT = 64 * 1024;
const RESPONSE_EXCERPT_LIMIT = 2_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const STALE_CLAIM_MS = 5 * 60 * 1_000;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const validatedTimeout = (value = DEFAULT_TIMEOUT_MS): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError("Webhook timeout must be between 1 and 60000 milliseconds");
  }
  return value;
};

export interface WebhookEndpointRow {
  id: string;
  organization_id: string;
  url: string;
  description: string | null;
  event_types_json: string;
  signing_secret_ciphertext: string;
  status: "active" | "disabled";
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ClaimedDeliveryRow {
  id: string;
  organization_id: string;
  endpoint_id: string;
  event_id: string;
  status: "processing";
  attempt_count: number;
  claim_token: string;
  endpoint_url: string;
  signing_secret_ciphertext: string;
  event_sequence_number: number;
  event_type: string;
  event_resource_type: string;
  event_resource_id: string | null;
  event_payload_json: string;
  event_actor_type: "user" | "service_account" | "system";
  event_actor_id: string | null;
  event_occurred_at: string;
}

export interface WebhookHttpResult {
  ok: boolean;
  status: number | null;
  bodyExcerpt: string;
  error?: string;
}

export interface PublicWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

const encryptionContext = (organizationId: string, endpointId: string): string =>
  `${organizationId}:webhook_endpoint:${endpointId}:signing_secret`;

const signingKey = (secret: string): Buffer => {
  if (!secret.startsWith("whsec_")) throw new TypeError("Webhook signing secret is malformed");
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  if (key.length !== 32) throw new TypeError("Webhook signing secret is malformed");
  return key;
};

export const createWebhookSigningSecret = (): string =>
  `whsec_${randomBytes(32).toString("base64")}`;

/** Sign the exact bytes sent over HTTP using the Standard Webhooks convention. */
export const signWebhookPayload = (
  secret: string,
  messageId: string,
  timestampSeconds: number,
  payload: string,
): string => {
  if (!messageId || !Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new TypeError("Webhook message id and timestamp are required");
  }
  const signedContent = `${messageId}.${timestampSeconds}.${payload}`;
  return `v1,${createHmac("sha256", signingKey(secret)).update(signedContent).digest("base64")}`;
};

export const verifyWebhookSignature = (
  secret: string,
  messageId: string,
  timestampSeconds: number,
  payload: string,
  signature: string,
): boolean => {
  try {
    const expected = signWebhookPayload(secret, messageId, timestampSeconds, payload);
    const actualBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return (
      actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    );
  } catch {
    return false;
  }
};

const isDisallowedIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const ipv6Integer = (address: string): bigint => {
  let value = address.toLowerCase().split("%")[0] ?? "";
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const octets = ipv4Tail.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, -ipv4Tail.length)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) throw new TypeError("IPv6 address is invalid");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new TypeError("IPv6 address is invalid");
  }
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    throw new TypeError("IPv6 address is invalid");
  }
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
};

const ipv6Prefix = (address: string, prefix: string, bits: number): boolean => {
  const shift = 128n - BigInt(bits);
  return ipv6Integer(address) >> shift === ipv6Integer(prefix) >> shift;
};

/**
 * Permit ordinary global-unicast IPv6 only. The exclusions are IANA special
 * assignments inside 2000::/3, including transition and documentation ranges.
 * Everything outside 2000::/3 (mapped IPv4, NAT64, discard, ULA, site/link
 * local, multicast, and other reserved space) fails closed.
 */
const isDisallowedIpv6 = (address: string): boolean =>
  !ipv6Prefix(address, "2000::", 3) ||
  ipv6Prefix(address, "2001::", 23) ||
  ipv6Prefix(address, "2001:db8::", 32) ||
  ipv6Prefix(address, "2002::", 16) ||
  ipv6Prefix(address, "2620:4f:8000::", 48) ||
  ipv6Prefix(address, "3fff::", 20);

export const isPublicWebhookAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !isDisallowedIpv4(address);
  if (family === 6) return !isDisallowedIpv6(address);
  return false;
};

type Lookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const defaultLookup: Lookup = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/** Resolve once, reject every private/special answer, and pin the selected IP. */
export const resolvePublicWebhookTarget = async (
  value: string,
  options: { allowHttp?: boolean; lookup?: Lookup } = {},
): Promise<PublicWebhookTarget> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Webhook URL must be absolute");
  }
  const permittedProtocols = options.allowHttp ? new Set(["https:", "http:"]) : new Set(["https:"]);
  if (
    !permittedProtocols.has(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname
  ) {
    throw new TypeError("Webhook URL must be a credential-free public HTTPS URL");
  }
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await (options.lookup ?? defaultLookup)(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) => ![4, 6].includes(family) || !isPublicWebhookAddress(address),
    )
  ) {
    throw new TypeError("Webhook hostname must resolve only to public IP addresses");
  }
  const selected = addresses[0] as { address: string; family: 4 | 6 };
  return { url, address: selected.address, family: selected.family };
};

export const createWebhookEndpoint = (
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    url: string;
    eventTypes: readonly string[];
    encryptionKey: string;
    description?: string;
    createdByUserId?: string;
    at?: string;
  },
): { endpoint: WebhookEndpointRow; signingSecret: string } => {
  const eventTypes = [...new Set(input.eventTypes)].sort();
  if (
    eventTypes.length === 0 ||
    eventTypes.length > 100 ||
    eventTypes.some((type) => type !== "*" && !EVENT_TYPE_PATTERN.test(type))
  ) {
    throw new TypeError("At least one valid webhook event type is required");
  }
  const id = randomUUID();
  const at = input.at ?? new Date().toISOString();
  const signingSecret = createWebhookSigningSecret();
  const ciphertext = encryptSecret(
    signingSecret,
    input.encryptionKey,
    encryptionContext(input.organizationId, id),
  );
  database
    .prepare(
      `INSERT INTO webhook_endpoints
        (id, organization_id, url, description, event_types_json,
         signing_secret_ciphertext, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.organizationId,
      input.url,
      input.description?.trim() || null,
      JSON.stringify(eventTypes),
      ciphertext,
      input.createdByUserId ?? null,
      at,
      at,
    );
  const endpoint = database
    .prepare("SELECT * FROM webhook_endpoints WHERE organization_id = ? AND id = ?")
    .get(input.organizationId, id) as unknown as WebhookEndpointRow;
  return { endpoint, signingSecret };
};

export const listWebhookEndpoints = (
  database: OpenCoiDatabase,
  organizationId: string,
): Array<
  Omit<WebhookEndpointRow, "signing_secret_ciphertext" | "event_types_json"> & {
    eventTypes: string[];
  }
> => {
  const rows = database
    .prepare(
      "SELECT * FROM webhook_endpoints WHERE organization_id = ? ORDER BY created_at DESC, id",
    )
    .all(organizationId) as unknown as WebhookEndpointRow[];
  return rows.map(({ signing_secret_ciphertext: _secret, event_types_json: encoded, ...row }) => ({
    ...row,
    eventTypes: JSON.parse(encoded) as string[],
  }));
};

export const setWebhookEndpointStatus = (
  database: OpenCoiDatabase,
  organizationId: string,
  endpointId: string,
  status: WebhookEndpointRow["status"],
  at = new Date().toISOString(),
): boolean =>
  Number(
    database
      .prepare(
        "UPDATE webhook_endpoints SET status = ?, updated_at = ? WHERE organization_id = ? AND id = ?",
      )
      .run(status, at, organizationId, endpointId).changes,
  ) === 1;

export const replayWebhookDelivery = (
  database: OpenCoiDatabase,
  organizationId: string,
  deliveryId: string,
  at = new Date().toISOString(),
): boolean =>
  Number(
    database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'pending', attempt_count = 0, next_attempt_at = ?, claim_token = NULL,
             claimed_at = NULL, response_status = NULL, response_body_excerpt = NULL,
             error_message = NULL, delivered_at = NULL, updated_at = ?
         WHERE organization_id = ? AND id = ? AND status IN ('failed', 'dead_letter')`,
      )
      .run(at, at, organizationId, deliveryId).changes,
  ) === 1;

export const listWebhookDeliveries = (
  database: OpenCoiDatabase,
  organizationId: string,
  limit = 100,
): Record<string, unknown>[] =>
  database
    .prepare(
      `SELECT d.id, d.endpoint_id, d.event_id, d.status, d.attempt_count,
              d.next_attempt_at, d.response_status, d.response_body_excerpt,
              d.error_message, d.delivered_at, d.created_at, d.updated_at,
              e.type AS event_type, w.url AS endpoint_url
       FROM webhook_deliveries d
       JOIN domain_events e ON e.organization_id = d.organization_id AND e.id = d.event_id
       JOIN webhook_endpoints w ON w.organization_id = d.organization_id AND w.id = d.endpoint_id
       WHERE d.organization_id = ? ORDER BY d.created_at DESC, d.id LIMIT ?`,
    )
    .all(organizationId, Math.min(Math.max(limit, 1), 250)) as Record<string, unknown>[];

const eventForDelivery = (row: ClaimedDeliveryRow): DomainEvent =>
  domainEventFromRow({
    id: row.event_id,
    organization_id: row.organization_id,
    sequence_number: row.event_sequence_number,
    type: row.event_type,
    resource_type: row.event_resource_type,
    resource_id: row.event_resource_id,
    payload_json: row.event_payload_json,
    actor_type: row.event_actor_type,
    actor_id: row.event_actor_id,
    occurred_at: row.event_occurred_at,
  });

interface DeliveryCandidate {
  id: string;
  organization_id: string;
}

const recoverStaleDeliveries = (database: OpenCoiDatabase, now: Date): number => {
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const recoveredDeadLettered = (
      database
        .prepare(
          `SELECT count(*) AS count FROM webhook_deliveries
           WHERE status = 'processing' AND claimed_at < ? AND attempt_count >= ?`,
        )
        .get(staleBefore, MAX_ATTEMPTS) as { count: number }
    ).count;
    database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = CASE WHEN attempt_count >= ? THEN 'dead_letter' ELSE 'failed' END,
             claim_token = NULL, claimed_at = NULL,
             error_message = 'Delivery claim expired before completion',
             next_attempt_at = ?, updated_at = ?
         WHERE status = 'processing' AND claimed_at < ?`,
      )
      .run(MAX_ATTEMPTS, at, at, staleBefore);
    database.exec("COMMIT");
    return recoveredDeadLettered;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
};

const dueDeliveryCandidates = (
  database: OpenCoiDatabase,
  now: Date,
  limit: number,
): DeliveryCandidate[] =>
  database
    .prepare(
      `SELECT d.organization_id, d.id FROM webhook_deliveries d
       JOIN webhook_endpoints w
         ON w.organization_id = d.organization_id AND w.id = d.endpoint_id
       WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at <= ?
         AND d.attempt_count < ? AND w.status = 'active'
       ORDER BY d.next_attempt_at, d.created_at, d.id LIMIT ?`,
    )
    .all(
      now.toISOString(),
      MAX_ATTEMPTS,
      Math.min(Math.max(limit, 1), 100),
    ) as unknown as DeliveryCandidate[];

/**
 * Lease exactly one due row immediately before its network attempt. Candidate
 * discovery deliberately does not reserve work, so a slow delivery cannot
 * make the rest of a batch appear stale to another worker.
 */
const claimDelivery = (
  database: OpenCoiDatabase,
  candidate: DeliveryCandidate,
  now: Date,
): ClaimedDeliveryRow | null => {
  const at = now.toISOString();
  const claimToken = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    const changed = database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'processing', attempt_count = attempt_count + 1,
             claim_token = ?, claimed_at = ?, updated_at = ?
         WHERE organization_id = ? AND id = ?
           AND status IN ('pending', 'failed') AND next_attempt_at <= ?
           AND attempt_count < ?
           AND EXISTS (
             SELECT 1 FROM webhook_endpoints w
             WHERE w.organization_id = webhook_deliveries.organization_id
               AND w.id = webhook_deliveries.endpoint_id AND w.status = 'active'
           )`,
      )
      .run(claimToken, at, at, candidate.organization_id, candidate.id, at, MAX_ATTEMPTS);
    const row =
      Number(changed.changes) === 1
        ? (database
            .prepare(
              `SELECT d.*, w.url AS endpoint_url,
                      w.signing_secret_ciphertext AS signing_secret_ciphertext,
                      e.sequence_number AS event_sequence_number, e.type AS event_type,
                      e.resource_type AS event_resource_type, e.resource_id AS event_resource_id,
                      e.payload_json AS event_payload_json, e.actor_type AS event_actor_type,
                      e.actor_id AS event_actor_id, e.occurred_at AS event_occurred_at
               FROM webhook_deliveries d
               JOIN webhook_endpoints w
                 ON w.organization_id = d.organization_id AND w.id = d.endpoint_id
               JOIN domain_events e
                 ON e.organization_id = d.organization_id AND e.id = d.event_id
               WHERE d.organization_id = ? AND d.id = ? AND d.claim_token = ?
                 AND d.status = 'processing' AND w.status = 'active'`,
            )
            .get(candidate.organization_id, candidate.id, claimToken) as
            | ClaimedDeliveryRow
            | undefined)
        : undefined;
    if (Number(changed.changes) === 1 && !row) {
      throw new Error("Claimed webhook delivery could not be loaded");
    }
    database.exec("COMMIT");
    return row ?? null;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
};

const webhookEndpointIsActive = (
  database: OpenCoiDatabase,
  organizationId: string,
  endpointId: string,
): boolean =>
  Boolean(
    database
      .prepare(
        `SELECT 1 FROM webhook_endpoints
         WHERE organization_id = ? AND id = ? AND status = 'active'`,
      )
      .get(organizationId, endpointId),
  );

const releaseDisabledClaim = (
  database: OpenCoiDatabase,
  row: ClaimedDeliveryRow,
  now: Date,
): boolean =>
  Number(
    database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = CASE WHEN attempt_count > 1 THEN 'failed' ELSE 'pending' END,
             attempt_count = max(attempt_count - 1, 0),
             claim_token = NULL, claimed_at = NULL, updated_at = ?
         WHERE organization_id = ? AND id = ? AND status = 'processing'
           AND claim_token = ?`,
      )
      .run(now.toISOString(), row.organization_id, row.id, row.claim_token).changes,
  ) === 1;

export const postWebhook = async (
  target: PublicWebhookTarget,
  event: DomainEvent,
  secret: string,
  options: { timeoutMs?: number; now?: Date; signal?: AbortSignal } = {},
): Promise<WebhookHttpResult> => {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const signature = signWebhookPayload(secret, event.id, timestamp, payload);
  const timeoutMs = validatedTimeout(options.timeoutMs);
  if (options.signal?.aborted) {
    return { ok: false, status: null, bodyExcerpt: "", error: "Webhook delivery was aborted" };
  }
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;
    let removeAbortListener = () => {};
    const finish = (result: WebhookHttpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      removeAbortListener();
      resolve(result);
    };
    const requestFunction = target.url.protocol === "https:" ? https.request : http.request;
    const request = requestFunction(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        family: target.family,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        servername: target.url.hostname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          host: target.url.host,
          "user-agent": "OpenCOI-Webhooks/1.0",
          "webhook-id": event.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received <= RESPONSE_EXCERPT_LIMIT) chunks.push(chunk);
          if (received > RESPONSE_BODY_LIMIT)
            response.destroy(new Error("Webhook response is too large"));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          finish({
            ok: status >= 200 && status < 300,
            status,
            bodyExcerpt: Buffer.concat(chunks).subarray(0, RESPONSE_EXCERPT_LIMIT).toString("utf8"),
            ...(status >= 200 && status < 300 ? {} : { error: `HTTP ${status}` }),
          });
        });
        response.on("error", (error) =>
          finish({
            ok: false,
            status: response.statusCode ?? null,
            bodyExcerpt: "",
            error: error.message,
          }),
        );
      },
    );
    deadline = setTimeout(
      () => request.destroy(new Error("Webhook request exceeded its absolute deadline")),
      timeoutMs,
    );
    if (options.signal) {
      const onAbort = () => request.destroy(new Error("Webhook delivery was aborted"));
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }
    request.on("timeout", () => request.destroy(new Error("Webhook request timed out")));
    request.on("error", (error) =>
      finish({ ok: false, status: null, bodyExcerpt: "", error: error.message }),
    );
    request.end(payload);
  });
};

const retryAt = (now: Date, attempt: number): string => {
  const delaysSeconds = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 8 * 60 * 60, 24 * 60 * 60];
  const delay =
    delaysSeconds[Math.min(Math.max(attempt - 1, 0), delaysSeconds.length - 1)] ?? 86_400;
  return new Date(now.getTime() + delay * 1_000).toISOString();
};

const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(new Error("Webhook attempt exceeded its deadline"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("Webhook attempt exceeded its deadline"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
};

export const runWebhookDeliveryBatch = async (
  database: OpenCoiDatabase,
  encryptionKey: string,
  options: {
    limit?: number;
    now?: Date;
    clock?: () => Date;
    timeoutMs?: number;
    resolveTarget?: typeof resolvePublicWebhookTarget;
    deliver?: typeof postWebhook;
  } = {},
): Promise<{ claimed: number; succeeded: number; failed: number; deadLettered: number }> => {
  const clock =
    options.clock ?? (options.now ? () => new Date(options.now?.getTime() ?? 0) : () => new Date());
  const batchStartedAt = clock();
  const timeoutMs = validatedTimeout(options.timeoutMs);
  const recoveredDeadLettered = recoverStaleDeliveries(database, batchStartedAt);
  const candidates = dueDeliveryCandidates(database, batchStartedAt, options.limit ?? 20);
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  let deadLettered = recoveredDeadLettered;
  for (const candidate of candidates) {
    const attemptAt = clock();
    const row = claimDelivery(database, candidate, attemptAt);
    if (!row) continue;
    claimed += 1;
    let result: WebhookHttpResult;
    let disabledBeforeSend = false;
    const startedAt = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const secret = decryptSecret(
        row.signing_secret_ciphertext,
        encryptionKey,
        encryptionContext(row.organization_id, row.endpoint_id),
      );
      const target = await abortable(
        (options.resolveTarget ?? resolvePublicWebhookTarget)(row.endpoint_url),
        controller.signal,
      );
      // Endpoint administration can race with DNS resolution. Recheck after
      // resolving and immediately before the first external side effect.
      if (!webhookEndpointIsActive(database, row.organization_id, row.endpoint_id)) {
        disabledBeforeSend = true;
        result = {
          ok: false,
          status: null,
          bodyExcerpt: "",
          error: "Webhook endpoint was disabled before delivery",
        };
      } else {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs < 1) throw new Error("Webhook attempt exceeded its deadline");
        result = await abortable(
          (options.deliver ?? postWebhook)(target, eventForDelivery(row), secret, {
            timeoutMs: remainingMs,
            now: attemptAt,
            signal: controller.signal,
          }),
          controller.signal,
        );
      }
    } catch (error) {
      result = {
        ok: false,
        status: null,
        bodyExcerpt: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(deadline);
    }
    const completedAt = clock();
    if (disabledBeforeSend) {
      if (releaseDisabledClaim(database, row, completedAt)) claimed -= 1;
      continue;
    }
    const at = completedAt.toISOString();
    if (result.ok) {
      const changed = database
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'succeeded', claim_token = NULL, claimed_at = NULL,
               response_status = ?, response_body_excerpt = ?, error_message = NULL,
               delivered_at = ?, updated_at = ?
           WHERE organization_id = ? AND id = ? AND claim_token = ?`,
        )
        .run(
          result.status,
          result.bodyExcerpt,
          at,
          at,
          row.organization_id,
          row.id,
          row.claim_token,
        );
      if (Number(changed.changes) === 1) succeeded += 1;
      continue;
    }
    const isDeadLetter = row.attempt_count >= MAX_ATTEMPTS;
    const changed = database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?, claim_token = NULL, claimed_at = NULL, response_status = ?,
             response_body_excerpt = ?, error_message = ?, next_attempt_at = ?, updated_at = ?
         WHERE organization_id = ? AND id = ? AND claim_token = ?`,
      )
      .run(
        isDeadLetter ? "dead_letter" : "failed",
        result.status,
        result.bodyExcerpt,
        result.error?.slice(0, 2_000) ?? "Webhook delivery failed",
        retryAt(completedAt, row.attempt_count),
        at,
        row.organization_id,
        row.id,
        row.claim_token,
      );
    if (Number(changed.changes) === 1) {
      if (isDeadLetter) deadLettered += 1;
      else failed += 1;
    }
  }
  return { claimed, succeeded, failed, deadLettered };
};
