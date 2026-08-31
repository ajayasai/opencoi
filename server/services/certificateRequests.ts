import { randomUUID } from "node:crypto";
import type { CertificateRequestRow, CertificateRow, OpenCoiDatabase } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import { decryptSecret, encryptSecret } from "../security/secrets.js";
import { hashUploadLinkToken } from "../security.js";

export const CERTIFICATE_REQUEST_KINDS = ["initial", "renewal"] as const;
export type CertificateRequestKind = (typeof CERTIFICATE_REQUEST_KINDS)[number];

export const CERTIFICATE_REQUEST_DELIVERY_METHODS = ["manual", "smtp"] as const;
export type CertificateRequestDeliveryMethod =
  (typeof CERTIFICATE_REQUEST_DELIVERY_METHODS)[number];

export interface CertificateRequestRecord {
  id: string;
  organizationId: string;
  vendorId: string;
  uploadLinkId: string;
  sourceCertificateId: string | null;
  submittedCertificateId: string | null;
  kind: CertificateRequestKind;
  deliveryMethod: CertificateRequestDeliveryMethod;
  deliveryStatus: CertificateRequestRow["delivery_status"];
  recipientName: string | null;
  recipientEmail: string | null;
  state: CertificateRequestRow["state"];
  expiresAt: string;
  uploadUseCount: number;
  uploadRevokedAt: string | null;
  deliverySecretAvailable: boolean;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  acceptedAt: string | null;
  deliveryError: string | null;
  createdByUserId: string | null;
  submittedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateRequestDeliveryMaterial {
  request: CertificateRequestRecord;
  uploadToken: string;
}

export interface ClaimedCertificateRequestDelivery extends CertificateRequestDeliveryMaterial {
  claimToken: string;
}

interface JoinedCertificateRequestRow extends CertificateRequestRow {
  expires_at: string;
  upload_use_count: number;
  upload_revoked_at: string | null;
}

export interface CreateCertificateRequestInput {
  organizationId: string;
  vendorId: string;
  uploadToken: string;
  expiresAt: string;
  kind: CertificateRequestKind;
  deliveryMethod: CertificateRequestDeliveryMethod;
  tokenPepper?: string;
  recipientName?: string;
  recipientEmail?: string;
  sourceCertificateId?: string;
  createdByUserId?: string;
  requestId?: string;
  uploadLinkId?: string;
  at?: string;
}

const MAX_REQUEST_LIFETIME_MS = 365 * 86_400_000;
const SMTP_ORGANIZATION_24_HOUR_LIMIT = 200;
const SMTP_CREATOR_24_HOUR_LIMIT = 30;
const SMTP_RECIPIENT_24_HOUR_LIMIT = 5;
const SMTP_VENDOR_OPEN_LIMIT = 3;
const uploadTokenPattern = /^[A-Za-z0-9._-]{40,600}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const encryptionContext = (organizationId: string, requestId: string): string =>
  `${organizationId}:certificate_request:${requestId}:upload_token`;

const instant = (value: string | undefined, label: string): string => {
  const parsed = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid ISO timestamp`);
  return parsed.toISOString();
};

const optionalText = (value: string | undefined, maximum: number, label: string): string | null => {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
};

const recipientEmail = (value: string | undefined, required: boolean): string | null => {
  const normalized = optionalText(value, 320, "recipientEmail")?.toLowerCase() ?? null;
  if (required && !normalized) throw new TypeError("recipientEmail is required for SMTP delivery");
  if (normalized && !emailPattern.test(normalized))
    throw new TypeError("recipientEmail is invalid");
  return normalized;
};

const requestRow = (
  database: OpenCoiDatabase,
  organizationId: string,
  requestId: string,
): JoinedCertificateRequestRow | null =>
  (database
    .prepare(
      `SELECT r.*, l.expires_at, l.use_count AS upload_use_count,
              l.revoked_at AS upload_revoked_at
       FROM certificate_requests r
       JOIN upload_links l
         ON l.organization_id = r.organization_id AND l.id = r.upload_link_id
       WHERE r.organization_id = ? AND r.id = ?`,
    )
    .get(organizationId, requestId) as unknown as JoinedCertificateRequestRow | undefined) ?? null;

const recordFrom = (row: JoinedCertificateRequestRow): CertificateRequestRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  vendorId: row.vendor_id,
  uploadLinkId: row.upload_link_id,
  sourceCertificateId: row.source_certificate_id,
  submittedCertificateId: row.submitted_certificate_id,
  kind: row.request_kind,
  deliveryMethod: row.delivery_method,
  deliveryStatus: row.delivery_status,
  recipientName: row.recipient_name,
  recipientEmail: row.recipient_email,
  state: row.state,
  expiresAt: row.expires_at,
  uploadUseCount: row.upload_use_count,
  uploadRevokedAt: row.upload_revoked_at,
  deliverySecretAvailable: row.upload_token_ciphertext !== null,
  attemptCount: row.attempt_count,
  lastAttemptAt: row.last_attempt_at,
  nextAttemptAt: row.next_attempt_at,
  acceptedAt: row.accepted_at,
  deliveryError: row.delivery_error,
  createdByUserId: row.created_by_user_id,
  submittedAt: row.submitted_at,
  cancelledAt: row.cancelled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const certificateForVendor = (
  certificate: CertificateRow | null,
  vendorId: string,
  label: string,
): CertificateRow | null => {
  if (certificate && certificate.vendor_id !== vendorId) {
    throw new TypeError(`${label} does not belong to the request vendor`);
  }
  return certificate;
};

export const createCertificateRequest = (
  database: OpenCoiDatabase,
  input: CreateCertificateRequestInput,
): CertificateRequestRecord => {
  if (!input.organizationId || !input.vendorId) {
    throw new TypeError("organizationId and vendorId are required");
  }
  if (!CERTIFICATE_REQUEST_KINDS.includes(input.kind)) {
    throw new TypeError("Certificate request kind is invalid");
  }
  if (!CERTIFICATE_REQUEST_DELIVERY_METHODS.includes(input.deliveryMethod)) {
    throw new TypeError("Certificate request delivery method is invalid");
  }
  if (!uploadTokenPattern.test(input.uploadToken)) {
    throw new TypeError("uploadToken is malformed");
  }

  const at = instant(input.at, "at");
  const expiresAt = instant(input.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(at);
  if (lifetime <= 0 || lifetime > MAX_REQUEST_LIFETIME_MS) {
    throw new RangeError("Certificate request expiry must be after creation and within 365 days");
  }
  const normalizedRecipientEmail = recipientEmail(
    input.recipientEmail,
    input.deliveryMethod === "smtp",
  );
  const normalizedRecipientName = optionalText(input.recipientName, 200, "recipientName");
  if (input.deliveryMethod === "smtp" && !input.tokenPepper) {
    throw new TypeError("tokenPepper is required for queued SMTP delivery");
  }

  const requestId = input.requestId ?? randomUUID();
  const uploadLinkId = input.uploadLinkId ?? randomUUID();
  const repository = createOrganizationRepository(database, input.organizationId);
  return repository.transaction((transactionRepository) => {
    const vendor = transactionRepository.getVendor(input.vendorId);
    if (vendor?.status !== "active") {
      throw new TypeError("Vendor does not exist or is not active in this organization");
    }
    if (input.createdByUserId && !transactionRepository.getUser(input.createdByUserId)) {
      throw new TypeError("Request creator does not exist in this organization");
    }
    if (input.sourceCertificateId) {
      const source = certificateForVendor(
        transactionRepository.getCertificate(input.sourceCertificateId),
        input.vendorId,
        "sourceCertificateId",
      );
      if (!source) throw new TypeError("sourceCertificateId does not exist in this organization");
    }
    if (input.deliveryMethod === "smtp") {
      const since = new Date(Date.parse(at) - 86_400_000).toISOString();
      const organizationCount = database
        .prepare(
          `SELECT count(*) AS count FROM certificate_requests
           WHERE organization_id = ? AND delivery_method = 'smtp' AND created_at >= ?`,
        )
        .get(input.organizationId, since) as { count: number };
      if (organizationCount.count >= SMTP_ORGANIZATION_24_HOUR_LIMIT) {
        throw new RangeError(
          "The workspace has reached its 24-hour certificate-request email limit",
        );
      }
      if (input.createdByUserId) {
        const creatorCount = database
          .prepare(
            `SELECT count(*) AS count FROM certificate_requests
             WHERE organization_id = ? AND delivery_method = 'smtp'
               AND created_by_user_id = ? AND created_at >= ?`,
          )
          .get(input.organizationId, input.createdByUserId, since) as { count: number };
        if (creatorCount.count >= SMTP_CREATOR_24_HOUR_LIMIT) {
          throw new RangeError("You have reached the 24-hour certificate-request email limit");
        }
      }
      const addressCount = database
        .prepare(
          `SELECT count(*) AS count FROM certificate_requests
           WHERE organization_id = ? AND delivery_method = 'smtp'
             AND recipient_email = ? COLLATE NOCASE AND created_at >= ?`,
        )
        .get(input.organizationId, normalizedRecipientEmail, since) as { count: number };
      if (addressCount.count >= SMTP_RECIPIENT_24_HOUR_LIMIT) {
        throw new RangeError("This recipient has reached the 24-hour certificate-request limit");
      }
      const vendorOpenCount = database
        .prepare(
          `SELECT count(*) AS count
           FROM certificate_requests r
           JOIN upload_links l
             ON l.organization_id = r.organization_id AND l.id = r.upload_link_id
           WHERE r.organization_id = ? AND r.vendor_id = ?
             AND r.delivery_method = 'smtp' AND r.state = 'open'
             AND l.revoked_at IS NULL AND l.use_count < l.max_uses AND l.expires_at > ?`,
        )
        .get(input.organizationId, input.vendorId, at) as { count: number };
      if (vendorOpenCount.count >= SMTP_VENDOR_OPEN_LIMIT) {
        throw new RangeError("This vendor already has three active certificate-request emails");
      }
    }

    const uploadLink = transactionRepository.createUploadLink({
      id: uploadLinkId,
      vendorId: input.vendorId,
      tokenHash: hashUploadLinkToken(input.uploadToken, input.tokenPepper),
      expiresAt,
      createdByUserId: input.createdByUserId,
      label: `Certificate request: ${input.kind}`,
      maxUses: 1,
    });
    const deliveryStatus = input.deliveryMethod === "smtp" ? "queued" : "manual_ready";
    const ciphertext =
      input.deliveryMethod === "smtp"
        ? encryptSecret(
            input.uploadToken,
            input.tokenPepper as string,
            encryptionContext(input.organizationId, requestId),
          )
        : null;
    database
      .prepare(
        `INSERT INTO certificate_requests
          (id, organization_id, vendor_id, upload_link_id, source_certificate_id,
           request_kind, delivery_method, delivery_status, recipient_name, recipient_email,
           upload_token_ciphertext, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.organizationId,
        input.vendorId,
        uploadLink.id,
        input.sourceCertificateId ?? null,
        input.kind,
        input.deliveryMethod,
        deliveryStatus,
        normalizedRecipientName,
        normalizedRecipientEmail,
        ciphertext,
        input.createdByUserId ?? null,
        at,
        at,
      );
    return recordFrom(
      requestRow(database, input.organizationId, requestId) as JoinedCertificateRequestRow,
    );
  });
};

export const getCertificateRequest = (
  database: OpenCoiDatabase,
  organizationId: string,
  requestId: string,
): CertificateRequestRecord | null => {
  const row = requestRow(database, organizationId, requestId);
  return row ? recordFrom(row) : null;
};

export const listCertificateRequests = (
  database: OpenCoiDatabase,
  organizationId: string,
  options: { vendorId?: string; limit?: number; before?: { createdAt: string; id: string } } = {},
): CertificateRequestRecord[] => {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("Certificate request list limit must be between 1 and 500");
  }
  if (
    options.before &&
    (Number.isNaN(Date.parse(options.before.createdAt)) ||
      !options.before.id ||
      options.before.id.length > 128)
  ) {
    throw new TypeError("Certificate request cursor is invalid");
  }
  const rows = database
    .prepare(
      `SELECT r.*, l.expires_at, l.use_count AS upload_use_count,
              l.revoked_at AS upload_revoked_at
       FROM certificate_requests r
       JOIN upload_links l
         ON l.organization_id = r.organization_id AND l.id = r.upload_link_id
       WHERE r.organization_id = ? AND (? IS NULL OR r.vendor_id = ?)
         AND (
           ? IS NULL OR r.created_at < ? OR
           (r.created_at = ? AND r.id < ?)
         )
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    )
    .all(
      organizationId,
      options.vendorId ?? null,
      options.vendorId ?? null,
      options.before?.createdAt ?? null,
      options.before?.createdAt ?? null,
      options.before?.createdAt ?? null,
      options.before?.id ?? null,
      limit,
    ) as unknown as JoinedCertificateRequestRow[];
  return rows.map(recordFrom);
};

const transitionOpenCertificateRequestToCancelled = (
  database: OpenCoiDatabase,
  current: JoinedCertificateRequestRow,
  at: string,
): CertificateRequestRecord | null => {
  database
    .prepare(
      `UPDATE upload_links SET revoked_at = COALESCE(revoked_at, ?)
       WHERE organization_id = ? AND id = ?`,
    )
    .run(at, current.organization_id, current.upload_link_id);
  const changed = database
    .prepare(
      `UPDATE certificate_requests
       SET state = 'cancelled',
           delivery_status = CASE
             WHEN delivery_method = 'smtp' AND delivery_status IN ('queued', 'processing')
               THEN 'cancelled'
             ELSE delivery_status
           END,
           upload_token_ciphertext = NULL, claim_token = NULL, claimed_at = NULL,
           next_attempt_at = NULL,
           delivery_error = CASE
             WHEN delivery_status = 'processing'
               THEN 'Request cancelled before the SMTP outcome was recorded'
             ELSE delivery_error
           END,
           cancelled_at = ?, updated_at = ?
       WHERE organization_id = ? AND id = ? AND state = 'open'`,
    )
    .run(at, at, current.organization_id, current.id);
  if (Number(changed.changes) !== 1) return null;
  return recordFrom(
    requestRow(database, current.organization_id, current.id) as JoinedCertificateRequestRow,
  );
};

/** Return a record only when this call performed the open-to-cancelled transition. */
export const cancelOpenCertificateRequest = (
  database: OpenCoiDatabase,
  input: { organizationId: string; requestId: string; at?: string },
): CertificateRequestRecord | null => {
  const at = instant(input.at, "at");
  const repository = createOrganizationRepository(database, input.organizationId);
  return repository.transaction(() => {
    const current = requestRow(database, input.organizationId, input.requestId);
    return current?.state === "open"
      ? transitionOpenCertificateRequestToCancelled(database, current, at)
      : null;
  });
};

export const cancelOpenCertificateRequestsForVendor = (
  database: OpenCoiDatabase,
  input: { organizationId: string; vendorId: string; at?: string },
): CertificateRequestRecord[] => {
  const at = instant(input.at, "at");
  const repository = createOrganizationRepository(database, input.organizationId);
  return repository.transaction(() => {
    const ids = database
      .prepare(
        `SELECT id FROM certificate_requests
         WHERE organization_id = ? AND vendor_id = ? AND state = 'open'
         ORDER BY created_at, id`,
      )
      .all(input.organizationId, input.vendorId) as Array<{ id: string }>;
    return ids.map((row) => {
      const cancelled = cancelOpenCertificateRequest(database, {
        organizationId: input.organizationId,
        requestId: row.id,
        at,
      });
      if (!cancelled) throw new Error("Open certificate request could not be cancelled");
      return cancelled;
    });
  });
};

export const getCertificateRequestDeliveryMaterial = (
  database: OpenCoiDatabase,
  input: { organizationId: string; requestId: string; tokenPepper: string; at?: string },
): CertificateRequestDeliveryMaterial | null => {
  const at = instant(input.at, "at");
  const row = requestRow(database, input.organizationId, input.requestId);
  if (
    row?.state !== "open" ||
    row.delivery_method !== "smtp" ||
    !["queued", "processing"].includes(row.delivery_status) ||
    !row.upload_token_ciphertext ||
    row.upload_revoked_at ||
    row.upload_use_count >= 1 ||
    Date.parse(row.expires_at) <= Date.parse(at)
  ) {
    return null;
  }
  return {
    request: recordFrom(row),
    uploadToken: decryptSecret(
      row.upload_token_ciphertext,
      input.tokenPepper,
      encryptionContext(input.organizationId, row.id),
    ),
  };
};

export const cancelCertificateRequest = (
  database: OpenCoiDatabase,
  input: { organizationId: string; requestId: string; at?: string },
): CertificateRequestRecord | null => {
  const at = instant(input.at, "at");
  const repository = createOrganizationRepository(database, input.organizationId);
  return repository.transaction(() => {
    const current = requestRow(database, input.organizationId, input.requestId);
    if (!current) return null;
    if (current.state === "cancelled") return recordFrom(current);
    if (current.state !== "open") {
      throw new RangeError(`A ${current.state} certificate request cannot be cancelled`);
    }
    return transitionOpenCertificateRequestToCancelled(database, current, at);
  });
};

export const markCertificateRequestSubmitted = (
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    uploadLinkId: string;
    certificateId: string;
    at?: string;
  },
): CertificateRequestRecord | null => {
  const at = instant(input.at, "at");
  const repository = createOrganizationRepository(database, input.organizationId);
  return repository.transaction(() => {
    const current = database
      .prepare(
        `SELECT r.*, l.expires_at, l.use_count AS upload_use_count,
                l.revoked_at AS upload_revoked_at
         FROM certificate_requests r
         JOIN upload_links l
           ON l.organization_id = r.organization_id AND l.id = r.upload_link_id
         WHERE r.organization_id = ? AND r.upload_link_id = ?`,
      )
      .get(input.organizationId, input.uploadLinkId) as unknown as
      | JoinedCertificateRequestRow
      | undefined;
    if (!current) return null;
    if (current.state === "submitted") {
      if (current.submitted_certificate_id !== input.certificateId) {
        throw new RangeError("Certificate request was already submitted with another certificate");
      }
      return recordFrom(current);
    }
    if (current.state !== "open") {
      throw new RangeError(`A ${current.state} certificate request cannot be submitted`);
    }

    const certificate = certificateForVendor(
      repository.getCertificate(input.certificateId),
      current.vendor_id,
      "certificateId",
    );
    if (!certificate) throw new TypeError("certificateId does not exist in this organization");
    const document = repository.getDocument(certificate.document_id);
    if (!document || document.upload_link_id !== current.upload_link_id) {
      throw new TypeError("Certificate was not submitted through this request's upload link");
    }

    database
      .prepare(
        `UPDATE certificate_requests
         SET state = 'submitted', submitted_certificate_id = ?, submitted_at = ?,
             delivery_status = CASE
               WHEN delivery_method = 'smtp' AND delivery_status IN ('queued', 'processing')
                 THEN 'superseded'
               ELSE delivery_status
             END,
             upload_token_ciphertext = NULL, claim_token = NULL, claimed_at = NULL,
             next_attempt_at = NULL,
             delivery_error = CASE
               WHEN delivery_status = 'processing'
                 THEN 'Request was submitted before the SMTP outcome was recorded'
               ELSE delivery_error
             END,
             updated_at = ?
         WHERE organization_id = ? AND id = ? AND state = 'open'`,
      )
      .run(input.certificateId, at, at, input.organizationId, current.id);
    return recordFrom(
      requestRow(database, input.organizationId, current.id) as JoinedCertificateRequestRow,
    );
  });
};

const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_LEASE_MS = 2 * 60_000;

/** Claim one tenant-scoped SMTP request immediately before the network attempt. */
export const claimCertificateRequestDelivery = (
  database: OpenCoiDatabase,
  input: { organizationId: string; tokenPepper: string; at?: string },
): ClaimedCertificateRequestDelivery | null => {
  const at = instant(input.at, "at");
  const staleBefore = new Date(Date.parse(at) - DELIVERY_LEASE_MS).toISOString();
  const repository = createOrganizationRepository(database, input.organizationId);
  return repository.transaction(() => {
    const recoverableSubmissions = database
      .prepare(
        `SELECT r.upload_link_id, c.id AS certificate_id
         FROM certificate_requests r
         JOIN documents d
           ON d.organization_id = r.organization_id AND d.upload_link_id = r.upload_link_id
         JOIN certificates c
           ON c.organization_id = d.organization_id AND c.document_id = d.id
         WHERE r.organization_id = ? AND r.state = 'open'`,
      )
      .all(input.organizationId) as Array<{ upload_link_id: string; certificate_id: string }>;
    for (const recovered of recoverableSubmissions) {
      markCertificateRequestSubmitted(database, {
        organizationId: input.organizationId,
        uploadLinkId: recovered.upload_link_id,
        certificateId: recovered.certificate_id,
        at,
      });
    }
    database
      .prepare(
        `UPDATE certificate_requests
         SET state = 'cancelled',
             delivery_status = CASE
               WHEN delivery_method = 'smtp' AND delivery_status IN ('queued', 'processing')
                 THEN 'cancelled'
               ELSE delivery_status
             END,
             upload_token_ciphertext = NULL, claim_token = NULL, claimed_at = NULL,
             next_attempt_at = NULL,
             delivery_error = CASE
               WHEN delivery_status = 'processing'
                 THEN 'Upload link became unavailable before the SMTP outcome was recorded'
               ELSE delivery_error
             END,
             cancelled_at = ?, updated_at = ?
         WHERE organization_id = ? AND state = 'open'
           AND EXISTS (
             SELECT 1 FROM upload_links l
             WHERE l.organization_id = certificate_requests.organization_id
               AND l.id = certificate_requests.upload_link_id
               AND (l.revoked_at IS NOT NULL OR l.use_count >= l.max_uses)
           )`,
      )
      .run(at, at, input.organizationId);
    database
      .prepare(
        `UPDATE certificate_requests
         SET state = 'expired',
             delivery_status = CASE
               WHEN delivery_method = 'smtp' AND delivery_status IN ('queued', 'processing')
                 THEN 'expired'
               ELSE delivery_status
             END,
             upload_token_ciphertext = NULL, claim_token = NULL, claimed_at = NULL,
             next_attempt_at = NULL,
             delivery_error = CASE
               WHEN delivery_method = 'smtp' AND delivery_status IN ('queued', 'processing')
                 THEN 'Request expired before the SMTP outcome was recorded'
               ELSE delivery_error
             END,
             updated_at = ?
         WHERE organization_id = ? AND state = 'open'
           AND EXISTS (
             SELECT 1 FROM upload_links l
             WHERE l.organization_id = certificate_requests.organization_id
               AND l.id = certificate_requests.upload_link_id AND l.expires_at <= ?
           )`,
      )
      .run(at, input.organizationId, at);
    database
      .prepare(
        `UPDATE certificate_requests
         SET delivery_status = 'failed', upload_token_ciphertext = NULL,
             claim_token = NULL, claimed_at = NULL, next_attempt_at = NULL,
             delivery_error = 'Delivery lease expired after the final attempt; outcome unknown',
             updated_at = ?
         WHERE organization_id = ? AND state = 'open' AND delivery_status = 'processing'
           AND claimed_at <= ? AND attempt_count >= ?`,
      )
      .run(at, input.organizationId, staleBefore, MAX_DELIVERY_ATTEMPTS);
    database
      .prepare(
        `UPDATE certificate_requests
         SET delivery_status = 'queued', claim_token = NULL, claimed_at = NULL,
             next_attempt_at = ?,
             delivery_error = 'Previous delivery worker stopped before recording an outcome',
             updated_at = ?
         WHERE organization_id = ? AND state = 'open' AND delivery_status = 'processing'
           AND claimed_at <= ? AND attempt_count < ?`,
      )
      .run(at, at, input.organizationId, staleBefore, MAX_DELIVERY_ATTEMPTS);
    const candidate = database
      .prepare(
        `SELECT r.id FROM certificate_requests r
         JOIN upload_links l
           ON l.organization_id = r.organization_id AND l.id = r.upload_link_id
         WHERE r.organization_id = ? AND r.state = 'open' AND r.delivery_method = 'smtp'
           AND delivery_status IN ('queued', 'failed')
           AND r.upload_token_ciphertext IS NOT NULL AND r.attempt_count < ?
           AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?)
           AND l.revoked_at IS NULL AND l.use_count < l.max_uses AND l.expires_at > ?
         ORDER BY r.created_at, r.id LIMIT 1`,
      )
      .get(input.organizationId, MAX_DELIVERY_ATTEMPTS, at, at) as { id: string } | undefined;
    if (!candidate) return null;
    const claimToken = randomUUID();
    const changed = database
      .prepare(
        `UPDATE certificate_requests
         SET delivery_status = 'processing', attempt_count = attempt_count + 1,
             last_attempt_at = ?, claim_token = ?, claimed_at = ?,
             next_attempt_at = NULL, delivery_error = NULL, updated_at = ?
         WHERE organization_id = ? AND id = ? AND state = 'open'
           AND delivery_status IN ('queued', 'failed') AND upload_token_ciphertext IS NOT NULL`,
      )
      .run(at, claimToken, at, at, input.organizationId, candidate.id);
    if (Number(changed.changes) !== 1) return null;
    const material = getCertificateRequestDeliveryMaterial(database, {
      organizationId: input.organizationId,
      requestId: candidate.id,
      tokenPepper: input.tokenPepper,
      at,
    });
    if (!material) throw new Error("Claimed certificate request delivery became unavailable");
    return { ...material, claimToken };
  });
};

/** Complete exactly the lease claimed by one worker; stale workers cannot overwrite a newer result. */
export const completeCertificateRequestDelivery = (
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    requestId: string;
    claimToken: string;
    accepted: boolean;
    errorMessage?: string;
    retryAt?: string;
    at?: string;
  },
): CertificateRequestRecord | null => {
  const at = instant(input.at, "at");
  const retryAt = input.retryAt ? instant(input.retryAt, "retryAt") : null;
  if (retryAt && Date.parse(retryAt) <= Date.parse(at)) {
    throw new RangeError("retryAt must be after the completion time");
  }
  const current = requestRow(database, input.organizationId, input.requestId);
  if (
    current?.state !== "open" ||
    current.delivery_status !== "processing" ||
    current.claim_token !== input.claimToken
  ) {
    return null;
  }
  const retryable =
    !input.accepted && Boolean(retryAt) && current.attempt_count < MAX_DELIVERY_ATTEMPTS;
  const result = database
    .prepare(
      `UPDATE certificate_requests
       SET delivery_status = ?, accepted_at = ?, delivery_error = ?, next_attempt_at = ?,
           upload_token_ciphertext = ?, claim_token = NULL, claimed_at = NULL, updated_at = ?
       WHERE organization_id = ? AND id = ? AND state = 'open'
         AND delivery_status = 'processing' AND claim_token = ?`,
    )
    .run(
      input.accepted ? "accepted" : "failed",
      input.accepted ? at : null,
      input.accepted ? null : (input.errorMessage ?? "SMTP submission failed").slice(0, 500),
      retryable ? retryAt : null,
      retryable ? current.upload_token_ciphertext : null,
      at,
      input.organizationId,
      input.requestId,
      input.claimToken,
    );
  if (Number(result.changes) !== 1) return null;
  return getCertificateRequest(database, input.organizationId, input.requestId);
};
