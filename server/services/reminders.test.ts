import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  type OrganizationRepository,
  openDatabase,
} from "../db.js";
import { vendorSummaryView } from "./projections.js";
import { listReminders, runReminderCycle } from "./reminders.js";

const mail = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mail.createTransport },
}));

const NOW = new Date("2026-06-15T12:00:00.000Z");
const minutesAfterNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const baseConfig: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  trustProxyHops: 0,
  appOrigin: "http://localhost:5173",
  dataDirectory: "C:/tmp/opencoi-reminder-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-reminder-test/uploads",
  maxUploadBytes: 5 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1000,
  uploadLinkTtlMs: 14 * 86_400_000,
  sessionCookieName: "opencoi_test_session",
  secureCookies: false,
  tokenPepper: "reminder-test-token-pepper-at-least-32-bytes",
  smtp: null,
  remindersEnabled: true,
  reminderPollMs: 60_000,
  bootstrap: null,
};

const addConfirmedCertificate = (
  repository: OrganizationRepository,
  input: {
    vendorId: string;
    expirationDate: string;
    suffix: string;
  },
) => {
  const document = repository.createDocument({
    id: `document-${input.suffix}`,
    vendorId: input.vendorId,
    uploadedByUserId: "admin-a",
    originalFilename: `${input.suffix}.pdf`,
    storageKey: `${input.suffix}/${input.suffix}.pdf`,
    byteSize: 100,
    sha256: input.suffix.padEnd(64, "a").slice(0, 64),
  });
  const certificate = repository.createCertificate({
    id: `certificate-${input.suffix}`,
    vendorId: input.vendorId,
    documentId: document.id,
    earliestExpirationDate: input.expirationDate,
  });
  repository.replacePolicies(certificate.id, [
    {
      coverageType: "COMMERCIAL_GENERAL_LIABILITY",
      insurerName: "Example Insurance",
      policyNumber: `POLICY-${input.suffix}`,
      effectiveDate: "2025-01-01",
      expirationDate: input.expirationDate,
    },
  ]);
  repository.setCertificateStatus(certificate.id, {
    confirmationStatus: "confirmed",
    complianceStatus: "compliant",
    confirmedByUserId: "admin-a",
  });
  return certificate;
};

describe("reminder service", () => {
  let database: OpenCoiDatabase;
  let repository: OrganizationRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin@example.test",
      administratorPasswordHash: "test-password-hash",
    });
    repository = createOrganizationRepository(database, "org-a");
    const vendorType = repository.createVendorType({ id: "type-a", name: "Contractor" });
    repository.createCoverageRequirement({
      id: "requirement-a",
      vendorTypeId: vendorType.id,
      coverageType: "general_liability",
      ruleConfig: { required: true, expirationWarningDays: 30 },
    });
    mail.createTransport.mockReset();
    mail.sendMail.mockReset();
    mail.close.mockReset();
    mail.createTransport.mockReturnValue({ sendMail: mail.sendMail, close: mail.close });
    mail.sendMail.mockResolvedValue({ messageId: "message-1" });
  });

  afterEach(() => database.close());

  const addVendor = (
    id: string,
    expirationDate: string,
    status: "active" | "inactive" = "active",
  ) => {
    const vendor = repository.createVendor({
      id,
      vendorTypeId: "type-a",
      legalName: `Vendor ${id}`,
      contactEmail: `${id}@example.test`,
    });
    if (status !== "active") repository.setVendorStatus(vendor.id, status);
    addConfirmedCertificate(repository, {
      vendorId: vendor.id,
      expirationDate,
      suffix: id,
    });
    return vendor;
  };

  const smtpConfig = (): AppConfig => ({
    ...baseConfig,
    smtp: {
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "OpenCOI <no-reply@example.test>",
    },
  });

  const createClaimedEmailReminder = (id: string) => {
    const vendor = addVendor(id, "2026-06-25");
    const reminderId = `reminder-${id}`;
    repository.createReminder({
      id: reminderId,
      vendorId: vendor.id,
      certificateId: `certificate-${id}`,
      reminderType: "renewal",
      channel: "email",
      recipient: `${id}@example.test`,
      scheduledFor: NOW.toISOString(),
      dedupeKey: `renewal:certificate-${id}:2026-06-25:v1`,
      payload: { vendorName: vendor.legal_name, expirationDate: "2026-06-25" },
    });
    if (!repository.markReminder({ id: reminderId, status: "processing", at: NOW.toISOString() })) {
      throw new Error("Could not create the simulated reminder claim");
    }
    return reminderId;
  };

  it("queues due-soon and already-expired latest confirmed documents but not future or inactive vendors", async () => {
    addVendor("due-soon", "2026-07-01");
    addVendor("expired", "2026-06-01");
    addVendor("stale-expired", "2025-01-01");
    addVendor("outside-window", "2026-07-20");
    addVendor("inactive", "2026-06-20", "inactive");

    const result = await runReminderCycle(database, baseConfig, {
      organizationId: "org-a",
      now: NOW,
    });

    expect(result).toEqual({
      organizations: 1,
      created: 2,
      sent: 2,
      failed: 0,
      skipped: 0,
    });
    expect(listReminders(database, "org-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vendorId: "expired", channel: "in_app", status: "sent" }),
        expect.objectContaining({ vendorId: "due-soon", channel: "in_app", status: "sent" }),
      ]),
    );
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it("deduplicates repeated cycles by certificate and printed expiration date", async () => {
    addVendor("dedupe", "2026-06-30");

    const first = await runReminderCycle(database, baseConfig, {
      organizationId: "org-a",
      now: NOW,
    });
    const second = await runReminderCycle(database, baseConfig, {
      organizationId: "org-a",
      now: new Date("2026-06-16T12:00:00.000Z"),
    });

    expect(first.created).toBe(1);
    expect(second).toMatchObject({ created: 0, sent: 0, failed: 0 });
    expect(listReminders(database, "org-a")).toHaveLength(1);
  });

  it("uses an in-app reminder when SMTP is absent, including for an explicit run with polling disabled", async () => {
    addVendor("manual", "2026-06-25");

    const result = await runReminderCycle(
      database,
      { ...baseConfig, remindersEnabled: false, smtp: null },
      { organizationId: "org-a", now: NOW },
    );

    expect(result).toMatchObject({ created: 1, sent: 1, failed: 0 });
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      vendorId: "manual",
      channel: "in_app",
      recipient: null,
      status: "sent",
    });
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it("delivers a neutral document-scoped email when SMTP is configured", async () => {
    addVendor("email", "2026-06-25");
    const smtp = {
      host: "smtp.example.test",
      port: 587,
      secure: false,
      user: "mailer",
      password: "secret",
      from: "OpenCOI <no-reply@example.test>",
    };

    const result = await runReminderCycle(
      database,
      { ...baseConfig, smtp },
      { organizationId: "org-a", now: NOW },
    );

    expect(result).toMatchObject({ created: 1, sent: 1, failed: 0 });
    expect(mail.createTransport).toHaveBeenCalledWith({
      host: smtp.host,
      port: smtp.port,
      secure: false,
      auth: { user: smtp.user, pass: smtp.password },
    });
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: smtp.from,
        to: "email@example.test",
        subject: "Insurance certificate renewal — Vendor email",
        text: expect.stringContaining("submitted document"),
      }),
    );
    expect(mail.close).toHaveBeenCalledOnce();
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      channel: "email",
      status: "sent",
      recipient: "email@example.test",
      attemptCount: 1,
      lastAttemptAt: NOW.toISOString(),
      sentAt: NOW.toISOString(),
    });
  });

  it("uses and projects each vendor type's configured warning window", async () => {
    const vendorType = repository.createVendorType({ id: "type-45", name: "Long lead" });
    repository.createCoverageRequirement({
      id: "requirement-45",
      vendorTypeId: vendorType.id,
      coverageType: "general_liability",
      ruleConfig: { required: true, expirationWarningDays: 45 },
    });
    const vendor = repository.createVendor({
      id: "custom-window",
      vendorTypeId: vendorType.id,
      legalName: "Vendor custom-window",
      contactEmail: "custom-window@example.test",
    });
    addConfirmedCertificate(repository, {
      vendorId: vendor.id,
      expirationDate: "2026-07-20",
      suffix: "custom-window",
    });

    expect(vendorSummaryView(database, repository, vendor, NOW)).toMatchObject({
      reminderExpiration: "2026-07-20",
      expirationWarningDays: 45,
      reminderEligible: true,
    });

    const result = await runReminderCycle(database, baseConfig, {
      organizationId: "org-a",
      now: NOW,
    });
    expect(result).toMatchObject({ created: 1, sent: 1, failed: 0 });
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      vendorId: "custom-window",
    });
  });

  it("keeps the queue on the latest confirmed document while a newer draft awaits review", async () => {
    const vendor = addVendor("awaiting-review", "2026-06-25");
    const draftDocument = repository.createDocument({
      id: "document-new-draft",
      vendorId: vendor.id,
      uploadedByUserId: "admin-a",
      originalFilename: "new-draft.pdf",
      storageKey: "new-draft/new-draft.pdf",
      byteSize: 100,
      sha256: "draft".padEnd(64, "a"),
    });
    const draftCertificate = repository.createCertificate({
      id: "certificate-new-draft",
      vendorId: vendor.id,
      documentId: draftDocument.id,
      earliestExpirationDate: "2026-12-31",
    });
    repository.replacePolicies(draftCertificate.id, [
      {
        coverageType: "COMMERCIAL_GENERAL_LIABILITY",
        insurerName: "Example Insurance",
        policyNumber: "POLICY-NEW-DRAFT",
        effectiveDate: "2026-01-01",
        expirationDate: "2026-12-31",
      },
    ]);
    database
      .prepare("UPDATE documents SET uploaded_at = ? WHERE organization_id = ? AND id = ?")
      .run("2026-06-14T00:00:00.000Z", "org-a", "document-awaiting-review");
    database
      .prepare("UPDATE documents SET uploaded_at = ? WHERE organization_id = ? AND id = ?")
      .run("2026-06-16T00:00:00.000Z", "org-a", draftDocument.id);

    expect(vendorSummaryView(database, repository, vendor, NOW)).toMatchObject({
      nextExpiration: "2026-12-31",
      reminderExpiration: "2026-06-25",
      reminderEligible: true,
    });

    await runReminderCycle(database, baseConfig, { organizationId: "org-a", now: NOW });
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      vendorId: vendor.id,
      certificateId: "certificate-awaiting-review",
    });
  });

  it("records a failed attempt, its error, and the first retry time", async () => {
    addVendor("failed-email", "2026-06-25");
    mail.sendMail.mockRejectedValueOnce(new Error("SMTP unavailable"));

    const result = await runReminderCycle(
      database,
      {
        ...baseConfig,
        smtp: {
          host: "smtp.example.test",
          port: 587,
          secure: false,
          from: "OpenCOI <no-reply@example.test>",
        },
      },
      { organizationId: "org-a", now: NOW },
    );

    expect(result).toMatchObject({ created: 1, sent: 0, failed: 1 });
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      vendorId: "failed-email",
      status: "failed",
      attemptCount: 1,
      lastAttemptAt: NOW.toISOString(),
      sentAt: null,
      error: "SMTP unavailable",
      retryEligible: true,
      nextAttemptAt: minutesAfterNow(15).toISOString(),
    });
  });

  it("waits for the first backoff and reuses the same row when a retry succeeds", async () => {
    addVendor("retry-success", "2026-06-25");
    mail.sendMail
      .mockRejectedValueOnce(
        Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" }),
      )
      .mockResolvedValueOnce({ messageId: "message-after-retry" });
    const config: AppConfig = {
      ...baseConfig,
      smtp: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "OpenCOI <no-reply@example.test>",
      },
    };

    expect(
      await runReminderCycle(database, config, { organizationId: "org-a", now: NOW }),
    ).toMatchObject({ created: 1, sent: 0, failed: 1 });
    expect(
      await runReminderCycle(database, config, {
        organizationId: "org-a",
        now: minutesAfterNow(14),
      }),
    ).toMatchObject({ created: 0, sent: 0, failed: 0 });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);

    expect(
      await runReminderCycle(database, config, {
        organizationId: "org-a",
        now: minutesAfterNow(15),
      }),
    ).toMatchObject({ created: 0, sent: 1, failed: 0 });
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(listReminders(database, "org-a")).toEqual([
      expect.objectContaining({
        vendorId: "retry-success",
        status: "sent",
        attemptCount: 2,
        lastAttemptAt: minutesAfterNow(15).toISOString(),
        sentAt: minutesAfterNow(15).toISOString(),
        error: null,
        retryEligible: false,
        nextAttemptAt: null,
      }),
    ]);
  });

  it("uses the second backoff and stops after three total transient failures", async () => {
    addVendor("retry-limit", "2026-06-25");
    mail.sendMail.mockRejectedValue(
      Object.assign(new Error("SMTP service temporarily unavailable"), { responseCode: 451 }),
    );
    const config: AppConfig = {
      ...baseConfig,
      smtp: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "OpenCOI <no-reply@example.test>",
      },
    };

    await runReminderCycle(database, config, { organizationId: "org-a", now: NOW });
    await runReminderCycle(database, config, {
      organizationId: "org-a",
      now: minutesAfterNow(15),
    });
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      attemptCount: 2,
      retryEligible: true,
      nextAttemptAt: minutesAfterNow(75).toISOString(),
    });

    await runReminderCycle(database, config, {
      organizationId: "org-a",
      now: minutesAfterNow(74),
    });
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(
      await runReminderCycle(database, config, {
        organizationId: "org-a",
        now: minutesAfterNow(75),
      }),
    ).toMatchObject({ created: 0, sent: 0, failed: 1 });

    await runReminderCycle(database, config, {
      organizationId: "org-a",
      now: minutesAfterNow(24 * 60),
    });
    expect(mail.sendMail).toHaveBeenCalledTimes(3);
    expect(listReminders(database, "org-a")).toEqual([
      expect.objectContaining({
        vendorId: "retry-limit",
        status: "failed",
        attemptCount: 3,
        lastAttemptAt: minutesAfterNow(75).toISOString(),
        error: "SMTP service temporarily unavailable",
        retryEligible: false,
        nextAttemptAt: null,
      }),
    ]);
  });

  it("does not retry a permanent SMTP rejection", async () => {
    addVendor("permanent-rejection", "2026-06-25");
    mail.sendMail.mockRejectedValue(
      Object.assign(new Error("Recipient rejected"), { responseCode: 550 }),
    );
    const config: AppConfig = {
      ...baseConfig,
      smtp: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "OpenCOI <no-reply@example.test>",
      },
    };

    await runReminderCycle(database, config, { organizationId: "org-a", now: NOW });
    await runReminderCycle(database, config, {
      organizationId: "org-a",
      now: minutesAfterNow(24 * 60),
    });

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
      retryEligible: false,
      nextAttemptAt: null,
    });
  });

  it("reclaims a stale processing claim after restart but not before its lease expires", async () => {
    createClaimedEmailReminder("restart-claim");
    const config = smtpConfig();

    expect(
      await runReminderCycle(database, config, {
        organizationId: "org-a",
        now: minutesAfterNow(29),
      }),
    ).toMatchObject({ created: 0, sent: 0, failed: 0 });
    expect(mail.sendMail).not.toHaveBeenCalled();

    expect(
      await runReminderCycle(database, config, {
        organizationId: "org-a",
        now: minutesAfterNow(30),
      }),
    ).toMatchObject({ created: 0, sent: 1, failed: 0 });
    expect(mail.sendMail).toHaveBeenCalledOnce();
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      status: "sent",
      attemptCount: 2,
      lastAttemptAt: minutesAfterNow(30).toISOString(),
      sentAt: minutesAfterNow(30).toISOString(),
    });
  });

  it("allows only one concurrent cycle to reclaim the same stale claim", () => {
    const reminderId = createClaimedEmailReminder("concurrent-claim");
    const reclaimAt = minutesAfterNow(30).toISOString();
    const staleBefore = NOW.toISOString();

    expect(repository.listDueReminders(reclaimAt, 10, 3, staleBefore)).toEqual([
      expect.objectContaining({ id: reminderId, status: "processing", attempt_count: 1 }),
    ]);
    const firstClaim = repository.markReminder({
      id: reminderId,
      status: "processing",
      at: reclaimAt,
      staleBefore,
      maxAttempts: 3,
    });
    const competingClaim = repository.markReminder({
      id: reminderId,
      status: "processing",
      at: reclaimAt,
      staleBefore,
      maxAttempts: 3,
    });

    expect(firstClaim).toBe(true);
    expect(competingClaim).toBe(false);
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      status: "processing",
      attemptCount: 2,
      lastAttemptAt: reclaimAt,
    });
  });

  it("terminally fails a stale claim that already consumed the third attempt", async () => {
    const reminderId = createClaimedEmailReminder("exhausted-claim");
    expect(
      repository.markReminder({
        id: reminderId,
        status: "processing",
        at: minutesAfterNow(30).toISOString(),
        staleBefore: NOW.toISOString(),
        maxAttempts: 3,
      }),
    ).toBe(true);
    expect(
      repository.markReminder({
        id: reminderId,
        status: "processing",
        at: minutesAfterNow(60).toISOString(),
        staleBefore: minutesAfterNow(30).toISOString(),
        maxAttempts: 3,
      }),
    ).toBe(true);

    expect(
      await runReminderCycle(database, smtpConfig(), {
        organizationId: "org-a",
        now: minutesAfterNow(89),
      }),
    ).toMatchObject({ sent: 0, failed: 0 });
    expect(
      await runReminderCycle(database, smtpConfig(), {
        organizationId: "org-a",
        now: minutesAfterNow(90),
      }),
    ).toMatchObject({ sent: 0, failed: 1 });
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(listReminders(database, "org-a")[0]).toMatchObject({
      status: "failed",
      attemptCount: 3,
      error:
        "Delivery claim expired after the final attempt; the delivery outcome could not be confirmed",
      retryEligible: false,
      nextAttemptAt: null,
    });
  });
});
