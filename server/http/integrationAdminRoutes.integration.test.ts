import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import { hashPassword } from "../security.js";
import { publishDomainEvent } from "../services/domainEvents.js";
import { authenticateServiceAccount, createServiceAccount } from "../services/serviceAccounts.js";
import { createWebhookEndpoint } from "../services/webhooks.js";
import type { DocumentStore } from "../storage.js";

const ORIGIN = "https://coi.example.test";
const PASSWORD = "correct horse battery staple";

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  trustProxyHops: 0,
  appOrigin: ORIGIN,
  dataDirectory: "C:/tmp/opencoi-integration-admin-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-integration-admin-test/uploads",
  maxUploadBytes: 5 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1_000,
  uploadLinkTtlMs: 14 * 86_400_000,
  sessionCookieName: "opencoi_integration_admin_test",
  secureCookies: false,
  tokenPepper: "integration-admin-test-token-pepper-at-least-32-bytes",
  oidc: null,
  smtp: null,
  remindersEnabled: false,
  reminderPollMs: 60_000,
  bootstrap: null,
};

const unusedStore: DocumentStore = {
  putPdf: async () => {
    throw new Error("not used");
  },
  get: async () => {
    throw new Error("not used");
  },
  remove: async () => {
    throw new Error("not used");
  },
};

describe("integration administration routes", () => {
  let database: OpenCoiDatabase;
  let app: Express;

  beforeAll(async () => {
    database = openDatabase(":memory:");
    const passwordHash = await hashPassword(PASSWORD);
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin-a@example.test",
      administratorPasswordHash: passwordHash,
    });
    const timestamp = "2026-08-31T09:00:00.000Z";
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
      passwordHash,
      role: "owner",
    });
    app = createApp({
      config,
      database,
      documentStore: unusedStore,
      staticDirectory: false,
    });
  });

  afterAll(() => database.close());

  const login = async () => {
    const agent = request.agent(app);
    const response = await agent
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ email: "admin-a@example.test", password: PASSWORD })
      .expect(200);
    return { agent, csrf: response.body.data.csrfToken as string };
  };

  it("requires authentication, a trusted origin, and CSRF for credential changes", async () => {
    await request(app).get("/api/integrations/service-accounts").expect(401);
    const { agent, csrf } = await login();
    await agent
      .post("/api/integrations/service-accounts")
      .set("Origin", "https://evil.example.test")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Blocked", scopes: ["vendors:read"] })
      .expect(403);
    await agent
      .post("/api/integrations/service-accounts")
      .set("Origin", ORIGIN)
      .send({ name: "No CSRF", scopes: ["vendors:read"] })
      .expect(403);
  });

  it("shows a token once, isolates tenants, audits changes, and disables access immediately", async () => {
    createServiceAccount(database, {
      organizationId: "org-b",
      name: "Other tenant client",
      scopes: ["vendors:read"],
      createdByUserId: "admin-b",
      tokenPepper: config.tokenPepper,
      at: "2026-08-31T09:30:00.000Z",
    });
    const { agent, csrf } = await login();
    const created = await agent
      .post("/api/integrations/service-accounts")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({
        name: "Warehouse integration",
        description: "Reads vendors only",
        scopes: ["vendors:read"],
      })
      .expect(201);
    const accountId = created.body.data.account.id as string;
    const token = created.body.data.secret.token as string;
    expect(token).toMatch(/^ocoi_sk_[0-9a-f-]+\.[A-Za-z0-9_-]{43}$/i);
    expect(authenticateServiceAccount(database, token, config.tokenPepper)).toMatchObject({
      organizationId: "org-a",
      scopes: ["vendors:read"],
    });

    const listed = await agent.get("/api/integrations/service-accounts").expect(200);
    expect(listed.body.data).toEqual([
      expect.objectContaining({ id: accountId, name: "Warehouse integration" }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(JSON.stringify(listed.body)).not.toContain("Other tenant client");

    await agent
      .patch(`/api/integrations/service-accounts/${accountId}`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ status: "disabled" })
      .expect(204);
    expect(authenticateServiceAccount(database, token, config.tokenPepper)).toBeNull();
    const auditActions = database
      .prepare("SELECT action FROM audit_events WHERE organization_id = ? ORDER BY sequence_number")
      .all("org-a") as Array<{ action: string }>;
    expect(auditActions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["service_account.created", "service_account.status_changed"]),
    );
  });

  it("rejects private webhook targets before persisting a secret", async () => {
    const { agent, csrf } = await login();
    const response = await agent
      .post("/api/integrations/webhooks")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ url: "https://127.0.0.1/hook", eventTypes: ["vendor.created"] })
      .expect(400);
    expect(response.body.error).toContain("public IP addresses");
    expect(database.prepare("SELECT count(*) AS count FROM webhook_endpoints").get()).toEqual({
      count: 0,
    });
  });

  it("lists only tenant webhooks and audits disable and replay operations", async () => {
    const endpoint = createWebhookEndpoint(database, {
      organizationId: "org-a",
      url: "https://hooks.example.test/opencoi",
      eventTypes: ["vendor.created"],
      encryptionKey: config.tokenPepper as string,
      createdByUserId: "admin-a",
      at: "2026-08-31T09:45:00.000Z",
    }).endpoint;
    createWebhookEndpoint(database, {
      organizationId: "org-b",
      url: "https://other.example.test/opencoi",
      eventTypes: ["*"],
      encryptionKey: config.tokenPepper as string,
      createdByUserId: "admin-b",
      at: "2026-08-31T09:45:00.000Z",
    });
    publishDomainEvent(database, {
      organizationId: "org-a",
      type: "vendor.created",
      resourceType: "vendor",
      resourceId: "vendor-a",
      data: { legalName: "Synthetic Vendor" },
      actorType: "user",
      actorId: "admin-a",
      at: "2026-08-31T09:46:00.000Z",
    });
    const delivery = database
      .prepare("SELECT id FROM webhook_deliveries WHERE organization_id = ?")
      .get("org-a") as { id: string };
    database
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'failed', error_message = 'Synthetic failure'
         WHERE organization_id = ? AND id = ?`,
      )
      .run("org-a", delivery.id);

    const { agent, csrf } = await login();
    const listed = await agent.get("/api/integrations/webhooks").expect(200);
    expect(listed.body.data).toMatchObject({
      configured: true,
      endpoints: [expect.objectContaining({ id: endpoint.id, status: "active" })],
      deliveries: [expect.objectContaining({ id: delivery.id, status: "failed" })],
    });
    expect(JSON.stringify(listed.body)).not.toContain("other.example.test");

    await agent
      .patch(`/api/integrations/webhooks/${endpoint.id}`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ status: "disabled" })
      .expect(204);
    await agent
      .post(`/api/integrations/webhook-deliveries/${delivery.id}/replay`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({})
      .expect(202);
    expect(
      database
        .prepare(
          "SELECT status, attempt_count FROM webhook_deliveries WHERE organization_id = ? AND id = ?",
        )
        .get("org-a", delivery.id),
    ).toEqual({ status: "pending", attempt_count: 0 });
    const actions = database
      .prepare("SELECT action FROM audit_events WHERE organization_id = ? ORDER BY sequence_number")
      .all("org-a") as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["webhook_endpoint.status_changed", "webhook_delivery.replayed"]),
    );
  });
});
