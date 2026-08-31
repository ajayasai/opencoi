import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapOrganization,
  type CertificateRequestRow,
  createOrganizationRepository,
  initializeDatabase,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import {
  type CreateCertificateRequestInput,
  cancelCertificateRequest,
  cancelOpenCertificateRequest,
  claimCertificateRequestDelivery,
  completeCertificateRequestDelivery,
  createCertificateRequest,
  getCertificateRequest,
  getCertificateRequestDeliveryMaterial,
  listCertificateRequests,
  markCertificateRequestSubmitted,
} from "./certificateRequests.js";

const TOKEN_PEPPER = "certificate-request-test-key-material-at-least-32-bytes";
const NOW = "2026-09-01T10:00:00.000Z";
const EXPIRES_AT = "2026-09-15T10:00:00.000Z";

const uploadToken = (suffix: string): string => `v1.org-a.${suffix.padEnd(48, "x")}`;

describe("certificate request domain", () => {
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
    const repository = createOrganizationRepository(database, "org-a");
    const vendorType = repository.createVendorType({ id: "vendor-type-a", name: "Contractor" });
    repository.createVendor({
      id: "vendor-a",
      vendorTypeId: vendorType.id,
      legalName: "Vendor A",
      contactName: "Taylor Vendor",
      contactEmail: "vendor-a@example.test",
    });
  });

  afterEach(() => database.close());

  const create = (overrides: Partial<CreateCertificateRequestInput> = {}) =>
    createCertificateRequest(database, {
      organizationId: "org-a",
      vendorId: "vendor-a",
      uploadToken: uploadToken("request-token"),
      expiresAt: EXPIRES_AT,
      kind: "renewal",
      deliveryMethod: "smtp",
      tokenPepper: TOKEN_PEPPER,
      recipientName: "Taylor Vendor",
      recipientEmail: "Vendor-A@Example.Test",
      createdByUserId: "admin-a",
      requestId: "request-a",
      uploadLinkId: "upload-link-a",
      at: NOW,
      ...overrides,
    });

  it("creates an organization-scoped upload link and keeps queued SMTP tokens encrypted", () => {
    const created = create();

    expect(created).toMatchObject({
      id: "request-a",
      organizationId: "org-a",
      vendorId: "vendor-a",
      uploadLinkId: "upload-link-a",
      kind: "renewal",
      deliveryMethod: "smtp",
      deliveryStatus: "queued",
      recipientEmail: "vendor-a@example.test",
      state: "open",
      expiresAt: EXPIRES_AT,
      uploadUseCount: 0,
      uploadRevokedAt: null,
      deliverySecretAvailable: true,
    });

    const raw = database
      .prepare("SELECT * FROM certificate_requests WHERE id = ?")
      .get(created.id) as unknown as CertificateRequestRow;
    expect(raw.upload_token_ciphertext).toMatch(/^enc:v1:/);
    expect(raw.upload_token_ciphertext).not.toContain(uploadToken("request-token"));
    expect(
      JSON.stringify(database.prepare("SELECT * FROM certificate_requests").all()),
    ).not.toContain(uploadToken("request-token"));
    expect(
      database.prepare("SELECT token_hash FROM upload_links WHERE id = ?").get("upload-link-a"),
    ).not.toEqual(expect.objectContaining({ token_hash: uploadToken("request-token") }));

    const material = getCertificateRequestDeliveryMaterial(database, {
      organizationId: "org-a",
      requestId: created.id,
      tokenPepper: TOKEN_PEPPER,
      at: NOW,
    });
    expect(material?.uploadToken).toBe(uploadToken("request-token"));
    expect(material?.request.id).toBe(created.id);
    expect(() =>
      getCertificateRequestDeliveryMaterial(database, {
        organizationId: "org-a",
        requestId: created.id,
        tokenPepper: "different-key-material-that-is-also-at-least-32-bytes",
        at: NOW,
      }),
    ).toThrow();
  });

  it("creates manual-share requests without retaining a reversible token", () => {
    const created = create({
      deliveryMethod: "manual",
      recipientEmail: undefined,
      tokenPepper: undefined,
      requestId: "manual-request",
      uploadLinkId: "manual-link",
      uploadToken: uploadToken("manual-token"),
      kind: "initial",
    });

    expect(created).toMatchObject({
      deliveryMethod: "manual",
      deliveryStatus: "manual_ready",
      recipientEmail: null,
      deliverySecretAvailable: false,
    });
    const raw = database
      .prepare("SELECT upload_token_ciphertext FROM certificate_requests WHERE id = ?")
      .get(created.id) as { upload_token_ciphertext: string | null };
    expect(raw.upload_token_ciphertext).toBeNull();
    expect(
      getCertificateRequestDeliveryMaterial(database, {
        organizationId: "org-a",
        requestId: created.id,
        tokenPepper: TOKEN_PEPPER,
        at: NOW,
      }),
    ).toBeNull();
  });

  it("leases queued SMTP delivery immediately before sending and completes only that claim", () => {
    create();
    const first = claimCertificateRequestDelivery(database, {
      organizationId: "org-a",
      tokenPepper: TOKEN_PEPPER,
      at: NOW,
    });
    expect(first).toMatchObject({
      uploadToken: uploadToken("request-token"),
      request: { id: "request-a", deliveryStatus: "processing", attemptCount: 1 },
    });
    expect(
      claimCertificateRequestDelivery(database, {
        organizationId: "org-a",
        tokenPepper: TOKEN_PEPPER,
        at: NOW,
      }),
    ).toBeNull();

    const retryAt = "2026-09-01T10:15:00.000Z";
    expect(
      completeCertificateRequestDelivery(database, {
        organizationId: "org-a",
        requestId: "request-a",
        claimToken: first?.claimToken ?? "",
        accepted: false,
        errorMessage: "Temporary SMTP failure",
        retryAt,
        at: "2026-09-01T10:00:30.000Z",
      }),
    ).toMatchObject({
      deliveryStatus: "failed",
      deliverySecretAvailable: true,
      nextAttemptAt: retryAt,
    });
    const second = claimCertificateRequestDelivery(database, {
      organizationId: "org-a",
      tokenPepper: TOKEN_PEPPER,
      at: retryAt,
    });
    expect(second?.claimToken).not.toBe(first?.claimToken);
    const accepted = completeCertificateRequestDelivery(database, {
      organizationId: "org-a",
      requestId: "request-a",
      claimToken: second?.claimToken ?? "",
      accepted: true,
      at: "2026-09-01T10:15:05.000Z",
    });
    expect(accepted).toMatchObject({
      deliveryStatus: "accepted",
      acceptedAt: "2026-09-01T10:15:05.000Z",
      deliverySecretAvailable: false,
      attemptCount: 2,
    });
    expect(
      completeCertificateRequestDelivery(database, {
        organizationId: "org-a",
        requestId: "request-a",
        claimToken: first?.claimToken ?? "",
        accepted: false,
        errorMessage: "Stale worker result",
        at: "2026-09-01T10:15:06.000Z",
      }),
    ).toBeNull();
    expect(
      claimCertificateRequestDelivery(database, {
        organizationId: "org-a",
        tokenPepper: TOKEN_PEPPER,
        at: "2026-09-16T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(getCertificateRequest(database, "org-a", "request-a")).toMatchObject({
      state: "expired",
      deliveryStatus: "accepted",
      acceptedAt: "2026-09-01T10:15:05.000Z",
      deliveryError: null,
    });
  });

  it("terminalizes a legacy revoked row and claims the next eligible request", () => {
    create();
    create({
      requestId: "request-b",
      uploadLinkId: "upload-link-b",
      uploadToken: uploadToken("request-token-b"),
      recipientEmail: "vendor-b@example.test",
      at: "2026-09-01T10:00:01.000Z",
    });
    const repository = createOrganizationRepository(database, "org-a");
    expect(repository.revokeUploadLink("upload-link-a", "2026-09-01T10:01:00.000Z")).toBe(true);

    const claimed = claimCertificateRequestDelivery(database, {
      organizationId: "org-a",
      tokenPepper: TOKEN_PEPPER,
      at: "2026-09-01T10:02:00.000Z",
    });
    expect(claimed?.request.id).toBe("request-b");
    expect(getCertificateRequest(database, "org-a", "request-a")).toMatchObject({
      state: "cancelled",
      deliveryStatus: "cancelled",
      deliverySecretAvailable: false,
    });
  });

  it("rolls back the upload link when queued-token encryption cannot be established", () => {
    expect(() =>
      create({
        requestId: "invalid-key-request",
        uploadLinkId: "invalid-key-link",
        uploadToken: uploadToken("invalid-key-token"),
        tokenPepper: "too-short",
      }),
    ).toThrow(/at least 32/i);
    expect(
      database.prepare("SELECT id FROM upload_links WHERE id = 'invalid-key-link'").get(),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT id FROM certificate_requests WHERE id = 'invalid-key-request'")
        .get(),
    ).toBeUndefined();
  });

  it("lists sanitized vendor history without crossing organization boundaries", () => {
    create();
    create({
      requestId: "request-b",
      uploadLinkId: "upload-link-b",
      uploadToken: uploadToken("request-token-b"),
      deliveryMethod: "manual",
      tokenPepper: undefined,
      recipientEmail: undefined,
      at: "2026-09-01T11:00:00.000Z",
    });

    const listed = listCertificateRequests(database, "org-a", { vendorId: "vendor-a" });
    expect(listed.map((request) => request.id)).toEqual(["request-b", "request-a"]);
    expect(listed.every((request) => !("upload_token_ciphertext" in request))).toBe(true);
    expect(listCertificateRequests(database, "org-b")).toEqual([]);
    expect(getCertificateRequest(database, "org-b", "request-a")).toBeNull();
    expect(
      cancelCertificateRequest(database, { organizationId: "org-b", requestId: "request-a" }),
    ).toBeNull();
  });

  it("enforces active-vendor, recipient, and creator SMTP abuse caps transactionally", () => {
    const createNumbered = (index: number, email: string) =>
      create({
        requestId: `limited-request-${index}`,
        uploadLinkId: `limited-link-${index}`,
        uploadToken: uploadToken(`limited-token-${index}`),
        recipientEmail: email,
      });
    const cancel = (id: string) =>
      cancelCertificateRequest(database, {
        organizationId: "org-a",
        requestId: id,
        at: "2026-09-01T10:01:00.000Z",
      });

    const active = [0, 1, 2].map((index) => createNumbered(index, `active-${index}@example.test`));
    expect(() => createNumbered(3, "active-3@example.test")).toThrow(/three active/i);
    for (const request of active) cancel(request.id);

    for (let index = 10; index < 15; index += 1) {
      cancel(createNumbered(index, "bounded-recipient@example.test").id);
    }
    expect(() => createNumbered(15, "bounded-recipient@example.test")).toThrow(/recipient/i);

    for (let index = 20; index < 42; index += 1) {
      cancel(createNumbered(index, `unique-${index}@example.test`).id);
    }
    expect(() => createNumbered(42, "creator-cap@example.test")).toThrow(/You have reached/i);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM certificate_requests WHERE organization_id = ?")
        .get("org-a"),
    ).toEqual({ count: 30 });
  });

  it("cancels idempotently, revokes the upload link, and destroys queued token ciphertext", () => {
    create();
    const claim = claimCertificateRequestDelivery(database, {
      organizationId: "org-a",
      tokenPepper: TOKEN_PEPPER,
      at: NOW,
    });
    const cancelled = cancelCertificateRequest(database, {
      organizationId: "org-a",
      requestId: "request-a",
      at: "2026-09-02T10:00:00.000Z",
    });

    expect(cancelled).toMatchObject({
      state: "cancelled",
      cancelledAt: "2026-09-02T10:00:00.000Z",
      uploadRevokedAt: "2026-09-02T10:00:00.000Z",
      deliverySecretAvailable: false,
      deliveryStatus: "cancelled",
    });
    const raw = database
      .prepare("SELECT upload_token_ciphertext FROM certificate_requests WHERE id = ?")
      .get("request-a") as { upload_token_ciphertext: string | null };
    expect(raw.upload_token_ciphertext).toBeNull();
    expect(
      getCertificateRequestDeliveryMaterial(database, {
        organizationId: "org-a",
        requestId: "request-a",
        tokenPepper: TOKEN_PEPPER,
        at: "2026-09-02T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      cancelCertificateRequest(database, {
        organizationId: "org-a",
        requestId: "request-a",
        at: "2026-09-03T10:00:00.000Z",
      }),
    ).toEqual(cancelled);
    expect(
      completeCertificateRequestDelivery(database, {
        organizationId: "org-a",
        requestId: "request-a",
        claimToken: claim?.claimToken ?? "",
        accepted: true,
        at: "2026-09-02T10:00:01.000Z",
      }),
    ).toBeNull();
  });

  it("reports only an actual open-to-cancelled transition", () => {
    create();
    const first = cancelOpenCertificateRequest(database, {
      organizationId: "org-a",
      requestId: "request-a",
      at: "2026-09-02T10:00:00.000Z",
    });
    const second = cancelOpenCertificateRequest(database, {
      organizationId: "org-a",
      requestId: "request-a",
      at: "2026-09-03T10:00:00.000Z",
    });

    expect(first).toMatchObject({ state: "cancelled" });
    expect(second).toBeNull();
  });

  it("marks only a certificate uploaded through the request link as submitted and clears ciphertext", () => {
    const request = create();
    const claim = claimCertificateRequestDelivery(database, {
      organizationId: "org-a",
      tokenPepper: TOKEN_PEPPER,
      at: NOW,
    });
    const repository = createOrganizationRepository(database, "org-a");
    const document = repository.createDocument({
      id: "document-a",
      vendorId: "vendor-a",
      uploadLinkId: request.uploadLinkId,
      originalFilename: "certificate.pdf",
      storageKey: "documents/document-a.pdf",
      byteSize: 100,
      sha256: "a".repeat(64),
    });
    const certificate = repository.createCertificate({
      id: "certificate-a",
      vendorId: "vendor-a",
      documentId: document.id,
    });

    const submitted = markCertificateRequestSubmitted(database, {
      organizationId: "org-a",
      uploadLinkId: request.uploadLinkId,
      certificateId: certificate.id,
      at: "2026-09-02T12:00:00.000Z",
    });
    expect(submitted).toMatchObject({
      state: "submitted",
      submittedCertificateId: "certificate-a",
      submittedAt: "2026-09-02T12:00:00.000Z",
      deliverySecretAvailable: false,
      deliveryStatus: "superseded",
    });
    expect(
      database
        .prepare("SELECT upload_token_ciphertext FROM certificate_requests WHERE id = ?")
        .get(request.id),
    ).toEqual({ upload_token_ciphertext: null });
    expect(
      markCertificateRequestSubmitted(database, {
        organizationId: "org-a",
        uploadLinkId: request.uploadLinkId,
        certificateId: certificate.id,
        at: "2026-09-03T12:00:00.000Z",
      }),
    ).toEqual(submitted);
    expect(() =>
      cancelCertificateRequest(database, {
        organizationId: "org-a",
        requestId: request.id,
        at: "2026-09-03T12:00:00.000Z",
      }),
    ).toThrow(/submitted/i);
    expect(
      completeCertificateRequestDelivery(database, {
        organizationId: "org-a",
        requestId: request.id,
        claimToken: claim?.claimToken ?? "",
        accepted: true,
        at: "2026-09-03T12:00:01.000Z",
      }),
    ).toBeNull();
  });

  it("rejects a certificate that did not arrive through the request link without changing state", () => {
    const request = create();
    const repository = createOrganizationRepository(database, "org-a");
    const otherLink = repository.createUploadLink({
      id: "other-link",
      vendorId: "vendor-a",
      tokenHash: "f".repeat(64),
      expiresAt: EXPIRES_AT,
    });
    const document = repository.createDocument({
      id: "other-document",
      vendorId: "vendor-a",
      uploadLinkId: otherLink.id,
      originalFilename: "other.pdf",
      storageKey: "documents/other.pdf",
      byteSize: 100,
      sha256: "b".repeat(64),
    });
    const certificate = repository.createCertificate({
      id: "other-certificate",
      vendorId: "vendor-a",
      documentId: document.id,
    });

    expect(() =>
      markCertificateRequestSubmitted(database, {
        organizationId: "org-a",
        uploadLinkId: request.uploadLinkId,
        certificateId: certificate.id,
        at: "2026-09-02T12:00:00.000Z",
      }),
    ).toThrow(/not submitted through/i);
    expect(getCertificateRequest(database, "org-a", request.id)).toMatchObject({
      state: "open",
      deliverySecretAvailable: true,
    });
  });

  it("installs the additive v3-to-v4 schema migration without foreign-key violations", () => {
    database.exec(`
      DROP TABLE certificate_requests;
      PRAGMA user_version = 3;
    `);

    initializeDatabase(database);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'certificate_requests'",
        )
        .get(),
    ).toEqual({ name: "certificate_requests" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
