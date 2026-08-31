import { createHash, randomUUID } from "node:crypto";
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
import { type DocumentStore, inspectPdf, type StoredDocument } from "../storage.js";

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

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<<>>\n%%EOF",
  "ascii",
);
const API_USER_AGENT = "OpenCOI-integration-tests/1.0";

class MemoryDocumentStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();

  async putPdf(input: Uint8Array): Promise<StoredDocument> {
    const inspection = inspectPdf(input);
    const id = randomUUID();
    const storageKey = `${id.slice(0, 2)}/${id}.pdf`;
    const bytes = Buffer.from(input);
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
    const bytes = this.files.get(storageKey);
    if (!bytes) throw new Error("missing test document");
    return bytes;
  }

  async remove(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}

describe("OpenCOI API v1", () => {
  let database: OpenCoiDatabase;
  let app: Express;
  let fullToken: string;
  let fullServiceAccountId: string;
  let fullServiceAccountSecretId: string;
  let readToken: string;
  let tenantBToken: string;
  const documentStore = new MemoryDocumentStore();

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
      documentStore,
      staticDirectory: false,
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    const fullServiceAccount = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Full API client",
      scopes: [
        "vendors:read",
        "vendors:write",
        "certificates:read",
        "certificates:write",
        "requests:read",
        "requests:write",
        "evidence:read",
        "requirements:read",
        "compliance:read",
        "events:read",
      ],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at: timestamp,
    });
    fullToken = fullServiceAccount.secret.token;
    fullServiceAccountId = fullServiceAccount.account.id;
    fullServiceAccountSecretId = fullServiceAccount.secret.id;
    readToken = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Read API client",
      scopes: ["vendors:read"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at: timestamp,
    }).secret.token;
    tenantBToken = createServiceAccount(database, {
      organizationId: "org-b",
      name: "Tenant B API client",
      scopes: [
        "certificates:read",
        "certificates:write",
        "requests:read",
        "requests:write",
        "evidence:read",
      ],
      createdByUserId: "admin-b",
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
    expect(malformed.headers["opencoi-version"]).toBe("2026-09-01");
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
        .set("User-Agent", API_USER_AGENT)
        .set("Idempotency-Key", "create-acme-0001")
        .send({
          vendorTypeId: "type-a",
          legalName: "Acme Electric",
          contactEmail: "insurance@acme.example",
        });
    const first = await create().expect(201);
    const replay = await create().expect(201);
    expect(first.body).toEqual({
      data: {
        id: expect.any(String),
        result: "created",
        updatedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(first.body)).not.toContain("insurance@acme.example");
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
    expect(
      database
        .prepare(
          `SELECT actor_type, ip_address, user_agent,
                  json_extract(metadata_json, '$.serviceAccountId') AS service_account_id,
                  json_extract(metadata_json, '$.serviceAccountSecretId') AS secret_id,
                  json_extract(metadata_json, '$.requestId') AS request_id,
                  json_extract(metadata_json, '$.legalName') AS legal_name
           FROM audit_events
           WHERE action = 'vendor.created_via_api' AND entity_id = ?`,
        )
        .get(first.body.data.id),
    ).toEqual({
      actor_type: "system",
      ip_address: expect.stringMatching(/127\.0\.0\.1$/),
      user_agent: API_USER_AGENT,
      service_account_id: fullServiceAccountId,
      secret_id: fullServiceAccountSecretId,
      request_id: first.headers["x-request-id"],
      legal_name: "Acme Electric",
    });

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
    expect(updated.body.data).toMatchObject({ id: row.id, result: "updated" });
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

  it("keeps vendor mutation responses non-sensitive across scope downgrades and replays", async () => {
    const repository = createOrganizationRepository(database, "org-a");
    repository.createVendor({
      id: "vendor-mutation-receipt",
      vendorTypeId: "type-a",
      legalName: "Private Mutation Vendor",
      contactEmail: "private-mutation@example.test",
      notes: "private mutation notes",
    });
    const account = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Vendor mutation client",
      scopes: ["vendors:read", "vendors:write"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at: "2026-08-31T09:00:00.000Z",
    });
    const current = await request(app)
      .get("/api/v1/vendors/vendor-mutation-receipt")
      .set("Authorization", `Bearer ${account.secret.token}`)
      .expect(200);
    const etag = current.headers.etag;
    if (!etag) throw new Error("Expected a vendor ETag");
    const update = () =>
      request(app)
        .patch("/api/v1/vendors/vendor-mutation-receipt")
        .set("Authorization", `Bearer ${account.secret.token}`)
        .set("Idempotency-Key", "vendor-mutation-receipt-01")
        .set("If-Match", etag)
        .send({ contactEmail: "changed-private@example.test", notes: "changed private notes" });
    const first = await update().expect(200);
    expect(first.body).toEqual({
      data: {
        id: "vendor-mutation-receipt",
        result: "updated",
        updatedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(first.body)).not.toMatch(/private|example\.test/i);

    database
      .prepare("UPDATE service_accounts SET scopes_json = ? WHERE organization_id = ? AND id = ?")
      .run(JSON.stringify(["vendors:write"]), "org-a", account.account.id);
    const replay = await update().expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(JSON.stringify(replay.body)).not.toMatch(/private|example\.test/i);
  });

  it("exposes requirements, document-scoped compliance, and an ordered event feed", async () => {
    const requirementId = createOrganizationRepository(database, "org-a").createCoverageRequirement(
      {
        id: "api-requirement-boolean-contract",
        vendorTypeId: "type-a",
        coverageType: "COMMERCIAL_GENERAL_LIABILITY",
        requiresAdditionalInsured: true,
        requiresWaiverOfSubrogation: false,
        requiresPrimaryNoncontributory: true,
        requiresCancellationNotice: false,
      },
    );
    try {
      const types = await request(app)
        .get("/api/v1/vendor-types")
        .set("Authorization", `Bearer ${fullToken}`)
        .expect(200);
      expect(types.body.data).toEqual([
        expect.objectContaining({
          id: "type-a",
          name: "Contractor",
          requirements: [
            expect.objectContaining({
              id: requirementId,
              requiresAdditionalInsured: true,
              requiresWaiverOfSubrogation: false,
              requiresPrimaryNoncontributory: true,
              requiresCancellationNotice: false,
            }),
          ],
        }),
      ]);
      for (const flag of [
        "requiresAdditionalInsured",
        "requiresWaiverOfSubrogation",
        "requiresPrimaryNoncontributory",
        "requiresCancellationNotice",
      ]) {
        expect(typeof types.body.data[0].requirements[0][flag]).toBe("boolean");
      }
    } finally {
      database
        .prepare(
          "UPDATE coverage_requirements SET is_active = 0 WHERE organization_id = ? AND id = ?",
        )
        .run("org-a", requirementId);
    }
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

  it("submits certificates idempotently as unconfirmed and reads them with a narrow scope", async () => {
    const repository = createOrganizationRepository(database, "org-a");
    repository.createVendor({
      id: "api-workflow-vendor",
      vendorTypeId: "type-a",
      legalName: "API Workflow Vendor",
      contactEmail: "workflow@example.test",
    });
    const metadata = JSON.stringify({
      reviewStatus: "CONFIRMED",
      namedInsured: "API Workflow Vendor",
      rawText: "synthetic API submission",
      policies: [
        {
          coverageType: "COMMERCIAL_GENERAL_LIABILITY",
          insurer: "Example Mutual",
          policyNumber: "API-100",
          effectiveDate: "2026-01-01",
          expirationDate: "2027-01-01",
          limits: { EACH_OCCURRENCE: 100_000_000 },
          endorsements: [],
        },
      ],
    });
    const submit = () =>
      request(app)
        .post("/api/v1/vendors/api-workflow-vendor/certificates")
        .set("Authorization", `Bearer ${fullToken}`)
        .set("User-Agent", API_USER_AGENT)
        .set("Idempotency-Key", "certificate-upload-0001")
        .field("metadata", metadata)
        .attach("document", PDF, {
          filename: "api-certificate.pdf",
          contentType: "application/pdf",
        });

    const responses = await Promise.all([submit().expect(201), submit().expect(201)]);
    const first = responses.find((response) => response.headers["idempotent-replayed"] !== "true");
    const replay = responses.find((response) => response.headers["idempotent-replayed"] === "true");
    if (!first || !replay) {
      throw new Error("Concurrent identical uploads must produce one creation and one replay");
    }
    expect(
      responses.filter((response) => response.headers["idempotent-replayed"] === "true"),
    ).toHaveLength(1);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(first.body.data).toMatchObject({
      vendorId: "api-workflow-vendor",
      result: "submitted",
      reviewStatus: "UNCONFIRMED",
      submittedAt: expect.any(String),
    });
    expect(JSON.stringify(first.body)).not.toContain("API Workflow Vendor");
    expect(JSON.stringify(first.body)).not.toContain("evaluatedRuleset");
    expect(first.headers.location).toBe(`/api/v1/certificates/${first.body.data.id}`);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM certificates WHERE vendor_id = ?")
        .get("api-workflow-vendor"),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM documents d
           JOIN certificates c
             ON c.organization_id = d.organization_id AND c.document_id = d.id
           WHERE c.organization_id = ? AND c.vendor_id = ?`,
        )
        .get("org-a", "api-workflow-vendor"),
    ).toEqual({ count: 1 });
    expect(documentStore.files.size).toBe(1);
    expect(
      database
        .prepare(
          `SELECT actor_type, actor_id, json_extract(payload_json, '$.submissionChannel') AS submission_channel
           FROM domain_events
           WHERE type = 'certificate.submitted' AND resource_id = ?`,
        )
        .get(first.body.data.id),
    ).toEqual({
      actor_type: "service_account",
      actor_id: fullServiceAccountId,
      submission_channel: "api",
    });
    expect(
      database
        .prepare(
          `SELECT ip_address, user_agent,
                  json_extract(metadata_json, '$.serviceAccountId') AS service_account_id,
                  json_extract(metadata_json, '$.serviceAccountSecretId') AS secret_id,
                  json_extract(metadata_json, '$.requestId') AS request_id,
                  json_extract(metadata_json, '$.vendorId') AS vendor_id
           FROM audit_events
           WHERE action = 'certificate.submitted_via_api' AND entity_id = ?`,
        )
        .get(first.body.data.id),
    ).toEqual({
      ip_address: expect.stringMatching(/127\.0\.0\.1$/),
      user_agent: API_USER_AGENT,
      service_account_id: fullServiceAccountId,
      secret_id: fullServiceAccountSecretId,
      request_id: first.headers["x-request-id"],
      vendor_id: "api-workflow-vendor",
    });
    const storedIdempotency = database
      .prepare(
        "SELECT response_json FROM api_idempotency_keys WHERE idempotency_key = 'certificate-upload-0001'",
      )
      .get() as { response_json: string };
    expect(JSON.parse(storedIdempotency.response_json)).toEqual({
      _opencoiEncryptedResponseV1: expect.stringMatching(/^enc:v1:/),
    });

    const certificateLocation = first.headers.location;
    if (!certificateLocation) throw new Error("Certificate response did not include Location");
    const detail = await request(app)
      .get(certificateLocation)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      id: first.body.data.id,
      namedInsured: "API Workflow Vendor",
      documentStatus: "pending_review",
    });
    const evidenceBundle = await request(app)
      .get(`${certificateLocation}/evidence-bundle`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("User-Agent", API_USER_AGENT)
      .expect(200);
    expect(evidenceBundle.headers["content-disposition"]).toContain("opencoi-evidence-");
    expect(evidenceBundle.body).toMatchObject({
      schemaVersion: "1.0",
      payload: {
        exportedBy: { id: expect.stringMatching(/^service-account:/), name: "Full API client" },
        sourceDocument: { sha256: detail.body.data.sha256 },
      },
      integrity: { signature: { algorithm: "Ed25519" } },
    });
    expect(
      database
        .prepare(
          `SELECT ip_address, user_agent,
                  json_extract(metadata_json, '$.serviceAccountId') AS service_account_id,
                  json_extract(metadata_json, '$.serviceAccountSecretId') AS secret_id,
                  json_extract(metadata_json, '$.requestId') AS request_id,
                  json_extract(metadata_json, '$.digest') AS digest
           FROM audit_events
           WHERE action = 'evidence_bundle.exported_via_api' AND entity_id = ?`,
        )
        .get(first.body.data.id),
    ).toEqual({
      ip_address: expect.stringMatching(/127\.0\.0\.1$/),
      user_agent: API_USER_AGENT,
      service_account_id: fullServiceAccountId,
      secret_id: fullServiceAccountSecretId,
      request_id: evidenceBundle.headers["x-request-id"],
      digest: evidenceBundle.body.integrity.digest.value,
    });
    await request(app)
      .get(certificateLocation)
      .set("Authorization", `Bearer ${readToken}`)
      .expect(403);
    await request(app)
      .get(`${certificateLocation}/evidence-bundle`)
      .set("Authorization", `Bearer ${readToken}`)
      .expect(403);
  });

  it("creates, lists, and cancels tracked requests through scoped API operations", async () => {
    const create = () =>
      request(app)
        .post("/api/v1/vendors/api-workflow-vendor/certificate-requests")
        .set("Authorization", `Bearer ${fullToken}`)
        .set("User-Agent", API_USER_AGENT)
        .set("Idempotency-Key", "certificate-request-0001")
        .send({ kind: "renewal", deliveryMethod: "manual", ttlDays: 21 });
    const first = await create().expect(201);
    const replay = await create().expect(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(first.body.data.request).toMatchObject({
      vendorId: "api-workflow-vendor",
      kind: "renewal",
      deliveryMethod: "manual",
      state: "open",
    });
    expect(first.body.data.uploadUrl).toMatch(/^http:\/\/localhost:5173\/upload#token=v1\./);
    expect(
      database
        .prepare(
          `SELECT ip_address, user_agent,
                  json_extract(metadata_json, '$.serviceAccountId') AS service_account_id,
                  json_extract(metadata_json, '$.serviceAccountSecretId') AS secret_id,
                  json_extract(metadata_json, '$.requestId') AS request_id,
                  json_extract(metadata_json, '$.kind') AS kind
           FROM audit_events
           WHERE action = 'certificate_request.created_via_api' AND entity_id = ?`,
        )
        .get(first.body.data.request.id),
    ).toEqual({
      ip_address: expect.stringMatching(/127\.0\.0\.1$/),
      user_agent: API_USER_AGENT,
      service_account_id: fullServiceAccountId,
      secret_id: fullServiceAccountSecretId,
      request_id: first.headers["x-request-id"],
      kind: "renewal",
    });
    const requestIdempotency = database
      .prepare("SELECT response_json FROM api_idempotency_keys WHERE idempotency_key = ?")
      .get("certificate-request-0001") as { response_json: string };
    expect(JSON.parse(requestIdempotency.response_json)).toEqual({
      _opencoiEncryptedResponseV1: expect.stringMatching(/^enc:v1:/),
    });

    const requestId = first.body.data.request.id as string;
    const second = await request(app)
      .post("/api/v1/vendors/api-workflow-vendor/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "certificate-request-0002")
      .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 })
      .expect(201);
    const secondRequestId = second.body.data.request.id as string;
    const pageOne = await request(app)
      .get("/api/v1/vendors/api-workflow-vendor/certificate-requests?limit=1")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(pageOne.body.data).toHaveLength(1);
    expect(pageOne.body.meta).toMatchObject({ hasMore: true });
    const pageTwo = await request(app)
      .get(
        `/api/v1/vendors/api-workflow-vendor/certificate-requests?limit=1&cursor=${encodeURIComponent(pageOne.body.meta.nextCursor)}`,
      )
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(new Set([pageOne.body.data[0].id, pageTwo.body.data[0].id])).toEqual(
      new Set([requestId, secondRequestId]),
    );
    await request(app)
      .get(`/api/v1/certificate-requests/${requestId}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);

    const cancel = () =>
      request(app)
        .post(`/api/v1/certificate-requests/${requestId}/cancel`)
        .set("Authorization", `Bearer ${fullToken}`)
        .set("User-Agent", API_USER_AGENT)
        .set("Idempotency-Key", "certificate-cancel-0001")
        .send({});
    const cancelled = await cancel().expect(200);
    const cancelledReplay = await cancel().expect(200);
    expect(cancelled.body.data).toEqual({
      id: requestId,
      result: "cancelled",
      state: "cancelled",
      cancelledAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(cancelledReplay.headers["idempotent-replayed"]).toBe("true");
    expect(cancelledReplay.body).toEqual(cancelled.body);
    expect(
      database
        .prepare(
          `SELECT ip_address, user_agent,
                  json_extract(metadata_json, '$.serviceAccountId') AS service_account_id,
                  json_extract(metadata_json, '$.serviceAccountSecretId') AS secret_id,
                  json_extract(metadata_json, '$.requestId') AS request_id,
                  json_extract(metadata_json, '$.vendorId') AS vendor_id
           FROM audit_events
           WHERE action = 'certificate_request.cancelled_via_api' AND entity_id = ?`,
        )
        .get(requestId),
    ).toEqual({
      ip_address: expect.stringMatching(/127\.0\.0\.1$/),
      user_agent: API_USER_AGENT,
      service_account_id: fullServiceAccountId,
      secret_id: fullServiceAccountSecretId,
      request_id: cancelled.headers["x-request-id"],
      vendor_id: "api-workflow-vendor",
    });
    await request(app)
      .get("/api/v1/vendors/api-workflow-vendor/certificate-requests")
      .set("Authorization", `Bearer ${readToken}`)
      .expect(403);
  });

  it("does not expose or mutate another tenant through certificate, evidence, or request APIs", async () => {
    const tenantMetadata = JSON.stringify({
      reviewStatus: "UNCONFIRMED",
      namedInsured: "Secret Vendor",
      rawText: "tenant-b synthetic certificate",
      policies: [],
    });
    const tenantBCertificate = await request(app)
      .post("/api/v1/vendors/vendor-b/certificates")
      .set("Authorization", `Bearer ${tenantBToken}`)
      .set("Idempotency-Key", "tenant-b-certificate-0001")
      .field("metadata", tenantMetadata)
      .attach("document", PDF, {
        filename: "tenant-b.pdf",
        contentType: "application/pdf",
      })
      .expect(201);
    const tenantBCertificateId = tenantBCertificate.body.data.id as string;
    const tenantBRequest = await request(app)
      .post("/api/v1/vendors/vendor-b/certificate-requests")
      .set("Authorization", `Bearer ${tenantBToken}`)
      .set("Idempotency-Key", "tenant-b-request-0001")
      .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 })
      .expect(201);
    const tenantBRequestId = tenantBRequest.body.data.request.id as string;

    const repository = createOrganizationRepository(database, "org-a");
    repository.createVendor({
      id: "tenant-isolation-a",
      vendorTypeId: "type-a",
      legalName: "Tenant Isolation A",
    });
    const tenantARequest = await request(app)
      .post("/api/v1/vendors/tenant-isolation-a/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "tenant-a-request-0001")
      .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 })
      .expect(201);

    const filesBeforeRejectedUploads = documentStore.files.size;
    const foreignUpload = await request(app)
      .post("/api/v1/vendors/vendor-b/certificates")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "foreign-certificate-upload")
      .field("metadata", tenantMetadata)
      .attach("document", PDF, { filename: "foreign.pdf", contentType: "application/pdf" })
      .expect(404);
    const missingUpload = await request(app)
      .post("/api/v1/vendors/missing-vendor/certificates")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "missing-certificate-upload")
      .field("metadata", tenantMetadata)
      .attach("document", PDF, { filename: "missing.pdf", contentType: "application/pdf" })
      .expect(404);
    expect(foreignUpload.body).toMatchObject({
      title: missingUpload.body.title,
      status: missingUpload.body.status,
      detail: missingUpload.body.detail,
    });
    expect(documentStore.files.size).toBe(filesBeforeRejectedUploads);

    const foreignCertificate = await request(app)
      .get(`/api/v1/certificates/${tenantBCertificateId}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    const missingCertificate = await request(app)
      .get("/api/v1/certificates/missing-certificate")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    expect(foreignCertificate.body).toMatchObject({
      title: missingCertificate.body.title,
      status: missingCertificate.body.status,
      detail: missingCertificate.body.detail,
    });

    const foreignEvidence = await request(app)
      .get(`/api/v1/certificates/${tenantBCertificateId}/evidence-bundle`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    const missingEvidence = await request(app)
      .get("/api/v1/certificates/missing-certificate/evidence-bundle")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    expect(foreignEvidence.body).toMatchObject({
      title: missingEvidence.body.title,
      status: missingEvidence.body.status,
      detail: missingEvidence.body.detail,
    });

    const foreignRequestList = await request(app)
      .get("/api/v1/vendors/vendor-b/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    const missingRequestList = await request(app)
      .get("/api/v1/vendors/missing-vendor/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    expect(foreignRequestList.body).toMatchObject({
      title: missingRequestList.body.title,
      status: missingRequestList.body.status,
      detail: missingRequestList.body.detail,
    });

    const foreignRequestCreate = await request(app)
      .post("/api/v1/vendors/vendor-b/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "foreign-request-create")
      .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 })
      .expect(404);
    const missingRequestCreate = await request(app)
      .post("/api/v1/vendors/missing-vendor/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "missing-request-create")
      .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 })
      .expect(404);
    expect(foreignRequestCreate.body).toMatchObject({
      title: missingRequestCreate.body.title,
      status: missingRequestCreate.body.status,
      detail: missingRequestCreate.body.detail,
    });

    const foreignRequest = await request(app)
      .get(`/api/v1/certificate-requests/${tenantBRequestId}`)
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    const missingRequest = await request(app)
      .get("/api/v1/certificate-requests/missing-request")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(404);
    expect(foreignRequest.body).toMatchObject({
      title: missingRequest.body.title,
      status: missingRequest.body.status,
      detail: missingRequest.body.detail,
    });

    const foreignCancel = await request(app)
      .post(`/api/v1/certificate-requests/${tenantBRequestId}/cancel`)
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "foreign-request-cancel")
      .send({})
      .expect(404);
    const missingCancel = await request(app)
      .post("/api/v1/certificate-requests/missing-request/cancel")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "missing-request-cancel")
      .send({})
      .expect(404);
    expect(foreignCancel.body).toMatchObject({
      title: missingCancel.body.title,
      status: missingCancel.body.status,
      detail: missingCancel.body.detail,
    });

    const ownList = await request(app)
      .get("/api/v1/vendors/tenant-isolation-a/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .expect(200);
    expect(ownList.body.data.map((record: { id: string }) => record.id)).toEqual([
      tenantARequest.body.data.request.id,
    ]);
    expect(JSON.stringify(ownList.body)).not.toContain(tenantBRequestId);
    expect(JSON.stringify(ownList.body)).not.toContain("Secret Vendor");

    const foreignSource = await request(app)
      .post("/api/v1/vendors/tenant-isolation-a/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "foreign-source-certificate")
      .send({
        kind: "renewal",
        deliveryMethod: "manual",
        sourceCertificateId: tenantBCertificateId,
        ttlDays: 14,
      })
      .expect(400);
    const missingSource = await request(app)
      .post("/api/v1/vendors/tenant-isolation-a/certificate-requests")
      .set("Authorization", `Bearer ${fullToken}`)
      .set("Idempotency-Key", "missing-source-certificate")
      .send({
        kind: "renewal",
        deliveryMethod: "manual",
        sourceCertificateId: "missing-certificate",
        ttlDays: 14,
      })
      .expect(400);
    expect(foreignSource.body).toMatchObject({
      title: missingSource.body.title,
      status: missingSource.body.status,
      detail: missingSource.body.detail,
    });

    expect(
      database
        .prepare(
          `SELECT organization_id, state FROM certificate_requests
           WHERE organization_id = ? AND id = ?`,
        )
        .get("org-b", tenantBRequestId),
    ).toEqual({ organization_id: "org-b", state: "open" });
  });

  it("applies least-privilege recipient and source-certificate scope boundaries", async () => {
    const privateContact = {
      name: "Private Vendor Contact",
      email: "private-contact@example.test",
    };
    database
      .prepare(
        `UPDATE vendors SET contact_name = ?, contact_email = ?
         WHERE organization_id = ? AND id = ?`,
      )
      .run(privateContact.name, privateContact.email, "org-a", "api-workflow-vendor");
    const at = "2026-08-31T09:30:00.000Z";
    const writeOnlyAccount = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Request writer",
      scopes: ["requests:write"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at,
    });
    const vendorReaderAccount = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Request writer with vendor read",
      scopes: ["requests:write", "vendors:read"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at,
    });
    const requestReaderAccount = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Request writer with request read",
      scopes: ["requests:read", "requests:write"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at,
    });
    const certificateReaderAccount = createServiceAccount(database, {
      organizationId: "org-a",
      name: "Request writer with certificate read",
      scopes: ["certificates:read", "requests:write"],
      createdByUserId: "admin-a",
      tokenPepper: config.tokenPepper,
      at,
    });
    const createManualRequest = (token: string, idempotencyKey: string) =>
      request(app)
        .post("/api/v1/vendors/api-workflow-vendor/certificate-requests")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", idempotencyKey)
        .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 });

    const writeOnly = await createManualRequest(
      writeOnlyAccount.secret.token,
      "scope-write-only-create",
    ).expect(201);
    expect(writeOnly.body.data.request).toMatchObject({
      recipientName: null,
      recipientEmail: null,
    });
    expect(JSON.stringify(writeOnly.body)).not.toContain(privateContact.name);
    expect(JSON.stringify(writeOnly.body)).not.toContain(privateContact.email);
    expect(
      database
        .prepare(
          `SELECT recipient_name, recipient_email FROM certificate_requests
           WHERE organization_id = ? AND id = ?`,
        )
        .get("org-a", writeOnly.body.data.request.id),
    ).toEqual({
      recipient_name: privateContact.name,
      recipient_email: privateContact.email,
    });
    const writeOnlyReplay = await createManualRequest(
      writeOnlyAccount.secret.token,
      "scope-write-only-create",
    ).expect(201);
    expect(writeOnlyReplay.headers["idempotent-replayed"]).toBe("true");
    expect(writeOnlyReplay.body.data.request).toMatchObject({
      recipientName: null,
      recipientEmail: null,
    });

    const vendorReader = await createManualRequest(
      vendorReaderAccount.secret.token,
      "scope-vendor-reader-create",
    ).expect(201);
    expect(vendorReader.body.data.request).toMatchObject({
      recipientName: privateContact.name,
      recipientEmail: privateContact.email,
    });
    database
      .prepare("UPDATE service_accounts SET scopes_json = ? WHERE organization_id = ? AND id = ?")
      .run(JSON.stringify(["requests:write"]), "org-a", vendorReaderAccount.account.id);
    const downgradedReplay = await createManualRequest(
      vendorReaderAccount.secret.token,
      "scope-vendor-reader-create",
    ).expect(201);
    expect(downgradedReplay.headers["idempotent-replayed"]).toBe("true");
    expect(downgradedReplay.body.data.request).toMatchObject({
      recipientName: null,
      recipientEmail: null,
    });

    const requestReader = await createManualRequest(
      requestReaderAccount.secret.token,
      "scope-request-reader-create",
    ).expect(201);
    expect(requestReader.body.data.request).toMatchObject({
      recipientName: privateContact.name,
      recipientEmail: privateContact.email,
    });

    const cancel = await request(app)
      .post(`/api/v1/certificate-requests/${writeOnly.body.data.request.id}/cancel`)
      .set("Authorization", `Bearer ${writeOnlyAccount.secret.token}`)
      .set("Idempotency-Key", "scope-write-only-cancel")
      .send({})
      .expect(200);
    expect(cancel.body.data).toEqual({
      id: writeOnly.body.data.request.id,
      result: "cancelled",
      state: "cancelled",
      cancelledAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const source = database
      .prepare(
        `SELECT id FROM certificates
         WHERE organization_id = ? AND vendor_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get("org-a", "api-workflow-vendor") as { id: string } | undefined;
    if (!source) throw new Error("Expected a source certificate from the API workflow fixture");
    const sourceRequest = (token: string, key: string, sourceCertificateId: string) =>
      request(app)
        .post("/api/v1/vendors/api-workflow-vendor/certificate-requests")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({
          kind: "renewal",
          deliveryMethod: "manual",
          sourceCertificateId,
          ttlDays: 14,
        });
    const forbiddenExisting = await sourceRequest(
      writeOnlyAccount.secret.token,
      "scope-source-existing",
      source.id,
    ).expect(403);
    const forbiddenMissing = await sourceRequest(
      writeOnlyAccount.secret.token,
      "scope-source-missing",
      "missing-certificate-id",
    ).expect(403);
    expect(forbiddenExisting.body).toMatchObject({
      title: "Forbidden",
      detail: "The certificates:read scope is required when sourceCertificateId is supplied",
    });
    expect(forbiddenMissing.body).toMatchObject({
      title: forbiddenExisting.body.title,
      status: forbiddenExisting.body.status,
      detail: forbiddenExisting.body.detail,
    });

    const allowedSource = await sourceRequest(
      certificateReaderAccount.secret.token,
      "scope-source-allowed",
      source.id,
    ).expect(201);
    expect(allowedSource.body.data.request).toMatchObject({
      sourceCertificateId: source.id,
      recipientName: null,
      recipientEmail: null,
    });
    const sourceCancel = () =>
      request(app)
        .post(`/api/v1/certificate-requests/${allowedSource.body.data.request.id}/cancel`)
        .set("Authorization", `Bearer ${certificateReaderAccount.secret.token}`)
        .set("Idempotency-Key", "scope-source-cancel")
        .send({});
    const sourceCancelled = await sourceCancel().expect(200);
    expect(sourceCancelled.body.data).toEqual({
      id: allowedSource.body.data.request.id,
      result: "cancelled",
      state: "cancelled",
      cancelledAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(sourceCancelled.body)).not.toContain(source.id);
    database
      .prepare("UPDATE service_accounts SET scopes_json = ? WHERE organization_id = ? AND id = ?")
      .run(JSON.stringify(["requests:write"]), "org-a", certificateReaderAccount.account.id);
    const sourceCancelReplay = await sourceCancel().expect(200);
    expect(sourceCancelReplay.headers["idempotent-replayed"]).toBe("true");
    expect(sourceCancelReplay.body).toEqual(sourceCancelled.body);
    expect(JSON.stringify(sourceCancelReplay.body)).not.toContain(source.id);
    await sourceRequest(
      certificateReaderAccount.secret.token,
      "scope-source-allowed",
      source.id,
    ).expect(403);
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
