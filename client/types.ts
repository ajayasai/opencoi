import type { EndorsementEvidenceLevel, LimitType } from "@shared/domain";

export type UserRole = "owner" | "admin" | "reviewer" | "viewer";

export interface SessionUser {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  email: string;
  role: UserRole;
  csrfToken: string;
}

export type DocumentCheckStatus =
  | "meets"
  | "deficient"
  | "needs_review"
  | "approved_exception"
  | "not_submitted";

export type LifecycleStatus = "current" | "expiring" | "expired" | "future" | "unknown";

export interface CoverageRequirement {
  id?: string;
  coverageType: string;
  label: string;
  required: boolean;
  minimumEachOccurrence?: number | null;
  minimumAggregate?: number | null;
  currency: string;
  requiredEndorsements: string[];
  endorsementEvidence: "indicated" | "document" | "reviewed_document";
  expirationWarningDays: number;
}

export interface VendorType {
  id: string;
  name: string;
  description: string;
  version: number;
  vendorCount: number;
  requirementCount: number;
  publishedAt?: string | null;
  requirements?: CoverageRequirement[];
}

export interface VendorSummary {
  id: string;
  legalName: string;
  dbaName?: string | null;
  contactName?: string | null;
  contactEmail: string;
  vendorTypeId: string;
  vendorTypeName: string;
  externalReference?: string | null;
  status: DocumentCheckStatus;
  lifecycleStatus: LifecycleStatus;
  nextExpiration?: string | null;
  reminderExpiration?: string | null;
  expirationWarningDays: number;
  reminderEligible: boolean;
  openFindings: number;
  updatedAt: string;
}

export interface ReminderRecord {
  id: string;
  vendorId: string;
  vendorName: string;
  certificateId?: string | null;
  type: "renewal" | "expiration" | "deficiency" | "exception_expiration";
  channel: "email" | "in_app";
  recipient?: string | null;
  scheduledFor: string;
  status: "pending" | "processing" | "sent" | "cancelled" | "failed";
  attemptCount: number;
  lastAttemptAt?: string | null;
  sentAt?: string | null;
  error?: string | null;
  retryEligible: boolean;
  nextAttemptAt?: string | null;
  createdAt: string;
}

export interface ReminderRunResult {
  organizations: number;
  created: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface PolicyRecord {
  id?: string;
  coverageType: string;
  insurer: string;
  policyNumber: string;
  effectiveDate: string;
  expirationDate: string;
  eachOccurrence?: number | null;
  aggregate?: number | null;
  limits: Partial<Record<LimitType, number>>;
  currency: string;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  primaryNoncontributory: boolean;
  endorsements: Array<{
    name: string;
    formCode?: string | null;
    evidenceLevel: EndorsementEvidenceLevel;
    evidence: "indicated" | "document" | "reviewed_document";
  }>;
}

export interface CertificateCorrectionInput {
  namedInsured: string;
  issueDate: string | null;
  producer: string | null;
  certificateHolder: string | null;
  policies: Array<{
    coverageType: string;
    insurer: string | null;
    policyNumber: string | null;
    effectiveDate: string | null;
    expirationDate: string | null;
    limits: Partial<Record<LimitType, number>>;
    endorsements: Array<{
      name: string;
      formCode?: string;
      evidenceLevel: EndorsementEvidenceLevel;
    }>;
  }>;
}

export interface FindingRecord {
  id: string;
  ruleCode: string;
  coverageType: string;
  outcome: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
  severity: "blocking" | "warning" | "info";
  reasonCode: string;
  message: string;
  expected?: string | null;
  observed?: string | null;
  excepted: boolean;
}

export interface CertificateRecord {
  id: string;
  vendorId: string;
  originalFilename: string;
  sha256: string;
  documentStatus: "pending_review" | "confirmed" | "superseded" | "rejected";
  checkStatus: DocumentCheckStatus;
  lifecycleStatus: LifecycleStatus;
  issueDate?: string | null;
  namedInsured: string;
  producer?: string | null;
  certificateHolder?: string | null;
  uploadedAt: string;
  confirmedAt?: string | null;
  requirementVersion?: number | null;
  evaluationDate?: string | null;
  reviewDecision?: {
    status?: "REJECTED";
    reason?: string;
    reviewedAt?: string;
  } | null;
  policies: PolicyRecord[];
  findings: FindingRecord[];
}

export interface VendorDetail extends VendorSummary {
  contactPhone?: string | null;
  notes?: string | null;
  certificates: CertificateRecord[];
  activeUploadLinks: Array<{
    id: string;
    expiresAt: string;
    createdAt: string;
    useCount: number;
  }>;
}

export interface DashboardData {
  stats: {
    totalVendors: number;
    meets: number;
    deficient: number;
    needsReview: number;
    expiring: number;
  };
  actionQueue: Array<{
    id: string;
    kind: "review" | "deficiency" | "expiration" | "exception";
    vendorId: string;
    vendorName: string;
    title: string;
    detail: string;
    dueAt?: string | null;
    priority: "high" | "medium" | "low";
  }>;
  recentActivity: Array<{
    id: string;
    action: string;
    actor: string;
    target: string;
    createdAt: string;
  }>;
}

export interface ExceptionRecord {
  id: string;
  vendorId: string;
  vendorName: string;
  findingId: string;
  ruleCode: string;
  coverageType: string;
  reason: string;
  compensatingControls?: string | null;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "revoked" | "expired";
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionReason?: string | null;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityLabel: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  chainValid?: boolean;
}

export interface PublicUploadContext {
  organizationName: string;
  vendorName: string;
  expiresAt: string;
  requirements: Array<{
    coverageType: string;
    label: string;
    summary: string;
  }>;
}
