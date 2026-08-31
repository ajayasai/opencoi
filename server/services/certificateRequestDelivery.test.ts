import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import {
  certificateRequestMailTransportOptions,
  runCertificateRequestDeliveryCycle,
} from "./certificateRequestDelivery.js";
import { createCertificateRequest, getCertificateRequest } from "./certificateRequests.js";
import { ensureIntegrationSchema } from "./integrationSchema.js";

const TOKEN_PEPPER = "certificate-request-delivery-test-pepper-at-least-32-bytes";
const NOW = new Date("2026-09-01T10:00:00.000Z");
const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  trustProxyHops: 0,
  appOrigin: "https://coi.example.test",
  dataDirectory: "C:/tmp/opencoi-request-delivery-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-request-delivery-test/uploads",
  maxUploadBytes: 1024,
  sessionTtlMs: 60_000,
  uploadLinkTtlMs: 60_000,
  sessionCookieName: "test",
  secureCookies: true,
  tokenPepper: TOKEN_PEPPER,
  oidc: null,
  smtp: {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    from: "requests@example.test",
  },
  remindersEnabled: false,
  reminderPollMs: 60_000,
  bootstrap: null,
};

describe("certificate request SMTP delivery", () => {
  let database: OpenCoiDatabase;

  beforeEach(() => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin@example.test",
      administratorPasswordHash: "hash",
    });
    ensureIntegrationSchema(database);
    const repository = createOrganizationRepository(database, "org-a");
    const type = repository.createVendorType({ id: "type-a", name: "Contractor" });
    repository.createVendor({ id: "vendor-a", vendorTypeId: type.id, legalName: "Vendor A" });
    createCertificateRequest(database, {
      organizationId: "org-a",
      vendorId: "vendor-a",
      uploadToken: `v1.b3JnLWE.${"x".repeat(48)}`,
      expiresAt: "2026-09-15T10:00:00.000Z",
      kind: "initial",
      deliveryMethod: "smtp",
      tokenPepper: TOKEN_PEPPER,
      recipientEmail: "vendor@example.test",
      createdByUserId: "admin-a",
      requestId: "request-a",
      uploadLinkId: "link-a",
      at: NOW.toISOString(),
    });
  });

  afterEach(() => database.close());

  it("requires authenticated TLS negotiation for bearer-link SMTP", () => {
    expect(certificateRequestMailTransportOptions(config)).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2" },
    });
    expect(
      certificateRequestMailTransportOptions({
        ...config,
        smtp: { ...(config.smtp as NonNullable<AppConfig["smtp"]>), port: 465, secure: true },
      }),
    ).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  it("uses a neutral fixed-text message and records SMTP acceptance without claiming delivery", async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["vendor@example.test"] });
    const result = await runCertificateRequestDeliveryCycle(database, config, {
      now: () => NOW,
      maxBatch: 10,
      transport: { sendMail, close: vi.fn() },
    });

    expect(result).toMatchObject({ claimed: 1, accepted: 1, failed: 0 });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Insurance certificate requested",
        text: expect.stringContaining("https://coi.example.test/upload/v1.b3JnLWE."),
      }),
    );
    expect(sendMail.mock.calls[0]?.[0].subject).not.toContain("Vendor A");
    expect(getCertificateRequest(database, "org-a", "request-a")).toMatchObject({
      deliveryStatus: "accepted",
      deliverySecretAvailable: false,
      attemptCount: 1,
    });
    const audit = database
      .prepare("SELECT action, metadata_json FROM audit_events WHERE entity_id = ?")
      .get("request-a") as { action: string; metadata_json: string };
    expect(audit.action).toBe("certificate_request.email_accepted");
    expect(audit.metadata_json).toContain("inbox delivery and opening are not established");
  });

  it("retains encrypted delivery material only for a bounded transient retry", async () => {
    const error = Object.assign(new Error("Temporary failure for vendor@example.test"), {
      code: "ETIMEDOUT",
    });
    const result = await runCertificateRequestDeliveryCycle(database, config, {
      now: () => NOW,
      maxBatch: 1,
      transport: { sendMail: vi.fn().mockRejectedValue(error), close: vi.fn() },
    });

    expect(result).toMatchObject({ claimed: 1, accepted: 0, failed: 1, retryScheduled: 1 });
    const request = getCertificateRequest(database, "org-a", "request-a");
    expect(request).toMatchObject({ deliveryStatus: "failed", deliverySecretAvailable: true });
    expect(request?.deliveryError).not.toContain("vendor@example.test");
    expect(request?.nextAttemptAt).toBe("2026-09-01T10:15:00.000Z");
  });

  it("cancels an inactive vendor request before any bearer link reaches SMTP", async () => {
    database
      .prepare("UPDATE vendors SET status = 'inactive' WHERE organization_id = ? AND id = ?")
      .run("org-a", "vendor-a");
    const sendMail = vi.fn();

    const first = await runCertificateRequestDeliveryCycle(database, config, {
      now: () => NOW,
      maxBatch: 10,
      transport: { sendMail, close: vi.fn() },
    });
    const second = await runCertificateRequestDeliveryCycle(database, config, {
      now: () => NOW,
      maxBatch: 10,
      transport: { sendMail, close: vi.fn() },
    });

    expect(first).toMatchObject({ claimed: 1, accepted: 0, failed: 1 });
    expect(second).toMatchObject({ claimed: 0, accepted: 0, failed: 0 });
    expect(sendMail).not.toHaveBeenCalled();
    expect(getCertificateRequest(database, "org-a", "request-a")).toMatchObject({
      state: "cancelled",
      deliveryStatus: "cancelled",
      deliverySecretAvailable: false,
      uploadRevokedAt: NOW.toISOString(),
    });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM audit_events
           WHERE organization_id = ? AND entity_id = ? AND action = ?`,
        )
        .get("org-a", "request-a", "certificate_request.cancelled"),
    ).toEqual({ count: 1 });
  });

  it("leaves an ambiguous accepted outcome leased instead of recording an SMTP failure", async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["vendor@example.test"] });

    await expect(
      runCertificateRequestDeliveryCycle(database, config, {
        now: () => NOW,
        maxBatch: 1,
        transport: { sendMail, close: vi.fn() },
        beforeAcceptedPersistence: () => {
          throw new Error("simulated post-acceptance persistence failure");
        },
      }),
    ).rejects.toThrow("simulated post-acceptance persistence failure");

    expect(sendMail).toHaveBeenCalledOnce();
    expect(getCertificateRequest(database, "org-a", "request-a")).toMatchObject({
      deliveryStatus: "processing",
      deliverySecretAvailable: true,
      attemptCount: 1,
      nextAttemptAt: null,
    });
    const lease = database
      .prepare(
        `SELECT claim_token, claimed_at FROM certificate_requests
         WHERE organization_id = ? AND id = ?`,
      )
      .get("org-a", "request-a") as { claim_token: string | null; claimed_at: string | null };
    expect(lease.claim_token).toEqual(expect.any(String));
    expect(lease.claimed_at).toBe(NOW.toISOString());
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM audit_events
           WHERE organization_id = ? AND entity_id = ? AND action = ?`,
        )
        .get("org-a", "request-a", "certificate_request.email_failed"),
    ).toEqual({ count: 0 });
  });
});
