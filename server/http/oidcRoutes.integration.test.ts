import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { OidcProtocol } from "../auth/oidc.js";
import type { AppConfig } from "../config.js";
import { bootstrapOrganization, type OpenCoiDatabase, openDatabase } from "../db.js";
import { hashPassword } from "../security.js";
import { type DocumentStore, inspectPdf, type StoredDocument } from "../storage.js";
import { oidcTransactionCookieOptions } from "./oidcRoutes.js";

const ORIGIN = "https://coi.example.test";
const ISSUER = "https://identity.example.test/tenant";
const PASSWORD = "correct horse battery staple";
const STATE = "route-state".padEnd(43, "s");

class MemoryDocumentStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();

  async putPdf(input: Uint8Array): Promise<StoredDocument> {
    const inspection = inspectPdf(input);
    const id = randomUUID();
    const bytes = Buffer.from(input);
    const storageKey = `${id}.pdf`;
    this.files.set(storageKey, bytes);
    return {
      storageKey,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      detectedMime: "application/pdf",
      pageCount: inspection.pageCountEstimate,
    };
  }

  async get(storageKey: string): Promise<Buffer> {
    const value = this.files.get(storageKey);
    if (!value) throw new Error("missing test document");
    return value;
  }

  async remove(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  trustProxyHops: 0,
  appOrigin: ORIGIN,
  dataDirectory: "C:/tmp/opencoi-oidc-route-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-oidc-route-test/uploads",
  maxUploadBytes: 5 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1000,
  uploadLinkTtlMs: 14 * 86_400_000,
  sessionCookieName: "opencoi_test_session",
  secureCookies: false,
  tokenPepper: "oidc-route-test-token-pepper-at-least-32-bytes",
  oidc: {
    issuer: ISSUER,
    clientId: "opencoi-client",
    clientSecret: "provider-secret",
    clientAuthMethod: "client_secret_basic",
    organizationSlug: "organization-a",
    displayName: "Company SSO",
    transactionTtlMs: 10 * 60_000,
  },
  smtp: null,
  remindersEnabled: false,
  reminderPollMs: 60_000,
  bootstrap: null,
};

describe("OIDC HTTP flow", () => {
  let database: OpenCoiDatabase;
  let app: Express;
  const store = new MemoryDocumentStore();
  const protocol: OidcProtocol = {
    createAuthorizationRequest: vi.fn().mockResolvedValue({
      authorizationUrl: `https://identity.example.test/authorize?state=${STATE}`,
      state: STATE,
      nonce: "route-nonce".padEnd(43, "n"),
      codeVerifier: "route-verifier".padEnd(64, "v"),
    }),
    exchangeAuthorizationCode: vi.fn().mockResolvedValue({
      issuer: ISSUER,
      subject: "employee-123",
      email: "admin-a@example.test",
      emailVerified: true,
    }),
  };

  beforeAll(async () => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin-a@example.test",
      administratorPasswordHash: await hashPassword(PASSWORD),
    });
    app = createApp({
      config,
      database,
      documentStore: store,
      staticDirectory: false,
      oidcProtocol: protocol,
    });
  });

  afterAll(() => database.close());

  it("reports the configured organization without exposing provider credentials", async () => {
    const response = await request(app).get("/api/auth/oidc/config").expect(200);
    expect(response.body).toEqual({
      data: {
        enabled: true,
        displayName: "Company SSO",
        organizationName: "Organization A",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("provider-secret");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("requires a trusted origin and issues a narrow Lax transaction cookie", async () => {
    await request(app)
      .post("/api/auth/oidc/start")
      .set("Origin", "https://evil.example.test")
      .send({})
      .expect(403);

    const response = await request(app)
      .post("/api/auth/oidc/start")
      .set("Origin", ORIGIN)
      .send({})
      .expect(200);
    expect(response.body.data.authorizationUrl).toContain("https://identity.example.test/");
    const cookie = (response.headers["set-cookie"] as unknown as string[]).find((value) =>
      value.startsWith("opencoi_test_session_oidc="),
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/auth/oidc/callback");
    expect(cookie).not.toContain("provider-secret");
    expect(oidcTransactionCookieOptions({ ...config, secureCookies: true }).secure).toBe(true);
  });

  it("rejects state substitution generically, then creates strict existing app sessions", async () => {
    const failedAgent = request.agent(app);
    await failedAgent.post("/api/auth/oidc/start").set("Origin", ORIGIN).send({}).expect(200);
    const failed = await failedAgent
      .get(`/api/auth/oidc/callback?code=bad-code&state=${"x".repeat(43)}`)
      .expect(303);
    expect(failed.headers.location).toBe("/login?sso=failed");
    expect(protocol.exchangeAuthorizationCode).not.toHaveBeenCalled();

    const agent = request.agent(app);
    const started = await agent
      .post("/api/auth/oidc/start")
      .set("Origin", ORIGIN)
      .send({})
      .expect(200);
    const oidcCookie = (started.headers["set-cookie"] as unknown as string[]).find((value) =>
      value.startsWith("opencoi_test_session_oidc="),
    ) as string;
    const cookiePair = oidcCookie.split(";", 1)[0] as string;
    const callback = await agent
      .get(`/api/auth/oidc/callback?code=one-use-code&state=${STATE}`)
      .expect(303);
    expect(callback.headers.location).toBe("/login?sso=success");
    const cookies = callback.headers["set-cookie"] as unknown as string[];
    const clearedTransactionCookie = cookies.find((value) =>
      value.startsWith("opencoi_test_session_oidc="),
    );
    expect(clearedTransactionCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(clearedTransactionCookie).not.toContain("Max-Age");
    expect(cookies.find((value) => value.startsWith("opencoi_test_session="))).toContain(
      "SameSite=Strict",
    );
    expect(cookies.find((value) => value.startsWith("opencoi_test_session_csrf="))).toContain(
      "SameSite=Strict",
    );
    expect(cookies.find((value) => value.startsWith("opencoi_test_session="))).toContain(
      "HttpOnly",
    );
    expect(cookies.find((value) => value.startsWith("opencoi_test_session_csrf="))).not.toContain(
      "HttpOnly",
    );
    expect(await agent.get("/api/auth/me").expect(200)).toMatchObject({
      body: { data: { id: "admin-a", organizationId: "org-a" } },
    });

    const replay = await request(app)
      .get(`/api/auth/oidc/callback?code=replayed-code&state=${STATE}`)
      .set("Cookie", cookiePair)
      .expect(303);
    expect(replay.headers.location).toBe("/login?sso=failed");
    expect(protocol.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("preserves local password login as a break-glass path", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ email: "admin-a@example.test", password: PASSWORD })
      .expect(200);
    expect(response.body.data).toMatchObject({ id: "admin-a", organizationId: "org-a" });
  });
});
