import { type EndorsementEvidenceLevel, LIMIT_TYPES, type LimitType } from "../../shared/domain.js";
import { auditActorLabel } from "../audit.js";
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

interface VendorSummaryAggregateRow {
  id: string;
  legal_name: string;
  trade_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  external_reference: string | null;
  vendor_status: VendorRow["status"];
  vendor_type_id: string;
  vendor_type_name: string;
  vendor_updated_at: string;
  certificate_id: string | null;
  confirmation_status: string | null;
  compliance_status: string | null;
  certificate_updated_at: string | null;
  certificate_effective_date: string | null;
  certificate_expiration_date: string | null;
  reminder_certificate_id: string | null;
  reminder_expiration_date: string | null;
  open_findings: number;
  active_exceptions: number;
  unexcepted_failures: number;
  expiration_warning_days: number;
}

const aggregateCheckStatus = (row: VendorSummaryAggregateRow): CheckStatus => {
  if (!row.certificate_id) return "not_submitted";
  if (row.confirmation_status === "draft" || row.compliance_status === "pending_review") {
    return "needs_review";
  }
  if (row.compliance_status === "compliant") return "meets";
  if (row.compliance_status === "exception") return "approved_exception";
  if (row.active_exceptions > 0 && row.unexcepted_failures === 0) return "approved_exception";
  return "deficient";
};

const aggregateLifecycle = (row: VendorSummaryAggregateRow, today: string): LifecycleStatus => {
  if (!row.certificate_id || !row.certificate_expiration_date) return "unknown";
  if (row.certificate_effective_date && row.certificate_effective_date > today) return "future";
  if (row.certificate_expiration_date < today) return "expired";
  const warning = new Date(`${today}T00:00:00.000Z`);
  warning.setUTCDate(warning.getUTCDate() + row.expiration_warning_days);
  return row.certificate_expiration_date <= warning.toISOString().slice(0, 10)
    ? "expiring"
    : "current";
};

export const listVendorSummaryViews = (
  database: OpenCoiDatabase,
  repository: OrganizationRepository,
  filters: VendorFilters = {},
  now = new Date(),
) => {
  const query = filters.q?.trim().toLowerCase();
  const at = now.toISOString();
  const today = at.slice(0, 10);
  const rows = database
    .prepare(
      `WITH ranked_certificates AS (
         SELECT c.*, d.uploaded_at,
                row_number() OVER (
                  PARTITION BY c.organization_id, c.vendor_id
                  ORDER BY d.uploaded_at DESC, c.id DESC
                ) AS recent_rank,
                CASE WHEN c.confirmation_status = 'confirmed' THEN
                  row_number() OVER (
                    PARTITION BY c.organization_id, c.vendor_id, c.confirmation_status
                    ORDER BY d.uploaded_at DESC, c.id DESC
                  )
                END AS confirmed_rank
         FROM certificates c
         JOIN documents d ON d.organization_id = c.organization_id AND d.id = c.document_id
         WHERE c.organization_id = ? AND c.confirmation_status <> 'rejected'
       ),
       latest AS (
         SELECT * FROM ranked_certificates WHERE recent_rank = 1
       ),
       latest_confirmed AS (
         SELECT * FROM ranked_certificates
         WHERE confirmation_status = 'confirmed' AND confirmed_rank = 1
       ),
       policy_dates AS (
         SELECT organization_id, certificate_id,
                min(effective_date) AS effective_date,
                min(expiration_date) AS expiration_date
         FROM policies WHERE organization_id = ?
         GROUP BY organization_id, certificate_id
       ),
       finding_counts AS (
         SELECT f.organization_id, f.certificate_id,
                sum(CASE WHEN f.status = 'open' AND f.evaluation_status IN ('FAIL', 'UNKNOWN')
                         THEN 1 ELSE 0 END) AS open_findings,
                sum(CASE WHEN f.status = 'open' AND f.evaluation_status = 'FAIL'
                          AND NOT EXISTS (
                            SELECT 1 FROM exceptions e
                            WHERE e.organization_id = f.organization_id AND e.finding_id = f.id
                              AND e.status = 'approved'
                              AND (e.expires_at IS NULL OR e.expires_at >= ?)
                          ) THEN 1 ELSE 0 END) AS unexcepted_failures
         FROM findings f WHERE f.organization_id = ?
         GROUP BY f.organization_id, f.certificate_id
       ),
       exception_counts AS (
         SELECT e.organization_id, f.certificate_id, count(*) AS active_exceptions
         FROM exceptions e
         JOIN findings f ON f.organization_id = e.organization_id AND f.id = e.finding_id
         WHERE e.organization_id = ? AND e.status = 'approved'
           AND (e.expires_at IS NULL OR e.expires_at >= ?)
         GROUP BY e.organization_id, f.certificate_id
       ),
       warning_days AS (
         SELECT organization_id, vendor_type_id,
                max(CASE
                  WHEN coalesce(json_extract(rule_config_json, '$.required'), 1) <> 0
                  THEN coalesce(json_extract(rule_config_json, '$.expirationWarningDays'), 30)
                  ELSE 0
                END) AS days
         FROM coverage_requirements
         WHERE organization_id = ? AND is_active = 1
         GROUP BY organization_id, vendor_type_id
       )
       SELECT v.id, v.legal_name, v.trade_name, v.contact_name, v.contact_email,
              v.external_reference, v.status AS vendor_status, v.vendor_type_id,
              vt.name AS vendor_type_name, v.updated_at AS vendor_updated_at,
              c.id AS certificate_id, c.confirmation_status, c.compliance_status,
              c.updated_at AS certificate_updated_at,
              coalesce(pd.effective_date, c.earliest_effective_date) AS certificate_effective_date,
              coalesce(pd.expiration_date, c.earliest_expiration_date) AS certificate_expiration_date,
              rc.id AS reminder_certificate_id,
              coalesce(rpd.expiration_date, rc.earliest_expiration_date) AS reminder_expiration_date,
              coalesce(fc.open_findings, 0) AS open_findings,
              coalesce(ec.active_exceptions, 0) AS active_exceptions,
              coalesce(fc.unexcepted_failures, 0) AS unexcepted_failures,
              coalesce(wd.days, 30) AS expiration_warning_days
       FROM vendors v
       JOIN vendor_types vt
         ON vt.organization_id = v.organization_id AND vt.id = v.vendor_type_id
       LEFT JOIN latest c ON c.organization_id = v.organization_id AND c.vendor_id = v.id
       LEFT JOIN policy_dates pd
         ON pd.organization_id = c.organization_id AND pd.certificate_id = c.id
       LEFT JOIN latest_confirmed rc
         ON rc.organization_id = v.organization_id AND rc.vendor_id = v.id
       LEFT JOIN policy_dates rpd
         ON rpd.organization_id = rc.organization_id AND rpd.certificate_id = rc.id
       LEFT JOIN finding_counts fc
         ON fc.organization_id = c.organization_id AND fc.certificate_id = c.id
       LEFT JOIN exception_counts ec
         ON ec.organization_id = c.organization_id AND ec.certificate_id = c.id
       LEFT JOIN warning_days wd
         ON wd.organization_id = v.organization_id AND wd.vendor_type_id = v.vendor_type_id
       WHERE v.organization_id = ?
         AND (? IS NULL OR v.vendor_type_id = ?)
         AND (
           ? IS NULL OR instr(lower(v.legal_name), ?) > 0 OR
           instr(lower(coalesce(v.trade_name, '')), ?) > 0 OR
           instr(lower(coalesce(v.contact_name, '')), ?) > 0 OR
           instr(lower(coalesce(v.contact_email, '')), ?) > 0 OR
           instr(lower(coalesce(v.external_reference, '')), ?) > 0
         )
       ORDER BY v.legal_name COLLATE NOCASE, v.id`,
    )
    .all(
      repository.organizationId,
      repository.organizationId,
      at,
      repository.organizationId,
      repository.organizationId,
      at,
      repository.organizationId,
      repository.organizationId,
      filters.type && filters.type !== "all" ? filters.type : null,
      filters.type && filters.type !== "all" ? filters.type : null,
      query ?? null,
      query ?? "",
      query ?? "",
      query ?? "",
      query ?? "",
      query ?? "",
    ) as unknown as VendorSummaryAggregateRow[];
  return rows
    .map((row) => ({
      id: row.id,
      legalName: row.legal_name,
      dbaName: row.trade_name,
      contactName: row.contact_name,
      contactEmail: row.contact_email ?? "",
      vendorTypeId: row.vendor_type_id,
      vendorTypeName: row.vendor_type_name,
      externalReference: row.external_reference,
      status: aggregateCheckStatus(row),
      lifecycleStatus: aggregateLifecycle(row, today),
      nextExpiration: row.certificate_expiration_date,
      reminderExpiration: row.reminder_expiration_date,
      expirationWarningDays: row.expiration_warning_days,
      reminderEligible: row.vendor_status === "active" && row.reminder_expiration_date !== null,
      openFindings: row.open_findings,
      updatedAt: row.certificate_updated_at ?? row.vendor_updated_at,
    }))
    .filter(
      (vendor) =>
        (!filters.check || filters.check === "all" || vendor.status === filters.check) &&
        (!filters.document ||
          filters.document === "all" ||
          vendor.lifecycleStatus === filters.document),
    );
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

const canonicalSourcePages = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  if (
    value.some(
      (page, index) =>
        !Number.isSafeInteger(page) ||
        Number(page) < 1 ||
        Number(page) > 100 ||
        (index > 0 && Number(value[index - 1]) >= Number(page)),
    )
  ) {
    return undefined;
  }
  return value.map(Number);
};

const policyView = (row: PolicyRow) => {
  const metadata = parseJson<{
    limits?: Record<string, number>;
    endorsements?: Array<{
      name: string;
      formCode?: string;
      evidenceLevel?: EndorsementEvidenceLevel;
      sourcePages?: number[];
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
    endorsements: (metadata.endorsements ?? []).map((endorsement) => {
      const sourcePages = canonicalSourcePages(endorsement.sourcePages);
      return {
        name: endorsement.name,
        formCode: endorsement.formCode ?? null,
        evidenceLevel: endorsement.evidenceLevel ?? "MENTIONED",
        ...(sourcePages ? { sourcePages } : {}),
        evidence:
          endorsement.evidenceLevel === "HUMAN_VERIFIED"
            ? "reviewed_document"
            : endorsement.evidenceLevel === "ATTACHED" || endorsement.evidenceLevel === "SCHEDULED"
              ? "document"
              : "indicated",
      };
    }),
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
    pages?: Array<{ page?: number }>;
    certificateHolder?: string | null;
    provenance?: Array<{
      field?: string;
      extractedValue?: string | number;
      policyIndex?: number;
      endorsementIndex?: number;
      limitType?: string;
      source?: "OCR";
      confidenceBps?: number;
      rawText?: string;
      page?: number;
    }>;
    _opencoi?: {
      evaluationDate?: string;
      requirementVersion?: number | null;
      sourceDocumentPageCount?: number;
      evaluationVendorType?: { id?: string; name?: string };
      evaluatedRuleset?: unknown;
      reviewDecision?: {
        status?: "REJECTED";
        reason?: string;
        reviewedAt?: string;
      };
    };
  }>(row.extraction_json, {});
  const sourceDocumentPageCount =
    Number.isSafeInteger(extraction._opencoi?.sourceDocumentPageCount) &&
    Number(extraction._opencoi?.sourceDocumentPageCount) >= 1 &&
    Number(extraction._opencoi?.sourceDocumentPageCount) <= 100
      ? Number(extraction._opencoi?.sourceDocumentPageCount)
      : null;
  const humanConfirmed = ["confirmed", "superseded"].includes(row.confirmation_status);
  const projectedPolicies = policies.map(policyView);
  const extractionEvidence = (extraction.provenance ?? [])
    .filter(
      (citation) =>
        typeof citation.field === "string" &&
        citation.source === "OCR" &&
        typeof citation.rawText === "string" &&
        citation.rawText.length > 0 &&
        Number.isSafeInteger(citation.page) &&
        Number(citation.page) > 0,
    )
    .map((citation) => ({
      kind: "extraction_citation" as const,
      field: citation.field as string,
      extractedValue: citation.extractedValue ?? "",
      policyIndex: citation.policyIndex ?? null,
      endorsementIndex: citation.endorsementIndex ?? null,
      limitType: citation.limitType ?? null,
      confidenceBps: citation.confidenceBps ?? null,
      rawText: citation.rawText as string,
      page: citation.page as number,
      origin: "client_submitted_extraction" as const,
      attestationStatus:
        humanConfirmed &&
        sourceDocumentPageCount !== null &&
        Number(citation.page) <= sourceDocumentPageCount
          ? ("reviewer_attested" as const)
          : ("unverified" as const),
    }));
  const endorsementPageEvidence = projectedPolicies.flatMap((policy, policyIndex) =>
    policy.endorsements.flatMap((endorsement, endorsementIndex) =>
      humanConfirmed &&
      sourceDocumentPageCount !== null &&
      endorsement.sourcePages?.length &&
      endorsement.sourcePages.every((page) => page <= sourceDocumentPageCount)
        ? [
            {
              kind: "endorsement_page_attestation" as const,
              policyIndex,
              endorsementIndex,
              endorsementName: endorsement.name,
              formCode: endorsement.formCode,
              evidenceLevel: endorsement.evidenceLevel,
              sourcePages: endorsement.sourcePages,
              sourceDocumentSha256: row.sha256,
              origin: "submitted_endorsement_page_reference" as const,
              attestationStatus: "reviewer_attested" as const,
              attestedByUserId: row.confirmed_by_user_id,
              attestedAt: row.confirmed_at,
            },
          ]
        : [],
    ),
  );
  const evidence = [...extractionEvidence, ...endorsementPageEvidence];
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
    pageCount: sourceDocumentPageCount,
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
    evaluationVendorType:
      typeof extraction._opencoi?.evaluationVendorType?.id === "string" &&
      typeof extraction._opencoi.evaluationVendorType.name === "string"
        ? {
            id: extraction._opencoi.evaluationVendorType.id,
            name: extraction._opencoi.evaluationVendorType.name,
          }
        : null,
    evaluatedRuleset: extraction._opencoi?.evaluatedRuleset ?? null,
    evaluationDate: extraction._opencoi?.evaluationDate ?? null,
    reviewDecision: extraction._opencoi?.reviewDecision ?? null,
    evidence,
    policies: projectedPolicies,
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
      `SELECT a.*, u.display_name, sa.name AS service_account_name
       FROM audit_events a
       LEFT JOIN users u ON u.organization_id = a.organization_id AND u.id = a.actor_user_id
       LEFT JOIN service_accounts sa
         ON sa.organization_id = a.organization_id
        AND sa.id = json_extract(a.metadata_json, '$.serviceAccountId')
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
      actor: auditActorLabel(
        {
          actor_type: String(row.actor_type) as "user" | "vendor" | "system",
          actor_user_id: typeof row.actor_user_id === "string" ? row.actor_user_id : null,
          metadata_json: String(row.metadata_json),
        },
        {
          userName: typeof row.display_name === "string" ? row.display_name : undefined,
          serviceAccountName:
            typeof row.service_account_name === "string" ? row.service_account_name : undefined,
        },
      ),
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
