import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";
import type { OpenCoiDatabase } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import { expirationWarningDaysFor } from "./projections.js";

export interface ReminderRunResult {
  organizations: number;
  created: number;
  sent: number;
  failed: number;
  skipped: number;
}

interface RenewalCandidate {
  organization_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_type_id: string;
  contact_email: string | null;
  certificate_id: string;
  expiration_date: string;
}

interface ReminderRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  vendor_id: string;
  certificate_id: string | null;
  reminder_type: string;
  channel: "email" | "in_app";
  recipient: string | null;
  scheduled_for: string;
  status: string;
  attempt_count: number;
  last_attempt_at: string | null;
  sent_at: string | null;
  error_message: string | null;
  retry_eligible: number;
  next_attempt_at: string | null;
  payload_json: string;
  created_at: string;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_CLAIM_LEASE_MS = 30 * 60_000;
const SMTP_SUBMISSION_DEADLINE_MS = 30_000;
const RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000] as const;
const EXHAUSTED_CLAIM_ERROR =
  "Delivery claim expired after the final attempt; the delivery outcome could not be confirmed";
const TRANSIENT_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDNS",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ESOCKET",
  "ETIMEDOUT",
]);
const PERMANENT_TRANSPORT_CODES = new Set(["EAUTH", "EENVELOPE", "EMESSAGE"]);

class SmtpSubmissionDeadlineError extends Error {
  constructor() {
    super("SMTP submission outcome was not available before the delivery deadline");
    this.name = "SmtpSubmissionDeadlineError";
  }
}

const withSmtpDeadline = async <T>(work: Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new SmtpSubmissionDeadlineError()),
          SMTP_SUBMISSION_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const transientDeliveryFailure = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return true;
  const responseCode = "responseCode" in error ? Number(error.responseCode) : Number.NaN;
  if (Number.isFinite(responseCode)) return responseCode >= 400 && responseCode < 500;
  const code = "code" in error && typeof error.code === "string" ? error.code.toUpperCase() : "";
  if (TRANSIENT_TRANSPORT_CODES.has(code)) return true;
  if (PERMANENT_TRANSPORT_CODES.has(code)) return false;
  // Unknown transport exceptions receive bounded retries; known permanent SMTP
  // responses and message/authentication errors are excluded above.
  return true;
};

const retryAtAfter = (attemptNumber: number, now: Date): string | null => {
  const delay = RETRY_BACKOFF_MS[attemptNumber - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay).toISOString();
};

const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const candidatesFor = (
  database: OpenCoiDatabase,
  organizationId: string,
  now: Date,
): RenewalCandidate[] => {
  const lookback = isoDay(addDays(now, -365));
  const horizon = isoDay(addDays(now, 365));
  const rows = database
    .prepare(
      `SELECT v.organization_id, v.id AS vendor_id, v.legal_name AS vendor_name,
              v.vendor_type_id,
              v.contact_email, c.id AS certificate_id,
              COALESCE(
                (SELECT min(p.expiration_date) FROM policies p
                 WHERE p.organization_id = c.organization_id AND p.certificate_id = c.id
                   AND p.expiration_date IS NOT NULL),
                c.earliest_expiration_date
              ) AS expiration_date
       FROM vendors v
       JOIN certificates c ON c.id = (
         SELECT c2.id FROM certificates c2
         JOIN documents d2 ON d2.organization_id = c2.organization_id AND d2.id = c2.document_id
         WHERE c2.organization_id = v.organization_id AND c2.vendor_id = v.id
           AND c2.confirmation_status = 'confirmed'
         ORDER BY d2.uploaded_at DESC, c2.id DESC LIMIT 1
       ) AND c.organization_id = v.organization_id
       WHERE v.organization_id = ? AND v.status = 'active'
         AND COALESCE(
           (SELECT min(p.expiration_date) FROM policies p
            WHERE p.organization_id = c.organization_id AND p.certificate_id = c.id
              AND p.expiration_date IS NOT NULL),
           c.earliest_expiration_date
         ) BETWEEN ? AND ?`,
    )
    .all(organizationId, lookback, horizon) as unknown as RenewalCandidate[];
  const repository = createOrganizationRepository(database, organizationId);
  return rows.filter(
    (candidate) =>
      candidate.expiration_date <=
      isoDay(addDays(now, expirationWarningDaysFor(repository, candidate.vendor_type_id))),
  );
};

const createScheduledReminders = (
  database: OpenCoiDatabase,
  organizationId: string,
  config: AppConfig,
  now: Date,
): number => {
  const repository = createOrganizationRepository(database, organizationId);
  let created = 0;
  for (const candidate of candidatesFor(database, organizationId, now)) {
    const channel = config.smtp && candidate.contact_email ? "email" : "in_app";
    const dedupeKey = `renewal:${candidate.certificate_id}:${candidate.expiration_date}:v1`;
    try {
      repository.createReminder({
        vendorId: candidate.vendor_id,
        certificateId: candidate.certificate_id,
        reminderType: "renewal",
        channel,
        recipient: channel === "email" ? (candidate.contact_email ?? undefined) : undefined,
        scheduledFor: now.toISOString(),
        dedupeKey,
        payload: {
          vendorName: candidate.vendor_name,
          expirationDate: candidate.expiration_date,
          documentScope: true,
        },
      });
      created += 1;
    } catch (error) {
      if (!(error instanceof Error) || !/UNIQUE constraint failed/i.test(error.message))
        throw error;
    }
  }
  return created;
};

const reminderMessage = (row: ReminderRow): { subject: string; text: string } => {
  let payload: { vendorName?: string; expirationDate?: string } = {};
  try {
    payload = JSON.parse(row.payload_json) as typeof payload;
  } catch {
    // Preserve delivery of a generic reminder even if an old payload is malformed.
  }
  const vendorName = payload.vendorName ?? "your organization";
  const expiration = payload.expirationDate ?? "the date shown on the submitted document";
  return {
    subject: `Insurance certificate renewal — ${vendorName}`,
    text: [
      `The insurance certificate submitted for ${vendorName} shows an expiration date of ${expiration}.`,
      "Please submit an updated certificate through the secure link supplied by the requesting organization.",
      "This reminder is based only on the submitted document and does not state that an insurer's policy records are active or inactive.",
    ].join("\n\n"),
  };
};

const messageIdDomain = (appOrigin: string): string => {
  try {
    return new URL(appOrigin).hostname.replace(/[^a-z0-9.-]/gi, "") || "opencoi.local";
  } catch {
    return "opencoi.local";
  }
};

export const runReminderCycle = async (
  database: OpenCoiDatabase,
  config: AppConfig,
  options: {
    organizationId?: string;
    now?: Date | (() => Date);
    beforeSentPersistence?: (reminder: ReminderRow) => void;
  } = {},
): Promise<ReminderRunResult> => {
  const currentTime = (): Date => {
    const value = typeof options.now === "function" ? options.now() : (options.now ?? new Date());
    return new Date(value);
  };
  const organizationIds = options.organizationId
    ? [options.organizationId]
    : (
        database.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id);
  const result: ReminderRunResult = {
    organizations: organizationIds.length,
    created: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };
  const transport = config.smtp
    ? nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        requireTLS: !config.smtp.secure,
        tls: { minVersion: "TLSv1.2" },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 25_000,
        ...(config.smtp.user && config.smtp.password
          ? { auth: { user: config.smtp.user, pass: config.smtp.password } }
          : {}),
      })
    : null;

  try {
    for (const organizationId of organizationIds) {
      result.created += createScheduledReminders(database, organizationId, config, currentTime());
      const repository = createOrganizationRepository(database, organizationId);
      const scanAt = currentTime();
      const staleBefore = new Date(scanAt.getTime() - DELIVERY_CLAIM_LEASE_MS).toISOString();
      result.failed += repository.failExhaustedStaleReminderClaims({
        staleBefore,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
        errorMessage: EXHAUSTED_CLAIM_ERROR,
        at: scanAt.toISOString(),
      });
      const due = repository.listDueReminders(
        scanAt.toISOString(),
        200,
        MAX_DELIVERY_ATTEMPTS,
        staleBefore,
      ) as ReminderRow[];
      for (const reminder of due) {
        const claimedAt = currentTime();
        const claimStaleBefore = new Date(
          claimedAt.getTime() - DELIVERY_CLAIM_LEASE_MS,
        ).toISOString();
        const claim = repository.claimReminder({
          id: reminder.id,
          at: claimedAt.toISOString(),
          staleBefore: claimStaleBefore,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
        if (!claim) {
          result.skipped += 1;
          continue;
        }
        const attemptNumber = claim.attemptNumber;
        let deliveryFailure: { error: unknown } | null = null;
        if (reminder.channel === "email") {
          try {
            if (!transport || !config.smtp || !reminder.recipient) {
              throw new Error("SMTP is not configured for this email reminder");
            }
            const message = reminderMessage(reminder);
            await withSmtpDeadline(
              transport.sendMail({
                from: config.smtp.from,
                to: reminder.recipient,
                subject: message.subject,
                text: message.text,
                messageId: `<opencoi-reminder-${reminder.id}@${messageIdDomain(config.appOrigin)}>`,
              }),
            );
          } catch (error) {
            deliveryFailure = { error };
          }
        }
        if (deliveryFailure) {
          if (deliveryFailure.error instanceof SmtpSubmissionDeadlineError) {
            throw deliveryFailure.error;
          }
          const completedAt = currentTime();
          const retryAt =
            reminder.channel === "email" &&
            attemptNumber < MAX_DELIVERY_ATTEMPTS &&
            transientDeliveryFailure(deliveryFailure.error)
              ? retryAtAfter(attemptNumber, completedAt)
              : null;
          const recorded = repository.markReminder({
            id: reminder.id,
            status: "failed",
            claimedAt: claim.claimedAt,
            attemptNumber,
            at: completedAt.toISOString(),
            ...(retryAt ? { retryAt } : {}),
            errorMessage:
              deliveryFailure.error instanceof Error
                ? deliveryFailure.error.message.slice(0, 500)
                : "Reminder delivery failed",
          });
          if (!recorded) throw new Error("Reminder delivery failure could not be persisted");
          result.failed += 1;
          continue;
        }
        if (reminder.channel === "email") options.beforeSentPersistence?.(reminder);
        const completedAt = currentTime();
        const recorded = repository.markReminder({
          id: reminder.id,
          status: "sent",
          claimedAt: claim.claimedAt,
          attemptNumber,
          at: completedAt.toISOString(),
        });
        if (!recorded) throw new Error("Reminder SMTP acceptance could not be persisted");
        result.sent += 1;
      }
    }
  } finally {
    transport?.close();
  }
  return result;
};

export const listReminders = (database: OpenCoiDatabase, organizationId: string) =>
  (
    database
      .prepare(
        `SELECT r.*, v.legal_name AS vendor_name
         FROM reminders r
         JOIN vendors v ON v.organization_id = r.organization_id AND v.id = r.vendor_id
         WHERE r.organization_id = ? ORDER BY r.scheduled_for DESC, r.id DESC LIMIT 500`,
      )
      .all(organizationId) as Array<Record<string, unknown>>
  ).map((row) => ({
    id: String(row.id),
    vendorId: String(row.vendor_id),
    vendorName: String(row.vendor_name),
    certificateId: row.certificate_id ? String(row.certificate_id) : null,
    type: String(row.reminder_type),
    channel: String(row.channel),
    recipient: row.recipient ? String(row.recipient) : null,
    scheduledFor: String(row.scheduled_for),
    status: String(row.status),
    attemptCount: Number(row.attempt_count),
    lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
    sentAt: row.sent_at ? String(row.sent_at) : null,
    error: row.error_message ? String(row.error_message) : null,
    retryEligible: Number(row.retry_eligible) === 1,
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    createdAt: String(row.created_at),
  }));
