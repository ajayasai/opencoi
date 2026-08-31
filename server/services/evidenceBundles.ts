import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { assertEvidenceBundlePayload, canonicalizeJson } from "../../shared/evidenceBundle.js";
import { OPENCOI_VERSION } from "../../shared/version.js";
import { verifyAuditChain } from "../audit.js";
import type { OpenCoiDatabase } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import { decryptSecret, encryptSecret } from "../security/secrets.js";
import { certificateView } from "./projections.js";

const EVIDENCE_SCHEMA_VERSION = "1.0" as const;
const SIGNING_ALGORITHM = "Ed25519" as const;
const CANONICALIZATION = "OPENCOI_CANONICAL_JSON_V1" as const;

interface EvidenceSigningKeyRow {
  id: string;
  organization_id: string;
  public_key_spki: string;
  public_key_fingerprint: string;
  private_key_ciphertext: string;
  created_at: string;
}

interface CertificateEvidenceRow {
  certificate_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_type_id: string;
  vendor_type_name: string;
  document_id: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  uploaded_at: string;
  extraction_json: string | null;
  confirmation_status: string;
  confirmed_by_user_id: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
}

interface RequirementVersionRow {
  id: string;
  version: number;
  requirements_json: string;
  published_at: string;
  published_by_user_id: string | null;
  published_by_name: string | null;
}

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const extractionWithoutServerMetadata = (
  extraction: Record<string, unknown>,
): Record<string, unknown> => {
  const { _opencoi: _serverMetadata, ...proposal } = extraction;
  return proposal;
};

const signingKeyContext = (organizationId: string, keyId: string): string =>
  `${organizationId}:evidence_signing_key:${keyId}:private_key`;

const activeSigningKey = (
  database: OpenCoiDatabase,
  organizationId: string,
): EvidenceSigningKeyRow | null =>
  (database
    .prepare(
      `SELECT id, organization_id, public_key_spki, public_key_fingerprint,
              private_key_ciphertext, created_at
       FROM evidence_signing_keys
       WHERE organization_id = ? AND status = 'active'`,
    )
    .get(organizationId) as EvidenceSigningKeyRow | undefined) ?? null;

/**
 * Create exactly one organization signing key and protect its private material
 * with the deployment pepper. The public fingerprint must be distributed over
 * a separately trusted channel when a verifier needs organization identity,
 * rather than bundle-integrity verification alone.
 */
export const getOrCreateEvidenceSigningKey = (
  database: OpenCoiDatabase,
  organizationId: string,
  tokenPepper: string | undefined,
  now = new Date(),
): EvidenceSigningKeyRow => {
  if (!tokenPepper || Buffer.byteLength(tokenPepper, "utf8") < 32) {
    throw new RangeError(
      "TOKEN_PEPPER of at least 32 bytes is required for signed evidence bundles",
    );
  }
  const existing = activeSigningKey(database, organizationId);
  if (existing) return existing;

  const id = randomUUID();
  const generated = generateKeyPairSync("ed25519");
  const publicKey = generated.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privateKey = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeySpki = publicKey.toString("base64url");
  const fingerprint = createHash("sha256").update(publicKey).digest("hex");
  const encryptedPrivateKey = encryptSecret(
    privateKey,
    tokenPepper,
    signingKeyContext(organizationId, id),
  );
  database
    .prepare(
      `INSERT OR IGNORE INTO evidence_signing_keys
        (id, organization_id, algorithm, public_key_spki, public_key_fingerprint,
         private_key_ciphertext, status, created_at)
       VALUES (?, ?, 'Ed25519', ?, ?, ?, 'active', ?)`,
    )
    .run(id, organizationId, publicKeySpki, fingerprint, encryptedPrivateKey, now.toISOString());
  const stored = activeSigningKey(database, organizationId);
  if (!stored) throw new Error("Evidence signing key could not be persisted");
  return stored;
};

export const evidenceSigningKeyView = (
  database: OpenCoiDatabase,
  organizationId: string,
  tokenPepper: string | undefined,
  now = new Date(),
) => {
  const key = getOrCreateEvidenceSigningKey(database, organizationId, tokenPepper, now);
  return {
    algorithm: SIGNING_ALGORITHM,
    keyId: key.id,
    publicKeySpki: key.public_key_spki,
    publicKeyFingerprint: key.public_key_fingerprint,
    createdAt: key.created_at,
  };
};

const certificateEvidenceRow = (
  database: OpenCoiDatabase,
  organizationId: string,
  certificateId: string,
): CertificateEvidenceRow | null =>
  (database
    .prepare(
      `SELECT c.id AS certificate_id, c.vendor_id, v.legal_name AS vendor_name,
              v.vendor_type_id, vt.name AS vendor_type_name, d.id AS document_id,
              d.original_filename, d.mime_type, d.byte_size, d.sha256, d.uploaded_at,
              d.extraction_json, c.confirmation_status, c.confirmed_by_user_id,
              reviewer.display_name AS confirmed_by_name, c.confirmed_at
       FROM certificates c
       JOIN documents d ON d.organization_id = c.organization_id AND d.id = c.document_id
       JOIN vendors v ON v.organization_id = c.organization_id AND v.id = c.vendor_id
       JOIN vendor_types vt ON vt.organization_id = v.organization_id AND vt.id = v.vendor_type_id
       LEFT JOIN users reviewer
         ON reviewer.organization_id = c.organization_id AND reviewer.id = c.confirmed_by_user_id
       WHERE c.organization_id = ? AND c.id = ?`,
    )
    .get(organizationId, certificateId) as CertificateEvidenceRow | undefined) ?? null;

const requirementPublication = (
  database: OpenCoiDatabase,
  organizationId: string,
  vendorTypeId: string,
  version: number | null,
) => {
  if (!version) return null;
  const row = database
    .prepare(
      `SELECT rv.id, rv.version, rv.requirements_json, rv.published_at,
              rv.published_by_user_id,
              publisher.display_name AS published_by_name
       FROM requirement_versions rv
       LEFT JOIN users publisher
         ON publisher.organization_id = rv.organization_id
        AND publisher.id = rv.published_by_user_id
       WHERE rv.organization_id = ? AND rv.vendor_type_id = ? AND rv.version = ?`,
    )
    .get(organizationId, vendorTypeId, version) as RequirementVersionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    publishedAt: row.published_at,
    publishedBy: row.published_by_user_id
      ? { id: row.published_by_user_id, name: row.published_by_name }
      : null,
    requirements: parseJson<unknown[]>(row.requirements_json, []),
  };
};

const baseFindings = (database: OpenCoiDatabase, organizationId: string, certificateId: string) =>
  (
    database
      .prepare(
        `SELECT id, requirement_id, category, evaluation_status, code, severity,
                coverage_type, title, message, expected_json, actual_json,
                evidence_ids_json, created_at
         FROM findings
         WHERE organization_id = ? AND certificate_id = ?
         ORDER BY created_at, id`,
      )
      .all(organizationId, certificateId) as Array<Record<string, unknown>>
  ).map((row) => ({
    id: String(row.id),
    requirementId: row.requirement_id ? String(row.requirement_id) : null,
    category: String(row.category),
    outcome: String(row.evaluation_status),
    code: String(row.code),
    severity: String(row.severity),
    coverageType: row.coverage_type ? String(row.coverage_type) : null,
    title: row.title ? String(row.title) : null,
    message: String(row.message),
    expected: parseJson(String(row.expected_json ?? ""), null),
    observed: parseJson(String(row.actual_json ?? ""), null),
    evidenceIds: parseJson<string[]>(String(row.evidence_ids_json ?? "[]"), []),
    evaluatedAt: String(row.created_at),
  }));

const exceptionDecisions = (
  database: OpenCoiDatabase,
  organizationId: string,
  certificateId: string,
) =>
  (
    database
      .prepare(
        `SELECT e.id, e.finding_id, e.status, e.request_reason, e.decision_note,
                e.expires_at, e.created_at, e.decided_at,
                e.requested_by_user_id, e.decided_by_user_id,
                requester.display_name AS requested_by_name,
                decider.display_name AS decided_by_name
         FROM exceptions e
         JOIN findings f
           ON f.organization_id = e.organization_id AND f.id = e.finding_id
         JOIN users requester
           ON requester.organization_id = e.organization_id
          AND requester.id = e.requested_by_user_id
         LEFT JOIN users decider
           ON decider.organization_id = e.organization_id
          AND decider.id = e.decided_by_user_id
         WHERE e.organization_id = ? AND f.certificate_id = ?
         ORDER BY e.created_at, e.id`,
      )
      .all(organizationId, certificateId) as Array<Record<string, unknown>>
  ).map((row) => ({
    id: String(row.id),
    findingId: String(row.finding_id),
    status: String(row.status),
    request: parseJson(String(row.request_reason), { reason: String(row.request_reason) }),
    decisionReason: row.decision_note ? String(row.decision_note) : null,
    requestedBy: {
      id: String(row.requested_by_user_id),
      name: String(row.requested_by_name),
    },
    requestedAt: String(row.created_at),
    decidedBy: row.decided_by_user_id
      ? {
          id: String(row.decided_by_user_id),
          name: String(row.decided_by_name ?? ""),
        }
      : null,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
  }));

const auditCheckpoint = (
  database: OpenCoiDatabase,
  organizationId: string,
  certificateId: string,
) => {
  const verification = verifyAuditChain(database, organizationId);
  const head = database
    .prepare(
      `SELECT sequence_number, event_hash, occurred_at
       FROM audit_events WHERE organization_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(organizationId) as
    | { sequence_number: number; event_hash: string; occurred_at: string }
    | undefined;
  const related = database
    .prepare(
      `SELECT sequence_number, id, actor_type, actor_user_id, action, entity_type, entity_id,
              occurred_at, metadata_json, previous_hash, event_hash
       FROM audit_events
       WHERE organization_id = ? AND entity_id = ?
       ORDER BY sequence_number`,
    )
    .all(organizationId, certificateId) as Array<Record<string, unknown>>;
  return {
    organizationChainVerifiedAtExport: verification.valid,
    checkedEvents: verification.checkedEvents,
    error: verification.error ?? null,
    head: head
      ? {
          sequence: head.sequence_number,
          eventHash: head.event_hash,
          occurredAt: head.occurred_at,
        }
      : null,
    certificateEvents: related.map((row) => ({
      sequence: Number(row.sequence_number),
      id: String(row.id),
      actorType: String(row.actor_type),
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      action: String(row.action),
      entityType: String(row.entity_type),
      entityId: row.entity_id ? String(row.entity_id) : null,
      occurredAt: String(row.occurred_at),
      metadata: parseJson(String(row.metadata_json), {}),
      previousHash: String(row.previous_hash),
      eventHash: String(row.event_hash),
    })),
  };
};

type EvidenceBundleExportInput = {
  database: OpenCoiDatabase;
  organizationId: string;
  certificateId: string;
  appOrigin: string;
  tokenPepper: string | undefined;
  now?: Date;
} & (
  | { exportedByUserId: string; exportedByServiceAccount?: never }
  | {
      exportedByUserId?: never;
      exportedByServiceAccount: { id: string; name: string };
    }
);

export const buildSignedEvidenceBundle = (input: EvidenceBundleExportInput) => {
  const at = input.now ?? new Date();
  const row = certificateEvidenceRow(input.database, input.organizationId, input.certificateId);
  if (!row) return null;
  const repository = createOrganizationRepository(input.database, input.organizationId);
  const organization = repository.getOrganization();
  const exporter = input.exportedByServiceAccount
    ? {
        id: `service-account:${input.exportedByServiceAccount.id}`,
        name: input.exportedByServiceAccount.name,
      }
    : (() => {
        const user = repository.getUser(input.exportedByUserId);
        return user ? { id: user.id, name: user.display_name } : null;
      })();
  if (!organization || !exporter) return null;
  const view = certificateView(input.database, repository, input.certificateId, at);
  if (!view) return null;
  const extraction = parseJson<Record<string, unknown>>(row.extraction_json, {});
  const openCoiMetadata = recordValue(extraction._opencoi);
  const storedMachineProposal = recordValue(openCoiMetadata?.machineProposal);
  const humanConfirmed = ["confirmed", "superseded"].includes(row.confirmation_status);
  const machineProposal =
    storedMachineProposal ?? (humanConfirmed ? null : extractionWithoutServerMetadata(extraction));
  const signingKey = getOrCreateEvidenceSigningKey(
    input.database,
    input.organizationId,
    input.tokenPepper,
    at,
  );
  const requirement =
    view.evaluationVendorType && view.requirementVersion && view.evaluatedRuleset
      ? {
          version: view.requirementVersion,
          vendorType: view.evaluationVendorType,
          evaluatedRuleset: view.evaluatedRuleset,
          publication: requirementPublication(
            input.database,
            input.organizationId,
            view.evaluationVendorType.id,
            view.requirementVersion,
          ),
        }
      : null;
  const unsigned = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    exportedAt: at.toISOString(),
    payload: {
      generator: {
        name: "OpenCOI",
        version: OPENCOI_VERSION,
        origin: input.appOrigin,
      },
      scope: {
        organization: { id: organization.id, name: organization.name },
        vendor: {
          id: row.vendor_id,
          legalName: row.vendor_name,
          vendorTypeAtExport: { id: row.vendor_type_id, name: row.vendor_type_name },
        },
        certificateId: row.certificate_id,
      },
      exportedBy: exporter,
      sourceDocument: {
        id: row.document_id,
        originalFilename: row.original_filename,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        sha256: row.sha256,
        uploadedAt: row.uploaded_at,
      },
      review: {
        status: row.confirmation_status,
        reviewedBy: row.confirmed_by_user_id
          ? { id: row.confirmed_by_user_id, name: row.confirmed_by_name }
          : null,
        reviewedAt: row.confirmed_at,
        evaluationDate: view.evaluationDate,
        requirementVersion: view.requirementVersion,
        evaluationVendorType: view.evaluationVendorType,
      },
      machineProposal,
      confirmedFacts: humanConfirmed
        ? {
            namedInsured: view.namedInsured,
            issueDate: view.issueDate,
            producer: view.producer,
            certificateHolder: view.certificateHolder,
            policies: view.policies,
          }
        : null,
      evidence: view.evidence ?? [],
      requirementSnapshot: requirement,
      findings: baseFindings(input.database, input.organizationId, input.certificateId),
      exceptions: exceptionDecisions(input.database, input.organizationId, input.certificateId),
      statusAtExport: {
        documentCheck: view.checkStatus,
        documentLifecycle: view.lifecycleStatus,
        asOf: at.toISOString(),
        limitation: humanConfirmed
          ? "This status compares human-confirmed document facts with configured rules. It is not live policy verification."
          : "This record has not produced human-confirmed facts. It is not live policy verification.",
      },
      audit: auditCheckpoint(input.database, input.organizationId, input.certificateId),
    },
  };
  assertEvidenceBundlePayload(unsigned.payload, unsigned.exportedAt);
  const canonical = canonicalizeJson(unsigned);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  const privateKeyPem = decryptSecret(
    signingKey.private_key_ciphertext,
    input.tokenPepper as string,
    signingKeyContext(input.organizationId, signingKey.id),
  );
  const signature = sign(null, Buffer.from(canonical, "utf8"), createPrivateKey(privateKeyPem));
  return {
    ...unsigned,
    integrity: {
      canonicalization: CANONICALIZATION,
      digest: { algorithm: "SHA-256" as const, value: digest },
      signature: {
        algorithm: SIGNING_ALGORITHM,
        keyId: signingKey.id,
        publicKeySpki: signingKey.public_key_spki,
        publicKeyFingerprint: signingKey.public_key_fingerprint,
        value: signature.toString("base64url"),
      },
    },
  };
};
