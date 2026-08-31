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
  normalizeOcrText,
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
import { publishDomainEvent } from "./domainEvents.js";

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
const sourcePagesSchema = z
  .array(z.number().int().min(1).max(100))
  .max(100)
  .optional()
  .superRefine((pages, context) => {
    if (!pages) return;
    for (let index = 0; index < pages.length; index += 1) {
      const previous = pages[index - 1];
      const current = pages[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Source pages must be unique and sorted in ascending order",
        });
      }
    }
  });

const endorsementSchema = z.object({
  name: z.string().trim().min(1).max(300),
  evidenceLevel: z.enum(ENDORSEMENT_EVIDENCE_LEVELS).default("MENTIONED"),
  formCode: z.string().trim().min(1).max(100).optional(),
  sourcePages: sourcePagesSchema,
});

const extractedPageSchema = z
  .object({
    page: z.number().int().min(1).max(100),
    text: z.string().max(2_000_000),
    method: z.enum(["text_layer", "ocr"]),
    confidenceBps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
const provenanceSchema = z
  .object({
    field: z.enum([
      "NAMED_INSURED",
      "CERTIFICATE_HOLDER",
      "COVERAGE_TYPE",
      "INSURER_NAME",
      "POLICY_NUMBER",
      "EFFECTIVE_DATE",
      "EXPIRATION_DATE",
      "LIMIT",
      "ENDORSEMENT_NAME",
      "ENDORSEMENT_FORM_CODE",
      "ENDORSEMENT_EVIDENCE_LEVEL",
    ]),
    extractedValue: z.union([z.string().max(500), z.number().int().nonnegative()]),
    policyIndex: z.number().int().nonnegative().max(49).optional(),
    endorsementIndex: z.number().int().nonnegative().max(99).optional(),
    limitType: z.enum(LIMIT_TYPES).optional(),
    source: z.literal("OCR"),
    confidenceBps: z.number().int().min(0).max(10_000).optional(),
    rawText: z.string().trim().min(1).max(2_000),
    page: z.number().int().min(1).max(100),
  })
  .strict();

const policySchema = z
  .object({
    coverageType: z.string().trim().min(1).max(100),
    insurer: optionalText,
    insurerName: optionalText,
    policyNumber: optionalText,
    effectiveDate: optionalIsoDate,
    expirationDate: optionalIsoDate,
    limits: limitsSchema,
    endorsements: z.array(endorsementSchema).max(100).default([]),
  })
  .passthrough();

const certificateMetadataObjectSchema = z
  .object({
    extractionVersion: z.string().trim().max(100).optional(),
    extractionMethod: z.string().trim().max(100).optional(),
    rawText: z.string().max(2_000_000).default(""),
    pages: z.array(extractedPageSchema).max(100).optional(),
    reviewStatus: z.enum(["CONFIRMED", "UNCONFIRMED"]).default("UNCONFIRMED"),
    namedInsured: z.string().trim().max(500).default(""),
    issueDate: optionalIsoDate,
    producer: optionalText,
    certificateHolder: optionalText,
    provenance: z.array(provenanceSchema).max(2_000).default([]),
    policies: z.array(policySchema).max(50).default([]),
  })
  .passthrough();

const validateCertificateMetadata = (
  metadata: z.output<typeof certificateMetadataObjectSchema>,
  context: z.RefinementCtx,
  requirePageAttestations: boolean,
) => {
  const pages = metadata.pages ?? [];
  const pageMap = new Map<number, Set<string>>();
  let submittedPageCharacters = 0;
  for (const [index, page] of pages.entries()) {
    submittedPageCharacters += page.text.length;
    if (pageMap.has(page.page)) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "page"],
        message: `Page ${page.page} is duplicated`,
      });
      continue;
    }
    pageMap.set(
      page.page,
      new Set(
        normalizeOcrText(page.text)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
  }
  if (submittedPageCharacters > 2_000_000) {
    context.addIssue({
      code: "custom",
      path: ["pages"],
      message: "Combined submitted page text exceeds 2,000,000 characters",
    });
  }
  const orderedPageNumbers = [...pageMap.keys()].sort((left, right) => left - right);
  if (orderedPageNumbers.some((page, index) => page !== index + 1)) {
    context.addIssue({
      code: "custom",
      path: ["pages"],
      message: "Submitted page metadata must be contiguous and start at page 1",
    });
  }
  if (metadata.provenance.length > 0 && pages.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["pages"],
      message: "Page metadata is required when extraction provenance is submitted",
    });
  }
  for (const [index, citation] of metadata.provenance.entries()) {
    const pageLines = pageMap.get(citation.page);
    if (!pageLines) {
      context.addIssue({
        code: "custom",
        path: ["provenance", index, "page"],
        message: `Citation page ${citation.page} is not present in submitted page metadata`,
      });
      continue;
    }
    const normalizedCitation = normalizeOcrText(citation.rawText);
    if (!pageLines.has(normalizedCitation)) {
      context.addIssue({
        code: "custom",
        path: ["provenance", index, "rawText"],
        message: "Citation text does not match a normalized line on the cited page",
      });
    }
    if (
      citation.field === "ENDORSEMENT_EVIDENCE_LEVEL" &&
      citation.extractedValue !== "MENTIONED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["provenance", index, "extractedValue"],
        message: "Machine endorsement evidence cannot exceed MENTIONED",
      });
    }
  }
  for (const [policyIndex, policy] of metadata.policies.entries()) {
    for (const [endorsementIndex, endorsement] of policy.endorsements.entries()) {
      const path = ["policies", policyIndex, "endorsements", endorsementIndex, "sourcePages"];
      const requiresPage = ["ATTACHED", "HUMAN_VERIFIED"].includes(endorsement.evidenceLevel);
      if (
        requiresPage &&
        ((requirePageAttestations && !endorsement.sourcePages?.length) ||
          endorsement.sourcePages?.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          path,
          message: `${endorsement.evidenceLevel} endorsement evidence requires at least one source page`,
        });
      }
      if (endorsement.sourcePages?.length && requirePageAttestations && pages.length === 0) {
        context.addIssue({
          code: "custom",
          path,
          message: "Submitted page metadata is required for endorsement source pages",
        });
      }
      for (const sourcePage of endorsement.sourcePages ?? []) {
        if (pages.length > 0 && !pageMap.has(sourcePage)) {
          context.addIssue({
            code: "custom",
            path,
            message: `Endorsement source page ${sourcePage} is not present in submitted page metadata`,
          });
        }
      }
    }
  }
};

/** Stored-record parser. Missing sourcePages remains valid for pre-v0.4 records. */
export const certificateMetadataSchema = certificateMetadataObjectSchema.superRefine(
  (metadata, context) => validateCertificateMetadata(metadata, context, false),
);

/** New uploads must make strong endorsement evidence page-addressable. */
export const certificateSubmissionMetadataSchema = certificateMetadataObjectSchema.superRefine(
  (metadata, context) => validateCertificateMetadata(metadata, context, true),
);

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
    policies: z
      .array(
        policySchema.superRefine((policy, context) => {
          for (const [index, endorsement] of policy.endorsements.entries()) {
            if (
              ["ATTACHED", "HUMAN_VERIFIED"].includes(endorsement.evidenceLevel) &&
              !endorsement.sourcePages?.length
            ) {
              context.addIssue({
                code: "custom",
                path: ["endorsements", index, "sourcePages"],
                message: `${endorsement.evidenceLevel} endorsement evidence requires at least one source page`,
              });
            }
          }
        }),
      )
      .max(50),
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
  submittedByServiceAccountId?: string;
  uploadLinkId?: string;
  consumeUploadLink?: boolean;
  forceUnconfirmed?: boolean;
  now?: Date;
  withinTransaction?: (result: IngestCertificateResult, repository: OrganizationRepository) => void;
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

export const parseCertificateSubmissionMetadata = (
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
  const parsed = certificateSubmissionMetadataSchema.parse(raw);
  return forceUnconfirmed ? { ...parsed, reviewStatus: "UNCONFIRMED" } : parsed;
};

const strongEndorsementEvidence = (level: string): boolean =>
  level === "ATTACHED" || level === "HUMAN_VERIFIED";

const assertEvidenceWithinSourceDocument = (
  metadata: CertificateMetadata,
  sourceDocumentPageCount: number | null,
): void => {
  const hasPageReferences = metadata.policies.some((policy) =>
    policy.endorsements.some((endorsement) => Boolean(endorsement.sourcePages?.length)),
  );
  const hasStrongEvidence = metadata.policies.some((policy) =>
    policy.endorsements.some((endorsement) => strongEndorsementEvidence(endorsement.evidenceLevel)),
  );
  if (sourceDocumentPageCount === null) {
    if (hasPageReferences || hasStrongEvidence) {
      throw new TypeError(
        "Strong endorsement evidence cannot be confirmed without a server-validated PDF page count; resubmit the document or downgrade the evidence",
      );
    }
    return;
  }
  if (
    !Number.isSafeInteger(sourceDocumentPageCount) ||
    sourceDocumentPageCount < 1 ||
    sourceDocumentPageCount > 100
  ) {
    throw new TypeError("The server-validated PDF page count is invalid");
  }
  for (const page of metadata.pages ?? []) {
    if (page.page > sourceDocumentPageCount) {
      throw new TypeError(
        `Submitted extraction page ${page.page} exceeds the ${sourceDocumentPageCount}-page source PDF`,
      );
    }
  }
  for (const policy of metadata.policies) {
    for (const endorsement of policy.endorsements) {
      if (
        strongEndorsementEvidence(endorsement.evidenceLevel) &&
        !endorsement.sourcePages?.length
      ) {
        throw new TypeError(
          `${endorsement.evidenceLevel} endorsement evidence requires an exact source page`,
        );
      }
      for (const page of endorsement.sourcePages ?? []) {
        if (page > sourceDocumentPageCount) {
          throw new TypeError(
            `Endorsement source page ${page} exceeds the ${sourceDocumentPageCount}-page source PDF`,
          );
        }
      }
    }
  }
};

const trustedPageCountFromExtraction = (extraction: Record<string, unknown>): number | null => {
  const openCoi =
    extraction._opencoi &&
    typeof extraction._opencoi === "object" &&
    !Array.isArray(extraction._opencoi)
      ? (extraction._opencoi as Record<string, unknown>)
      : null;
  const value = openCoi?.sourceDocumentPageCount;
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100
    ? Number(value)
    : null;
};

const machineProposalSnapshot = (extraction: Record<string, unknown>): Record<string, unknown> => {
  const { _opencoi: _serverMetadata, ...proposal } = extraction;
  return proposal;
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

type ExtractionProvenance = CertificateMetadata["provenance"][number];

const valuesMatch = (left: unknown, right: unknown): boolean =>
  typeof left === typeof right && left === right;

const findProvenance = (
  metadata: CertificateMetadata,
  field: ExtractionProvenance["field"],
  value: unknown,
  qualifiers: Pick<ExtractionProvenance, "policyIndex" | "endorsementIndex" | "limitType"> = {},
): ExtractionProvenance | undefined =>
  metadata.provenance.find(
    (candidate) =>
      candidate.field === field &&
      valuesMatch(candidate.extractedValue, value) &&
      (qualifiers.policyIndex === undefined || candidate.policyIndex === qualifiers.policyIndex) &&
      (qualifiers.endorsementIndex === undefined ||
        candidate.endorsementIndex === qualifiers.endorsementIndex) &&
      (qualifiers.limitType === undefined || candidate.limitType === qualifiers.limitType),
  );

const evidence = <T>(value: T, confirmed: boolean, provenance?: ExtractionProvenance) =>
  evidenceField(value, {
    confirmation: confirmed ? "CONFIRMED" : "UNCONFIRMED",
    source: provenance ? "OCR" : "MANUAL",
    confidenceBps: provenance?.confidenceBps ?? (confirmed ? 10_000 : undefined),
    ...(provenance ? { rawText: provenance.rawText, page: provenance.page } : {}),
  });

export const documentFacts = (
  documentId: string,
  metadata: CertificateMetadata,
): CoiDocumentFacts => {
  const confirmed = metadata.reviewStatus === "CONFIRMED";
  const endorsements: CoiEndorsementEvidence[] = [];
  const policies: CoiPolicyFacts[] = metadata.policies.map((policy, policyIndex) => {
    for (const [endorsementIndex, endorsement] of policy.endorsements.entries()) {
      const nameEvidence =
        findProvenance(metadata, "ENDORSEMENT_NAME", endorsement.name, { policyIndex }) ??
        findProvenance(metadata, "ENDORSEMENT_NAME", endorsement.name);
      const originalEndorsementIndex = nameEvidence?.endorsementIndex;
      endorsements.push({
        id: `${documentId}:endorsement:${endorsements.length + 1}`,
        name: evidence(endorsement.name, confirmed, nameEvidence),
        ...(endorsement.formCode
          ? {
              formCode: evidence(
                endorsement.formCode,
                confirmed,
                findProvenance(metadata, "ENDORSEMENT_FORM_CODE", endorsement.formCode, {
                  endorsementIndex: originalEndorsementIndex ?? endorsementIndex,
                }) ?? findProvenance(metadata, "ENDORSEMENT_FORM_CODE", endorsement.formCode),
              ),
            }
          : {}),
        evidenceLevel: evidence(
          endorsement.evidenceLevel,
          confirmed,
          findProvenance(metadata, "ENDORSEMENT_EVIDENCE_LEVEL", endorsement.evidenceLevel, {
            endorsementIndex: originalEndorsementIndex ?? endorsementIndex,
          }) ?? findProvenance(metadata, "ENDORSEMENT_EVIDENCE_LEVEL", endorsement.evidenceLevel),
        ),
        ...(endorsement.sourcePages?.length ? { sourcePages: endorsement.sourcePages } : {}),
      });
    }
    const limits: Partial<Record<LimitType, EvidenceField<MoneyMinor>>> = {};
    for (const [key, value] of Object.entries(policy.limits)) {
      if ((LIMIT_TYPES as readonly string[]).includes(key) && value !== undefined) {
        limits[key as LimitType] = evidence(
          moneyMinor(value),
          confirmed,
          findProvenance(metadata, "LIMIT", value, {
            policyIndex,
            limitType: key as LimitType,
          }),
        );
      }
    }
    return {
      id: `${documentId}:policy:${policyIndex + 1}`,
      coverageType: evidence(
        normalizeCoverageType(policy.coverageType),
        confirmed,
        findProvenance(metadata, "COVERAGE_TYPE", policy.coverageType, { policyIndex }),
      ),
      ...((policy.insurer ?? policy.insurerName)
        ? {
            insurerName: evidence(
              (policy.insurer ?? policy.insurerName) as string,
              confirmed,
              findProvenance(metadata, "INSURER_NAME", policy.insurer ?? policy.insurerName, {
                policyIndex,
              }),
            ),
          }
        : {}),
      ...(policy.policyNumber
        ? {
            policyNumber: evidence(
              policy.policyNumber,
              confirmed,
              findProvenance(metadata, "POLICY_NUMBER", policy.policyNumber, { policyIndex }),
            ),
          }
        : {}),
      ...(policy.effectiveDate
        ? {
            effectiveDate: evidence(
              isoDate(policy.effectiveDate),
              confirmed,
              findProvenance(metadata, "EFFECTIVE_DATE", policy.effectiveDate, { policyIndex }),
            ),
          }
        : {}),
      ...(policy.expirationDate
        ? {
            expirationDate: evidence(
              isoDate(policy.expirationDate),
              confirmed,
              findProvenance(metadata, "EXPIRATION_DATE", policy.expirationDate, { policyIndex }),
            ),
          }
        : {}),
      limits,
    };
  });
  return {
    id: documentId,
    reviewStatus: metadata.reviewStatus,
    ...(metadata.namedInsured
      ? {
          namedInsured: evidence(
            metadata.namedInsured,
            confirmed,
            findProvenance(metadata, "NAMED_INSURED", metadata.namedInsured),
          ),
        }
      : {}),
    ...(metadata.certificateHolder
      ? {
          certificateHolder: evidence(
            metadata.certificateHolder,
            confirmed,
            findProvenance(metadata, "CERTIFICATE_HOLDER", metadata.certificateHolder),
          ),
        }
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
): {
  requirementVersion: number | null;
  evaluationVendorType: { id: string; name: string };
  evaluatedRuleset: RulesetV1Input | null;
} => {
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
    return {
      requirementVersion: null,
      evaluationVendorType: { id: vendorType.id, name: vendorType.name },
      evaluatedRuleset: null,
    };
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
  return {
    requirementVersion: configured.version,
    evaluationVendorType: { id: vendorType.id, name: vendorType.name },
    evaluatedRuleset: configured.ruleset,
  };
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
  if (input.uploadedByUserId && input.submittedByServiceAccountId) {
    throw new TypeError(
      "A certificate submission cannot have both a user and service-account actor",
    );
  }
  const vendor = input.repository.getVendor(input.vendorId);
  if (!vendor) throw new TypeError("Vendor does not exist in this organization");
  const metadata = parseCertificateSubmissionMetadata(input.metadata, input.forceUnconfirmed);
  const stored = await input.documentStore.putPdf(input.bytes);
  const now = input.now ?? new Date();
  const evaluationDate = now.toISOString().slice(0, 10);
  try {
    assertEvidenceWithinSourceDocument(metadata, stored.pageCount);
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
      const evaluationContext = persistEvaluation(
        input.database,
        repository,
        certificate,
        metadata,
        evaluationDate,
      );
      const { requirementVersion } = evaluationContext;
      const extraction = {
        ...metadata,
        reviewStatus: input.forceUnconfirmed ? "UNCONFIRMED" : metadata.reviewStatus,
        _opencoi: {
          machineProposal:
            metadata.reviewStatus === "UNCONFIRMED" ? machineProposalSnapshot(metadata) : null,
          evaluationDate,
          requirementVersion,
          evaluationVendorType: evaluationContext.evaluationVendorType,
          evaluatedRuleset: evaluationContext.evaluatedRuleset,
          sourceDocumentPageCount: stored.pageCount,
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
      publishDomainEvent(input.database, {
        organizationId: repository.organizationId,
        type: "certificate.submitted",
        resourceType: "certificate",
        resourceId: certificate.id,
        data: {
          vendorId: input.vendorId,
          documentId: document.id,
          reviewStatus: metadata.reviewStatus,
          submissionChannel: input.uploadLinkId
            ? "vendor_upload_link"
            : input.submittedByServiceAccountId
              ? "api"
              : "staff",
        },
        actorType: input.uploadedByUserId
          ? "user"
          : input.submittedByServiceAccountId
            ? "service_account"
            : "system",
        actorId: input.uploadedByUserId ?? input.submittedByServiceAccountId,
        at: now.toISOString(),
      });
      if (metadata.reviewStatus === "CONFIRMED") {
        publishDomainEvent(input.database, {
          organizationId: repository.organizationId,
          type: "certificate.confirmed",
          resourceType: "certificate",
          resourceId: certificate.id,
          data: {
            vendorId: input.vendorId,
            documentId: document.id,
            requirementVersion,
            evaluationDate,
          },
          actorType: input.uploadedByUserId ? "user" : "system",
          actorId: input.uploadedByUserId,
          at: now.toISOString(),
        });
      }
      const result = {
        certificate: repository.getCertificate(certificate.id) as CertificateRow,
        document: repository.getDocument(document.id) as DocumentRow,
        requirementVersion,
        evaluationDate,
      };
      input.withinTransaction?.(result, repository);
      return result;
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
    const previousOpenCoi =
      storedExtraction._opencoi && typeof storedExtraction._opencoi === "object"
        ? (storedExtraction._opencoi as Record<string, unknown>)
        : {};
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
    assertEvidenceWithinSourceDocument(metadata, trustedPageCountFromExtraction(storedExtraction));
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
    const evaluationContext = persistEvaluation(
      input.database,
      repository,
      certificate,
      metadata,
      evaluationDate,
    );
    const { requirementVersion } = evaluationContext;
    const immutableMachineProposal =
      previousOpenCoi.machineProposal &&
      typeof previousOpenCoi.machineProposal === "object" &&
      !Array.isArray(previousOpenCoi.machineProposal)
        ? previousOpenCoi.machineProposal
        : machineProposalSnapshot(storedExtraction);
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
          machineProposal: immutableMachineProposal,
          evaluationDate,
          requirementVersion,
          evaluationVendorType: evaluationContext.evaluationVendorType,
          evaluatedRuleset: evaluationContext.evaluatedRuleset,
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
    publishDomainEvent(input.database, {
      organizationId: repository.organizationId,
      type: "certificate.confirmed",
      resourceType: "certificate",
      resourceId: certificate.id,
      data: {
        vendorId: certificate.vendor_id,
        documentId: document.id,
        requirementVersion,
        evaluationDate,
        correctedFields,
      },
      actorType: "user",
      actorId: input.reviewerUserId,
      at: now.toISOString(),
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
    publishDomainEvent(input.database, {
      organizationId: repository.organizationId,
      type: "certificate.rejected",
      resourceType: "certificate",
      resourceId: certificate.id,
      data: { vendorId: certificate.vendor_id, documentId: document.id },
      actorType: "user",
      actorId: input.reviewerUserId,
      at,
    });
    return {
      certificate: repository.getCertificate(certificate.id) as CertificateRow,
      document: repository.getDocument(document.id) as DocumentRow,
      rejectedAt: at,
    };
  });
