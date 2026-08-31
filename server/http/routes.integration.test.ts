import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeJson } from "../../shared/evidenceBundle.js";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import { hashPassword } from "../security.js";
import { type DocumentStore, inspectPdf, type StoredDocument } from "../storage.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<<>>\n%%EOF",
  "ascii",
);

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
      pageCountEstimate: inspection.pageCountEstimate,
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
  dataDirectory: "C:/tmp/opencoi-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-test/uploads",
  maxUploadBytes: 5 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1000,
  uploadLinkTtlMs: 14 * 86_400_000,
  sessionCookieName: "opencoi_test_session",
  secureCookies: false,
  tokenPepper: "integration-test-token-pepper-at-least-32-bytes",
  oidc: null,
  smtp: null,
  remindersEnabled: false,
  reminderPollMs: 60_000,
  bootstrap: null,
};

interface LoginResult {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
}

describe("OpenCOI API integration", () => {
  let database: OpenCoiDatabase;
  let app: Express;
  let passwordHash: string;
  const store = new MemoryDocumentStore();

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin-a@example.test",
      administratorPasswordHash: passwordHash,
    });
    const timestamp = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO organizations (id, slug, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("org-b", "organization-b", "Organization B", timestamp, timestamp);
    const repositoryB = createOrganizationRepository(database, "org-b");
    repositoryB.createUser({
      id: "admin-b",
      email: "admin-b@example.test",
      displayName: "Admin B",
      passwordHash,
      role: "owner",
    });
    const typeB = repositoryB.createVendorType({ id: "type-b", name: "Type B" });
    repositoryB.createVendor({ id: "vendor-b", vendorTypeId: typeB.id, legalName: "Vendor B" });
    app = createApp({ config, database, documentStore: store, staticDirectory: false });
  });

  afterAll(() => database.close());

  const login = async (): Promise<LoginResult> => {
    const agent = request.agent(app);
    const response = await agent
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ email: "admin-a@example.test", password: PASSWORD })
      .expect(200);
    return { agent, csrf: response.body.data.csrfToken as string };
  };

  const setupVendor = () => {
    const repository = createOrganizationRepository(database, "org-a");
    let vendorType = repository.getVendorType("type-a");
    if (!vendorType) vendorType = repository.createVendorType({ id: "type-a", name: "Contractor" });
    if (repository.listCoverageRequirements(vendorType.id).length === 0) {
      repository.createCoverageRequirement({
        id: "requirement-cgl",
        vendorTypeId: vendorType.id,
        coverageType: "general_liability",
        minimumEachOccurrence: 100_000_000,
        ruleConfig: {
          version: 1,
          label: "Commercial General Liability",
          required: true,
          currency: "USD",
          expirationWarningDays: 30,
        },
      });
    }
    let vendor = repository.getVendor("vendor-a");
    if (!vendor) {
      vendor = repository.createVendor({
        id: "vendor-a",
        vendorTypeId: vendorType.id,
        legalName: "=Formula Electric",
        contactEmail: "vendor@example.test",
      });
    }
    return vendor;
  };

  it("enforces trusted origins and CSRF while restoring a session with /me", async () => {
    await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send({ email: "admin-a@example.test", password: PASSWORD })
      .expect(403);
    const { agent, csrf } = await login();
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.data).toMatchObject({ organizationId: "org-a", role: "admin" });
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.headers.etag).toBeUndefined();
    expect(me.headers["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(me.headers["content-security-policy"]).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
    await agent
      .post("/api/vendor-types")
      .set("Origin", ORIGIN)
      .send({ name: "No CSRF" })
      .expect(403);
    await agent
      .post("/api/vendor-types")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ name: "With CSRF" })
      .expect(201);
  });

  it("requires a workspace slug only after credentials match multiple tenants", async () => {
    const repositoryB = createOrganizationRepository(database, "org-b");
    const duplicate = repositoryB.createUser({
      id: "duplicate-email-user-b",
      email: "admin-a@example.test",
      displayName: "Duplicate Email B",
      passwordHash,
      role: "viewer",
    });
    try {
      await request(app)
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({ email: "admin-a@example.test", password: "wrong-password" })
        .expect(401, { error: "Email or password is incorrect" });
      await request(app)
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({
          email: "admin-a@example.test",
          password: PASSWORD,
          organizationSlug: "workspace-that-does-not-exist",
        })
        .expect(401, { error: "Email or password is incorrect" });
      await request(app)
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({ email: "admin-a@example.test", password: PASSWORD })
        .expect(400, {
          error: "Workspace slug is required when these credentials match multiple organizations",
        });
      const scoped = await request(app)
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({
          email: "admin-a@example.test",
          password: PASSWORD,
          organizationSlug: "organization-a",
        })
        .expect(200);
      expect(scoped.body.data.organizationId).toBe("org-a");
    } finally {
      repositoryB.setUserStatus(duplicate.id, "disabled");
    }
  });

  it("uses only explicitly trusted proxy hops to scope login throttling", async () => {
    const attemptFromDistinctForwardedAddresses = async (target: Express) => {
      let status = 0;
      for (let index = 1; index <= 21; index += 1) {
        const response = await request(target)
          .post("/api/auth/login")
          .set("Origin", ORIGIN)
          .set("X-Forwarded-For", `198.51.100.${index}`)
          .send({ email: `missing-${index}@example.test`, password: "invalid" });
        status = response.status;
      }
      return status;
    };

    const directApp = createApp({
      config: { ...config, trustProxyHops: 0 },
      database,
      documentStore: store,
      staticDirectory: false,
    });
    const proxiedApp = createApp({
      config: { ...config, trustProxyHops: 1 },
      database,
      documentStore: store,
      staticDirectory: false,
    });

    // With no trusted proxy, client-supplied forwarding headers cannot evade
    // the shared socket-IP bucket. With one controlled hop, real clients get
    // independent buckets instead of globally locking out the deployment.
    expect(await attemptFromDistinctForwardedAddresses(directApp)).toBe(429);
    expect(await attemptFromDistinctForwardedAddresses(proxiedApp)).toBe(401);
  });

  it("rate-limits every route before accepting unbounded work", async () => {
    const limitedApp = createApp({
      config,
      database,
      documentStore: store,
      staticDirectory: false,
    });
    for (let requestNumber = 0; requestNumber < 300; requestNumber += 1) {
      await request(limitedApp).get("/api/health").expect(200);
    }
    const limited = await request(limitedApp).get("/api/health").expect(429);
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(limited.body).toEqual({ error: "Too many requests; try again later" });
  });

  it("uploads and deterministically evaluates a staff-confirmed certificate", async () => {
    setupVendor();
    const { agent, csrf } = await login();
    const metadata = {
      reviewStatus: "CONFIRMED",
      namedInsured: "Formula Electric LLC",
      policies: [
        {
          coverageType: "COMMERCIAL_GENERAL_LIABILITY",
          insurer: "Example Insurance Co",
          policyNumber: "GL-100",
          effectiveDate: "2026-01-01",
          expirationDate: "2027-01-01",
          limits: { EACH_OCCURRENCE: 200_000_000 },
          endorsements: [],
        },
      ],
    };
    const response = await agent
      .post("/api/vendors/vendor-a/certificates")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .field("metadata", JSON.stringify(metadata))
      .attach("document", PDF, "certificate.pdf")
      .expect(201);
    expect(response.body.data).toMatchObject({ documentStatus: "confirmed", checkStatus: "meets" });
    expect(
      response.body.data.findings.some(
        (finding: { outcome: string }) => finding.outcome === "PASS",
      ),
    ).toBe(true);
    await agent
      .get(`/api/certificates/${response.body.data.id}/download`)
      .expect("Content-Type", /application\/pdf/)
      .expect(200);
    const evidenceRepository = createOrganizationRepository(database, "org-a");
    if (!evidenceRepository.getUser("evidence-decider")) {
      evidenceRepository.createUser({
        id: "evidence-decider",
        email: "evidence-decider@example.test",
        displayName: "Evidence Decider",
        passwordHash,
        role: "admin",
      });
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO requirement_versions
          (id, organization_id, vendor_type_id, version, requirements_json,
           published_by_user_id, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "published-type-a-v1",
        "org-a",
        "type-a",
        1,
        JSON.stringify([{ id: "requirement-cgl", version: 1 }]),
        "admin-a",
        "2026-08-31T12:00:00.000Z",
      );
    const evidenceFinding = database
      .prepare(
        "SELECT id FROM findings WHERE organization_id = ? AND certificate_id = ? ORDER BY id LIMIT 1",
      )
      .get("org-a", response.body.data.id) as { id: string };
    database
      .prepare(
        `INSERT INTO exceptions
          (id, organization_id, vendor_id, finding_id, requested_by_user_id,
           request_reason, status, decided_by_user_id, decision_note, decided_at,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evidence-exception",
        "org-a",
        "vendor-a",
        evidenceFinding.id,
        "admin-a",
        "Synthetic exception request for evidence attribution",
        "evidence-decider",
        "Rejected in synthetic evidence fixture",
        "2026-08-31T12:05:00.000Z",
        "2026-12-31",
        "2026-08-31T12:01:00.000Z",
        "2026-08-31T12:05:00.000Z",
      );
    const evidence = await agent
      .get(`/api/certificates/${response.body.data.id}/evidence-bundle`)
      .expect("Content-Type", /application\/json/)
      .expect("Cache-Control", "private, no-store")
      .expect(200);
    expect(evidence.headers["content-disposition"]).toContain("opencoi-evidence-");
    expect(evidence.body).toMatchObject({
      schemaVersion: "1.0",
      payload: {
        scope: { organization: { id: "org-a" }, certificateId: response.body.data.id },
        sourceDocument: {
          originalFilename: "certificate.pdf",
          sha256: createHash("sha256").update(PDF).digest("hex"),
        },
        machineProposal: null,
        confirmedFacts: { namedInsured: "Formula Electric LLC" },
        statusAtExport: { documentCheck: "meets" },
        requirementSnapshot: {
          publication: { publishedBy: { id: "admin-a", name: "Admin A" } },
        },
        exceptions: [
          {
            id: "evidence-exception",
            requestedBy: { id: "admin-a", name: "Admin A" },
            decidedBy: { id: "evidence-decider", name: "Evidence Decider" },
          },
        ],
      },
      integrity: {
        canonicalization: "OPENCOI_CANONICAL_JSON_V1",
        digest: { algorithm: "SHA-256" },
        signature: { algorithm: "Ed25519" },
      },
    });
    const canonical = canonicalizeJson({
      schemaVersion: evidence.body.schemaVersion,
      exportedAt: evidence.body.exportedAt,
      payload: evidence.body.payload,
    });
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      evidence.body.integrity.digest.value,
    );
    const publicKey = createPublicKey({
      key: Buffer.from(evidence.body.integrity.signature.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(canonical),
        publicKey,
        Buffer.from(evidence.body.integrity.signature.value, "base64url"),
      ),
    ).toBe(true);
    const storedKey = database
      .prepare(
        "SELECT public_key_fingerprint, private_key_ciphertext FROM evidence_signing_keys WHERE organization_id = ?",
      )
      .get("org-a") as { public_key_fingerprint: string; private_key_ciphertext: string };
    expect(storedKey.public_key_fingerprint).toBe(
      evidence.body.integrity.signature.publicKeyFingerprint,
    );
    expect(storedKey.private_key_ciphertext).toMatch(/^enc:v1:/);
    expect(evidence.body.payload.audit.certificateEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ actorUserId: "admin-a" })]),
    );
    const repository = createOrganizationRepository(database, "org-a");
    if (!repository.getVendorType("type-after-evaluation")) {
      repository.createVendorType({ id: "type-after-evaluation", name: "Changed later" });
    }
    database
      .prepare("UPDATE vendors SET vendor_type_id = ? WHERE organization_id = ? AND id = ?")
      .run("type-after-evaluation", "org-a", "vendor-a");
    try {
      const afterVendorTypeChange = await agent
        .get(`/api/certificates/${response.body.data.id}/evidence-bundle`)
        .expect(200);
      expect(afterVendorTypeChange.body.payload).toMatchObject({
        scope: { vendor: { vendorTypeAtExport: { id: "type-after-evaluation" } } },
        review: { evaluationVendorType: { id: "type-a", name: "Contractor" } },
        requirementSnapshot: {
          version: 1,
          vendorType: { id: "type-a", name: "Contractor" },
          evaluatedRuleset: { id: "requirements:type-a:v1" },
        },
      });
    } finally {
      database
        .prepare("UPDATE vendors SET vendor_type_id = ? WHERE organization_id = ? AND id = ?")
        .run("type-a", "org-a", "vendor-a");
    }
  });

  it("tracks a single-use certificate request through exact-link submission", async () => {
    setupVendor();
    const { agent, csrf } = await login();
    const created = await agent
      .post("/api/vendors/vendor-a/certificate-requests")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({
        kind: "initial",
        deliveryMethod: "manual",
        recipientName: "Vendor Contact",
        recipientEmail: "vendor@example.test",
        ttlDays: 14,
      })
      .expect(201);
    expect(created.body.data).toMatchObject({
      request: {
        vendorId: "vendor-a",
        state: "open",
        deliveryMethod: "manual",
        deliverySecretAvailable: false,
      },
      disclosure: expect.stringContaining("shown once"),
    });
    const uploadUrl = new URL(created.body.data.uploadUrl as string);
    const publicPath = `${uploadUrl.pathname.replace(/^\/upload\//, "/api/public/upload/")}`;
    await request(app).get(publicPath).expect(200);
    const submitted = await request(app)
      .post(publicPath)
      .field(
        "metadata",
        JSON.stringify({
          reviewStatus: "UNCONFIRMED",
          namedInsured: "Formula Electric LLC",
          policies: [],
        }),
      )
      .attach("document", PDF, "requested-certificate.pdf")
      .expect(201);
    const listed = await agent.get("/api/vendors/vendor-a/certificate-requests").expect(200);
    expect(listed.body.data.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.data.request.id,
          state: "submitted",
          submittedCertificateId: submitted.body.data.receiptId,
          deliverySecretAvailable: false,
        }),
      ]),
    );
    await agent
      .post(`/api/certificate-requests/${created.body.data.request.id}/cancel`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({})
      .expect(409);
    await request(app).get(publicPath).expect(404);
  });

  it("cancels a tracked request when its generic upload link is revoked", async () => {
    setupVendor();
    const { agent, csrf } = await login();
    const created = await agent
      .post("/api/vendors/vendor-a/certificate-requests")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ kind: "renewal", deliveryMethod: "manual", ttlDays: 14 })
      .expect(201);

    await agent
      .post(`/api/upload-links/${created.body.data.request.uploadLinkId}/revoke`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({})
      .expect(204);
    const listed = await agent.get("/api/vendors/vendor-a/certificate-requests").expect(200);
    expect(listed.body.data.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.data.request.id,
          state: "cancelled",
          deliverySecretAvailable: false,
        }),
      ]),
    );
    const uploadUrl = new URL(created.body.data.uploadUrl as string);
    await request(app)
      .get(uploadUrl.pathname.replace(/^\/upload\//, "/api/public/upload/"))
      .expect(404);
  });

  it("atomically cancels open requests when a vendor is deactivated", async () => {
    setupVendor();
    const { agent, csrf } = await login();
    const created = await agent
      .post("/api/vendors/vendor-a/certificate-requests")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ kind: "initial", deliveryMethod: "manual", ttlDays: 14 })
      .expect(201);
    const publicPath = new URL(created.body.data.uploadUrl as string).pathname.replace(
      /^\/upload\//,
      "/api/public/upload/",
    );

    try {
      await agent
        .patch("/api/vendors/vendor-a")
        .set("Origin", ORIGIN)
        .set("X-CSRF-Token", csrf)
        .send({ status: "inactive" })
        .expect(200);

      const listed = await agent.get("/api/vendors/vendor-a/certificate-requests").expect(200);
      expect(listed.body.data.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.body.data.request.id,
            state: "cancelled",
            deliverySecretAvailable: false,
          }),
        ]),
      );
      await request(app).get(publicPath).expect(404);
      expect(
        database
          .prepare(
            `SELECT count(*) AS count FROM audit_events
             WHERE organization_id = ? AND entity_id = ? AND action = ?`,
          )
          .get("org-a", created.body.data.request.id, "certificate_request.cancelled"),
      ).toEqual({ count: 1 });
    } finally {
      database
        .prepare("UPDATE vendors SET status = 'active' WHERE organization_id = ? AND id = ?")
        .run("org-a", "vendor-a");
    }
  });

  it("prevents reviewers from redirecting SMTP certificate requests", async () => {
    setupVendor();
    const repository = createOrganizationRepository(database, "org-a");
    const reviewer = repository.createUser({
      id: "request-reviewer",
      email: "request-reviewer@example.test",
      displayName: "Request Reviewer",
      passwordHash,
      role: "reviewer",
    });
    const smtpApp = createApp({
      config: {
        ...config,
        smtp: {
          host: "smtp.example.test",
          port: 587,
          secure: false,
          from: "requests@example.test",
        },
      },
      database,
      documentStore: store,
      staticDirectory: false,
    });
    const reviewerAgent = request.agent(smtpApp);
    try {
      const signedIn = await reviewerAgent
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({ email: reviewer.email, password: PASSWORD })
        .expect(200);
      const csrf = signedIn.body.data.csrfToken as string;
      await reviewerAgent
        .patch("/api/vendors/vendor-a")
        .set("Origin", ORIGIN)
        .set("X-CSRF-Token", csrf)
        .send({ contactEmail: "redirect@example.test" })
        .expect(403);
      await reviewerAgent
        .post("/api/vendors/vendor-a/certificate-requests")
        .set("Origin", ORIGIN)
        .set("X-CSRF-Token", csrf)
        .send({
          kind: "renewal",
          deliveryMethod: "smtp",
          recipientEmail: "redirect@example.test",
          ttlDays: 14,
        })
        .expect(403);
      await reviewerAgent
        .post("/api/vendors/vendor-a/certificate-requests")
        .set("Origin", ORIGIN)
        .set("X-CSRF-Token", csrf)
        .send({ kind: "renewal", deliveryMethod: "smtp", ttlDays: 14 })
        .expect(201);
    } finally {
      repository.setUserStatus(reviewer.id, "disabled");
    }
  });

  it("allows exceptions only for open failures on confirmed certificates", async () => {
    const repository = createOrganizationRepository(database, "org-a");
    const vendorType = repository.createVendorType({
      id: "type-exception-guard",
      name: "Exception guard contractor",
    });
    repository.createCoverageRequirement({
      id: "requirement-exception-guard",
      vendorTypeId: vendorType.id,
      coverageType: "general_liability",
      minimumEachOccurrence: 2_000_000,
      ruleConfig: {
        version: 1,
        label: "Commercial General Liability",
        required: true,
        currency: "USD",
      },
    });
    repository.createVendor({
      id: "vendor-exception-guard",
      vendorTypeId: vendorType.id,
      legalName: "Exception Guard Vendor",
      contactEmail: "exception-guard@example.test",
    });
    const { agent, csrf } = await login();
    const uploaded = await agent
      .post("/api/vendors/vendor-exception-guard/certificates")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .field(
        "metadata",
        JSON.stringify({
          reviewStatus: "UNCONFIRMED",
          namedInsured: "Exception Guard Vendor",
          policies: [
            {
              coverageType: "COMMERCIAL_GENERAL_LIABILITY",
              insurer: "Example Insurance",
              policyNumber: "GUARD-1",
              effectiveDate: "2026-01-01",
              expirationDate: "2027-12-31",
              limits: { EACH_OCCURRENCE: 1_000_000 },
              endorsements: [],
            },
          ],
        }),
      )
      .attach("document", PDF, "exception-guard.pdf")
      .expect(201);
    const certificateId = uploaded.body.data.id as string;
    const draftFindingId = uploaded.body.data.findings[0].id as string;
    const requestBody = {
      vendorId: "vendor-exception-guard",
      reason: "A documented temporary business exception is required.",
      compensatingControls: "Contract owner will monitor work until replacement coverage arrives.",
      expiresAt: "2027-12-31",
    };

    await agent
      .post("/api/exceptions")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ ...requestBody, findingId: draftFindingId })
      .expect(400);

    const confirmed = await agent
      .put(`/api/certificates/${certificateId}/confirmation`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ confirmed: true })
      .expect(200);
    const failedFinding = confirmed.body.data.findings.find(
      (finding: { outcome: string }) => finding.outcome === "FAIL",
    ) as { id: string } | undefined;
    const nonFailedFinding = confirmed.body.data.findings.find(
      (finding: { outcome: string }) => finding.outcome !== "FAIL",
    ) as { id: string } | undefined;
    expect(failedFinding).toBeDefined();
    expect(nonFailedFinding).toBeDefined();

    await agent
      .post("/api/exceptions")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ ...requestBody, findingId: nonFailedFinding?.id })
      .expect(400);
    const exception = await agent
      .post("/api/exceptions")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ ...requestBody, findingId: failedFinding?.id })
      .expect(201);
    await agent
      .post(`/api/exceptions/${exception.body.data.id}/decision`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({
        decision: "approved",
        decisionReason: "The requester cannot approve the same risk exception.",
      })
      .expect(409);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("evaluates automobile CSL and professional claim/aggregate limits by their exact types", async () => {
    const repository = createOrganizationRepository(database, "org-a");
    const vendorType = repository.createVendorType({
      id: "type-specialty-limits",
      name: "Specialty limit contractor",
    });
    repository.createCoverageRequirement({
      id: "requirement-auto-csl",
      vendorTypeId: vendorType.id,
      coverageType: "automobile_liability",
      minimumEachOccurrence: 100_000_000,
      ruleConfig: { version: 1, label: "Automobile Liability", required: true, currency: "USD" },
    });
    repository.createCoverageRequirement({
      id: "requirement-professional",
      vendorTypeId: vendorType.id,
      coverageType: "professional_liability",
      minimumEachOccurrence: 100_000_000,
      minimumAggregate: 200_000_000,
      ruleConfig: {
        version: 1,
        label: "Professional Liability",
        required: true,
        currency: "USD",
      },
    });
    const vendor = repository.createVendor({
      id: "vendor-specialty-limits",
      vendorTypeId: vendorType.id,
      legalName: "Specialty Limits Vendor",
    });
    const { agent, csrf } = await login();
    const response = await agent
      .post(`/api/vendors/${vendor.id}/certificates`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .field(
        "metadata",
        JSON.stringify({
          reviewStatus: "CONFIRMED",
          namedInsured: vendor.legal_name,
          policies: [
            {
              coverageType: "AUTOMOBILE_LIABILITY",
              insurer: "Example Auto Insurance",
              policyNumber: "AUTO-CSL-1",
              effectiveDate: "2026-01-01",
              expirationDate: "2027-01-01",
              limits: { COMBINED_SINGLE_LIMIT: 100_000_000 },
              endorsements: [],
            },
            {
              coverageType: "PROFESSIONAL_LIABILITY",
              insurer: "Example Professional Insurance",
              policyNumber: "PRO-CLAIM-1",
              effectiveDate: "2026-01-01",
              expirationDate: "2027-01-01",
              limits: { EACH_CLAIM: 100_000_000, AGGREGATE: 200_000_000 },
              endorsements: [],
            },
          ],
        }),
      )
      .attach("document", PDF, "specialty-limits.pdf")
      .expect(201);

    expect(response.body.data).toMatchObject({ documentStatus: "confirmed", checkStatus: "meets" });
    const passingLimitTypes = response.body.data.findings
      .filter(
        (finding: { ruleCode: string; outcome: string }) =>
          finding.ruleCode === "LIMIT_SATISFIES" && finding.outcome === "PASS",
      )
      .map((finding: { expected: string }) => JSON.parse(finding.expected).limitType);
    expect(passingLimitTypes).toEqual(
      expect.arrayContaining(["COMBINED_SINGLE_LIMIT", "EACH_CLAIM", "AGGREGATE"]),
    );
  });

  it("rejects an invalid public token before parsing an upload body", async () => {
    await request(app).post("/api/public/upload/not-a-real-token").expect(404);
  });

  it("persists reviewer corrections before evaluating a vendor submission", async () => {
    setupVendor();
    const { agent, csrf } = await login();
    const linkResponse = await agent
      .post("/api/vendors/vendor-a/upload-links")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ ttlDays: 7 })
      .expect(201);
    const token = new URL(linkResponse.body.data.url as string).pathname
      .split("/")
      .at(-1) as string;
    const context = await request(app).get(`/api/public/upload/${token}`).expect(200);
    expect(context.body.data.vendorName).toBe("=Formula Electric");
    expect(context.headers["cache-control"]).toBe("no-store");
    expect(context.headers.etag).toBeUndefined();
    const submitted = await request(app)
      .post(`/api/public/upload/${token}`)
      .field(
        "metadata",
        JSON.stringify({
          reviewStatus: "CONFIRMED",
          namedInsured: "Untrusted Vendor Claim",
          issueDate: "2025-12-01",
          producer: "Untrusted OCR producer",
          certificateHolder: "Wrong holder",
          rawText: "ORIGINAL OCR PAYLOAD",
          pages: [{ page: 1, text: "ORIGINAL OCR PAYLOAD", method: "text_layer" }],
          policies: [
            {
              coverageType: "COMMERCIAL_GENERAL_LIABILITY",
              insurer: "OCR Insurance",
              policyNumber: "OCR-1",
              effectiveDate: "2026-01-01",
              expirationDate: "2026-02-01",
              limits: { EACH_OCCURRENCE: 1 },
              endorsements: [],
            },
          ],
        }),
      )
      .attach("document", PDF, "vendor.pdf")
      .expect(201);
    const certificateId = submitted.body.data.receiptId as string;
    const pending = await agent.get(`/api/certificates/${certificateId}`).expect(200);
    expect(pending.body.data).toMatchObject({
      documentStatus: "pending_review",
      checkStatus: "needs_review",
    });
    const pendingEvidence = await agent
      .get(`/api/certificates/${certificateId}/evidence-bundle`)
      .expect(200);
    expect(pendingEvidence.body.payload).toMatchObject({
      review: { status: "draft", reviewedBy: null, reviewedAt: null },
      machineProposal: {
        reviewStatus: "UNCONFIRMED",
        namedInsured: "Untrusted Vendor Claim",
        rawText: "ORIGINAL OCR PAYLOAD",
        policies: [expect.objectContaining({ policyNumber: "OCR-1" })],
      },
      confirmedFacts: null,
    });
    const confirmed = await agent
      .put(`/api/certificates/${certificateId}/confirmation`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({
        confirmed: true,
        corrections: {
          namedInsured: "Formula Electric LLC",
          issueDate: "2026-01-02",
          producer: "Correct Broker LLC",
          certificateHolder: "Organization A",
          policies: [
            {
              coverageType: "COMMERCIAL_GENERAL_LIABILITY",
              insurer: "Correct Insurance Co",
              policyNumber: "GL-CORRECTED",
              effectiveDate: "2026-01-01",
              expirationDate: "2027-01-01",
              limits: {
                EACH_OCCURRENCE: 200_000_000,
                GENERAL_AGGREGATE: 300_000_000,
              },
              endorsements: [
                {
                  name: "Additional Insured",
                  formCode: "CG 20 10",
                  evidenceLevel: "HUMAN_VERIFIED",
                },
              ],
            },
            {
              coverageType: "PROFESSIONAL_LIABILITY",
              insurer: "Correct Specialty Co",
              policyNumber: "PRO-CORRECTED",
              effectiveDate: "2026-01-01",
              expirationDate: "2027-01-01",
              limits: { EACH_CLAIM: 500_000_000, AGGREGATE: 1_000_000_000 },
              endorsements: [],
            },
          ],
        },
      })
      .expect(200);
    expect(confirmed.body.data).toMatchObject({
      documentStatus: "confirmed",
      checkStatus: "meets",
      namedInsured: "Formula Electric LLC",
      issueDate: "2026-01-02",
      producer: "Correct Broker LLC",
      certificateHolder: "Organization A",
    });
    const professionalPolicy = confirmed.body.data.policies.find(
      (policy: { coverageType: string }) => policy.coverageType === "PROFESSIONAL_LIABILITY",
    );
    expect(professionalPolicy).toMatchObject({
      policyNumber: "PRO-CORRECTED",
      limits: { EACH_CLAIM: 500_000_000, AGGREGATE: 1_000_000_000 },
    });
    const generalLiabilityPolicy = confirmed.body.data.policies.find(
      (policy: { coverageType: string }) => policy.coverageType === "COMMERCIAL_GENERAL_LIABILITY",
    );
    expect(generalLiabilityPolicy).toMatchObject({
      insurer: "Correct Insurance Co",
      limits: { EACH_OCCURRENCE: 200_000_000, GENERAL_AGGREGATE: 300_000_000 },
      endorsements: [
        {
          name: "Additional Insured",
          formCode: "CG 20 10",
          evidenceLevel: "HUMAN_VERIFIED",
        },
      ],
    });
    const confirmedEvidence = await agent
      .get(`/api/certificates/${certificateId}/evidence-bundle`)
      .expect(200);
    expect(confirmedEvidence.body.payload).toMatchObject({
      review: { status: "confirmed", reviewedBy: { id: "admin-a", name: "Admin A" } },
      machineProposal: {
        reviewStatus: "UNCONFIRMED",
        namedInsured: "Untrusted Vendor Claim",
        rawText: "ORIGINAL OCR PAYLOAD",
        policies: [expect.objectContaining({ policyNumber: "OCR-1" })],
      },
      confirmedFacts: {
        namedInsured: "Formula Electric LLC",
        policies: expect.arrayContaining([
          expect.objectContaining({ policyNumber: "GL-CORRECTED" }),
        ]),
      },
    });

    const storedCertificate = database
      .prepare(
        `SELECT insured_name, producer_name, issued_on, earliest_expiration_date
         FROM certificates WHERE organization_id = 'org-a' AND id = ?`,
      )
      .get(certificateId) as Record<string, unknown>;
    expect(storedCertificate).toMatchObject({
      insured_name: "Formula Electric LLC",
      producer_name: "Correct Broker LLC",
      issued_on: "2026-01-02",
      earliest_expiration_date: "2027-01-01",
    });
    const storedProfessionalPolicy = database
      .prepare(
        `SELECT metadata_json FROM policies
         WHERE organization_id = 'org-a' AND certificate_id = ?
           AND coverage_type = 'PROFESSIONAL_LIABILITY'`,
      )
      .get(certificateId) as { metadata_json: string };
    expect(JSON.parse(storedProfessionalPolicy.metadata_json).limits).toEqual({
      EACH_CLAIM: 500_000_000,
      AGGREGATE: 1_000_000_000,
    });
    const storedDocument = database
      .prepare(
        `SELECT processing_status, ocr_text, extraction_json
         FROM documents WHERE organization_id = 'org-a'
           AND id = (SELECT document_id FROM certificates WHERE id = ?)`,
      )
      .get(certificateId) as {
      processing_status: string;
      ocr_text: string;
      extraction_json: string;
    };
    expect(storedDocument).toMatchObject({
      processing_status: "confirmed",
      ocr_text: "ORIGINAL OCR PAYLOAD",
    });
    const extraction = JSON.parse(storedDocument.extraction_json);
    expect(extraction).toMatchObject({
      rawText: "ORIGINAL OCR PAYLOAD",
      pages: [{ page: 1, text: "ORIGINAL OCR PAYLOAD", method: "text_layer" }],
      reviewStatus: "CONFIRMED",
      namedInsured: "Formula Electric LLC",
      _opencoi: {
        machineProposal: {
          reviewStatus: "UNCONFIRMED",
          namedInsured: "Untrusted Vendor Claim",
          policies: [expect.objectContaining({ policyNumber: "OCR-1" })],
        },
        confirmation: {
          status: "CONFIRMED",
          correctedFields: expect.arrayContaining([
            "namedInsured",
            "issueDate",
            "producer",
            "certificateHolder",
            "policies",
          ]),
        },
      },
    });
    const auditResponse = await agent.get("/api/audit").expect(200);
    const confirmationAudit = auditResponse.body.data.find(
      (event: { action: string; entityLabel: string }) =>
        event.action === "certificate.confirmed" &&
        event.entityLabel === `certificate ${certificateId}`,
    );
    expect(confirmationAudit.metadata.correctedFields).toEqual(
      expect.arrayContaining(["namedInsured", "policies"]),
    );
    await agent
      .put(`/api/certificates/${certificateId}/confirmation`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ confirmed: true })
      .expect(409);
    await request(app).get(`/api/public/upload/${token}`).expect(404);
  });

  it("rejects a pending vendor submission with an audited reason and removes it from review", async () => {
    setupVendor();
    const repository = createOrganizationRepository(database, "org-a");
    repository.createVendor({
      id: "vendor-rejection",
      vendorTypeId: "type-a",
      legalName: "Rejected Submission Vendor",
      contactEmail: "rejected@example.test",
    });
    const { agent, csrf } = await login();
    const linkResponse = await agent
      .post("/api/vendors/vendor-rejection/upload-links")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ ttlDays: 7 })
      .expect(201);
    const token = new URL(linkResponse.body.data.url as string).pathname
      .split("/")
      .at(-1) as string;
    const submitted = await request(app)
      .post(`/api/public/upload/${token}`)
      .field(
        "metadata",
        JSON.stringify({
          reviewStatus: "UNCONFIRMED",
          namedInsured: "Different Legal Entity",
          rawText: "REJECTED ORIGINAL OCR",
          policies: [],
        }),
      )
      .attach("document", PDF, "wrong-entity.pdf")
      .expect(201);
    const certificateId = submitted.body.data.receiptId as string;

    await agent
      .put(`/api/certificates/${certificateId}/rejection`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ reason: "too short" })
      .expect(400);

    const reason = "The named insured is a different legal entity from the vendor record.";
    const rejected = await agent
      .put(`/api/certificates/${certificateId}/rejection`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ reason })
      .expect(200);
    expect(rejected.body.data).toMatchObject({
      documentStatus: "rejected",
      checkStatus: "not_submitted",
      reviewDecision: { status: "REJECTED", reason },
    });

    const vendors = await agent.get("/api/vendors").expect(200);
    expect(
      vendors.body.data.find((vendor: { id: string }) => vendor.id === "vendor-rejection"),
    ).toMatchObject({ status: "not_submitted", lifecycleStatus: "unknown" });
    const reviewCandidates = await agent.get("/api/vendors?check=needs_review").expect(200);
    expect(
      reviewCandidates.body.data.some((vendor: { id: string }) => vendor.id === "vendor-rejection"),
    ).toBe(false);
    const complianceExport = await agent.get("/api/vendors/export.csv").expect(200);
    expect(complianceExport.text).not.toContain(certificateId);
    const vendorDetail = await agent.get("/api/vendors/vendor-rejection").expect(200);
    expect(vendorDetail.body.data.certificates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: certificateId, documentStatus: "rejected" }),
      ]),
    );

    const stored = database
      .prepare(
        `SELECT c.confirmation_status, d.processing_status, d.ocr_text, d.extraction_json
         FROM certificates c
         JOIN documents d ON d.organization_id = c.organization_id AND d.id = c.document_id
         WHERE c.organization_id = 'org-a' AND c.id = ?`,
      )
      .get(certificateId) as {
      confirmation_status: string;
      processing_status: string;
      ocr_text: string;
      extraction_json: string;
    };
    expect(stored).toMatchObject({
      confirmation_status: "rejected",
      processing_status: "rejected",
      ocr_text: "REJECTED ORIGINAL OCR",
    });
    expect(JSON.parse(stored.extraction_json)).toMatchObject({
      rawText: "REJECTED ORIGINAL OCR",
      _opencoi: { reviewDecision: { status: "REJECTED", reason } },
    });
    const auditResponse = await agent.get("/api/audit").expect(200);
    expect(
      auditResponse.body.data.find(
        (event: { action: string; entityLabel: string }) =>
          event.action === "certificate.rejected" &&
          event.entityLabel === `certificate ${certificateId}`,
      ),
    ).toMatchObject({ metadata: { rejectionReason: reason } });

    await agent
      .put(`/api/certificates/${certificateId}/confirmation`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ confirmed: true })
      .expect(409);
    await agent
      .put(`/api/certificates/${certificateId}/rejection`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ reason })
      .expect(409);
  });

  it("publishes v2 after evaluation without rewriting v1 requirements or findings", async () => {
    const { agent, csrf } = await login();
    const vendorTypeResponse = await agent
      .post("/api/vendor-types")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({ name: "Versioned requirement contractor" })
      .expect(201);
    const vendorTypeId = vendorTypeResponse.body.data.id as string;
    const requirement = (minimumEachOccurrence: number) => ({
      coverageType: "general_liability",
      label: "Commercial General Liability",
      required: true,
      minimumEachOccurrence,
      minimumAggregate: null,
      currency: "USD",
      requiredEndorsements: [],
      endorsementEvidence: "indicated",
      expirationWarningDays: 30,
    });
    const v1Payload = { requirements: [requirement(100_000_000)] };
    const v1 = await agent
      .put(`/api/vendor-types/${vendorTypeId}/requirements`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send(v1Payload)
      .expect(200);
    expect(v1.body.data.version).toBe(1);

    const vendorResponse = await agent
      .post("/api/vendors")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send({
        vendorTypeId,
        legalName: "Versioned Evaluation Vendor",
        contactEmail: "versioned@example.test",
      })
      .expect(201);
    const vendorId = vendorResponse.body.data.id as string;
    const certificateResponse = await agent
      .post(`/api/vendors/${vendorId}/certificates`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .field(
        "metadata",
        JSON.stringify({
          reviewStatus: "CONFIRMED",
          namedInsured: "Versioned Evaluation Vendor",
          policies: [
            {
              coverageType: "COMMERCIAL_GENERAL_LIABILITY",
              insurer: "Example Insurance",
              policyNumber: "VERSIONED-1",
              effectiveDate: "2026-01-01",
              expirationDate: "2027-12-31",
              limits: { EACH_OCCURRENCE: 150_000_000 },
              endorsements: [],
            },
          ],
        }),
      )
      .attach("document", PDF, "versioned.pdf")
      .expect(201);
    const certificateId = certificateResponse.body.data.id as string;
    const repository = createOrganizationRepository(database, "org-a");
    const v1Requirements = repository.listCoverageRequirements(vendorTypeId);
    expect(v1Requirements).toHaveLength(1);
    const v1RequirementId = String(v1Requirements[0]?.id);
    const findingsBefore = database
      .prepare(
        `SELECT id, requirement_id, evaluation_status, code, message,
                expected_json, actual_json, created_at, updated_at
         FROM findings WHERE organization_id = ? AND certificate_id = ? ORDER BY id`,
      )
      .all("org-a", certificateId);
    expect(findingsBefore.some((row) => row.requirement_id === v1RequirementId)).toBe(true);

    const v2Payload = { requirements: [requirement(300_000_000)] };
    const v2 = await agent
      .put(`/api/vendor-types/${vendorTypeId}/requirements`)
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf)
      .send(v2Payload)
      .expect(200);
    expect(v2.body.data).toMatchObject({ version: 2, requirementCount: 1 });
    expect(v2.body.data.requirements).toEqual([
      expect.objectContaining({ minimumEachOccurrence: 300_000_000 }),
    ]);

    const requirementRows = database
      .prepare(
        `SELECT id, is_active, minimum_each_occurrence, rule_config_json
         FROM coverage_requirements
         WHERE organization_id = ? AND vendor_type_id = ?
         ORDER BY is_active, created_at, id`,
      )
      .all("org-a", vendorTypeId);
    expect(requirementRows).toHaveLength(2);
    expect(requirementRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: v1RequirementId,
          is_active: 0,
          minimum_each_occurrence: 100_000_000,
        }),
        expect.objectContaining({ is_active: 1, minimum_each_occurrence: 300_000_000 }),
      ]),
    );
    expect(repository.listCoverageRequirements(vendorTypeId)).toEqual([
      expect.objectContaining({ is_active: 1, minimum_each_occurrence: 300_000_000 }),
    ]);
    expect(
      database
        .prepare(
          `SELECT version, requirements_json FROM requirement_versions
           WHERE organization_id = ? AND vendor_type_id = ? ORDER BY version`,
        )
        .all("org-a", vendorTypeId),
    ).toEqual([
      { version: 1, requirements_json: JSON.stringify(v1Payload.requirements) },
      { version: 2, requirements_json: JSON.stringify(v2Payload.requirements) },
    ]);
    expect(
      database
        .prepare(
          `SELECT id, requirement_id, evaluation_status, code, message,
                  expected_json, actual_json, created_at, updated_at
           FROM findings WHERE organization_id = ? AND certificate_id = ? ORDER BY id`,
        )
        .all("org-a", certificateId),
    ).toEqual(findingsBefore);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("does not expose records from another organization", async () => {
    const { agent } = await login();
    await agent.get("/api/vendors/vendor-b").expect(404);
    const rows = await agent.get("/api/vendors").expect(200);
    expect(rows.body.data.some((vendor: { id: string }) => vendor.id === "vendor-b")).toBe(false);
  });

  it("exports organization-scoped compliance CSV with formula neutralization", async () => {
    setupVendor();
    const { agent } = await login();
    const response = await agent.get("/api/vendors/export.csv").expect(200);
    expect(response.headers["content-type"]).toMatch(/text\/csv/);
    expect(response.text).toContain("Vendor ID,Vendor name");
    expect(response.text).toContain("'=Formula Electric");
    expect(response.text).not.toContain("Vendor B");
  });
});
