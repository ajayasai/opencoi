import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import {
  type DomainEvent,
  getDomainEvent,
  listDomainEvents,
  publishDomainEvent,
} from "./domainEvents.js";
import { ensureIntegrationSchema } from "./integrationSchema.js";
import {
  authenticateServiceAccount,
  createServiceAccount,
  listServiceAccounts,
  revokeServiceAccountSecret,
  rotateServiceAccountSecret,
  setServiceAccountStatus,
} from "./serviceAccounts.js";
import {
  createWebhookEndpoint,
  createWebhookSigningSecret,
  isPublicWebhookAddress,
  listWebhookDeliveries,
  type PublicWebhookTarget,
  postWebhook,
  replayWebhookDelivery,
  resolvePublicWebhookTarget,
  runWebhookDeliveryBatch,
  signWebhookPayload,
  verifyWebhookSignature,
  type WebhookHttpResult,
} from "./webhooks.js";

const pepper = "test-only-integration-pepper-with-more-than-32-bytes";
const encryptionKey = "test-only-encryption-material-with-more-than-32-bytes";

describe("service accounts, events, and webhooks", () => {
  let database: OpenCoiDatabase;

  beforeEach(() => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin-a@example.test",
      administratorPasswordHash: "test-password-hash",
    });
    const timestamp = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO organizations (id, slug, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("org-b", "organization-b", "Organization B", timestamp, timestamp);
    createOrganizationRepository(database, "org-b").createUser({
      id: "admin-b",
      email: "admin-b@example.test",
      displayName: "Admin B",
      passwordHash: "test-password-hash",
      role: "owner",
    });
    ensureIntegrationSchema(database);
  });

  afterEach(() => database.close());

  it("installs the additive integration schema idempotently", () => {
    ensureIntegrationSchema(database);
    const names = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "service_accounts",
        "service_account_secrets",
        "webhook_endpoints",
        "domain_events",
        "webhook_deliveries",
        "api_idempotency_keys",
      ]),
    );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upgrades existing idempotency records with replayable response headers", () => {
    const issued = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Migration account",
      scopes: ["vendors:write"],
      tokenPepper: pepper,
    });
    database.exec(`
      DROP TABLE api_idempotency_keys;
      CREATE TABLE api_idempotency_keys (
        organization_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        response_status INTEGER NOT NULL,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, service_account_id, idempotency_key),
        FOREIGN KEY (organization_id, service_account_id)
          REFERENCES service_accounts(organization_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
    `);
    database
      .prepare(
        `INSERT INTO api_idempotency_keys
          (organization_id, service_account_id, idempotency_key, method, path,
           request_hash, response_status, response_json, created_at, expires_at)
         VALUES (?, ?, ?, 'POST', '/vendors', ?, 201, '{}', ?, ?)`,
      )
      .run(
        "org-a",
        issued.account.id,
        "migration-key",
        "a".repeat(64),
        "2030-01-01T10:00:00.000Z",
        "2030-01-02T10:00:00.000Z",
      );

    ensureIntegrationSchema(database);
    ensureIntegrationSchema(database);

    expect(
      database
        .prepare(
          `SELECT response_headers_json FROM api_idempotency_keys
           WHERE organization_id = ? AND service_account_id = ?`,
        )
        .get("org-a", issued.account.id),
    ).toEqual({ response_headers_json: "{}" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("issues a one-time scoped token, binds its tenant, rotates, and revokes", () => {
    const issued = createServiceAccount(database, {
      organizationId: "org-a",
      name: "ERP sync",
      scopes: ["vendors:read", "vendors:write", "vendors:read"],
      createdByUserId: "admin-a",
      tokenPepper: pepper,
      at: "2026-08-31T10:00:00.000Z",
    });
    expect(issued.secret.token).toMatch(/^ocoi_sk_/);
    expect(JSON.stringify(listServiceAccounts(database, "org-a"))).not.toContain(
      issued.secret.token,
    );
    expect(authenticateServiceAccount(database, issued.secret.token, pepper)).toMatchObject({
      id: issued.account.id,
      organizationId: "org-a",
      scopes: ["vendors:read", "vendors:write"],
    });
    expect(listServiceAccounts(database, "org-b")).toEqual([]);

    const replacement = rotateServiceAccountSecret(database, {
      organizationId: "org-a",
      serviceAccountId: issued.account.id,
      createdByUserId: "admin-a",
      tokenPepper: pepper,
    });
    expect(authenticateServiceAccount(database, replacement.token, pepper)?.organizationId).toBe(
      "org-a",
    );
    expect(revokeServiceAccountSecret(database, "org-a", issued.account.id, issued.secret.id)).toBe(
      true,
    );
    expect(authenticateServiceAccount(database, issued.secret.token, pepper)).toBeNull();
    expect(setServiceAccountStatus(database, "org-a", issued.account.id, "disabled")).toBe(true);
    expect(authenticateServiceAccount(database, replacement.token, pepper)).toBeNull();
  });

  it("rejects unknown scopes and expired credentials", () => {
    expect(() =>
      createServiceAccount(database, {
        organizationId: "org-a",
        name: "Overprivileged",
        scopes: ["root:all"],
        tokenPepper: pepper,
      }),
    ).toThrow(/valid service-account scope/);
    const issued = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Expired",
      scopes: ["vendors:read"],
      secretExpiresAt: "2026-08-30T00:00:00.000Z",
      tokenPepper: pepper,
    });
    expect(
      authenticateServiceAccount(database, issued.secret.token, pepper, "2026-08-31T00:00:00.000Z"),
    ).toBeNull();

    const offsetExpiry = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Offset expiry",
      scopes: ["vendors:read"],
      secretExpiresAt: "2030-01-01T12:00:00+05:30",
      tokenPepper: pepper,
      at: "2030-01-01T05:00:00.000Z",
    });
    expect(offsetExpiry.secret.expiresAt).toBe("2030-01-01T06:30:00.000Z");
    expect(
      authenticateServiceAccount(
        database,
        offsetExpiry.secret.token,
        pepper,
        "2030-01-01T10:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("uses append-only domain events and transactional endpoint fanout", () => {
    const endpoint = createWebhookEndpoint(database, {
      organizationId: "org-a",
      url: "https://hooks.example.test/opencoi",
      eventTypes: ["vendor.created"],
      encryptionKey,
      createdByUserId: "admin-a",
      at: "2026-08-31T10:00:00.000Z",
    });
    const event = publishDomainEvent(database, {
      organizationId: "org-a",
      type: "vendor.created",
      resourceType: "vendor",
      resourceId: "vendor-a",
      data: { legalName: "Vendor A" },
      actorType: "user",
      actorId: "admin-a",
      at: "2026-08-31T10:01:00.000Z",
    });
    expect(getDomainEvent(database, "org-a", event.id)).toEqual(event);
    expect(getDomainEvent(database, "org-b", event.id)).toBeNull();
    expect(listDomainEvents(database, "org-a")).toMatchObject({
      events: [event],
      hasMore: false,
    });
    expect(listWebhookDeliveries(database, "org-a")).toEqual([
      expect.objectContaining({
        endpoint_id: endpoint.endpoint.id,
        event_id: event.id,
        status: "pending",
      }),
    ]);
    expect(() =>
      database
        .prepare("UPDATE domain_events SET type = 'vendor.updated' WHERE id = ?")
        .run(event.id),
    ).toThrow(/append-only/);
    expect(() => database.prepare("DELETE FROM domain_events WHERE id = ?").run(event.id)).toThrow(
      /append-only/,
    );
  });

  it("delivers signed envelopes, retries failures, dead-letters, and permits replay", async () => {
    createWebhookEndpoint(database, {
      organizationId: "org-a",
      url: "https://hooks.example.test/opencoi",
      eventTypes: ["*"],
      encryptionKey,
    });
    const event = publishDomainEvent(database, {
      organizationId: "org-a",
      type: "certificate.confirmed",
      resourceType: "certificate",
      resourceId: "certificate-a",
      data: { status: "non_compliant" },
      actorType: "service_account",
      actorId: "sync-a",
      at: "2026-08-31T10:00:00.000Z",
    });
    const deliver = vi.fn(
      async (
        _target: PublicWebhookTarget,
        deliveredEvent: DomainEvent,
        secret: string,
      ): Promise<WebhookHttpResult> => {
        expect(
          verifyWebhookSignature(
            secret,
            deliveredEvent.id,
            1,
            JSON.stringify(deliveredEvent),
            signWebhookPayload(secret, deliveredEvent.id, 1, JSON.stringify(deliveredEvent)),
          ),
        ).toBe(true);
        return { ok: true, status: 204, bodyExcerpt: "" };
      },
    );
    const result = await runWebhookDeliveryBatch(database, encryptionKey, {
      now: new Date("2026-08-31T10:00:01.000Z"),
      resolveTarget: async (url) => ({ url: new URL(url), address: "203.0.114.10", family: 4 }),
      deliver,
    });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(deliver).toHaveBeenCalledWith(
      expect.anything(),
      event,
      expect.stringMatching(/^whsec_/),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(listWebhookDeliveries(database, "org-a")[0]).toMatchObject({
      status: "succeeded",
      attempt_count: 1,
    });

    const second = publishDomainEvent(database, {
      organizationId: "org-a",
      type: "vendor.updated",
      resourceType: "vendor",
      resourceId: "vendor-a",
      data: { status: "inactive" },
      actorType: "system",
      at: "2026-08-31T10:30:00.000Z",
    });
    const delivery = listWebhookDeliveries(database, "org-a").find(
      (row) => row.event_id === second.id,
    );
    if (!delivery) throw new Error("Expected a webhook delivery");
    database
      .prepare(
        "UPDATE webhook_deliveries SET attempt_count = 7 WHERE organization_id = ? AND id = ?",
      )
      .run("org-a", String(delivery.id));
    const failed = await runWebhookDeliveryBatch(database, encryptionKey, {
      now: new Date("2026-08-31T11:00:00.000Z"),
      resolveTarget: async (url) => ({ url: new URL(url), address: "203.0.114.10", family: 4 }),
      deliver: async () => ({
        ok: false,
        status: 503,
        bodyExcerpt: "unavailable",
        error: "HTTP 503",
      }),
    });
    expect(failed.deadLettered).toBe(1);
    const dead = listWebhookDeliveries(database, "org-a").find((row) => row.event_id === second.id);
    expect(dead).toMatchObject({ status: "dead_letter", attempt_count: 8, response_status: 503 });
    expect(replayWebhookDelivery(database, "org-a", String(dead?.id))).toBe(true);
    expect(
      listWebhookDeliveries(database, "org-a").find((row) => row.id === dead?.id),
    ).toMatchObject({
      status: "pending",
      attempt_count: 0,
    });
  });

  it("dead-letters a stale final-attempt claim instead of stranding it as failed", async () => {
    createWebhookEndpoint(database, {
      organizationId: "org-a",
      url: "https://hooks.example.test/opencoi",
      eventTypes: ["*"],
      encryptionKey,
    });
    publishDomainEvent(database, {
      organizationId: "org-a",
      type: "vendor.created",
      resourceType: "vendor",
      resourceId: "vendor-a",
      data: {},
      actorType: "system",
      at: "2030-01-01T10:00:00.000Z",
    });
    const delivery = listWebhookDeliveries(database, "org-a")[0];
    database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'processing', attempt_count = 8, claim_token = 'crashed-worker',
             claimed_at = '2030-01-01T10:00:00.000Z'
         WHERE organization_id = ? AND id = ?`,
      )
      .run("org-a", String(delivery?.id));

    const result = await runWebhookDeliveryBatch(database, encryptionKey, {
      now: new Date("2030-01-01T10:06:00.000Z"),
      resolveTarget: async () => {
        throw new Error("A final stale claim must not be delivered again");
      },
    });

    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0, deadLettered: 1 });
    expect(listWebhookDeliveries(database, "org-a")[0]).toMatchObject({
      status: "dead_letter",
      attempt_count: 8,
      error_message: "Delivery claim expired before completion",
    });
  });

  it("enforces an absolute webhook deadline even while a receiver trickles data", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      let sent = 0;
      const timer = setInterval(() => {
        response.write(".");
        sent += 1;
        if (sent >= 20) {
          clearInterval(timer);
          response.end();
        }
      }, 40);
      response.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const startedAt = Date.now();
    try {
      const result = await postWebhook(
        {
          url: new URL(`http://receiver.example.test:${address.port}/hook`),
          address: "127.0.0.1",
          family: 4,
        },
        {
          id: "deadline-event",
          sequence: 1,
          type: "vendor.created",
          occurredAt: "2030-01-01T10:00:00.000Z",
          resource: { type: "vendor", id: "vendor-a" },
          data: {},
        },
        createWebhookSigningSecret(),
        { timeoutMs: 100 },
      );
      expect(result.ok).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(600);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("includes destination resolution in the delivery-attempt deadline", async () => {
    createWebhookEndpoint(database, {
      organizationId: "org-a",
      url: "https://hooks.example.test/opencoi",
      eventTypes: ["*"],
      encryptionKey,
    });
    publishDomainEvent(database, {
      organizationId: "org-a",
      type: "vendor.created",
      resourceType: "vendor",
      resourceId: "vendor-a",
      data: {},
      actorType: "system",
      at: "2030-01-01T10:00:00.000Z",
    });
    const deliver = vi.fn(
      async (): Promise<WebhookHttpResult> => ({
        ok: true,
        status: 204,
        bodyExcerpt: "",
      }),
    );
    const startedAt = Date.now();

    const result = await runWebhookDeliveryBatch(database, encryptionKey, {
      now: new Date("2030-01-01T10:00:01.000Z"),
      timeoutMs: 75,
      resolveTarget: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                url: new URL("https://hooks.example.test/opencoi"),
                address: "203.0.114.10",
                family: 4,
              }),
            250,
          ),
        ),
      deliver,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 0 });
    expect(deliver).not.toHaveBeenCalled();
    expect(listWebhookDeliveries(database, "org-a")[0]).toMatchObject({
      status: "failed",
      attempt_count: 1,
      error_message: "Webhook attempt exceeded its deadline",
    });
  });

  it("rejects private, loopback, link-local, documentation, and mixed DNS answers", async () => {
    expect(isPublicWebhookAddress("8.8.8.8")).toBe(true);
    expect(isPublicWebhookAddress("2606:4700:4700::1111")).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.1.1",
      "192.168.1.1",
      "::1",
      "::ffff:8.8.8.8",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "100::1",
      "fd00::1",
      "fec0::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "2620:4f:8000::1",
      "3fff::1",
    ]) {
      expect(isPublicWebhookAddress(address)).toBe(false);
    }
    await expect(resolvePublicWebhookTarget("http://example.com/hook")).rejects.toThrow(/HTTPS/);
    await expect(resolvePublicWebhookTarget("https://127.0.0.1/hook")).rejects.toThrow(/public/);
    await expect(
      resolvePublicWebhookTarget("https://hooks.example.test/hook", {
        lookup: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow(/public/);
    await expect(
      resolvePublicWebhookTarget("https://hooks.example.test/hook", {
        lookup: async () => [{ address: "fec0::1", family: 6 }],
      }),
    ).rejects.toThrow(/public/);
    await expect(
      resolvePublicWebhookTarget("https://hooks.example.test/hook", {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
    ).resolves.toMatchObject({ address: "8.8.8.8", family: 4 });
  });
});
