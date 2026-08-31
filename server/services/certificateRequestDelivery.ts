import nodemailer from "nodemailer";
import { appendAuditEvent } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { OpenCoiDatabase } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import { publicUploadUrl } from "../security.js";
import {
  cancelOpenCertificateRequest,
  claimCertificateRequestDelivery,
  completeCertificateRequestDelivery,
} from "./certificateRequests.js";
import { publishDomainEvent } from "./domainEvents.js";

const MAX_BATCH = 100;
const SEND_DEADLINE_MS = 30_000;
const RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000] as const;

interface MailTransport {
  sendMail(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    messageId: string;
  }): Promise<unknown>;
  close(): void;
}

export interface CertificateRequestDeliveryResult {
  configured: boolean;
  organizations: number;
  claimed: number;
  accepted: number;
  failed: number;
  retryScheduled: number;
}

const permanentCodes = new Set(["EAUTH", "EENVELOPE", "EMESSAGE"]);

const transientFailure = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return true;
  const responseCode = "responseCode" in error ? Number(error.responseCode) : Number.NaN;
  if (Number.isFinite(responseCode)) return responseCode >= 400 && responseCode < 500;
  const code = "code" in error && typeof error.code === "string" ? error.code.toUpperCase() : "";
  if (permanentCodes.has(code)) return false;
  return true;
};

const redactLiteral = (value: string, secret: string): string =>
  secret ? value.split(secret).join("[secret redacted]") : value;

const smtpCredentialSecrets = (user?: string, password?: string): string[] => {
  const clear = [user, password].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const encoded = clear.map((value) => Buffer.from(value, "utf8").toString("base64"));
  const authPlain =
    user && password ? [Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64")] : [];
  return [...new Set([...clear, ...encoded, ...authPlain])];
};

const safeError = (error: unknown, exactSecrets: readonly string[] = []): string => {
  let message = (error instanceof Error ? error.message : "SMTP submission failed").replace(
    /[\r\n\t]+/g,
    " ",
  );
  for (const secret of [...exactSecrets].sort((left, right) => right.length - left.length)) {
    message = redactLiteral(message, secret);
  }
  return message
    .replace(
      /\bocoi_sk_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?=$|[^A-Za-z0-9_-])/g,
      "[service token redacted]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, "[url redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .slice(0, 300);
};

const withDeadline = async <T>(work: Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SMTP submission deadline exceeded")),
          SEND_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const certificateRequestMailTransportOptions = (config: AppConfig) => {
  if (!config.smtp) return null;
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: !config.smtp.secure,
    tls: { minVersion: "TLSv1.2" as const },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
    ...(config.smtp.user && config.smtp.password
      ? { auth: { user: config.smtp.user, pass: config.smtp.password } }
      : {}),
  };
};

const transportFor = (config: AppConfig): MailTransport | null => {
  const options = certificateRequestMailTransportOptions(config);
  return options ? nodemailer.createTransport(options) : null;
};

const messageIdDomain = (appOrigin: string): string => {
  try {
    return new URL(appOrigin).hostname.replace(/[^a-z0-9.-]/gi, "") || "opencoi.local";
  } catch {
    return "opencoi.local";
  }
};

export const runCertificateRequestDeliveryCycle = async (
  database: OpenCoiDatabase,
  config: AppConfig,
  options: {
    now?: () => Date;
    transport?: MailTransport;
    maxBatch?: number;
    organizationId?: string;
    beforeAcceptedPersistence?: () => void;
  } = {},
): Promise<CertificateRequestDeliveryResult> => {
  const transport = options.transport ?? transportFor(config);
  const configured = Boolean(config.smtp && config.tokenPepper && transport);
  const organizationIds = options.organizationId
    ? [options.organizationId]
    : (
        database.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id);
  const result: CertificateRequestDeliveryResult = {
    configured,
    organizations: organizationIds.length,
    claimed: 0,
    accepted: 0,
    failed: 0,
    retryScheduled: 0,
  };
  if (!configured || !config.smtp || !config.tokenPepper || !transport) return result;
  const maxBatch = Math.min(Math.max(options.maxBatch ?? MAX_BATCH, 1), MAX_BATCH);
  const now = options.now ?? (() => new Date());

  try {
    while (result.claimed < maxBatch) {
      let claimedInRound = false;
      for (const organizationId of organizationIds) {
        if (result.claimed >= maxBatch) break;
        const claimedAt = now();
        const claimed = claimCertificateRequestDelivery(database, {
          organizationId,
          tokenPepper: config.tokenPepper,
          at: claimedAt.toISOString(),
        });
        if (!claimed) continue;
        claimedInRound = true;
        result.claimed += 1;
        const repository = createOrganizationRepository(database, organizationId);
        const organization = repository.getOrganization();
        const vendor = repository.getVendor(claimed.request.vendorId);
        const recipient = claimed.request.recipientEmail;
        if (vendor && vendor.status !== "active") {
          const completedAt = now();
          let recorded = false;
          repository.transaction(() => {
            const cancelled = cancelOpenCertificateRequest(database, {
              organizationId,
              requestId: claimed.request.id,
              at: completedAt.toISOString(),
            });
            if (!cancelled) return;
            recorded = true;
            publishDomainEvent(database, {
              organizationId,
              type: "certificate_request.cancelled",
              resourceType: "certificate_request",
              resourceId: cancelled.id,
              data: {
                vendorId: cancelled.vendorId,
                kind: cancelled.kind,
                reason: "vendor_inactive",
              },
              actorType: "system",
              at: completedAt.toISOString(),
            });
            appendAuditEvent(database, organizationId, {
              actorType: "system",
              action: "certificate_request.cancelled",
              entityType: "certificate_request",
              entityId: cancelled.id,
              occurredAt: completedAt.toISOString(),
              metadata: {
                vendorId: cancelled.vendorId,
                kind: cancelled.kind,
                reason: "vendor_inactive",
              },
            });
          });
          if (recorded) result.failed += 1;
          continue;
        }
        if (!organization || !vendor || !recipient) {
          const completedAt = now();
          let recorded = false;
          repository.transaction(() => {
            const completed = completeCertificateRequestDelivery(database, {
              organizationId,
              requestId: claimed.request.id,
              claimToken: claimed.claimToken,
              accepted: false,
              errorMessage: "Request recipient or organization context is unavailable",
              at: completedAt.toISOString(),
            });
            if (!completed) return;
            recorded = true;
            appendAuditEvent(database, organizationId, {
              actorType: "system",
              action: "certificate_request.email_failed",
              entityType: "certificate_request",
              entityId: claimed.request.id,
              occurredAt: completedAt.toISOString(),
              metadata: { attempt: claimed.request.attemptCount, retryScheduled: false },
            });
          });
          if (recorded) result.failed += 1;
          continue;
        }
        const uploadUrl = publicUploadUrl(config.appOrigin, claimed.uploadToken);
        let submissionFailure: { error: unknown } | null = null;
        try {
          await withDeadline(
            transport.sendMail({
              from: config.smtp.from,
              to: recipient,
              subject: "Insurance certificate requested",
              messageId: `<opencoi-certificate-request-${claimed.request.id}@${messageIdDomain(config.appOrigin)}>`,
              text: [
                `${organization.name} has requested an insurance certificate for ${vendor.legal_name}.`,
                `Upload one PDF through this secure, single-use link: ${uploadUrl}`,
                `The link expires ${claimed.request.expiresAt}.`,
                "OpenCOI checks the submitted document against configured requirements. It does not verify live policy status with an insurer.",
              ].join("\n\n"),
            }),
          );
        } catch (error) {
          submissionFailure = { error };
        }
        if (submissionFailure) {
          const completedAt = now();
          const retryDelay = RETRY_BACKOFF_MS[claimed.request.attemptCount - 1];
          const retryAt =
            retryDelay !== undefined && transientFailure(submissionFailure.error)
              ? new Date(completedAt.getTime() + retryDelay).toISOString()
              : undefined;
          let recorded = false;
          repository.transaction(() => {
            const completed = completeCertificateRequestDelivery(database, {
              organizationId,
              requestId: claimed.request.id,
              claimToken: claimed.claimToken,
              accepted: false,
              errorMessage: safeError(submissionFailure.error, [
                uploadUrl,
                claimed.uploadToken,
                ...smtpCredentialSecrets(config.smtp?.user, config.smtp?.password),
              ]),
              retryAt,
              at: completedAt.toISOString(),
            });
            if (!completed) return;
            recorded = true;
            publishDomainEvent(database, {
              organizationId,
              type: "certificate_request.email_failed",
              resourceType: "certificate_request",
              resourceId: completed.id,
              data: {
                vendorId: completed.vendorId,
                attempt: completed.attemptCount,
                retryScheduled: completed.deliverySecretAvailable,
              },
              actorType: "system",
              at: completedAt.toISOString(),
            });
            appendAuditEvent(database, organizationId, {
              actorType: "system",
              action: "certificate_request.email_failed",
              entityType: "certificate_request",
              entityId: completed.id,
              occurredAt: completedAt.toISOString(),
              metadata: {
                attempt: completed.attemptCount,
                retryScheduled: completed.deliverySecretAvailable,
              },
            });
            if (completed.deliverySecretAvailable) result.retryScheduled += 1;
          });
          if (recorded) result.failed += 1;
          continue;
        }
        options.beforeAcceptedPersistence?.();
        const completedAt = now();
        let recorded = false;
        repository.transaction(() => {
          const completed = completeCertificateRequestDelivery(database, {
            organizationId,
            requestId: claimed.request.id,
            claimToken: claimed.claimToken,
            accepted: true,
            at: completedAt.toISOString(),
          });
          if (!completed) return;
          recorded = true;
          publishDomainEvent(database, {
            organizationId,
            type: "certificate_request.email_accepted",
            resourceType: "certificate_request",
            resourceId: completed.id,
            data: { vendorId: completed.vendorId, attempt: completed.attemptCount },
            actorType: "system",
            at: completedAt.toISOString(),
          });
          appendAuditEvent(database, organizationId, {
            actorType: "system",
            action: "certificate_request.email_accepted",
            entityType: "certificate_request",
            entityId: completed.id,
            occurredAt: completedAt.toISOString(),
            metadata: {
              attempt: completed.attemptCount,
              disclosure: "SMTP accepted; inbox delivery and opening are not established",
            },
          });
        });
        if (recorded) result.accepted += 1;
      }
      if (!claimedInRound) break;
    }
  } finally {
    if (!options.transport) transport.close();
  }
  return result;
};
