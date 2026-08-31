import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type CoiDocumentFacts,
  type CoiEndorsementEvidence,
  type CoiPolicyFacts,
  type CoverageType,
  ENDORSEMENT_EVIDENCE_LEVELS,
  type EvidenceField,
  evaluateCompliance,
  evidenceField,
  isIsoDate,
  isoDate,
  LIMIT_TYPES,
  type LimitType,
  type MoneyMinor,
  moneyMinor,
  RULES_SCHEMA_VERSION,
  type RulesetV1Input,
} from "../../shared/index.js";
import type {
  CertificateRow,
  CreatePolicyInput,
  DocumentRow,
  FindingRow,
  OpenCoiDatabase,
  OrganizationRepository,
} from "../db.js";
import type { DocumentStore } from "../storage.js";

const optionalText = z.string().trim().max(500).nullable().optional();
const optionalIsoDate = z
  .string()
  .trim()
  .refine((value) => value === "" || isIsoDate(value), "Expected a date in YYYY-MM-DD format")
  .nullable()
  .optional()
  .transform((value) => value || null);

const limitValueSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limitsSchema = z.partialRecord(z.enum(LIMIT_TYPES), limitValueSchema).default({});

const policySchema = z
  .object({
    coverageType: z.string().trim().min(1).max(100),
    insurer: optionalText,
    insurerName: optionalText,
    policyNumber: optionalText,
    effectiveDate: optionalIsoDate,
    expirationDate: optionalIsoDate,
    limits: limitsSchema,
    endorsements: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(300),
          evidenceLevel: z.enum(ENDORSEMENT_EVIDENCE_LEVELS).default("MENTIONED"),
          formCode: z.string().trim().min(1).max(100).optional(),
        }),
      )
      .max(100)
      .default([]),
  })
  .passthrough();

export const certificateMetadataSchema = z
  .object({
    extractionVersion: z.string().trim().max(100).optional(),
    extractionMethod: z.string().trim().max(100).optional(),
    rawText: z.string().max(2_000_000).default(""),
    pages: z.array(z.unknown()).max(100).optional(),
    reviewStatus: z.enum(["CONFIRMED", "UNCONFIRMED"]).default("UNCONFIRMED"),
    namedInsured: z.string().trim().max(500).default(""),
    issueDate: optionalIsoDate,
    producer: optionalText,
    certificateHolder: optionalText,
    policies: z.array(policySchema).max(50).default([]),
  })
  .passthrough();

/**
 * Reviewer-editable facts are deliberately narrower than stored extraction
 * metadata. Raw OCR text, page candidates, and processing provenance cannot be
 * replaced through the confirmation endpoint.
 */
export const certificateCorrectionSchema = z
  .object({
    namedInsured: z.string().trim().min(1).max(500),
    issueDate: optionalIsoDate,
    producer: optionalText,
    certificateHolder: optionalText,
    policies: z.array(policySchema).max(50),
  })
  .strict();

export const certificateRejectionReasonSchema = z.string().trim().min(10).max(5_000);

export type CertificateMetadata = z.output<typeof certificateMetadataSchema>;
export type CertificateCorrection = z.output<typeof certificateCorrectionSchema>;

export interface IngestCertificateInput {
  database: OpenCoiDatabase;
  repository: OrganizationRepository;
  documentStore: DocumentStore;
  vendorId: string;
  originalFilename: string;
  bytes: Uint8Array;
  metadata: unknown;
  uploadedByUserId?: string;
  uploadLinkId?: string;
  consumeUploadLink?: boolean;
  forceUnconfirmed?: boolean;
  now?: Date;
}

export interface IngestCertificateResult {
  certificate: CertificateRow;
  document: DocumentRow;
  requirementVersion: number | null;
  evaluationDate: string | null;
}

export interface ConfirmCertificateResult {
  certificate: CertificateRow;
  document: DocumentRow;
  requirementVersion: number | null;
  evaluationDate: string;
  correctedFields: string[];
}

export interface RejectCertificateResult {
  certificate: CertificateRow;
  document: DocumentRow;
  rejectedAt: string;
}

const COVERAGE_ALIASES: Readonly<Record<string, CoverageType>> = {
  GENERAL_LIABILITY: "COMMERCIAL_GENERAL_LIABILITY",
  COMMERCIAL_GENERAL_LIABILITY: "COMMERCIAL_GENERAL_LIABILITY",
  AUTOMOBILE_LIABILITY: "AUTOMOBILE_LIABILITY",
  AUTO_LIABILITY: "AUTOMOBILE_LIABILITY",
  WORKERS_COMPENSATION: "WORKERS_COMPENSATION",
  WORKERS_COMP: "WORKERS_COMPENSATION",
  EMPLOYERS_LIABILITY: "EMPLOYERS_LIABILITY",
  EMPLOYER_LIABILITY: "EMPLOYERS_LIABILITY",
  UMBRELLA_EXCESS: "UMBRELLA_EXCESS_LIABILITY",
  UMBRELLA_EXCESS_LIABILITY: "UMBRELLA_EXCESS_LIABILITY",
  PROFESSIONAL_LIABILITY: "PROFESSIONAL_LIABILITY",
  CYBER_LIABILITY: "CYBER_LIABILITY",
  POLLUTION_LIABILITY: "POLLUTION_LIABILITY",
  PROPERTY: "PROPERTY",
  OTHER: "OTHER",
};

export const normalizeCoverageType = (value: string): CoverageType => {
  const key = value
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase();
  return COVERAGE_ALIASES[key] ?? "OTHER";
};

const safeJson = <T>(value: unknown, fallback: T): T => {
  try {
    return (typeof value === "string" ? JSON.parse(value) : value) as T;
  } catch {
    return fallback;
  }
};

export const parseCertificateMetadata = (
  input: unknown,
  forceUnconfirmed = false,
): CertificateMetadata => {
  const raw =
    typeof input === "string"
      ? input.trim()
        ? safeJson<unknown>(input, Symbol.for("invalid-json"))
        : {}
      : (input ?? {});
  if (raw === Symbol.for("invalid-json")) {
    throw new TypeError("The metadata field is not valid JSON");
  }
  const parsed = certificateMetadataSchema.parse(raw);
  return forceUnconfirmed ? { ...parsed, reviewStatus: "UNCONFIRMED" } : parsed;
};

interface RequirementRow extends Record<string, unknown> {
  id: string;
  coverage_type: string;
  minimum_each_occurrence: number | null;
  minimum_aggregate: number | null;
  minimum_combined_single_limit: number | null;
  required_endorsements_json: string;
  rule_config_json: string;
}

interface RequirementConfig {
  version?: number;
  label?: string;
  required?: boolean;
  expirationWarningDays?: number;
  endorsementEvidence?: "indicated" | "document" | "reviewed_document";
}

export const requirementVersionFor = (
  repository: OrganizationRepository,
  vendorTypeId: string,
): number | null => {
  const versions = (repository.listCoverageRequirements(vendorTypeId) as RequirementRow[]).map(
    (row) => safeJson<RequirementConfig>(row.rule_config_json, {}).version ?? 0,
  );
  return versions.length ? Math.max(...versions) : null;
};

const minimumEvidence = (
  value: RequirementConfig["endorsementEvidence"],
): "MENTIONED" | "ATTACHED" | "HUMAN_VERIFIED" => {
  if (value === "reviewed_document") return "HUMAN_VERIFIED";
  if (value === "document") return "ATTACHED";
  return "MENTIONED";
};

const rulesetFor = (
  repository: OrganizationRepository,
  vendorTypeId: string,
  vendorTypeName: string,
): { ruleset: RulesetV1Input; version: number } | null => {
  const rows = repository.listCoverageRequirements(vendorTypeId) as RequirementRow[];
  if (rows.length === 0) return null;
  const version = requirementVersionFor(repository, vendorTypeId) ?? 1;
  return {
    version,
    ruleset: {
      schemaVersion: RULES_SCHEMA_VERSION,
      id: `requirements:${vendorTypeId}:v${version}`,
      name: `${vendorTypeName} requirements v${version}`,
      currency: "USD",
      vendorTypes: [
        {
          vendorTypeId,
          name: vendorTypeName,
          requirements: rows.map((row) => {
            const config = safeJson<RequirementConfig>(row.rule_config_json, {});
            const minimumLimits: Array<{
              limitType: LimitType;
              minimumMinor: number;
              allowUmbrellaStacking: boolean;
            }> = [];
            if (row.minimum_each_occurrence !== null) {
              const coverageType = normalizeCoverageType(row.coverage_type);
              minimumLimits.push({
                limitType:
                  coverageType === "AUTOMOBILE_LIABILITY"
                    ? "COMBINED_SINGLE_LIMIT"
                    : coverageType === "EMPLOYERS_LIABILITY"
                      ? "EACH_ACCIDENT"
                      : [
                            "PROFESSIONAL_LIABILITY",
                            "CYBER_LIABILITY",
                            "POLLUTION_LIABILITY",
                          ].includes(coverageType)
                        ? "EACH_CLAIM"
                        : "EACH_OCCURRENCE",
                minimumMinor: row.minimum_each_occurrence,
                allowUmbrellaStacking: false,
              });
            }
            if (row.minimum_combined_single_limit !== null) {
              minimumLimits.push({
                limitType: "COMBINED_SINGLE_LIMIT",
                minimumMinor: row.minimum_combined_single_limit,
                allowUmbrellaStacking: false,
              });
            }
            if (row.minimum_aggregate !== null) {
              const coverageType = normalizeCoverageType(row.coverage_type);
              minimumLimits.push({
                limitType: [
                  "PROFESSIONAL_LIABILITY",
                  "CYBER_LIABILITY",
                  "POLLUTION_LIABILITY",
                  "UMBRELLA_EXCESS_LIABILITY",
                ].includes(coverageType)
                  ? "AGGREGATE"
                  : "GENERAL_AGGREGATE",
                minimumMinor: row.minimum_aggregate,
                allowUmbrellaStacking: false,
              });
            }
            const endorsements = safeJson<unknown[]>(row.required_endorsements_json, [])
              .map((value) => (typeof value === "string" ? value.trim() : ""))
              .filter(Boolean)
              .map((name, index) => ({
                id: `${row.id}:endorsement:${index + 1}`,
                name,
                applicability: "REQUIRED" as const,
                minimumEvidenceLevel: minimumEvidence(config.endorsementEvidence),
              }));
            return {
              id: row.id,
              coverageType: normalizeCoverageType(row.coverage_type),
              applicability: config.required === false ? "NOT_APPLICABLE" : "REQUIRED",
              requiredPolicyFields: ["INSURER_NAME", "POLICY_NUMBER"] as const,
              // Warning horizons drive queue/reminder urgency, not compliance. A policy
              // remains document-current through its printed expiration date.
              minimumDaysRemaining: 0,
              minimumLimits,
              endorsements,
            };
          }),
        },
      ],
    },
  };
};

const evidence = <T>(value: T, confirmed: boolean) =>
  evidenceField(value, {
    confirmation: confirmed ? "CONFIRMED" : "UNCONFIRMED",
    source: "MANUAL",
    confidenceBps: confirmed ? 10_000 : undefined,
  });

const documentFacts = (documentId: string, metadata: CertificateMetadata): CoiDocumentFacts => {
  const confirmed = metadata.reviewStatus === "CONFIRMED";
  const endorsements: CoiEndorsementEvidence[] = [];
  const policies: CoiPolicyFacts[] = metadata.policies.map((policy, policyIndex) => {
    for (const endorsement of policy.endorsements) {
      endorsements.push({
        id: `${documentId}:endorsement:${endorsements.length + 1}`,
        name: evidence(endorsement.name, confirmed),
        ...(endorsement.formCode ? { formCode: evidence(endorsement.formCode, confirmed) } : {}),
        evidenceLevel: evidence(endorsement.evidenceLevel, confirmed),
      });
    }
    const limits: Partial<Record<LimitType, EvidenceField<MoneyMinor>>> = {};
    for (const [key, value] of Object.entries(policy.limits)) {
      if ((LIMIT_TYPES as readonly string[]).includes(key) && value !== undefined) {
        limits[key as LimitType] = evidence(moneyMinor(value), confirmed);
      }
    }
    return {
      id: `${documentId}:policy:${policyIndex + 1}`,
      coverageType: evidence(normalizeCoverageType(policy.coverageType), confirmed),
      ...((policy.insurer ?? policy.insurerName)
        ? { insurerName: evidence((policy.insurer ?? policy.insurerName) as string, confirmed) }
        : {}),
      ...(policy.policyNumber ? { policyNumber: evidence(policy.policyNumber, confirmed) } : {}),
      ...(policy.effectiveDate
        ? { effectiveDate: evidence(isoDate(policy.effectiveDate), confirmed) }
        : {}),
      ...(policy.expirationDate
        ? { expirationDate: evidence(isoDate(policy.expirationDate), confirmed) }
        : {}),
      limits,
    };
  });
  return {
    id: documentId,
    reviewStatus: metadata.reviewStatus,
    ...(metadata.namedInsured ? { namedInsured: evidence(metadata.namedInsured, confirmed) } : {}),
    ...(metadata.certificateHolder
      ? { certificateHolder: evidence(metadata.certificateHolder, confirmed) }
      : {}),
    policies,
    endorsements,
  };
};

const findingSeverity = (
  status: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE",
): FindingRow["severity"] => {
  if (status === "FAIL") return "critical";
  if (status === "UNKNOWN") return "warning";
  return "info";
};

const persistEvaluation = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  certificate: CertificateRow,
  metadata: CertificateMetadata,
  evaluationDate: string,
): number | null => {
  const vendor = repository.getVendor(certificate.vendor_id);
  if (!vendor) throw new Error("Vendor disappeared during certificate evaluation");
  const vendorType = repository.getVendorType(vendor.vendor_type_id);
  if (!vendorType) throw new Error("Vendor type disappeared during certificate evaluation");
  const configured = rulesetFor(repository, vendorType.id, vendorType.name);
  if (!configured) {
    repository.replaceFindings(certificate.id, [
      {
        category: "RULE_PROFILE",
        evaluationStatus: "UNKNOWN",
        code: "VENDOR_TYPE_RULES_NOT_FOUND",
        severity: "warning",
        title: "Vendor rules are not configured",
        message: `No active coverage requirements exist for ${vendorType.name}.`,
        actual: { vendorTypeId: vendorType.id },
      },
    ]);
    repository.setCertificateStatus(certificate.id, {
      confirmationStatus: metadata.reviewStatus === "CONFIRMED" ? "confirmed" : "draft",
      complianceStatus: "pending_review",
      ...(metadata.reviewStatus === "CONFIRMED" && certificate.confirmed_by_user_id
        ? { confirmedByUserId: certificate.confirmed_by_user_id }
        : {}),
    });
    return null;
  }
  const result = evaluateCompliance(
    configured.ruleset,
    documentFacts(certificate.document_id, metadata),
    {
      vendorTypeId: vendorType.id,
      evaluationDate: isoDate(evaluationDate),
    },
  );
  repository.replaceFindings(
    certificate.id,
    result.findings.map((finding) => ({
      id: randomUUID(),
      requirementId: repository
        .listCoverageRequirements(vendorType.id)
        .some((row) => row.id === finding.requirementId)
        ? finding.requirementId
        : undefined,
      category: finding.category,
      evaluationStatus: finding.status,
      code: finding.code,
      severity: findingSeverity(finding.status),
      coverageType:
        typeof finding.expected?.coverageType === "string"
          ? finding.expected.coverageType
          : undefined,
      title: finding.title,
      message: finding.explanation,
      expected: finding.expected,
      actual: finding.observed,
      evidenceIds: [...finding.evidenceIds],
    })),
  );
  const complianceStatus =
    result.label === "DOCUMENT_COMPLIANT" || result.label === "DOCUMENT_NOT_APPLICABLE"
      ? "compliant"
      : result.label === "DOCUMENT_NON_COMPLIANT"
        ? "non_compliant"
        : "pending_review";
  repository.setCertificateStatus(certificate.id, {
    confirmationStatus: metadata.reviewStatus === "CONFIRMED" ? "confirmed" : "draft",
    complianceStatus,
    ...(metadata.reviewStatus === "CONFIRMED" && certificate.confirmed_by_user_id
      ? { confirmedByUserId: certificate.confirmed_by_user_id }
      : {}),
  });
  void database;
  return configured.version;
};

const booleanEndorsement = (names: readonly string[], pattern: RegExp): boolean | undefined =>
  names.some((name) => pattern.test(name)) ? true : undefined;

const policyInputsFor = (metadata: CertificateMetadata): CreatePolicyInput[] =>
  metadata.policies.map((policy) => {
    const endorsementNames = policy.endorsements.map((endorsement) => endorsement.name);
    return {
      coverageType: normalizeCoverageType(policy.coverageType),
      insurerName: policy.insurer ?? policy.insurerName ?? undefined,
      policyNumber: policy.policyNumber ?? undefined,
      effectiveDate: policy.effectiveDate ?? undefined,
      expirationDate: policy.expirationDate ?? undefined,
      eachOccurrenceLimit:
        policy.limits.EACH_OCCURRENCE ?? policy.limits.EACH_ACCIDENT ?? policy.limits.EACH_CLAIM,
      aggregateLimit: policy.limits.GENERAL_AGGREGATE ?? policy.limits.AGGREGATE,
      combinedSingleLimit: policy.limits.COMBINED_SINGLE_LIMIT,
      additionalInsured: booleanEndorsement(endorsementNames, /additional\s+insured/i),
      waiverOfSubrogation: booleanEndorsement(endorsementNames, /waiver.*subrogation/i),
      primaryNoncontributory: booleanEndorsement(endorsementNames, /primary.*non.?contributory/i),
      metadata: {
        // The relational columns above support common projections. This map is
        // authoritative for rule evaluation and preserves EACH_CLAIM,
        // EACH_ACCIDENT, GENERAL_AGGREGATE, and every other exact limit key.
        limits: policy.limits,
        endorsements: policy.endorsements,
        currency: "USD",
      },
    };
  });

const replaceCertificateEndorsements = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  certificateId: string,
  metadata: CertificateMetadata,
  at: string,
): void => {
  database
    .prepare(
      "DELETE FROM certificate_endorsements WHERE organization_id = ? AND certificate_id = ?",
    )
    .run(repository.organizationId, certificateId);
  const seen = new Set<string>();
  const insert = database.prepare(
    `INSERT INTO certificate_endorsements
      (id, organization_id, certificate_id, endorsement_type, form_number,
       status, source_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'present', ?, ?, ?)`,
  );
  for (const endorsement of metadata.policies.flatMap((policy) => policy.endorsements)) {
    const identity = `${endorsement.name.toLowerCase()}|${endorsement.formCode ?? ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    insert.run(
      randomUUID(),
      repository.organizationId,
      certificateId,
      endorsement.name,
      endorsement.formCode ?? null,
      endorsement.name,
      at,
      at,
    );
  }
};

const replaceCertificateFacts = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  certificateId: string,
  metadata: CertificateMetadata,
  at: string,
): void => {
  const effectiveDates = metadata.policies
    .map((policy) => policy.effectiveDate)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort();
  const expirationDates = metadata.policies
    .map((policy) => policy.expirationDate)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort();
  const updated = database
    .prepare(
      `UPDATE certificates
       SET insured_name = ?, producer_name = ?, issued_on = ?,
           earliest_effective_date = ?, earliest_expiration_date = ?, updated_at = ?
       WHERE organization_id = ? AND id = ?`,
    )
    .run(
      metadata.namedInsured || null,
      metadata.producer ?? null,
      metadata.issueDate ?? null,
      effectiveDates[0] ?? null,
      expirationDates[0] ?? null,
      at,
      repository.organizationId,
      certificateId,
    );
  if (Number(updated.changes) !== 1) {
    throw new Error("Certificate facts could not be updated");
  }
  repository.replacePolicies(certificateId, policyInputsFor(metadata));
  replaceCertificateEndorsements(database, repository, certificateId, metadata, at);
};

export const ingestCertificate = async (
  input: IngestCertificateInput,
): Promise<IngestCertificateResult> => {
  const vendor = input.repository.getVendor(input.vendorId);
  if (!vendor) throw new TypeError("Vendor does not exist in this organization");
  const metadata = parseCertificateMetadata(input.metadata, input.forceUnconfirmed);
  const stored = await input.documentStore.putPdf(input.bytes);
  const now = input.now ?? new Date();
  const evaluationDate = now.toISOString().slice(0, 10);
  try {
    return input.repository.transaction((repository) => {
      if (
        input.uploadLinkId &&
        input.consumeUploadLink &&
        !repository.consumeUploadLink(input.uploadLinkId, now.toISOString())
      ) {
        throw new TypeError("Upload link is expired, revoked, or already used");
      }
      const document = repository.createDocument({
        vendorId: input.vendorId,
        ...(input.uploadLinkId ? { uploadLinkId: input.uploadLinkId } : {}),
        ...(input.uploadedByUserId ? { uploadedByUserId: input.uploadedByUserId } : {}),
        originalFilename: input.originalFilename.slice(0, 240) || "certificate.pdf",
        storageKey: stored.storageKey,
        byteSize: stored.sizeBytes,
        sha256: stored.sha256,
      });
      const certificate = repository.createCertificate({
        vendorId: input.vendorId,
        documentId: document.id,
      });
      if (metadata.reviewStatus === "CONFIRMED" && input.uploadedByUserId) {
        certificate.confirmed_by_user_id = input.uploadedByUserId;
      }
      replaceCertificateFacts(
        input.database,
        repository,
        certificate.id,
        metadata,
        now.toISOString(),
      );
      const requirementVersion = persistEvaluation(
        input.database,
        repository,
        certificate,
        metadata,
        evaluationDate,
      );
      const extraction = {
        ...metadata,
        reviewStatus: input.forceUnconfirmed ? "UNCONFIRMED" : metadata.reviewStatus,
        _opencoi: {
          evaluationDate,
          requirementVersion,
          scope: "UPLOADED_DOCUMENT",
        },
      };
      repository.updateDocumentProcessing(document.id, {
        status: metadata.reviewStatus === "CONFIRMED" ? "confirmed" : "review_required",
        ocrText: metadata.rawText || null,
        extraction,
        confidence: metadata.reviewStatus === "CONFIRMED" ? 1 : null,
        ...(metadata.reviewStatus === "CONFIRMED" && input.uploadedByUserId
          ? { reviewedByUserId: input.uploadedByUserId }
          : {}),
      });
      return {
        certificate: repository.getCertificate(certificate.id) as CertificateRow,
        document: repository.getDocument(document.id) as DocumentRow,
        requirementVersion,
        evaluationDate,
      };
    });
  } catch (error) {
    await input.documentStore.remove(stored.storageKey);
    throw error;
  }
};

/**
 * Confirm a pending vendor submission, optionally replacing only the
 * reviewer-editable facts. Raw OCR/page candidates remain immutable; corrected
 * facts and reviewer provenance are stored alongside them before evaluation.
 */
export const confirmStoredCertificate = (input: {
  database: OpenCoiDatabase;
  repository: OrganizationRepository;
  certificateId: string;
  reviewerUserId: string;
  corrections?: unknown;
  now?: Date;
}): ConfirmCertificateResult =>
  input.repository.transaction((repository) => {
    const certificate = repository.getCertificate(input.certificateId);
    if (!certificate) throw new TypeError("Certificate does not exist in this organization");
    if (certificate.confirmation_status !== "draft") {
      throw new TypeError("Only a pending certificate can be confirmed");
    }
    const document = repository.getDocument(certificate.document_id);
    if (!document) throw new Error("Certificate document is unavailable");
    const storedExtraction = parseJsonObject(document.extraction_json);
    const corrections =
      input.corrections === undefined
        ? undefined
        : certificateCorrectionSchema.parse(input.corrections);
    const correctedFields = corrections
      ? Object.keys(corrections).filter(
          (key) =>
            JSON.stringify(storedExtraction[key] ?? null) !==
            JSON.stringify(corrections[key as keyof CertificateCorrection] ?? null),
        )
      : [];
    const metadata = parseCertificateMetadata({
      ...storedExtraction,
      ...corrections,
      reviewStatus: "CONFIRMED",
    });
    const now = input.now ?? new Date();
    const evaluationDate = now.toISOString().slice(0, 10);
    certificate.confirmed_by_user_id = input.reviewerUserId;
    replaceCertificateFacts(
      input.database,
      repository,
      certificate.id,
      metadata,
      now.toISOString(),
    );
    const requirementVersion = persistEvaluation(
      input.database,
      repository,
      certificate,
      metadata,
      evaluationDate,
    );
    const previousOpenCoi =
      storedExtraction._opencoi && typeof storedExtraction._opencoi === "object"
        ? (storedExtraction._opencoi as Record<string, unknown>)
        : {};
    repository.updateDocumentProcessing(document.id, {
      status: "confirmed",
      extraction: {
        ...storedExtraction,
        namedInsured: metadata.namedInsured,
        issueDate: metadata.issueDate,
        producer: metadata.producer,
        certificateHolder: metadata.certificateHolder,
        policies: metadata.policies,
        reviewStatus: "CONFIRMED",
        _opencoi: {
          ...previousOpenCoi,
          evaluationDate,
          requirementVersion,
          scope: "UPLOADED_DOCUMENT",
          confirmation: {
            status: "CONFIRMED",
            reviewedByUserId: input.reviewerUserId,
            reviewedAt: now.toISOString(),
            correctedFields,
          },
        },
      },
      confidence: 1,
      reviewedByUserId: input.reviewerUserId,
    });
    return {
      certificate: repository.getCertificate(certificate.id) as CertificateRow,
      document: repository.getDocument(document.id) as DocumentRow,
      requirementVersion,
      evaluationDate,
      correctedFields,
    };
  });

const parseJsonObject = (value: string | null): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const rejectStoredCertificate = (input: {
  database: OpenCoiDatabase;
  repository: OrganizationRepository;
  certificateId: string;
  reviewerUserId: string;
  reason: string;
  now?: Date;
}): RejectCertificateResult =>
  input.repository.transaction((repository) => {
    const certificate = repository.getCertificate(input.certificateId);
    if (!certificate) throw new TypeError("Certificate does not exist in this organization");
    if (certificate.confirmation_status !== "draft") {
      throw new TypeError("Only a pending certificate can be rejected");
    }
    const document = repository.getDocument(certificate.document_id);
    if (!document) throw new Error("Certificate document is unavailable");
    const reason = certificateRejectionReasonSchema.parse(input.reason);
    const at = (input.now ?? new Date()).toISOString();
    const updated = input.database
      .prepare(
        `UPDATE certificates
         SET confirmation_status = 'rejected', compliance_status = 'pending_review', updated_at = ?
         WHERE organization_id = ? AND id = ? AND confirmation_status = 'draft'`,
      )
      .run(at, repository.organizationId, certificate.id);
    if (Number(updated.changes) !== 1) throw new TypeError("Certificate is no longer pending");
    const storedExtraction = parseJsonObject(document.extraction_json);
    const previousOpenCoi =
      storedExtraction._opencoi && typeof storedExtraction._opencoi === "object"
        ? (storedExtraction._opencoi as Record<string, unknown>)
        : {};
    repository.updateDocumentProcessing(document.id, {
      status: "rejected",
      extraction: {
        ...storedExtraction,
        _opencoi: {
          ...previousOpenCoi,
          reviewDecision: {
            status: "REJECTED",
            reason,
            reviewedByUserId: input.reviewerUserId,
            reviewedAt: at,
          },
        },
      },
      reviewedByUserId: input.reviewerUserId,
    });
    return {
      certificate: repository.getCertificate(certificate.id) as CertificateRow,
      document: repository.getDocument(document.id) as DocumentRow,
      rejectedAt: at,
    };
  });
