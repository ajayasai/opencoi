/**
 * Pure domain primitives shared by the API and browser application.
 *
 * A compliance result in OpenCOI is deliberately document scoped. It says what
 * an uploaded certificate demonstrates; it never asserts that an insurer still
 * considers a policy active.
 */

export const FINDING_STATUSES = ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const DOCUMENT_COMPLIANCE_LABELS = [
  "DOCUMENT_COMPLIANT",
  "DOCUMENT_NON_COMPLIANT",
  "DOCUMENT_REVIEW_REQUIRED",
  "DOCUMENT_NOT_APPLICABLE",
] as const;
export type DocumentComplianceLabel = (typeof DOCUMENT_COMPLIANCE_LABELS)[number];

export const DOCUMENT_SCOPE = "UPLOADED_DOCUMENT" as const;
export type DocumentScope = typeof DOCUMENT_SCOPE;

export const DOCUMENT_SCOPE_DISCLAIMER =
  "This result compares the uploaded document with configured requirements. " +
  "It does not verify that a policy is currently active in an insurer's system.";

export const COVERAGE_TYPES = [
  "COMMERCIAL_GENERAL_LIABILITY",
  "AUTOMOBILE_LIABILITY",
  "WORKERS_COMPENSATION",
  "EMPLOYERS_LIABILITY",
  "UMBRELLA_EXCESS_LIABILITY",
  "PROFESSIONAL_LIABILITY",
  "CYBER_LIABILITY",
  "POLLUTION_LIABILITY",
  "PROPERTY",
  "OTHER",
] as const;
export type CoverageType = (typeof COVERAGE_TYPES)[number];

export const LIMIT_TYPES = [
  "EACH_OCCURRENCE",
  "DAMAGE_TO_RENTED_PREMISES",
  "MEDICAL_EXPENSE",
  "PERSONAL_ADVERTISING_INJURY",
  "GENERAL_AGGREGATE",
  "PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE",
  "COMBINED_SINGLE_LIMIT",
  "BODILY_INJURY_PER_PERSON",
  "BODILY_INJURY_PER_ACCIDENT",
  "PROPERTY_DAMAGE_PER_ACCIDENT",
  "EACH_ACCIDENT",
  "DISEASE_EACH_EMPLOYEE",
  "DISEASE_POLICY_LIMIT",
  "EACH_CLAIM",
  "AGGREGATE",
] as const;
export type LimitType = (typeof LIMIT_TYPES)[number];

export const ENDORSEMENT_EVIDENCE_LEVELS = [
  "NONE",
  "MENTIONED",
  "SCHEDULED",
  "ATTACHED",
  "HUMAN_VERIFIED",
] as const;
export type EndorsementEvidenceLevel = (typeof ENDORSEMENT_EVIDENCE_LEVELS)[number];

export const ENDORSEMENT_EVIDENCE_RANK: Readonly<Record<EndorsementEvidenceLevel, number>> = {
  NONE: 0,
  MENTIONED: 1,
  SCHEDULED: 2,
  ATTACHED: 3,
  HUMAN_VERIFIED: 4,
};

export const CONFIRMATION_STATUSES = ["UNCONFIRMED", "CONFIRMED"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const EVIDENCE_SOURCES = ["OCR", "MANUAL", "IMPORT"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

declare const moneyMinorBrand: unique symbol;
/** Integer currency minor units (for example, cents for USD). */
export type MoneyMinor = number & { readonly [moneyMinorBrand]: "MoneyMinor" };

declare const isoDateBrand: unique symbol;
/** A real Gregorian calendar date serialized as YYYY-MM-DD. */
export type IsoDate = string & { readonly [isoDateBrand]: "IsoDate" };

export function moneyMinor(value: number): MoneyMinor {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Money must be a non-negative safe integer in minor units.");
  }
  return value as MoneyMinor;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new TypeError(`Invalid ISO calendar date: ${value}`);
  }
  return value;
}

/** Converts a validated ISO date to an integer day, avoiding local-time behavior. */
export function isoDateToEpochDay(value: IsoDate): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Math.trunc(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function addIsoDateDays(value: IsoDate, days: number): IsoDate {
  if (!Number.isSafeInteger(days)) throw new TypeError("Date offset must be a safe integer.");
  const date = new Date((isoDateToEpochDay(value) + days) * 86_400_000);
  return isoDate(date.toISOString().slice(0, 10));
}

export interface EvidenceField<T> {
  readonly value: T;
  readonly confirmation: ConfirmationStatus;
  readonly source: EvidenceSource;
  /** Integer basis points from 0 through 10,000. Primarily useful for OCR review UI. */
  readonly confidenceBps?: number;
  readonly rawText?: string;
  readonly page?: number;
}

export function evidenceField<T>(
  value: T,
  options: Omit<EvidenceField<T>, "value">,
): EvidenceField<T> {
  if (
    options.confidenceBps !== undefined &&
    (!Number.isInteger(options.confidenceBps) ||
      options.confidenceBps < 0 ||
      options.confidenceBps > 10_000)
  ) {
    throw new TypeError("Evidence confidence must be integer basis points from 0 to 10,000.");
  }
  if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1)) {
    throw new TypeError("Evidence page must be a positive integer.");
  }
  return { value, ...options };
}

export interface CoiPolicyFacts {
  readonly id: string;
  readonly coverageType: EvidenceField<CoverageType>;
  readonly insurerName?: EvidenceField<string>;
  readonly policyNumber?: EvidenceField<string>;
  readonly effectiveDate?: EvidenceField<IsoDate>;
  readonly expirationDate?: EvidenceField<IsoDate>;
  readonly limits: Readonly<Partial<Record<LimitType, EvidenceField<MoneyMinor>>>>;
}

export interface CoiEndorsementEvidence {
  readonly id: string;
  readonly formCode?: EvidenceField<string>;
  readonly name?: EvidenceField<string>;
  readonly evidenceLevel: EvidenceField<EndorsementEvidenceLevel>;
  /**
   * Exact, one-based pages in the uploaded PDF package that a person identified
   * as supporting this endorsement record. OCR citations remain separate.
   */
  readonly sourcePages?: readonly number[];
}

export interface CoiDocumentFacts {
  readonly id: string;
  /** Set to CONFIRMED only after a person has reviewed the extraction as a whole. */
  readonly reviewStatus: ConfirmationStatus;
  readonly namedInsured?: EvidenceField<string>;
  readonly certificateHolder?: EvidenceField<string>;
  readonly policies: readonly CoiPolicyFacts[];
  readonly endorsements: readonly CoiEndorsementEvidence[];
}

export const FINDING_CATEGORIES = [
  "RULE_PROFILE",
  "COVERAGE",
  "POLICY_FIELD",
  "POLICY_PERIOD",
  "LIMIT",
  "ENDORSEMENT",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface ComplianceFinding {
  readonly id: string;
  readonly requirementId: string;
  readonly category: FindingCategory;
  readonly status: FindingStatus;
  readonly code: string;
  readonly title: string;
  /** A deterministic, human-readable reason for the status. */
  readonly explanation: string;
  readonly expected?: Readonly<Record<string, unknown>>;
  readonly observed?: Readonly<Record<string, unknown>>;
  readonly evidenceIds: readonly string[];
}

export const EXCEPTION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "REVOKED"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/**
 * Workflow metadata kept separate from base rule findings. An approved exception
 * does not rewrite a FAIL into a PASS or change the document compliance label.
 */
export interface ComplianceException {
  readonly id: string;
  readonly findingIds: readonly string[];
  readonly status: ExceptionStatus;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedOn: IsoDate;
  readonly decidedBy?: string;
  readonly decidedOn?: IsoDate;
  readonly expiresOn?: IsoDate;
}

export interface DocumentComplianceEvaluation {
  readonly scope: DocumentScope;
  readonly disclaimer: typeof DOCUMENT_SCOPE_DISCLAIMER;
  readonly documentId: string;
  readonly rulesetId: string;
  readonly vendorTypeId: string;
  readonly evaluationDate: IsoDate;
  readonly label: DocumentComplianceLabel;
  readonly findings: readonly ComplianceFinding[];
  /** Exceptions are echoed for display only and never influence findings or label. */
  readonly exceptions: readonly ComplianceException[];
}

export function deriveDocumentComplianceLabel(
  findings: readonly Pick<ComplianceFinding, "status">[],
): DocumentComplianceLabel {
  if (findings.some((finding) => finding.status === "FAIL")) {
    return "DOCUMENT_NON_COMPLIANT";
  }
  if (findings.some((finding) => finding.status === "UNKNOWN")) {
    return "DOCUMENT_REVIEW_REQUIRED";
  }
  if (findings.some((finding) => finding.status === "PASS")) {
    return "DOCUMENT_COMPLIANT";
  }
  return "DOCUMENT_NOT_APPLICABLE";
}
