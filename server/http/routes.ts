import { randomUUID } from "node:crypto";
import { type Request, type RequestHandler, type Response, Router } from "express";
import multer from "multer";
import { z } from "zod";
import { buildComplianceStatusCsv } from "../../shared/csv.js";
import { appendAuditEvent, listAuditEvents, verifyAuditChain } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { OpenCoiDatabase, UserRow } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import {
  createSessionTokens,
  createUploadLinkToken,
  hashUploadLinkToken,
  verifyPassword,
  verifyPasswordOrDummy,
} from "../security.js";
import {
  certificateCorrectionSchema,
  certificateRejectionReasonSchema,
  confirmStoredCertificate,
  ingestCertificate,
  normalizeCoverageType,
  rejectStoredCertificate,
} from "../services/certificates.js";
import {
  certificateView,
  dashboardView,
  documentForDownload,
  listVendorSummaryViews,
  requirementViews,
  type VendorFilters,
  vendorDetailView,
  vendorTypeView,
} from "../services/projections.js";
import { listReminders, runReminderCycle } from "../services/reminders.js";
import type { DocumentStore } from "../storage.js";
import { attachmentContentDisposition } from "../storage.js";
import { asyncRoute, HttpError } from "./errors.js";
import {
  authContext,
  authenticate,
  csrfCookieName,
  csrfCookieOptions,
  enforceTrustedOrigin,
  rateLimit,
  requestAuditContext,
  requireCsrf,
  requireRole,
  sessionCookieOptions,
} from "./middleware.js";

export interface ApiDependencies {
  config: AppConfig;
  database: OpenCoiDatabase;
  documentStore: DocumentStore;
  now?: () => Date;
}

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();
const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(1_024),
  organizationSlug: z.string().trim().min(1).max(64).optional(),
});

const vendorCreateSchema = z.object({
  vendorTypeId: text(128),
  legalName: text(240),
  dbaName: nullableText(240),
  tradeName: nullableText(240),
  contactName: nullableText(200),
  contactEmail: z.string().trim().email().max(320).nullable().optional(),
  contactPhone: nullableText(100),
  externalReference: nullableText(200),
  notes: nullableText(10_000),
});

const vendorPatchSchema = vendorCreateSchema.partial().extend({
  status: z.enum(["active", "inactive", "archived"]).optional(),
});

const requirementSchema = z.object({
  id: z.string().trim().max(128).optional(),
  coverageType: text(100),
  label: text(200),
  required: z.boolean().default(true),
  minimumEachOccurrence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  minimumAggregate: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  currency: z.literal("USD").default("USD"),
  requiredEndorsements: z.array(text(300)).max(100).default([]),
  endorsementEvidence: z.enum(["indicated", "document", "reviewed_document"]).default("indicated"),
  expirationWarningDays: z.number().int().min(0).max(365).default(30),
});

const publishRequirementsSchema = z
  .object({ requirements: z.array(requirementSchema).min(1).max(50) })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.requirements.forEach((requirement, index) => {
      const key = requirement.coverageType.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "coverageType"],
          message: "Coverage types must be unique within a vendor type",
        });
      }
      seen.add(key);
    });
  });

const sessionUser = (user: UserRow, organizationName: string, csrfToken: string) => ({
  id: user.id,
  organizationId: user.organization_id,
  organizationName,
  name: user.display_name,
  email: user.email,
  role: user.role === "owner" ? "admin" : user.role,
  csrfToken,
});

const data = <T>(response: Response, value: T, status = 200): void => {
  response.status(status).json({ data: value });
};

const audit = (
  dependencies: ApiDependencies,
  request: Request,
  response: Response,
  input: { action: string; entityType: string; entityId?: string; metadata?: unknown },
): void => {
  const auth = authContext(response);
  appendAuditEvent(dependencies.database, auth.user.organization_id, {
    actorType: "user",
    actorUserId: auth.user.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
    ...requestAuditContext(request),
  });
};

const upload = (config: AppConfig) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: config.maxUploadBytes, fields: 5, fieldSize: 2_000_000 },
  }).single("document");

const tokenForOrganization = (organizationId: string, randomPart: string): string =>
  `v1.${Buffer.from(organizationId, "utf8").toString("base64url")}.${randomPart}`;

const organizationFromToken = (token: string): string | null => {
  const match = /^v1\.([A-Za-z0-9_-]{2,180})\.([A-Za-z0-9_-]{40,400})$/.exec(token);
  if (!match?.[1]) return null;
  try {
    const organizationId = Buffer.from(match[1], "base64url").toString("utf8");
    if (
      !organizationId ||
      organizationId.length > 128 ||
      Buffer.from(organizationId, "utf8").toString("base64url") !== match[1]
    ) {
      return null;
    }
    return organizationId;
  } catch {
    return null;
  }
};

const publicLinkContext = (dependencies: ApiDependencies, token: string, now: Date) => {
  const organizationId = organizationFromToken(token);
  if (!organizationId) throw new HttpError(404, "Upload link not found or no longer active");
  const repository = createOrganizationRepository(dependencies.database, organizationId);
  const link = repository.getActiveUploadLinkByHash(
    hashUploadLinkToken(token, dependencies.config.tokenPepper),
    now.toISOString(),
  );
  if (!link) throw new HttpError(404, "Upload link not found or no longer active");
  const vendor = repository.getVendor(link.vendor_id);
  const organization = repository.getOrganization();
  if (!vendor || !organization || vendor.status !== "active") {
    throw new HttpError(404, "Upload link not found or no longer active");
  }
  return { repository, link, vendor, organization };
};

const exceptionView = (
  database: OpenCoiDatabase,
  organizationId: string,
  id: string,
  now: Date,
) => {
  const row = database
    .prepare(
      `SELECT e.*, v.legal_name AS vendor_name, f.code AS rule_code,
              COALESCE(f.coverage_type, '') AS coverage_type,
              requester.display_name AS requested_by,
              decider.display_name AS decided_by
       FROM exceptions e
       JOIN vendors v ON v.organization_id = e.organization_id AND v.id = e.vendor_id
       LEFT JOIN findings f ON f.organization_id = e.organization_id AND f.id = e.finding_id
       JOIN users requester ON requester.organization_id = e.organization_id
         AND requester.id = e.requested_by_user_id
       LEFT JOIN users decider ON decider.organization_id = e.organization_id
         AND decider.id = e.decided_by_user_id
       WHERE e.organization_id = ? AND e.id = ?`,
    )
    .get(organizationId, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  let request: { reason?: string; compensatingControls?: string | null } = {};
  try {
    request = JSON.parse(String(row.request_reason)) as typeof request;
  } catch {
    request = { reason: String(row.request_reason) };
  }
  const expired =
    typeof row.expires_at === "string" && row.expires_at < now.toISOString().slice(0, 10);
  return {
    id: String(row.id),
    vendorId: String(row.vendor_id),
    vendorName: String(row.vendor_name),
    findingId: row.finding_id ? String(row.finding_id) : "",
    ruleCode: row.rule_code ? String(row.rule_code) : "",
    coverageType: String(row.coverage_type),
    reason: request.reason ?? String(row.request_reason),
    compensatingControls: request.compensatingControls ?? null,
    requestedBy: String(row.requested_by),
    requestedAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : "",
    status:
      expired && ["pending", "approved"].includes(String(row.status))
        ? "expired"
        : String(row.status),
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decisionReason: row.decision_note ? String(row.decision_note) : null,
  };
};

export const createApiRouter = (dependencies: ApiDependencies): Router => {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  const now = (): Date => dependencies.now?.() ?? new Date();
  const trustedOrigin = enforceTrustedOrigin(dependencies.config);
  const pdfUpload = upload(dependencies.config);

  router.post(
    "/auth/login",
    rateLimit({ windowMs: 15 * 60_000, max: 20, prefix: "login" }),
    trustedOrigin,
    asyncRoute(async (request, response) => {
      const input = loginSchema.parse(request.body);
      const candidates = dependencies.database
        .prepare(
          `SELECT u.*, o.name AS organization_name
           FROM users u JOIN organizations o ON o.id = u.organization_id
           WHERE u.email = ? COLLATE NOCASE AND u.status = 'active'
             AND (? IS NULL OR o.slug = ? COLLATE NOCASE)
           ORDER BY u.organization_id LIMIT 10`,
        )
        .all(
          input.email,
          input.organizationSlug ?? null,
          input.organizationSlug ?? null,
        ) as unknown as Array<UserRow & { organization_name: string }>;
      const matches: Array<UserRow & { organization_name: string }> = [];
      if (candidates.length === 0) {
        await verifyPasswordOrDummy(input.password);
      }
      for (const candidate of candidates) {
        if (await verifyPassword(input.password, candidate.password_hash)) matches.push(candidate);
      }
      if (matches.length !== 1) throw new HttpError(401, "Email or password is incorrect");
      const user = matches[0] as UserRow & { organization_name: string };
      const tokens = createSessionTokens(dependencies.config.tokenPepper);
      const at = now();
      const expiresAt = new Date(at.getTime() + dependencies.config.sessionTtlMs).toISOString();
      const repository = createOrganizationRepository(dependencies.database, user.organization_id);
      const session = repository.createSession({
        userId: user.id,
        tokenHash: tokens.sessionTokenHash,
        csrfTokenHash: tokens.csrfTokenHash,
        expiresAt,
        ipAddress: request.ip,
        userAgent: request.get("user-agent"),
      });
      dependencies.database
        .prepare(
          "UPDATE users SET last_login_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?",
        )
        .run(at.toISOString(), at.toISOString(), user.organization_id, user.id);
      response.cookie(
        dependencies.config.sessionCookieName,
        tokens.sessionToken,
        sessionCookieOptions(dependencies.config),
      );
      response.cookie(
        csrfCookieName(dependencies.config),
        tokens.csrfToken,
        csrfCookieOptions(dependencies.config),
      );
      appendAuditEvent(dependencies.database, user.organization_id, {
        actorType: "user",
        actorUserId: user.id,
        action: "auth.login",
        entityType: "session",
        entityId: session.id,
        ...requestAuditContext(request),
      });
      data(response, sessionUser(user, user.organization_name, tokens.csrfToken));
    }),
  );

  const publicLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100, prefix: "public-upload" });
  const requireActivePublicLink: RequestHandler = (request, _response, next) => {
    try {
      // Reject arbitrary or expired bearer tokens before Multer allocates a
      // bounded in-memory upload. The handler repeats this lookup immediately
      // before the transaction so link expiry/use limits are still enforced.
      publicLinkContext(dependencies, request.params.token as string, now());
      next();
    } catch (error) {
      next(error);
    }
  };
  router.get(
    "/public/upload/:token",
    publicLimiter,
    asyncRoute(async (request, response) => {
      const context = publicLinkContext(dependencies, request.params.token as string, now());
      const requirements = requirementViews(context.repository, context.vendor.vendor_type_id);
      data(response, {
        organizationName: context.organization.name,
        vendorName: context.vendor.legal_name,
        expiresAt: context.link.expires_at,
        requirements: requirements
          .filter((requirement) => requirement.required)
          .map((requirement) => ({
            coverageType: requirement.coverageType,
            label: requirement.label,
            summary:
              [
                requirement.minimumEachOccurrence
                  ? `Each occurrence minimum ${(requirement.minimumEachOccurrence / 100).toLocaleString("en-US", { style: "currency", currency: requirement.currency })}`
                  : null,
                requirement.minimumAggregate
                  ? `Aggregate minimum ${(requirement.minimumAggregate / 100).toLocaleString("en-US", { style: "currency", currency: requirement.currency })}`
                  : null,
                requirement.requiredEndorsements.length
                  ? `Endorsements: ${requirement.requiredEndorsements.join(", ")}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Certificate evidence is required",
          })),
      });
    }),
  );

  router.post(
    "/public/upload/:token",
    publicLimiter,
    requireActivePublicLink,
    pdfUpload,
    asyncRoute(async (request, response) => {
      if (!request.file) throw new HttpError(400, "A PDF document is required");
      const at = now();
      const context = publicLinkContext(dependencies, request.params.token as string, at);
      const result = await ingestCertificate({
        database: dependencies.database,
        repository: context.repository,
        documentStore: dependencies.documentStore,
        vendorId: context.vendor.id,
        originalFilename: request.file.originalname,
        bytes: request.file.buffer,
        metadata: request.body.metadata,
        uploadLinkId: context.link.id,
        consumeUploadLink: true,
        forceUnconfirmed: true,
        now: at,
      });
      appendAuditEvent(dependencies.database, context.repository.organizationId, {
        actorType: "vendor",
        action: "certificate.vendor_uploaded",
        entityType: "certificate",
        entityId: result.certificate.id,
        metadata: {
          vendorId: context.vendor.id,
          documentId: result.document.id,
          sha256: result.document.sha256,
          reviewStatus: "UNCONFIRMED",
        },
        ...requestAuditContext(request),
      });
      data(
        response,
        { receiptId: result.certificate.id, uploadedAt: result.document.uploaded_at },
        201,
      );
    }),
  );

  router.use(authenticate(dependencies.database, dependencies.config));
  router.use(trustedOrigin);
  const csrf = requireCsrf(dependencies.config);
  router.use((request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      next();
      return;
    }
    csrf(request, response, next);
  });

  router.get("/auth/me", (_request, response) => {
    const auth = authContext(response);
    data(response, sessionUser(auth.user, auth.organizationName, auth.csrfToken));
  });

  router.post("/auth/logout", (request, response) => {
    const auth = authContext(response);
    audit(dependencies, request, response, {
      action: "auth.logout",
      entityType: "session",
      entityId: auth.session.id,
    });
    createOrganizationRepository(dependencies.database, auth.user.organization_id).revokeSession(
      auth.session.id,
      now().toISOString(),
    );
    response.clearCookie(
      dependencies.config.sessionCookieName,
      sessionCookieOptions(dependencies.config),
    );
    response.clearCookie(
      csrfCookieName(dependencies.config),
      csrfCookieOptions(dependencies.config),
    );
    response.status(204).end();
  });

  router.get("/dashboard", (_request, response) => {
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    data(response, dashboardView(dependencies.database, repository, now()));
  });

  router.get("/vendors/export.csv", (request, response) => {
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const filters: VendorFilters = {
      q: typeof request.query.q === "string" ? request.query.q : undefined,
      type: typeof request.query.type === "string" ? request.query.type : undefined,
      check: typeof request.query.check === "string" ? request.query.check : undefined,
      document: typeof request.query.document === "string" ? request.query.document : undefined,
    };
    const at = now();
    const rows = listVendorSummaryViews(dependencies.database, repository, filters, at).flatMap(
      (vendor) => {
        const detail = repository.getVendor(vendor.id);
        const certificate = detail
          ? vendorDetailView(dependencies.database, repository, detail, at).certificates.find(
              (candidate) => candidate.documentStatus !== "rejected",
            )
          : undefined;
        const findings = certificate?.findings.filter((finding) =>
          ["FAIL", "UNKNOWN"].includes(finding.outcome),
        );
        const base = {
          vendorId: vendor.id,
          vendorName: vendor.legalName,
          vendorType: vendor.vendorTypeName,
          documentId: certificate?.id ?? "",
          evaluationDate: certificate?.evaluationDate ?? at.toISOString().slice(0, 10),
          documentLabel:
            vendor.status === "meets"
              ? ("DOCUMENT_COMPLIANT" as const)
              : vendor.status === "deficient" || vendor.status === "approved_exception"
                ? ("DOCUMENT_NON_COMPLIANT" as const)
                : ("DOCUMENT_REVIEW_REQUIRED" as const),
          expirationDate: vendor.nextExpiration ?? "",
        };
        return findings?.length
          ? findings.map((finding) => ({
              ...base,
              findingStatus: finding.outcome,
              deficiencyCode: finding.ruleCode,
              deficiency: finding.message,
            }))
          : [base];
      },
    );
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="opencoi-compliance-${at.toISOString().slice(0, 10)}.csv"`,
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.send(`${buildComplianceStatusCsv(rows)}\r\n`);
  });

  router.get("/vendors", (request, response) => {
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    data(
      response,
      listVendorSummaryViews(
        dependencies.database,
        repository,
        {
          q: typeof request.query.q === "string" ? request.query.q : undefined,
          type: typeof request.query.type === "string" ? request.query.type : undefined,
          check: typeof request.query.check === "string" ? request.query.check : undefined,
          document: typeof request.query.document === "string" ? request.query.document : undefined,
        },
        now(),
      ),
    );
  });

  router.post("/vendors", requireRole("owner", "admin"), (request, response) => {
    const input = vendorCreateSchema.parse(request.body);
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    if (!repository.getVendorType(input.vendorTypeId)) {
      throw new HttpError(400, "Vendor type does not exist in this organization");
    }
    const vendor = repository.createVendor({
      vendorTypeId: input.vendorTypeId,
      legalName: input.legalName,
      tradeName: input.dbaName ?? input.tradeName ?? undefined,
      contactName: input.contactName ?? undefined,
      contactEmail: input.contactEmail ?? undefined,
      contactPhone: input.contactPhone ?? undefined,
      externalReference: input.externalReference ?? undefined,
      notes: input.notes ?? undefined,
    });
    audit(dependencies, request, response, {
      action: "vendor.created",
      entityType: "vendor",
      entityId: vendor.id,
      metadata: { legalName: vendor.legal_name, vendorTypeId: vendor.vendor_type_id },
    });
    data(response, vendorDetailView(dependencies.database, repository, vendor, now()), 201);
  });

  router.get("/vendors/:id", (request, response) => {
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const vendor = repository.getVendor(request.params.id as string);
    if (!vendor) throw new HttpError(404, "Vendor not found");
    data(response, vendorDetailView(dependencies.database, repository, vendor, now()));
  });

  router.patch("/vendors/:id", requireRole("owner", "admin", "reviewer"), (request, response) => {
    const input = vendorPatchSchema.parse(request.body);
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const current = repository.getVendor(request.params.id as string);
    if (!current) throw new HttpError(404, "Vendor not found");
    const vendorTypeId = input.vendorTypeId ?? current.vendor_type_id;
    if (!repository.getVendorType(vendorTypeId)) {
      throw new HttpError(400, "Vendor type does not exist in this organization");
    }
    const pick = (key: keyof typeof input, fallback: string | null): string | null =>
      Object.hasOwn(input, key) ? ((input[key] as string | null) ?? null) : fallback;
    const timestamp = now().toISOString();
    dependencies.database
      .prepare(
        `UPDATE vendors SET vendor_type_id = ?, legal_name = ?, trade_name = ?, contact_name = ?,
             contact_email = ?, contact_phone = ?, external_reference = ?, status = ?, notes = ?, updated_at = ?
           WHERE organization_id = ? AND id = ?`,
      )
      .run(
        vendorTypeId,
        input.legalName ?? current.legal_name,
        Object.hasOwn(input, "dbaName")
          ? (input.dbaName ?? null)
          : Object.hasOwn(input, "tradeName")
            ? (input.tradeName ?? null)
            : current.trade_name,
        pick("contactName", current.contact_name),
        pick("contactEmail", current.contact_email),
        pick("contactPhone", current.contact_phone),
        pick("externalReference", current.external_reference),
        input.status ?? current.status,
        pick("notes", current.notes),
        timestamp,
        repository.organizationId,
        current.id,
      );
    audit(dependencies, request, response, {
      action: "vendor.updated",
      entityType: "vendor",
      entityId: current.id,
      metadata: { fields: Object.keys(input).sort() },
    });
    data(
      response,
      vendorDetailView(
        dependencies.database,
        repository,
        repository.getVendor(current.id) as NonNullable<ReturnType<typeof repository.getVendor>>,
        now(),
      ),
    );
  });

  router.get("/vendor-types", (_request, response) => {
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    data(
      response,
      repository
        .listVendorTypes(false)
        .map((row) => vendorTypeView(dependencies.database, repository, row)),
    );
  });

  router.post("/vendor-types", requireRole("owner", "admin"), (request, response) => {
    const input = z
      .object({ name: text(160), description: nullableText(2_000) })
      .parse(request.body);
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const row = repository.createVendorType({
      name: input.name,
      description: input.description ?? undefined,
    });
    audit(dependencies, request, response, {
      action: "vendor_type.created",
      entityType: "vendor_type",
      entityId: row.id,
      metadata: { name: row.name },
    });
    data(response, vendorTypeView(dependencies.database, repository, row), 201);
  });

  router.put(
    "/vendor-types/:id/requirements",
    requireRole("owner", "admin"),
    (request, response) => {
      const input = publishRequirementsSchema.parse(request.body);
      const auth = authContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        auth.user.organization_id,
      );
      const vendorType = repository.getVendorType(request.params.id as string);
      if (!vendorType) throw new HttpError(404, "Vendor type not found");
      const at = now().toISOString();
      const version = repository.transaction(() => {
        const current = dependencies.database
          .prepare(
            `SELECT COALESCE(max(version), 0) AS version FROM requirement_versions
             WHERE organization_id = ? AND vendor_type_id = ?`,
          )
          .get(repository.organizationId, vendorType.id) as { version: number };
        const nextVersion = current.version + 1;
        dependencies.database
          .prepare(
            `INSERT INTO requirement_versions
              (id, organization_id, vendor_type_id, version, requirements_json,
               published_by_user_id, published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            repository.organizationId,
            vendorType.id,
            nextVersion,
            JSON.stringify(input.requirements),
            auth.user.id,
            at,
          );
        dependencies.database
          .prepare(
            `UPDATE coverage_requirements
             SET is_active = 0, updated_at = ?
             WHERE organization_id = ? AND vendor_type_id = ? AND is_active = 1`,
          )
          .run(at, repository.organizationId, vendorType.id);
        for (const requirement of input.requirements) {
          repository.createCoverageRequirement({
            vendorTypeId: vendorType.id,
            coverageType: requirement.coverageType,
            minimumEachOccurrence: requirement.minimumEachOccurrence ?? undefined,
            minimumAggregate: requirement.minimumAggregate ?? undefined,
            requiredEndorsements: requirement.requiredEndorsements,
            ruleConfig: {
              version: nextVersion,
              label: requirement.label,
              required: requirement.required,
              currency: requirement.currency,
              endorsementEvidence: requirement.endorsementEvidence,
              expirationWarningDays: requirement.expirationWarningDays,
              publishedAt: at,
              canonicalCoverageType: normalizeCoverageType(requirement.coverageType),
            },
          });
        }
        return nextVersion;
      });
      audit(dependencies, request, response, {
        action: "requirements.published",
        entityType: "vendor_type",
        entityId: vendorType.id,
        metadata: { version, requirementCount: input.requirements.length },
      });
      data(response, vendorTypeView(dependencies.database, repository, vendorType));
    },
  );

  router.post(
    "/vendors/:id/certificates",
    requireRole("owner", "admin", "reviewer"),
    pdfUpload,
    asyncRoute(async (request, response) => {
      if (!request.file) throw new HttpError(400, "A PDF document is required");
      const auth = authContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        auth.user.organization_id,
      );
      const result = await ingestCertificate({
        database: dependencies.database,
        repository,
        documentStore: dependencies.documentStore,
        vendorId: request.params.id as string,
        originalFilename: request.file.originalname,
        bytes: request.file.buffer,
        metadata: request.body.metadata,
        uploadedByUserId: auth.user.id,
        now: now(),
      });
      audit(dependencies, request, response, {
        action:
          result.certificate.confirmation_status === "confirmed"
            ? "certificate.staff_uploaded_confirmed"
            : "certificate.staff_uploaded_pending",
        entityType: "certificate",
        entityId: result.certificate.id,
        metadata: {
          vendorId: result.certificate.vendor_id,
          documentId: result.document.id,
          sha256: result.document.sha256,
          requirementVersion: result.requirementVersion,
          evaluationDate: result.evaluationDate,
        },
      });
      data(
        response,
        certificateView(dependencies.database, repository, result.certificate.id, now()),
        201,
      );
    }),
  );

  router.get("/certificates/:id", (request, response) => {
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const view = certificateView(
      dependencies.database,
      repository,
      request.params.id as string,
      now(),
    );
    if (!view) throw new HttpError(404, "Certificate not found");
    data(response, view);
  });

  router.put(
    "/certificates/:id/confirmation",
    requireRole("owner", "admin", "reviewer"),
    (request, response) => {
      const input = z
        .object({
          confirmed: z.literal(true),
          corrections: certificateCorrectionSchema.optional(),
        })
        .strict()
        .parse(request.body);
      const auth = authContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        auth.user.organization_id,
      );
      const existing = repository.getCertificate(request.params.id as string);
      if (!existing) throw new HttpError(404, "Certificate not found");
      if (existing.confirmation_status !== "draft") {
        throw new HttpError(409, "Certificate has already been reviewed");
      }
      const result = confirmStoredCertificate({
        database: dependencies.database,
        repository,
        certificateId: existing.id,
        reviewerUserId: auth.user.id,
        corrections: input.corrections,
        now: now(),
      });
      audit(dependencies, request, response, {
        action: "certificate.confirmed",
        entityType: "certificate",
        entityId: existing.id,
        metadata: {
          documentId: result.document.id,
          requirementVersion: result.requirementVersion,
          evaluationDate: result.evaluationDate,
          correctedFields: result.correctedFields,
        },
      });
      data(response, certificateView(dependencies.database, repository, existing.id, now()));
    },
  );

  router.put(
    "/certificates/:id/rejection",
    requireRole("owner", "admin", "reviewer"),
    (request, response) => {
      const input = z
        .object({ reason: certificateRejectionReasonSchema })
        .strict()
        .parse(request.body);
      const auth = authContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        auth.user.organization_id,
      );
      const existing = repository.getCertificate(request.params.id as string);
      if (!existing) throw new HttpError(404, "Certificate not found");
      if (existing.confirmation_status !== "draft") {
        throw new HttpError(409, "Certificate has already been reviewed");
      }
      const result = rejectStoredCertificate({
        database: dependencies.database,
        repository,
        certificateId: existing.id,
        reviewerUserId: auth.user.id,
        reason: input.reason,
        now: now(),
      });
      audit(dependencies, request, response, {
        action: "certificate.rejected",
        entityType: "certificate",
        entityId: existing.id,
        metadata: {
          documentId: result.document.id,
          rejectionReason: input.reason,
          rejectedAt: result.rejectedAt,
        },
      });
      data(response, certificateView(dependencies.database, repository, existing.id, now()));
    },
  );

  const download = asyncRoute(async (request, response) => {
    const auth = authContext(response);
    const document = documentForDownload(
      dependencies.database,
      auth.user.organization_id,
      request.params.id as string,
    );
    if (!document) throw new HttpError(404, "Certificate not found");
    const bytes = await dependencies.documentStore.get(document.storage_key);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Length", String(bytes.byteLength));
    response.setHeader(
      "Content-Disposition",
      attachmentContentDisposition(document.original_filename),
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(bytes);
  });
  router.get("/certificates/:id/download", download);

  router.post(
    "/vendors/:id/upload-links",
    requireRole("owner", "admin", "reviewer"),
    (request, response) => {
      const input = z
        .object({
          ttlDays: z
            .number()
            .int()
            .min(1)
            .max(365)
            .default(Math.max(1, Math.round(dependencies.config.uploadLinkTtlMs / 86_400_000))),
          maxUses: z.number().int().min(1).max(25).default(1),
          label: nullableText(200),
        })
        .parse(request.body);
      const auth = authContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        auth.user.organization_id,
      );
      const vendor = repository.getVendor(request.params.id as string);
      if (!vendor) throw new HttpError(404, "Vendor not found");
      const random = createUploadLinkToken(dependencies.config.tokenPepper);
      const token = tokenForOrganization(repository.organizationId, random.token);
      const tokenHash = hashUploadLinkToken(token, dependencies.config.tokenPepper);
      const expiresAt = new Date(now().getTime() + input.ttlDays * 86_400_000).toISOString();
      const link = repository.createUploadLink({
        vendorId: vendor.id,
        tokenHash,
        expiresAt,
        createdByUserId: auth.user.id,
        maxUses: input.maxUses,
        label: input.label ?? undefined,
      });
      audit(dependencies, request, response, {
        action: "upload_link.created",
        entityType: "upload_link",
        entityId: link.id,
        metadata: { vendorId: vendor.id, expiresAt, maxUses: input.maxUses },
      });
      data(
        response,
        { id: link.id, url: `${dependencies.config.appOrigin}/upload/${token}`, expiresAt },
        201,
      );
    },
  );

  router.post(
    "/upload-links/:id/revoke",
    requireRole("owner", "admin", "reviewer"),
    (request, response) => {
      const auth = authContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        auth.user.organization_id,
      );
      const link = repository.getUploadLink(request.params.id as string);
      if (!link) throw new HttpError(404, "Upload link not found");
      if (!repository.revokeUploadLink(link.id, now().toISOString())) {
        throw new HttpError(409, "Upload link is already revoked");
      }
      audit(dependencies, request, response, {
        action: "upload_link.revoked",
        entityType: "upload_link",
        entityId: link.id,
        metadata: { vendorId: link.vendor_id },
      });
      response.status(204).end();
    },
  );

  router.get("/exceptions", (_request, response) => {
    const auth = authContext(response);
    const ids = dependencies.database
      .prepare(
        "SELECT id FROM exceptions WHERE organization_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(auth.user.organization_id) as Array<{ id: string }>;
    data(
      response,
      ids
        .map((row) =>
          exceptionView(dependencies.database, auth.user.organization_id, row.id, now()),
        )
        .filter(Boolean),
    );
  });

  router.post("/exceptions", requireRole("owner", "admin", "reviewer"), (request, response) => {
    const input = z
      .object({
        vendorId: text(128),
        findingId: text(128),
        reason: text(5_000),
        compensatingControls: nullableText(5_000),
        expiresAt: isoDateString,
      })
      .parse(request.body);
    if (input.expiresAt < now().toISOString().slice(0, 10)) {
      throw new HttpError(400, "Exception expiration cannot be in the past");
    }
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const finding = dependencies.database
      .prepare(
        `SELECT f.id FROM findings f
           JOIN certificates c ON c.organization_id = f.organization_id AND c.id = f.certificate_id
           WHERE f.organization_id = ? AND f.id = ? AND c.vendor_id = ?
             AND c.confirmation_status = 'confirmed'
             AND f.evaluation_status = 'FAIL'
             AND f.status = 'open'`,
      )
      .get(repository.organizationId, input.findingId, input.vendorId);
    if (!finding) {
      throw new HttpError(
        400,
        "Only an open failed finding on a confirmed certificate can be excepted",
      );
    }
    const id = repository.createException({
      vendorId: input.vendorId,
      findingId: input.findingId,
      requestedByUserId: auth.user.id,
      requestReason: JSON.stringify({
        reason: input.reason,
        compensatingControls: input.compensatingControls ?? null,
      }),
      expiresAt: input.expiresAt,
    });
    audit(dependencies, request, response, {
      action: "exception.requested",
      entityType: "exception",
      entityId: id,
      metadata: {
        vendorId: input.vendorId,
        findingId: input.findingId,
        expiresAt: input.expiresAt,
      },
    });
    data(response, exceptionView(dependencies.database, repository.organizationId, id, now()), 201);
  });

  router.post("/exceptions/:id/decision", requireRole("owner", "admin"), (request, response) => {
    const input = z
      .object({
        decision: z.enum(["approved", "rejected", "revoked"]),
        decisionReason: text(5_000),
        expiresAt: isoDateString.optional(),
      })
      .parse(request.body);
    const auth = authContext(response);
    const repository = createOrganizationRepository(
      dependencies.database,
      auth.user.organization_id,
    );
    const existing = exceptionView(
      dependencies.database,
      repository.organizationId,
      request.params.id as string,
      now(),
    );
    if (!existing) throw new HttpError(404, "Exception not found");
    if (
      !repository.decideException({
        id: existing.id,
        status: input.decision,
        decidedByUserId: auth.user.id,
        decisionNote: input.decisionReason,
        expiresAt: input.expiresAt,
      })
    ) {
      throw new HttpError(409, "Exception cannot be changed from its current status");
    }
    audit(dependencies, request, response, {
      action: `exception.${input.decision}`,
      entityType: "exception",
      entityId: existing.id,
      metadata: { decisionReason: input.decisionReason },
    });
    data(
      response,
      exceptionView(dependencies.database, repository.organizationId, existing.id, now()),
    );
  });

  router.get("/audit", (_request, response) => {
    const auth = authContext(response);
    const verification = verifyAuditChain(dependencies.database, auth.user.organization_id);
    const users = new Map(
      createOrganizationRepository(dependencies.database, auth.user.organization_id)
        .listUsers()
        .map((user) => [user.id, user.display_name]),
    );
    const rows = listAuditEvents(dependencies.database, auth.user.organization_id, { limit: 500 });
    data(
      response,
      rows.reverse().map((row) => ({
        id: row.id,
        actor:
          (row.actor_user_id ? users.get(row.actor_user_id) : undefined) ??
          (row.actor_type === "vendor" ? "Vendor uploader" : "OpenCOI"),
        action: row.action,
        entityType: row.entity_type,
        entityLabel: row.entity_id ? `${row.entity_type} ${row.entity_id}` : row.entity_type,
        createdAt: row.occurred_at,
        metadata: (() => {
          try {
            return JSON.parse(row.metadata_json) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
        chainValid: verification.valid,
      })),
    );
  });

  router.get("/reminders", (_request, response) => {
    const auth = authContext(response);
    data(response, listReminders(dependencies.database, auth.user.organization_id));
  });

  router.post(
    "/reminders/run",
    requireRole("owner", "admin"),
    asyncRoute(async (request, response) => {
      const auth = authContext(response);
      const result = await runReminderCycle(dependencies.database, dependencies.config, {
        organizationId: auth.user.organization_id,
        now: now(),
      });
      audit(dependencies, request, response, {
        action: "reminders.run",
        entityType: "reminder_batch",
        metadata: result,
      });
      data(response, result);
    }),
  );

  return router;
};
