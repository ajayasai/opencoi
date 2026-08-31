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
import { createServiceAccount } from "../services/serviceAccounts.js";
import type { DocumentStore } from "../storage.js";

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  trustProxyHops: 0,
  appOrigin: "http://localhost:5173",
  dataDirectory: "C:/tmp/opencoi-api-v1-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-api-v1-test/uploads",
  maxUploadBytes: 5 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1_000,
  uploadLinkTtlMs: 14 * 86_400_000,
  sessionCookieName: "opencoi_api_v1_test",
  secureCookies: false,
  tokenPepper: "api-v1-test-token-pepper-that-is-longer-than-32-bytes",
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

describe("OpenCOI API v1", () => {
  let database: OpenCoiDatabase;
  let app: Express;
  let fullToken: string;
  let readToken: string;

  beforeAll(() => {
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
    const timestamp = "2026-08-31T09:00:00.000Z";
    database
      .prepare(
        `INSERT INTO organizations (id, slug, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("org-b", "organization-b", "Organization B", timestamp, timestamp);
    const repositoryA = createOrganizationRepository(database, "org-a");
    const repositoryB = createOrganizationRepository(database, "org-b");
    repositoryB.createUser({
      id: "admin-b",
      email: "admin-b@example.test",
      displayName: "Admin B",
      passwordHash: "test-password-hash",
      role: "owner",
    });
    repositoryA.createVendorType({ id: "type-a", name: "Contractor" });
    repositoryB.createVendorType({ id: "type-b", name: "Other tenant type" });
    repositoryB.createVendor({
      id: "vendor-b",
      vendorTypeId: "type-b",
      legalName: "Secret Vendor",
    });
    app = createApp({
      config,
      database,
      documentStore: unusedStore,
      staticDirectory: false,
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    fullToken = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Full API client",
      scopes: [
        "vendors:read",
        "vendors:write",
        "requirements:read",
        "compliance:read",
        "events:read",
      ],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at: timestamp,
    }).secret.token;
    readToken = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Read API client",
      scopes: ["vendors:read"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at: timestamp,
    }).secret.token;
  });

  afterAll(() => database.close());

  it("serves the OpenAPI document without credentials and uses Problem Details", async () => {
    const specification = await request(app).get("/api/v1/openapi.json").expect(200);
    expect(specification.body).toMatchObject({ openapi: "3.1.0", info: { title: "OpenCOI API" } });
    expect(
      specification.body.paths["/vendors"].post.requestBody.content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/VendorInput" });
    expect(specification.body.paths["/vendors"].post.responses["201"].headers).toHaveProperty(
      "Location",
    );
    expect(specification.body.components.schemas.Vendor.required).toContain("updatedAt");
    expect(
      specification.body.components.responses.Problem.content["application/problem+json"].schema,
    ).toEqual({ $ref: "#/components/schemas/Problem" });

    const unauthorized = await request(app).get("/api/v1/vendors").expect(401);
    expect(unauthorized.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(unauthorized.headers["www-authenticate"]).toContain("Bearer");
    expect(unauthorized.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(unauthorized.body).toMatchObject({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      requestId: unauthorized.headers["x-request-id"],
    });

    const malformed = await request(app)
      .post("/api/v1/vendors")
      .set("Content-Type", "application/json")
      .send('{"broken"')
      .expect(400);
    expect(malformed.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(malformed.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(malformed.headers["opencoi-version"]).toBe("2026-08-31");
    expect(malformed.headers["cache-control"]).toBe("private, no-store");
    expect(malformed.body).toMatchObject({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Request body is not valid JSON",
      requestId: malformed.headers["x-request-id"],
    });
  });

  it("enforces least-privilege scopes", async () => {
    const response = await request(app)
      .post("/api/v1/vendors")
      .set("Authorization", `Bearer ${readToken}`)
      .set("Idempotency-Key", "read-only-attempt")
      .send({ vendorTypeId: "type-a", legalName: "Blocked Vendor" })
      .expect(403);
    expect(response.body.detail).toContain("vendors:write");
  });

  it("creates idempotently, paginates, and never accepts a caller-selected tenant", async () => {
    const create = () =>
      request(app)
        .post("/api/v1/vendors")
        .set("Authorization", `Bearer ${fullToken}`)
        .set("Idempotency-Key", "create-acme-0001")
        .send({
          vendorTypeId: "type-a",
          legalName: "Acme Electric",
          contactEmail: "insurance@acme.example",
        });
    const first = await create().expect(201);
    const replay = await create().expect(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers.etag).toBe(first.headers.etag);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM vendors WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM domain_events WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 1 });

    await request(app)
      .post("/api/v1/vendors")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "create-zeta-0002")
      .send({ vendorTypeId: "type-a", legalName: "Zeta Plumbing" })
      .expect(201);
    const pageOne = await request(app)
      .get("/api/v1/vendors?limit=1")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(pageOne.body.data).toHaveLength(1);
    expect(pageOne.body.meta).toMatchObject({ limit: 1, hasMore: true });
    const pageTwo = await request(app)
      .get(`/api/v1/vendors?limit=1&cursor=${encodeURIComponent(pageOne.body.meta.nextCursor)}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(pageTwo.body.data[0].legalName).toBe("Zeta Plumbing");
    expect(JSON.stringify(pageOne.body) + JSON.stringify(pageTwo.body)).not.toContain(
      "Secret Vendor",
    );
  });

  it("uses ETag preconditions and idempotency for updates", async () => {
    const row = database
      .prepare("SELECT id FROM vendors WHERE organization_id = ? AND legal_name = ?")
      .get("org-a", "Acme Electric") as { id: string };
    const detail = await request(app)
      .get(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    const etag = detail.headers.etag;
    if (!etag) throw new Error("Expected an ETag");
    await request(app)
      .patch(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "patch-acme-0001")
      .send({ status: "inactive" })
      .expect(428);
    const updated = await request(app)
      .patch(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "patch-acme-0002")
      .set("If-Match", etag)
      .send({ status: "inactive" })
      .expect(200);
    expect(updated.body.data.status).toBe("inactive");
    const afterFirst = await request(app)
      .get(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    const sameTimestampEtag = afterFirst.headers.etag;
    if (!sameTimestampEtag) throw new Error("Expected an ETag after update");
    const second = await request(app)
      .patch(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "patch-acme-0003")
      .set("If-Match", sameTimestampEtag)
      .send({ tradeName: "Second update in the same millisecond" })
      .expect(200);
    expect(second.headers.etag).not.toBe(sameTimestampEtag);
    const secondReplay = await request(app)
      .patch(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "patch-acme-0003")
      .set("If-Match", sameTimestampEtag)
      .send({ tradeName: "Second update in the same millisecond" })
      .expect(200);
    expect(secondReplay.headers["idempotent-replayed"]).toBe("true");
    expect(secondReplay.headers.etag).toBe(second.headers.etag);
    await request(app)
      .patch(`/api/v1/vendors/${row.id}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "patch-acme-0004")
      .set("If-Match", sameTimestampEtag)
      .send({ tradeName: "Stale overwrite" })
      .expect(412);
  });

  it("exposes requirements, document-scoped compliance, and an ordered event feed", async () => {
    const types = await request(app)
      .get("/api/v1/vendor-types")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(types.body.data).toEqual([
      expect.objectContaining({ id: "type-a", name: "Contractor", requirements: [] }),
    ]);
    const vendor = database
      .prepare("SELECT id FROM vendors WHERE organization_id = ? ORDER BY id LIMIT 1")
      .get("org-a") as { id: string };
    const compliance = await request(app)
      .get(`/api/v1/vendors/${vendor.id}/compliance`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(compliance.body.data).toMatchObject({ vendorId: vendor.id, certificate: null });

    const events = await request(app)
      .get("/api/v1/events?limit=1")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(events.body.data).toHaveLength(1);
    expect(events.body.data[0]).toMatchObject({ sequence: 1, type: "vendor.created" });
    expect(events.body.meta.hasMore).toBe(true);
  });

  it("rejects idempotency-key reuse with a different request", async () => {
    const conflict = await request(app)
      .post("/api/v1/vendors")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "create-acme-0001")
      .send({ vendorTypeId: "type-a", legalName: "Different Vendor" })
      .expect(409);
    expect(conflict.body.title).toBe("Idempotency conflict");
  });
});
