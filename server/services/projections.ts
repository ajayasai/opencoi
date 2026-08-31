import { type EndorsementEvidenceLevel, LIMIT_TYPES, type LimitType } from "../../shared/domain.js";
import type {
  CertificateRow,
  DocumentRow,
  FindingRow,
  OpenCoiDatabase,
  OrganizationRepository,
  PolicyRow,
  UploadLinkRow,
  VendorRow,
  VendorTypeRow,
} from "../db.js";

type CheckStatus = "meets" | "deficient" | "needs_review" | "approved_exception" | "not_submitted";
type LifecycleStatus = "current" | "expiring" | "expired" | "future" | "unknown";

interface RequirementConfig {
  version?: number;
  label?: string;
  required?: boolean;
  currency?: string;
  endorsementEvidence?: "indicated" | "document" | "reviewed_document";
  expirationWarningDays?: number;
  publishedAt?: string;
}

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const humanize = (value: string): string =>
  value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());

export const requirementViews = (repository: OrganizationRepository, vendorTypeId: string) =>
  repository.listCoverageRequirements(vendorTypeId).map((row) => {
    const config = parseJson<RequirementConfig>(String(row.rule_config_json ?? "{}"), {});
    return {
      id: String(row.id),
      coverageType: String(row.coverage_type),
      label: config.label || humanize(String(row.coverage_type)),
      required: config.required !== false,
      minimumEachOccurrence: (row.minimum_each_occurrence as number | null) ?? null,
      minimumAggregate: (row.minimum_aggregate as number | null) ?? null,
      currency: config.currency ?? "USD",
      requiredEndorsements: parseJson<string[]>(String(row.required_endorsements_json ?? "[]"), []),
      endorsementEvidence: config.endorsementEvidence ?? "indicated",
      expirationWarningDays: config.expirationWarningDays ?? 30,
    };
  });

export const expirationWarningDaysFor = (
  repository: OrganizationRepository,
  vendorTypeId: string,
): number => {
  const days = requirementViews(repository, vendorTypeId)
    .filter((requirement) => requirement.required)
    .map((requirement) => requirement.expirationWarningDays);
  return days.length ? Math.max(...days) : 30;
};

export const vendorTypeView = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  row: VendorTypeRow,
) => {
  const requirements = requirementViews(repository, row.id);
  const configs = repository
    .listCoverageRequirements(row.id)
    .map((requirement) =>
      parseJson<RequirementConfig>(String(requirement.rule_config_json ?? "{}"), {}),
    );
  const count = database
    .prepare(
      "SELECT count(*) AS count FROM vendors WHERE organization_id = ? AND vendor_type_id = ? AND status != 'archived'",
    )
    .get(repository.organizationId, row.id) as { count: number };
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    version: configs.length ? Math.max(...configs.map((config) => config.version ?? 1)) : 0,
    vendorCount: count.count,
    requirementCount: requirements.length,
    publishedAt:
      configs
        .map((config) => config.publishedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
    requirements,
  };
};

const lifecycleFor = (
  certificate: CertificateRow | null,
  policies: readonly PolicyRow[],
  today: string,
  warningDays = 30,
): LifecycleStatus => {
  if (!certificate) return "unknown";
  const effectiveDates = policies
    .map((policy) => policy.effective_date)
    .filter((value): value is string => Boolean(value))
    .sort();
  const expirationDates = policies
    .map((policy) => policy.expiration_date)
    .filter((value): value is string => Boolean(value))
    .sort();
  const expiration = expirationDates[0] ?? certificate.earliest_expiration_date;
  if (!expiration) return "unknown";
  if (effectiveDates.length > 0 && (effectiveDates[0] as string) > today) return "future";
  if (expiration < today) return "expired";
  const warning = new Date(`${today}T00:00:00.000Z`);
  warning.setUTCDate(warning.getUTCDate() + warningDays);
  return expiration <= warning.toISOString().slice(0, 10) ? "expiring" : "current";
};

const activeExceptionCount = (
  database: OpenCoiDatabase,
  organizationId: string,
  certificateId: string,
  at: string,
): number => {
  const row = database
    .prepare(
      `SELECT count(*) AS count
       FROM exceptions e
       JOIN findings f ON f.organization_id = e.organization_id AND f.id = e.finding_id
       WHERE e.organization_id = ? AND f.certificate_id = ? AND e.status = 'approved'
         AND (e.expires_at IS NULL OR e.expires_at >= ?)`,
    )
    .get(organizationId, certificateId, at) as { count: number };
  return row.count;
};

const checkFor = (
  database: OpenCoiDatabase,
  organizationId: string,
  certificate: CertificateRow | null,
  at: string,
): CheckStatus => {
  if (!certificate) return "not_submitted";
  if (
    certificate.confirmation_status === "draft" ||
    certificate.compliance_status === "pending_review"
  ) {
    return "needs_review";
  }
  if (certificate.compliance_status === "compliant") return "meets";
  if (certificate.compliance_status === "exception") return "approved_exception";
  if (activeExceptionCount(database, organizationId, certificate.id, at) > 0) {
    const failures = database
      .prepare(
        `SELECT count(*) AS count FROM findings f
         WHERE f.organization_id = ? AND f.certificate_id = ? AND f.evaluation_status = 'FAIL'
           AND f.status = 'open' AND NOT EXISTS (
             SELECT 1 FROM exceptions e
             WHERE e.organization_id = f.organization_id AND e.finding_id = f.id
               AND e.status = 'approved' AND (e.expires_at IS NULL OR e.expires_at >= ?)
           )`,
      )
      .get(organizationId, certificate.id, at) as { count: number };
    if (failures.count === 0) return "approved_exception";
  }
  return "deficient";
};

interface LatestCertificateJoin extends CertificateRow {
  original_filename: string;
  sha256: string;
  processing_status: string;
  extraction_json: string | null;
  uploaded_at: string;
  storage_key: string;
}

const latestCertificate = (
  database: OpenCoiDatabase,
  organizationId: string,
  vendorId: string,
): LatestCertificateJoin | null =>
  (database
    .prepare(
      `SELECT c.*, d.original_filename, d.sha256, d.processing_status,
              d.extraction_json, d.uploaded_at, d.storage_key
       FROM certificates c
       JOIN documents d ON d.organization_id = c.organization_id AND d.id = c.document_id
       WHERE c.organization_id = ? AND c.vendor_id = ?
         AND c.confirmation_status != 'rejected'
       ORDER BY d.uploaded_at DESC, c.id DESC LIMIT 1`,
    )
    .get(organizationId, vendorId) as unknown as LatestCertificateJoin | undefined) ?? null;

const latestConfirmedCertificate = (
  database: OpenCoiDatabase,
  organizationId: string,
  vendorId: string,
): LatestCertificateJoin | null =>
  (database
    .prepare(
      `SELECT c.*, d.original_filename, d.sha256, d.processing_status,
              d.extraction_json, d.uploaded_at, d.storage_key
       FROM certificates c
       JOIN documents d ON d.organization_id = c.organization_id AND d.id = c.document_id
       WHERE c.organization_id = ? AND c.vendor_id = ? AND c.confirmation_status = 'confirmed'
       ORDER BY d.uploaded_at DESC, c.id DESC LIMIT 1`,
    )
    .get(organizationId, vendorId) as unknown as LatestCertificateJoin | undefined) ?? null;

export const vendorSummaryView = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  vendor: VendorRow,
  now = new Date(),
) => {
  const type = repository.getVendorType(vendor.vendor_type_id);
  const certificate = latestCertificate(database, repository.organizationId, vendor.id);
  const policies = certificate ? repository.listPolicies(certificate.id) : [];
  const reminderCertificate = latestConfirmedCertificate(
    database,
    repository.organizationId,
    vendor.id,
  );
  const reminderPolicies = reminderCertificate
    ? repository.listPolicies(reminderCertificate.id)
    : [];
  const findings = certificate ? repository.listFindings(certificate.id) : [];
  const today = now.toISOString().slice(0, 10);
  const at = now.toISOString();
  const expirationWarningDays = expirationWarningDaysFor(repository, vendor.vendor_type_id);
  const expiration =
    policies
      .map((policy) => policy.expiration_date)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ??
    certificate?.earliest_expiration_date ??
    null;
  const reminderExpiration =
    reminderPolicies
      .map((policy) => policy.expiration_date)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ??
    reminderCertificate?.earliest_expiration_date ??
    null;
  return {
    id: vendor.id,
    legalName: vendor.legal_name,
    dbaName: vendor.trade_name,
    contactName: vendor.contact_name,
    contactEmail: vendor.contact_email ?? "",
    vendorTypeId: vendor.vendor_type_id,
    vendorTypeName: type?.name ?? "Unknown vendor type",
    externalReference: vendor.external_reference,
    status: checkFor(database, repository.organizationId, certificate, at),
    lifecycleStatus: lifecycleFor(certificate, policies, today, expirationWarningDays),
    nextExpiration: expiration,
    reminderExpiration,
    expirationWarningDays,
    reminderEligible: vendor.status === "active" && reminderExpiration !== null,
    openFindings: findings.filter(
      (finding) =>
        finding.status === "open" && ["FAIL", "UNKNOWN"].includes(finding.evaluation_status),
    ).length,
    updatedAt: certificate?.updated_at ?? vendor.updated_at,
  };
};

export interface VendorFilters {
  q?: string;
  type?: string;
  check?: string;
  document?: string;
}

export const listVendorSummaryViews = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  filters: VendorFilters = {},
  now = new Date(),
) => {
  const query = filters.q?.trim().toLowerCase();
  return repository
    .listVendors()
    .map((vendor) => vendorSummaryView(database, repository, vendor, now))
    .filter((vendor) => {
      if (
        query &&
        ![
          vendor.legalName,
          vendor.dbaName,
          vendor.contactName,
          vendor.contactEmail,
          vendor.externalReference,
        ].some((value) => value?.toLowerCase().includes(query))
      ) {
        return false;
      }
      if (filters.type && filters.type !== "all" && vendor.vendorTypeId !== filters.type)
        return false;
      if (filters.check && filters.check !== "all" && vendor.status !== filters.check) return false;
      if (
        filters.document &&
        filters.document !== "all" &&
        vendor.lifecycleStatus !== filters.document
      ) {
        return false;
      }
      return true;
    });
};

const findingView = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  row: FindingRow,
  at: string,
) => {
  const excepted = Boolean(
    database
      .prepare(
        `SELECT 1 FROM exceptions
         WHERE organization_id = ? AND finding_id = ? AND status = 'approved'
           AND (expires_at IS NULL OR expires_at >= ?) LIMIT 1`,
      )
      .get(repository.organizationId, row.id, at),
  );
  const stringify = (value: string | null): string | null => {
    if (!value) return null;
    const parsed = parseJson<unknown>(value, value);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  };
  return {
    id: row.id,
    ruleCode: row.code,
    coverageType: row.coverage_type ?? "",
    outcome: row.evaluation_status,
    severity:
      row.severity === "critical" ? "blocking" : row.severity === "warning" ? "warning" : "info",
    reasonCode: row.code,
    message: row.message,
    expected: stringify(row.expected_json),
    observed: stringify(row.actual_json),
    excepted,
  };
};

const policyView = (row: PolicyRow) => {
  const metadata = parseJson<{
    limits?: Record<string, number>;
    endorsements?: Array<{
      name: string;
      formCode?: string;
      evidenceLevel?: EndorsementEvidenceLevel;
    }>;
    currency?: string;
  }>(row.metadata_json, {});
  return {
    id: row.id,
    coverageType: row.coverage_type,
    insurer: row.insurer_name ?? "",
    policyNumber: row.policy_number ?? "",
    effectiveDate: row.effective_date ?? "",
    expirationDate: row.expiration_date ?? "",
    eachOccurrence: row.each_occurrence_limit,
    aggregate: row.aggregate_limit,
    limits: Object.fromEntries(
      Object.entries(metadata.limits ?? {}).filter(
        (entry): entry is [LimitType, number] =>
          (LIMIT_TYPES as readonly string[]).includes(entry[0]) &&
          Number.isInteger(entry[1]) &&
          entry[1] >= 0,
      ),
    ) as Partial<Record<LimitType, number>>,
    currency: metadata.currency ?? "USD",
    additionalInsured: row.additional_insured === 1,
    waiverOfSubrogation: row.waiver_of_subrogation === 1,
    primaryNoncontributory: row.primary_noncontributory === 1,
    endorsements: (metadata.endorsements ?? []).map((endorsement) => ({
      name: endorsement.name,
      formCode: endorsement.formCode ?? null,
      evidenceLevel: endorsement.evidenceLevel ?? "MENTIONED",
      evidence:
        endorsement.evidenceLevel === "HUMAN_VERIFIED"
          ? "reviewed_document"
          : endorsement.evidenceLevel === "ATTACHED" || endorsement.evidenceLevel === "SCHEDULED"
            ? "document"
            : "indicated",
    })),
  };
};

export const certificateView = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  certificateId: string,
  now = new Date(),
) => {
  const row = database
    .prepare(
      `SELECT c.*, d.original_filename, d.sha256, d.processing_status,
              d.extraction_json, d.uploaded_at, d.storage_key
       FROM certificates c
       JOIN documents d ON d.organization_id = c.organization_id AND d.id = c.document_id
       WHERE c.organization_id = ? AND c.id = ?`,
    )
    .get(repository.organizationId, certificateId) as unknown as LatestCertificateJoin | undefined;
  if (!row) return null;
  const policies = repository.listPolicies(row.id);
  const extraction = parseJson<{
    certificateHolder?: string | null;
    _opencoi?: {
      evaluationDate?: string;
      requirementVersion?: number | null;
      reviewDecision?: {
        status?: "REJECTED";
        reason?: string;
        reviewedAt?: string;
      };
    };
  }>(row.extraction_json, {});
  const vendor = repository.getVendor(row.vendor_id);
  const lifecycleStatus = lifecycleFor(
    row,
    policies,
    now.toISOString().slice(0, 10),
    vendor ? expirationWarningDaysFor(repository, vendor.vendor_type_id) : 30,
  );
  return {
    id: row.id,
    vendorId: row.vendor_id,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    documentStatus:
      row.confirmation_status === "superseded"
        ? "superseded"
        : row.confirmation_status === "rejected"
          ? "rejected"
          : row.confirmation_status === "confirmed"
            ? "confirmed"
            : "pending_review",
    checkStatus:
      row.confirmation_status === "rejected"
        ? "not_submitted"
        : checkFor(database, repository.organizationId, row, now.toISOString()),
    lifecycleStatus,
    issueDate: row.issued_on,
    namedInsured: row.insured_name ?? "",
    producer: row.producer_name,
    certificateHolder: extraction.certificateHolder ?? null,
    uploadedAt: row.uploaded_at,
    confirmedAt: row.confirmed_at,
    requirementVersion: extraction._opencoi?.requirementVersion ?? null,
    evaluationDate: extraction._opencoi?.evaluationDate ?? null,
    reviewDecision: extraction._opencoi?.reviewDecision ?? null,
    policies: policies.map(policyView),
    findings: repository
      .listFindings(row.id)
      .map((finding) => findingView(database, repository, finding, now.toISOString())),
  };
};

export const vendorDetailView = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  vendor: VendorRow,
  now = new Date(),
) => {
  const summary = vendorSummaryView(database, repository, vendor, now);
  const certificates = repository
    .listCertificatesForVendor(vendor.id)
    .map((certificate) => certificateView(database, repository, certificate.id, now))
    .filter((certificate): certificate is NonNullable<typeof certificate> => Boolean(certificate));
  const activeUploadLinks = database
    .prepare(
      `SELECT * FROM upload_links
       WHERE organization_id = ? AND vendor_id = ? AND revoked_at IS NULL AND expires_at > ?
         AND use_count < max_uses ORDER BY created_at DESC`,
    )
    .all(repository.organizationId, vendor.id, now.toISOString()) as unknown as UploadLinkRow[];
  return {
    ...summary,
    contactPhone: vendor.contact_phone,
    notes: vendor.notes,
    certificates,
    activeUploadLinks: activeUploadLinks.map((link) => ({
      id: link.id,
      expiresAt: link.expires_at,
      createdAt: link.created_at,
      useCount: link.use_count,
    })),
  };
};

export const dashboardView = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  now = new Date(),
) => {
  const vendors = listVendorSummaryViews(database, repository, {}, now);
  const actionQueue = vendors
    .filter(
      (vendor) =>
        vendor.status !== "meets" || ["expiring", "expired"].includes(vendor.lifecycleStatus),
    )
    .slice(0, 30)
    .map((vendor) => {
      const kind =
        vendor.status === "needs_review"
          ? "review"
          : vendor.status === "deficient"
            ? "deficiency"
            : vendor.status === "approved_exception"
              ? "exception"
              : "expiration";
      return {
        id: `${kind}:${vendor.id}`,
        kind,
        vendorId: vendor.id,
        vendorName: vendor.legalName,
        title:
          kind === "review"
            ? "Certificate needs human review"
            : kind === "deficiency"
              ? "Document does not meet requirements"
              : kind === "exception"
                ? "Approved exception is active"
                : "Document expiration is approaching",
        detail:
          vendor.openFindings > 0
            ? `${vendor.openFindings} open document finding${vendor.openFindings === 1 ? "" : "s"}`
            : `Document status: ${vendor.lifecycleStatus}`,
        dueAt: vendor.nextExpiration,
        priority:
          vendor.lifecycleStatus === "expired" || vendor.status === "deficient"
            ? "high"
            : vendor.status === "needs_review" || vendor.lifecycleStatus === "expiring"
              ? "medium"
              : "low",
      };
    });
  const recentRows = database
    .prepare(
      `SELECT a.*, u.display_name
       FROM audit_events a
       LEFT JOIN users u ON u.organization_id = a.organization_id AND u.id = a.actor_user_id
       WHERE a.organization_id = ? ORDER BY a.sequence_number DESC LIMIT 12`,
    )
    .all(repository.organizationId) as Array<Record<string, unknown>>;
  return {
    stats: {
      totalVendors: vendors.length,
      meets: vendors.filter((vendor) => vendor.status === "meets").length,
      deficient: vendors.filter((vendor) => vendor.status === "deficient").length,
      needsReview: vendors.filter((vendor) => vendor.status === "needs_review").length,
      expiring: vendors.filter((vendor) => vendor.lifecycleStatus === "expiring").length,
    },
    actionQueue,
    recentActivity: recentRows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      actor:
        typeof row.display_name === "string"
          ? row.display_name
          : row.actor_type === "vendor"
            ? "Vendor uploader"
            : "OpenCOI",
      target: `${String(row.entity_type)}${row.entity_id ? ` ${String(row.entity_id)}` : ""}`,
      createdAt: String(row.occurred_at),
    })),
  };
};

export const documentForDownload = (
  database: OpenCoiDatabase,
  organizationId: string,
  certificateId: string,
): DocumentRow | null =>
  (database
    .prepare(
      `SELECT d.* FROM documents d
       JOIN certificates c ON c.organization_id = d.organization_id AND c.document_id = d.id
       WHERE c.organization_id = ? AND c.id = ?`,
    )
    .get(organizationId, certificateId) as unknown as DocumentRow | undefined) ?? null;
