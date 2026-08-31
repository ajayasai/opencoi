import { createHash, randomUUID } from "node:crypto";
import { type ErrorRequestHandler, type RequestHandler, type Response, Router } from "express";
import multer from "multer";
import { ZodError, z } from "zod";
import { type AppendAuditEventInput, appendAuditEvent } from "../audit.js";
import type { AppConfig } from "../config.js";
import { createOrganizationRepository, type OpenCoiDatabase, type VendorRow } from "../db.js";
import { decryptSecret, encryptSecret } from "../security/secrets.js";
import { createUploadLinkToken, publicUploadUrl } from "../security.js";
import {
  type CertificateRequestRecord,
  cancelCertificateRequest,
  cancelOpenCertificateRequestsForVendor,
  createCertificateRequest,
  getCertificateRequest,
  listCertificateRequests,
} from "../services/certificateRequests.js";
import { ingestCertificate } from "../services/certificates.js";
import { listDomainEvents, publishDomainEvent } from "../services/domainEvents.js";
import { buildSignedEvidenceBundle } from "../services/evidenceBundles.js";
import { certificateView } from "../services/projections.js";
import {
  type AuthenticatedServiceAccount,
  authenticateServiceAccount,
  type ServiceAccountScope,
} from "../services/serviceAccounts.js";
import { type DocumentStore, UnsafeDocumentError } from "../storage.js";

export const API_VERSION = "2026-09-01";
const MAX_PAGE_SIZE = 100;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface ApiV1Dependencies {
  config: AppConfig;
  database: OpenCoiDatabase;
  documentStore: DocumentStore;
  uploadCapacity: RequestHandler;
  now?: () => Date;
}

interface ApiAuthContext {
  serviceAccount: AuthenticatedServiceAccount;
  requestId: string;
}

class ApiProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly title = message,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

const apiContext = (response: Response): ApiAuthContext => {
  const context = response.locals.apiAuth as ApiAuthContext | undefined;
  if (!context) throw new ApiProblem(500, "API authentication context is unavailable");
  return context;
};

type ApiAuditInput = Omit<
  AppendAuditEventInput,
  "actorType" | "ipAddress" | "userAgent" | "metadata"
> & {
  metadata?: Record<string, unknown>;
};

const appendApiAuditEvent = (
  dependencies: ApiV1Dependencies,
  request: Parameters<RequestHandler>[0],
  response: Response,
  organizationId: string,
  input: ApiAuditInput,
) => {
  const context = apiContext(response);
  return appendAuditEvent(dependencies.database, organizationId, {
    ...input,
    actorType: "system",
    ipAddress: request.ip,
    userAgent: request.get("user-agent"),
    metadata: {
      ...(input.metadata ?? {}),
      serviceAccountId: context.serviceAccount.id,
      serviceAccountSecretId: context.serviceAccount.secretId,
      requestId: context.requestId,
    },
  });
};

export const apiV1RequestMetadata: RequestHandler = (_request, response, next) => {
  const requestId =
    typeof response.locals.apiRequestId === "string" ? response.locals.apiRequestId : randomUUID();
  response.setHeader("X-Request-ID", requestId);
  response.setHeader("OpenCOI-Version", API_VERSION);
  response.setHeader("Cache-Control", "private, no-store");
  response.locals.apiRequestId = requestId;
  next();
};

const authenticateApi =
  (dependencies: ApiV1Dependencies): RequestHandler =>
  (request, response, next) => {
    const authorization = request.get("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match?.[1]) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="OpenCOI API"');
      next(new ApiProblem(401, "A bearer service-account token is required", "Unauthorized"));
      return;
    }
    const serviceAccount = authenticateServiceAccount(
      dependencies.database,
      match[1],
      dependencies.config.tokenPepper,
      (dependencies.now ?? (() => new Date()))().toISOString(),
    );
    if (!serviceAccount) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="OpenCOI API", error="invalid_token"');
      next(
        new ApiProblem(
          401,
          "The bearer token is invalid, expired, revoked, or disabled",
          "Unauthorized",
        ),
      );
      return;
    }
    response.locals.apiAuth = {
      serviceAccount,
      requestId: String(response.locals.apiRequestId),
    } satisfies ApiAuthContext;
    next();
  };

const requireScope =
  (scope: ServiceAccountScope): RequestHandler =>
  (_request, response, next) => {
    if (!apiContext(response).serviceAccount.scopes.includes(scope)) {
      next(new ApiProblem(403, `The ${scope} scope is required`, "Forbidden"));
      return;
    }
    next();
  };

const numberParameter = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ApiProblem(400, "limit must be a positive integer", "Invalid query parameter");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new ApiProblem(
      400,
      `limit must be between 1 and ${MAX_PAGE_SIZE}`,
      "Invalid query parameter",
    );
  }
  return parsed;
};

interface VendorCursor {
  name: string;
  id: string;
}

interface CertificateRequestCursor {
  createdAt: string;
  id: string;
}

const encodeCursor = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeVendorCursor = (value: unknown): VendorCursor | null => {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw new ApiProblem(400, "cursor is invalid", "Invalid query parameter");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof (decoded as VendorCursor).name !== "string" ||
      typeof (decoded as VendorCursor).id !== "string" ||
      (decoded as VendorCursor).name.length > 240 ||
      (decoded as VendorCursor).id.length > 128
    ) {
      throw new Error("invalid cursor data");
    }
    return decoded as VendorCursor;
  } catch {
    throw new ApiProblem(400, "cursor is invalid", "Invalid query parameter");
  }
};

const decodeCertificateRequestCursor = (value: unknown): CertificateRequestCursor | null => {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw new ApiProblem(400, "cursor is invalid", "Invalid query parameter");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const cursor = decoded as CertificateRequestCursor;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      cursor.id.length > 128 ||
      new Date(cursor.createdAt).toISOString() !== cursor.createdAt
    ) {
      throw new Error("invalid cursor data");
    }
    return cursor;
  } catch {
    throw new ApiProblem(400, "cursor is invalid", "Invalid query parameter");
  }
};

const decodeSequenceCursor = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ApiProblem(400, "cursor is invalid", "Invalid query parameter");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiProblem(400, "cursor is invalid", "Invalid query parameter");
  }
  return parsed;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

const requestHash = (method: string, path: string, body: unknown): string =>
  createHash("sha256")
    .update(`${method}\n${path}\n${JSON.stringify(canonicalize(body))}`, "utf8")
    .digest("hex");

interface IdempotencyRecord {
  idempotency_key: string;
  method: string;
  path: string;
  request_hash: string;
  response_status: number;
  response_json: string;
  response_headers_json: string;
}

interface IdempotentResponseHeaders {
  etag?: string;
  location?: string;
}

interface IdempotencyRequest {
  key: string;
  hash: string;
}

const idempotencyKey = (request: Parameters<RequestHandler>[0]): string => {
  const key = request.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiProblem(
      400,
      "Idempotency-Key must be 8–128 letters, digits, periods, underscores, colons, or hyphens",
      "Invalid idempotency key",
    );
  }
  return key;
};

const prepareIdempotencyRequest = (
  request: Parameters<RequestHandler>[0],
  body: unknown = request.body,
): IdempotencyRequest => ({
  key: idempotencyKey(request),
  hash: requestHash(request.method, request.path, body),
});

class IdempotentReplay extends Error {
  constructor(readonly record: IdempotencyRecord) {
    super("An equivalent request completed concurrently");
    this.name = "IdempotentReplay";
  }
}

const findIdempotentResponse = (
  dependencies: ApiV1Dependencies,
  request: Parameters<RequestHandler>[0],
  response: Response,
  idempotency: IdempotencyRequest,
): IdempotencyRecord | null => {
  const context = apiContext(response);
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  dependencies.database.prepare("DELETE FROM api_idempotency_keys WHERE expires_at <= ?").run(now);
  const record = dependencies.database
    .prepare(
      `SELECT idempotency_key, method, path, request_hash, response_status, response_json,
              response_headers_json
       FROM api_idempotency_keys
       WHERE organization_id = ? AND service_account_id = ? AND idempotency_key = ?
         AND expires_at > ?`,
    )
    .get(
      context.serviceAccount.organizationId,
      context.serviceAccount.id,
      idempotency.key,
      now,
    ) as unknown as IdempotencyRecord | undefined;
  if (!record) return null;
  if (
    record.method !== request.method ||
    record.path !== request.path ||
    record.request_hash !== idempotency.hash
  ) {
    throw new ApiProblem(
      409,
      "Idempotency-Key was already used for a different request",
      "Idempotency conflict",
    );
  }
  return record;
};

const idempotencySecretContext = (
  organizationId: string,
  serviceAccountId: string,
  key: string,
): string => `${organizationId}:service_account:${serviceAccountId}:idempotency:${key}`;

const ENCRYPTED_IDEMPOTENCY_RESPONSE_KEY = "_opencoiEncryptedResponseV1";

const sendIdempotentResponse = (
  dependencies: ApiV1Dependencies,
  response: Response,
  record: IdempotencyRecord,
  transformPayload?: (payload: unknown) => unknown,
): void => {
  const context = apiContext(response);
  const parsedHeaders = JSON.parse(record.response_headers_json) as unknown;
  const storedHeaders: IdempotentResponseHeaders =
    parsedHeaders && typeof parsedHeaders === "object" && !Array.isArray(parsedHeaders)
      ? (parsedHeaders as IdempotentResponseHeaders)
      : {};
  if (typeof storedHeaders.etag === "string") response.setHeader("ETag", storedHeaders.etag);
  if (typeof storedHeaders.location === "string") {
    response.setHeader("Location", storedHeaders.location);
  }
  response.setHeader("Idempotent-Replayed", "true");
  const storedPayload = JSON.parse(record.response_json) as unknown;
  const encryptedResponse =
    storedPayload &&
    typeof storedPayload === "object" &&
    !Array.isArray(storedPayload) &&
    Object.keys(storedPayload).length === 1 &&
    typeof (storedPayload as Record<string, unknown>)[ENCRYPTED_IDEMPOTENCY_RESPONSE_KEY] ===
      "string"
      ? String((storedPayload as Record<string, unknown>)[ENCRYPTED_IDEMPOTENCY_RESPONSE_KEY])
      : null;
  const payload = encryptedResponse
    ? JSON.parse(
        decryptSecret(
          encryptedResponse,
          dependencies.config.tokenPepper as string,
          idempotencySecretContext(
            context.serviceAccount.organizationId,
            context.serviceAccount.id,
            record.idempotency_key,
          ),
        ),
      )
    : storedPayload;
  response
    .status(record.response_status)
    .json(transformPayload ? transformPayload(payload) : payload);
};

const storeIdempotentResponse = (
  dependencies: ApiV1Dependencies,
  request: Parameters<RequestHandler>[0],
  response: Response,
  key: string,
  hash: string,
  status: number,
  payload: unknown,
  headers: IdempotentResponseHeaders,
): void => {
  const context = apiContext(response);
  const now = (dependencies.now ?? (() => new Date()))();
  const serializedPayload = JSON.stringify(payload);
  const storedPayload = dependencies.config.tokenPepper
    ? JSON.stringify({
        [ENCRYPTED_IDEMPOTENCY_RESPONSE_KEY]: encryptSecret(
          serializedPayload,
          dependencies.config.tokenPepper,
          idempotencySecretContext(
            context.serviceAccount.organizationId,
            context.serviceAccount.id,
            key,
          ),
        ),
      })
    : serializedPayload;
  dependencies.database
    .prepare(
      `INSERT INTO api_idempotency_keys
        (organization_id, service_account_id, idempotency_key, method, path, request_hash,
         response_status, response_json, response_headers_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      context.serviceAccount.organizationId,
      context.serviceAccount.id,
      key,
      request.method,
      request.path,
      hash,
      status,
      storedPayload,
      JSON.stringify(headers),
      now.toISOString(),
      new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    );
};

const transaction = <T>(database: OpenCoiDatabase, work: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
};

interface VendorApiRow extends VendorRow {
  vendor_type_name: string;
  latest_certificate_id: string | null;
  latest_compliance_status: string | null;
  latest_expiration_date: string | null;
}

const vendorResource = (row: VendorApiRow) => ({
  id: row.id,
  vendorType: { id: row.vendor_type_id, name: row.vendor_type_name },
  legalName: row.legal_name,
  tradeName: row.trade_name,
  contact: {
    name: row.contact_name,
    email: row.contact_email,
    phone: row.contact_phone,
  },
  externalReference: row.external_reference,
  status: row.status,
  notes: row.notes,
  latestCertificate: row.latest_certificate_id
    ? {
        id: row.latest_certificate_id,
        complianceStatus: row.latest_compliance_status,
        expirationDate: row.latest_expiration_date,
      }
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectVendor = (
  database: OpenCoiDatabase,
  organizationId: string,
  vendorId: string,
): VendorApiRow | null => {
  const row = database
    .prepare(
      `SELECT v.*, vt.name AS vendor_type_name,
              c.id AS latest_certificate_id,
              c.compliance_status AS latest_compliance_status,
              c.earliest_expiration_date AS latest_expiration_date
       FROM vendors v
       JOIN vendor_types vt
         ON vt.organization_id = v.organization_id AND vt.id = v.vendor_type_id
       LEFT JOIN certificates c
         ON c.organization_id = v.organization_id AND c.vendor_id = v.id
        AND c.id = (
          SELECT c2.id FROM certificates c2
          WHERE c2.organization_id = v.organization_id AND c2.vendor_id = v.id
            AND c2.confirmation_status <> 'rejected'
          ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1
        )
       WHERE v.organization_id = ? AND v.id = ?`,
    )
    .get(organizationId, vendorId) as unknown as VendorApiRow | undefined;
  return row ?? null;
};

const etagFor = (resource: ReturnType<typeof vendorResource>): string =>
  `"${createHash("sha256").update(JSON.stringify(resource)).digest("base64url")}"`;

const vendorCreateSchema = z
  .object({
    vendorTypeId: z.string().trim().min(1).max(128),
    legalName: z.string().trim().min(1).max(240),
    tradeName: z.string().trim().max(240).nullable().optional(),
    contactName: z.string().trim().max(200).nullable().optional(),
    contactEmail: z.string().trim().email().max(320).nullable().optional(),
    contactPhone: z.string().trim().max(80).nullable().optional(),
    externalReference: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(5_000).nullable().optional(),
  })
  .strict();

const vendorPatchSchema = vendorCreateSchema
  .partial()
  .extend({ status: z.enum(["active", "inactive", "archived"]).optional() })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const certificateRequestCreateSchema = z
  .object({
    kind: z.enum(["initial", "renewal"]),
    deliveryMethod: z.enum(["manual", "smtp"]),
    recipientName: z.string().trim().max(200).nullable().optional(),
    recipientEmail: z.string().trim().email().max(320).nullable().optional(),
    sourceCertificateId: z.string().trim().min(1).max(128).nullable().optional(),
    ttlDays: z.number().int().min(1).max(365).default(14),
  })
  .strict();

const tokenForOrganization = (organizationId: string, randomPart: string): string =>
  `v1.${Buffer.from(organizationId, "utf8").toString("base64url")}.${randomPart}`;

const certificateRequestResource = (
  record: CertificateRequestRecord,
  at: Date,
  options: { redactRecipient?: boolean } = {},
) => {
  const { organizationId: _organizationId, deliverySecretAvailable: _secret, ...resource } = record;
  return {
    ...resource,
    ...(options.redactRecipient ? { recipientName: null, recipientEmail: null } : {}),
    state:
      resource.state === "open" && resource.expiresAt <= at.toISOString()
        ? ("expired" as const)
        : resource.state,
  };
};

const objectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const redactCertificateRequestCreateResponse = (payload: unknown): unknown => {
  if (
    !objectRecord(payload) ||
    !objectRecord(payload.data) ||
    !objectRecord(payload.data.request)
  ) {
    return payload;
  }
  return {
    ...payload,
    data: {
      ...payload.data,
      request: {
        ...payload.data.request,
        recipientName: null,
        recipientEmail: null,
      },
    },
  };
};

const certificateUpload = (config: AppConfig) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: config.maxUploadBytes, fields: 2, fieldSize: 2_000_000 },
  }).single("document");

const multipartMetadata = (value: unknown): unknown => {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") {
    throw new ApiProblem(400, "metadata must be a JSON object", "Invalid multipart field");
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metadata is not an object");
    }
    return parsed;
  } catch {
    throw new ApiProblem(400, "metadata must be a valid JSON object", "Invalid multipart field");
  }
};

const problemHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  let status = 500;
  let title = "Internal Server Error";
  let detail = "An unexpected error occurred";
  let errors: unknown;
  if (error instanceof ApiProblem) {
    status = error.status;
    title = error.title;
    detail = error.message;
    errors = error.errors;
  } else if (error instanceof ZodError) {
    status = 400;
    title = "Request validation failed";
    detail = "The request body does not match the API schema";
    errors = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  } else if (error instanceof multer.MulterError) {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    title = error.code === "LIMIT_FILE_SIZE" ? "Upload too large" : "Invalid multipart upload";
    detail =
      error.code === "LIMIT_FILE_SIZE"
        ? "The PDF exceeds the configured upload limit"
        : error.message;
  } else if (
    error instanceof Error &&
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(error.message)
  ) {
    status = 409;
    title = "Conflict";
    detail = "A resource with those values already exists";
  } else if (
    error instanceof Error &&
    /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(error.message)
  ) {
    status = 400;
    title = "Invalid reference";
    detail = "A referenced resource does not exist in this organization";
  }
  const payload: Record<string, unknown> = {
    type: "about:blank",
    title,
    status,
    detail,
    instance: request.originalUrl,
    requestId: response.locals.apiRequestId,
  };
  if (errors !== undefined) payload.errors = errors;
  response.status(status).type("application/problem+json").json(payload);
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "OpenCOI API",
    version: API_VERSION,
    description: "Tenant-isolated API for vendor, requirements, compliance, and event automation.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/vendors": {
      get: {
        summary: "List vendors",
        operationId: "listVendors",
        tags: ["Vendors"],
        "x-required-scope": "vendors:read",
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" },
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["active", "inactive", "archived"] },
          },
        ],
        responses: {
          "200": {
            description: "Cursor page of vendors",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorPage" } },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
      post: {
        summary: "Create a vendor",
        operationId: "createVendor",
        tags: ["Vendors"],
        "x-required-scope": "vendors:write",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/VendorInput" } },
          },
        },
        responses: {
          "201": {
            description: "Non-sensitive vendor creation receipt",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
              ETag: { $ref: "#/components/headers/ETag" },
              Location: { $ref: "#/components/headers/Location" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VendorMutationEnvelope" },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
          "413": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendors/{vendorId}": {
      parameters: [{ $ref: "#/components/parameters/VendorId" }],
      get: {
        summary: "Get a vendor",
        operationId: "getVendor",
        tags: ["Vendors"],
        "x-required-scope": "vendors:read",
        responses: {
          "200": {
            description: "Vendor and ETag",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              ETag: { $ref: "#/components/headers/ETag" },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorEnvelope" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
      patch: {
        summary: "Update a vendor",
        operationId: "updateVendor",
        tags: ["Vendors"],
        "x-required-scope": "vendors:write",
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/VendorPatch" } },
          },
        },
        responses: {
          "200": {
            description: "Non-sensitive vendor update receipt and current ETag",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
              ETag: { $ref: "#/components/headers/ETag" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VendorMutationEnvelope" },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
          "412": { $ref: "#/components/responses/Problem" },
          "413": { $ref: "#/components/responses/Problem" },
          "428": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendors/{vendorId}/compliance": {
      get: {
        summary: "Get the latest document compliance result",
        operationId: "getVendorCompliance",
        tags: ["Compliance"],
        "x-required-scope": "compliance:read",
        parameters: [{ $ref: "#/components/parameters/VendorId" }],
        responses: {
          "200": {
            description: "Uploaded-document compliance result",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ComplianceEnvelope" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendors/{vendorId}/certificates": {
      post: {
        summary: "Submit a certificate for human review",
        description:
          "Uploads a PDF and extraction proposal. Service-account submissions are always unconfirmed and cannot satisfy a configured rule until an authorized person reviews them.",
        operationId: "submitCertificate",
        tags: ["Certificates"],
        "x-required-scope": "certificates:write",
        parameters: [
          { $ref: "#/components/parameters/VendorId" },
          { $ref: "#/components/parameters/IdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["document"],
                properties: {
                  document: { type: "string", format: "binary" },
                  metadata: {
                    type: "string",
                    contentMediaType: "application/json",
                    contentSchema: {
                      $ref: "#/components/schemas/CertificateSubmissionMetadata",
                    },
                    description: "JSON object using the browser extraction metadata contract.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Non-sensitive certificate submission receipt",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
              Location: { $ref: "#/components/headers/Location" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CertificateSubmissionEnvelope" },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
          "413": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
          "503": { $ref: "#/components/responses/UploadCapacityProblem" },
        },
      },
    },
    "/certificates/{certificateId}": {
      get: {
        summary: "Get a certificate assessment",
        operationId: "getCertificate",
        tags: ["Certificates"],
        "x-required-scope": "certificates:read",
        parameters: [{ $ref: "#/components/parameters/CertificateId" }],
        responses: {
          "200": {
            description: "Certificate facts, evidence, findings, and document-scoped status",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CertificateEnvelope" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/certificates/{certificateId}/evidence-bundle": {
      get: {
        summary: "Export a signed evidence bundle",
        description:
          "Returns an Ed25519-signed portable record of the document assessment. It does not assert live policy status.",
        operationId: "exportEvidenceBundle",
        tags: ["Evidence"],
        "x-required-scope": "evidence:read",
        parameters: [{ $ref: "#/components/parameters/CertificateId" }],
        responses: {
          "200": {
            description: "Signed evidence bundle",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              "Content-Disposition": {
                description: "Attachment filename containing the certificate ID.",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/EvidenceBundle" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
          "503": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendors/{vendorId}/certificate-requests": {
      get: {
        summary: "List tracked certificate requests for a vendor",
        operationId: "listCertificateRequests",
        tags: ["Certificate requests"],
        "x-required-scope": "requests:read",
        parameters: [
          { $ref: "#/components/parameters/VendorId" },
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" },
        ],
        responses: {
          "200": {
            description: "Tracked requests",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CertificateRequestPage" },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
      post: {
        summary: "Create a tracked initial or renewal request",
        description:
          "Requires requests:write. Supplying sourceCertificateId additionally requires certificates:read so the caller cannot use renewal creation as a certificate-existence oracle.",
        operationId: "createCertificateRequest",
        tags: ["Certificate requests"],
        "x-required-scope": "requests:write",
        "x-conditional-scopes": { sourceCertificateId: "certificates:read" },
        parameters: [
          { $ref: "#/components/parameters/VendorId" },
          { $ref: "#/components/parameters/IdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CertificateRequestInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "Tracked request created; manual upload URLs contain a bearer secret",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
              Location: { $ref: "#/components/headers/Location" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CertificateRequestCreateEnvelope" },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
          "413": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
          "503": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/certificate-requests/{requestId}": {
      get: {
        summary: "Get a tracked certificate request",
        operationId: "getCertificateRequest",
        tags: ["Certificate requests"],
        "x-required-scope": "requests:read",
        parameters: [{ $ref: "#/components/parameters/RequestId" }],
        responses: {
          "200": {
            description: "Tracked request",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CertificateRequestEnvelope" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/certificate-requests/{requestId}/cancel": {
      post: {
        summary: "Cancel an open tracked certificate request",
        operationId: "cancelCertificateRequest",
        tags: ["Certificate requests"],
        "x-required-scope": "requests:write",
        parameters: [
          { $ref: "#/components/parameters/RequestId" },
          { $ref: "#/components/parameters/IdempotencyKey" },
        ],
        responses: {
          "200": {
            description: "Non-sensitive cancellation receipt",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
              "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CertificateRequestCancellationEnvelope",
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendor-types": {
      get: {
        summary: "List vendor types and active requirements",
        operationId: "listVendorTypes",
        tags: ["Requirements"],
        "x-required-scope": "requirements:read",
        responses: {
          "200": {
            description: "Vendor types and rules",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VendorTypePage" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/events": {
      get: {
        summary: "Read the ordered domain-event feed",
        operationId: "listEvents",
        tags: ["Events"],
        "x-required-scope": "events:read",
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" },
        ],
        responses: {
          "200": {
            description: "Ordered event page",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
              "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/EventPage" } },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
          "429": { $ref: "#/components/responses/Problem" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "ocoi_sk_…" },
    },
    parameters: {
      VendorId: {
        name: "vendorId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      CertificateId: {
        name: "certificateId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      RequestId: {
        name: "requestId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]{8,128}$",
        },
      },
      Limit: {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 },
      },
      Cursor: {
        name: "cursor",
        in: "query",
        schema: { type: "string", maxLength: 1_024 },
      },
    },
    headers: {
      XRequestId: {
        description: "Stable request correlation UUID.",
        schema: { type: "string", format: "uuid" },
      },
      OpenCoiVersion: {
        description: "Date-based revision of the /api/v1 contract.",
        schema: { type: "string", const: API_VERSION },
      },
      IdempotentReplayed: {
        description: "Present with value true only when a stored response was replayed.",
        schema: { type: "string", enum: ["true"] },
      },
      ETag: {
        description: "Strong entity tag for vendor optimistic concurrency.",
        schema: { type: "string" },
      },
      Location: {
        description: "Relative URL of the created resource.",
        schema: { type: "string" },
      },
      RetryAfter: {
        description: "Minimum number of seconds to wait before retrying the upload.",
        schema: { type: "integer", minimum: 1 },
      },
    },
    responses: {
      Problem: {
        description: "RFC 9457 Problem Details",
        headers: {
          "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
          "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
        },
        content: {
          "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
        },
      },
      UploadCapacityProblem: {
        description: "Certificate upload capacity is temporarily exhausted.",
        headers: {
          "X-Request-ID": { $ref: "#/components/headers/XRequestId" },
          "OpenCOI-Version": { $ref: "#/components/headers/OpenCoiVersion" },
          "Retry-After": { $ref: "#/components/headers/RetryAfter" },
        },
        content: {
          "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
        },
      },
    },
    schemas: {
      VendorStatus: {
        type: "string",
        enum: ["active", "inactive", "archived"],
      },
      VendorInput: {
        type: "object",
        additionalProperties: false,
        required: ["vendorTypeId", "legalName"],
        properties: {
          vendorTypeId: { type: "string", minLength: 1, maxLength: 128 },
          legalName: { type: "string", minLength: 1, maxLength: 240 },
          tradeName: { type: ["string", "null"], maxLength: 240 },
          contactName: { type: ["string", "null"], maxLength: 200 },
          contactEmail: { type: ["string", "null"], format: "email", maxLength: 320 },
          contactPhone: { type: ["string", "null"], maxLength: 80 },
          externalReference: { type: ["string", "null"], maxLength: 200 },
          notes: { type: ["string", "null"], maxLength: 5_000 },
        },
      },
      Vendor: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "vendorType",
          "legalName",
          "tradeName",
          "contact",
          "externalReference",
          "status",
          "notes",
          "latestCertificate",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          vendorType: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          legalName: { type: "string" },
          tradeName: { type: ["string", "null"] },
          contact: {
            type: "object",
            additionalProperties: false,
            required: ["name", "email", "phone"],
            properties: {
              name: { type: ["string", "null"] },
              email: { type: ["string", "null"] },
              phone: { type: ["string", "null"] },
            },
          },
          externalReference: { type: ["string", "null"] },
          status: { $ref: "#/components/schemas/VendorStatus" },
          notes: { type: ["string", "null"] },
          latestCertificate: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/VendorLatestCertificate" }],
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      VendorLatestCertificate: {
        type: "object",
        additionalProperties: false,
        required: ["id", "complianceStatus", "expirationDate"],
        properties: {
          id: { type: "string" },
          complianceStatus: { type: ["string", "null"] },
          expirationDate: { type: ["string", "null"], format: "date" },
        },
      },
      VendorPatch: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          vendorTypeId: { type: "string", minLength: 1, maxLength: 128 },
          legalName: { type: "string", minLength: 1, maxLength: 240 },
          tradeName: { type: ["string", "null"], maxLength: 240 },
          contactName: { type: ["string", "null"], maxLength: 200 },
          contactEmail: { type: ["string", "null"], format: "email", maxLength: 320 },
          contactPhone: { type: ["string", "null"], maxLength: 80 },
          externalReference: { type: ["string", "null"], maxLength: 200 },
          notes: { type: ["string", "null"], maxLength: 5_000 },
          status: { $ref: "#/components/schemas/VendorStatus" },
        },
      },
      VendorEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Vendor" } },
      },
      VendorMutationReceipt: {
        type: "object",
        additionalProperties: false,
        required: ["id", "result", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          result: { type: "string", enum: ["created", "updated"] },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      VendorMutationEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/VendorMutationReceipt" } },
      },
      CertificateSubmissionMetadata: {
        type: "object",
        description:
          "Client-generated extraction proposal. Strong endorsement evidence must cite at least one page in the submitted contiguous page metadata.",
        properties: {
          extractionVersion: { type: "string", maxLength: 100 },
          extractionMethod: { type: "string", maxLength: 100 },
          rawText: { type: "string", maxLength: 2_000_000, default: "" },
          pages: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/ExtractedPage" },
          },
          reviewStatus: {
            type: "string",
            enum: ["CONFIRMED", "UNCONFIRMED"],
            default: "UNCONFIRMED",
            description: "The API ignores CONFIRMED and always creates an unconfirmed record.",
          },
          namedInsured: { type: "string", maxLength: 500, default: "" },
          issueDate: { type: ["string", "null"], format: "date" },
          producer: { type: ["string", "null"], maxLength: 500 },
          certificateHolder: { type: ["string", "null"], maxLength: 500 },
          provenance: {
            type: "array",
            maxItems: 2_000,
            default: [],
            items: { $ref: "#/components/schemas/ExtractionProvenanceInput" },
          },
          policies: {
            type: "array",
            maxItems: 50,
            default: [],
            items: { $ref: "#/components/schemas/CertificatePolicyInput" },
          },
        },
      },
      ExtractedPage: {
        type: "object",
        additionalProperties: false,
        required: ["page", "text", "method"],
        properties: {
          page: { type: "integer", minimum: 1, maximum: 100 },
          text: { type: "string", maxLength: 2_000_000 },
          method: { type: "string", enum: ["text_layer", "ocr"] },
          confidenceBps: { type: "integer", minimum: 0, maximum: 10_000 },
        },
      },
      ExtractionProvenanceInput: {
        type: "object",
        additionalProperties: false,
        required: ["field", "extractedValue", "source", "rawText", "page"],
        properties: {
          field: {
            type: "string",
            enum: [
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
            ],
          },
          extractedValue: {
            oneOf: [
              { type: "string", maxLength: 500 },
              { type: "integer", minimum: 0 },
            ],
          },
          policyIndex: { type: "integer", minimum: 0, maximum: 49 },
          endorsementIndex: { type: "integer", minimum: 0, maximum: 99 },
          limitType: { $ref: "#/components/schemas/LimitType" },
          source: { type: "string", const: "OCR" },
          confidenceBps: { type: "integer", minimum: 0, maximum: 10_000 },
          rawText: { type: "string", minLength: 1, maxLength: 2_000 },
          page: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      CertificatePolicyInput: {
        type: "object",
        required: ["coverageType"],
        properties: {
          coverageType: { type: "string", minLength: 1, maxLength: 100 },
          insurer: { type: ["string", "null"], maxLength: 500 },
          insurerName: { type: ["string", "null"], maxLength: 500 },
          policyNumber: { type: ["string", "null"], maxLength: 500 },
          effectiveDate: { type: ["string", "null"], format: "date" },
          expirationDate: { type: ["string", "null"], format: "date" },
          limits: { $ref: "#/components/schemas/Limits" },
          endorsements: {
            type: "array",
            maxItems: 100,
            default: [],
            items: { $ref: "#/components/schemas/EndorsementInput" },
          },
        },
      },
      EndorsementInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          evidenceLevel: {
            allOf: [{ $ref: "#/components/schemas/EndorsementEvidenceLevel" }],
            default: "MENTIONED",
          },
          formCode: { type: "string", minLength: 1, maxLength: 100 },
          sourcePages: {
            type: "array",
            maxItems: 100,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 100 },
            description: "Must be strictly ascending; required for ATTACHED and HUMAN_VERIFIED.",
          },
        },
      },
      Certificate: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "vendorId",
          "originalFilename",
          "sha256",
          "pageCount",
          "documentStatus",
          "checkStatus",
          "lifecycleStatus",
          "issueDate",
          "namedInsured",
          "producer",
          "certificateHolder",
          "uploadedAt",
          "confirmedAt",
          "requirementVersion",
          "evaluationVendorType",
          "evaluatedRuleset",
          "evaluationDate",
          "reviewDecision",
          "evidence",
          "policies",
          "findings",
        ],
        properties: {
          id: { type: "string" },
          vendorId: { type: "string" },
          originalFilename: { type: "string" },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          pageCount: { type: ["integer", "null"], minimum: 1, maximum: 100 },
          documentStatus: {
            type: "string",
            enum: ["pending_review", "confirmed", "superseded", "rejected"],
          },
          checkStatus: {
            type: "string",
            enum: ["meets", "deficient", "needs_review", "approved_exception", "not_submitted"],
          },
          lifecycleStatus: {
            type: "string",
            enum: ["current", "expiring", "expired", "future", "unknown"],
          },
          issueDate: { type: ["string", "null"], format: "date" },
          namedInsured: { type: "string" },
          producer: { type: ["string", "null"] },
          certificateHolder: { type: ["string", "null"] },
          uploadedAt: { type: "string", format: "date-time" },
          confirmedAt: { type: ["string", "null"], format: "date-time" },
          requirementVersion: { type: ["integer", "null"], minimum: 1 },
          evaluationVendorType: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/Identity" }],
          },
          evaluatedRuleset: { $ref: "#/components/schemas/CanonicalValue" },
          evaluationDate: { type: ["string", "null"], format: "date" },
          reviewDecision: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/CertificateReviewDecision" }],
          },
          evidence: {
            type: "array",
            items: {
              oneOf: [
                { $ref: "#/components/schemas/ExtractionCitation" },
                { $ref: "#/components/schemas/EndorsementPageAttestation" },
              ],
              discriminator: { propertyName: "kind" },
            },
          },
          policies: {
            type: "array",
            items: { $ref: "#/components/schemas/CertificatePolicy" },
          },
          findings: {
            type: "array",
            items: { $ref: "#/components/schemas/CertificateFinding" },
          },
        },
      },
      CertificateReviewDecision: {
        type: "object",
        additionalProperties: false,
        required: ["status", "reason", "reviewedAt"],
        properties: {
          status: { type: "string", const: "REJECTED" },
          reason: { type: "string" },
          reviewedAt: { type: "string", format: "date-time" },
        },
      },
      CertificateEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { $ref: "#/components/schemas/Certificate" },
        },
      },
      CertificateSubmissionReceipt: {
        type: "object",
        additionalProperties: false,
        required: ["id", "vendorId", "result", "reviewStatus", "submittedAt"],
        properties: {
          id: { type: "string" },
          vendorId: { type: "string" },
          result: { type: "string", const: "submitted" },
          reviewStatus: { type: "string", const: "UNCONFIRMED" },
          submittedAt: { type: "string", format: "date-time" },
        },
      },
      CertificateSubmissionEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { $ref: "#/components/schemas/CertificateSubmissionReceipt" },
        },
      },
      ExtractionCitation: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "field",
          "extractedValue",
          "policyIndex",
          "endorsementIndex",
          "limitType",
          "confidenceBps",
          "rawText",
          "page",
          "origin",
          "attestationStatus",
        ],
        properties: {
          kind: { type: "string", const: "extraction_citation" },
          field: { type: "string" },
          extractedValue: { type: ["string", "integer"] },
          policyIndex: { type: ["integer", "null"], minimum: 0 },
          endorsementIndex: { type: ["integer", "null"], minimum: 0 },
          limitType: { type: ["string", "null"] },
          confidenceBps: { type: ["integer", "null"], minimum: 0, maximum: 10_000 },
          rawText: { type: "string" },
          page: { type: "integer", minimum: 1, maximum: 100 },
          origin: { type: "string", const: "client_submitted_extraction" },
          attestationStatus: {
            type: "string",
            enum: ["unverified", "reviewer_attested"],
          },
        },
      },
      EndorsementPageAttestation: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "policyIndex",
          "endorsementIndex",
          "endorsementName",
          "formCode",
          "evidenceLevel",
          "sourcePages",
          "sourceDocumentSha256",
          "origin",
          "attestationStatus",
          "attestedByUserId",
          "attestedAt",
        ],
        properties: {
          kind: { type: "string", const: "endorsement_page_attestation" },
          policyIndex: { type: "integer", minimum: 0, maximum: 49 },
          endorsementIndex: { type: "integer", minimum: 0, maximum: 99 },
          endorsementName: { type: "string", minLength: 1, maxLength: 300 },
          formCode: { type: ["string", "null"], maxLength: 100 },
          evidenceLevel: { $ref: "#/components/schemas/EndorsementEvidenceLevel" },
          sourcePages: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 100 },
          },
          sourceDocumentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          origin: { type: "string", const: "submitted_endorsement_page_reference" },
          attestationStatus: { type: "string", const: "reviewer_attested" },
          attestedByUserId: { type: "string", minLength: 1 },
          attestedAt: { type: "string", format: "date-time" },
        },
      },
      CertificatePolicy: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "coverageType",
          "insurer",
          "policyNumber",
          "effectiveDate",
          "expirationDate",
          "eachOccurrence",
          "aggregate",
          "limits",
          "currency",
          "additionalInsured",
          "waiverOfSubrogation",
          "primaryNoncontributory",
          "endorsements",
        ],
        properties: {
          id: { type: "string" },
          coverageType: { type: "string" },
          insurer: { type: "string" },
          policyNumber: { type: "string" },
          effectiveDate: { type: "string" },
          expirationDate: { type: "string" },
          eachOccurrence: { type: ["integer", "null"], minimum: 0 },
          aggregate: { type: ["integer", "null"], minimum: 0 },
          limits: { $ref: "#/components/schemas/Limits" },
          currency: { type: "string" },
          additionalInsured: { type: "boolean" },
          waiverOfSubrogation: { type: "boolean" },
          primaryNoncontributory: { type: "boolean" },
          endorsements: {
            type: "array",
            items: { $ref: "#/components/schemas/Endorsement" },
          },
        },
      },
      Endorsement: {
        type: "object",
        additionalProperties: false,
        required: ["name", "formCode", "evidenceLevel", "evidence"],
        properties: {
          name: { type: "string" },
          formCode: { type: ["string", "null"] },
          evidenceLevel: { $ref: "#/components/schemas/EndorsementEvidenceLevel" },
          sourcePages: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 100 },
          },
          evidence: {
            type: "string",
            enum: ["indicated", "document", "reviewed_document"],
          },
        },
      },
      CertificateFinding: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "ruleCode",
          "coverageType",
          "outcome",
          "severity",
          "reasonCode",
          "message",
          "expected",
          "observed",
          "excepted",
        ],
        properties: {
          id: { type: "string" },
          ruleCode: { type: "string" },
          coverageType: { type: "string" },
          outcome: {
            type: "string",
            enum: ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"],
          },
          severity: { type: "string", enum: ["blocking", "warning", "info"] },
          reasonCode: { type: "string" },
          message: { type: "string" },
          expected: { type: ["string", "null"] },
          observed: { type: ["string", "null"] },
          excepted: { type: "boolean" },
        },
      },
      LimitType: {
        type: "string",
        enum: [
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
        ],
      },
      Limits: {
        type: "object",
        additionalProperties: false,
        properties: {
          EACH_OCCURRENCE: { type: "integer", minimum: 0 },
          DAMAGE_TO_RENTED_PREMISES: { type: "integer", minimum: 0 },
          MEDICAL_EXPENSE: { type: "integer", minimum: 0 },
          PERSONAL_ADVERTISING_INJURY: { type: "integer", minimum: 0 },
          GENERAL_AGGREGATE: { type: "integer", minimum: 0 },
          PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE: { type: "integer", minimum: 0 },
          COMBINED_SINGLE_LIMIT: { type: "integer", minimum: 0 },
          BODILY_INJURY_PER_PERSON: { type: "integer", minimum: 0 },
          BODILY_INJURY_PER_ACCIDENT: { type: "integer", minimum: 0 },
          PROPERTY_DAMAGE_PER_ACCIDENT: { type: "integer", minimum: 0 },
          EACH_ACCIDENT: { type: "integer", minimum: 0 },
          DISEASE_EACH_EMPLOYEE: { type: "integer", minimum: 0 },
          DISEASE_POLICY_LIMIT: { type: "integer", minimum: 0 },
          EACH_CLAIM: { type: "integer", minimum: 0 },
          AGGREGATE: { type: "integer", minimum: 0 },
        },
      },
      EndorsementEvidenceLevel: {
        type: "string",
        enum: ["NONE", "MENTIONED", "SCHEDULED", "ATTACHED", "HUMAN_VERIFIED"],
      },
      CertificateRequestInput: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "deliveryMethod"],
        properties: {
          kind: { type: "string", enum: ["initial", "renewal"] },
          deliveryMethod: { type: "string", enum: ["manual", "smtp"] },
          recipientName: { type: ["string", "null"], maxLength: 200 },
          recipientEmail: { type: ["string", "null"], format: "email", maxLength: 320 },
          sourceCertificateId: {
            type: ["string", "null"],
            maxLength: 128,
            description:
              "Optional certificate in the same organization. When supplied, certificates:read is required in addition to requests:write.",
          },
          ttlDays: { type: "integer", minimum: 1, maximum: 365, default: 14 },
        },
      },
      CertificateRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "vendorId",
          "uploadLinkId",
          "sourceCertificateId",
          "submittedCertificateId",
          "kind",
          "deliveryMethod",
          "deliveryStatus",
          "recipientName",
          "recipientEmail",
          "state",
          "expiresAt",
          "uploadUseCount",
          "uploadRevokedAt",
          "attemptCount",
          "lastAttemptAt",
          "nextAttemptAt",
          "acceptedAt",
          "deliveryError",
          "createdByUserId",
          "submittedAt",
          "cancelledAt",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          vendorId: { type: "string" },
          uploadLinkId: { type: "string", format: "uuid" },
          sourceCertificateId: { type: ["string", "null"] },
          submittedCertificateId: { type: ["string", "null"] },
          kind: { type: "string", enum: ["initial", "renewal"] },
          deliveryMethod: { type: "string", enum: ["manual", "smtp"] },
          deliveryStatus: {
            type: "string",
            enum: [
              "manual_ready",
              "queued",
              "processing",
              "accepted",
              "failed",
              "cancelled",
              "superseded",
              "expired",
            ],
          },
          recipientName: { type: ["string", "null"] },
          recipientEmail: { type: ["string", "null"], format: "email" },
          state: { type: "string", enum: ["open", "submitted", "cancelled", "expired"] },
          expiresAt: { type: "string", format: "date-time" },
          uploadUseCount: { type: "integer", minimum: 0 },
          uploadRevokedAt: { type: ["string", "null"], format: "date-time" },
          attemptCount: { type: "integer", minimum: 0 },
          lastAttemptAt: { type: ["string", "null"], format: "date-time" },
          nextAttemptAt: { type: ["string", "null"], format: "date-time" },
          acceptedAt: { type: ["string", "null"], format: "date-time" },
          deliveryError: { type: ["string", "null"] },
          createdByUserId: { type: ["string", "null"] },
          submittedAt: { type: ["string", "null"], format: "date-time" },
          cancelledAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CertificateRequestEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/CertificateRequest" } },
      },
      CertificateRequestCancellationReceipt: {
        type: "object",
        additionalProperties: false,
        required: ["id", "result", "state", "cancelledAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          result: { type: "string", enum: ["cancelled"] },
          state: { type: "string", enum: ["cancelled"] },
          cancelledAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CertificateRequestCancellationEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { $ref: "#/components/schemas/CertificateRequestCancellationReceipt" },
        },
      },
      CertificateRequestCreateEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: {
            type: "object",
            additionalProperties: false,
            required: ["request", "uploadUrl", "disclosure"],
            properties: {
              request: { $ref: "#/components/schemas/CertificateRequest" },
              uploadUrl: {
                type: ["string", "null"],
                format: "uri",
                description: "Bearer URL returned only for manual delivery.",
              },
              disclosure: { type: "string" },
            },
          },
        },
      },
      CertificateRequestPage: {
        type: "object",
        additionalProperties: false,
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/CertificateRequest" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      Identity: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string" },
        },
      },
      CanonicalValue: {
        anyOf: [
          { type: "null" },
          { type: "boolean" },
          { type: "number" },
          { type: "string" },
          { type: "array", items: { $ref: "#/components/schemas/CanonicalValue" } },
          {
            type: "object",
            additionalProperties: { $ref: "#/components/schemas/CanonicalValue" },
          },
        ],
      },
      EvidenceBundle: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "exportedAt", "payload", "integrity"],
        properties: {
          schemaVersion: { type: "string", const: "1.0" },
          exportedAt: { type: "string", format: "date-time" },
          payload: { $ref: "#/components/schemas/EvidenceBundlePayload" },
          integrity: { $ref: "#/components/schemas/EvidenceBundleIntegrity" },
        },
      },
      EvidenceBundlePayload: {
        type: "object",
        additionalProperties: false,
        required: [
          "generator",
          "scope",
          "exportedBy",
          "sourceDocument",
          "review",
          "machineProposal",
          "confirmedFacts",
          "evidence",
          "requirementSnapshot",
          "findings",
          "exceptions",
          "statusAtExport",
          "audit",
        ],
        properties: {
          generator: {
            type: "object",
            additionalProperties: false,
            required: ["name", "version", "origin"],
            properties: {
              name: { type: "string", const: "OpenCOI" },
              version: { type: "string", minLength: 1 },
              origin: { type: "string", format: "uri" },
            },
          },
          scope: {
            type: "object",
            additionalProperties: false,
            required: ["organization", "vendor", "certificateId"],
            properties: {
              organization: { $ref: "#/components/schemas/Identity" },
              vendor: {
                type: "object",
                additionalProperties: false,
                required: ["id", "legalName", "vendorTypeAtExport"],
                properties: {
                  id: { type: "string", minLength: 1 },
                  legalName: { type: "string" },
                  vendorTypeAtExport: { $ref: "#/components/schemas/Identity" },
                },
              },
              certificateId: { type: "string", minLength: 1 },
            },
          },
          exportedBy: { $ref: "#/components/schemas/Identity" },
          sourceDocument: {
            type: "object",
            additionalProperties: false,
            required: ["id", "originalFilename", "mimeType", "byteSize", "sha256", "uploadedAt"],
            properties: {
              id: { type: "string", minLength: 1 },
              originalFilename: { type: "string" },
              mimeType: { type: "string", const: "application/pdf" },
              byteSize: { type: "integer", minimum: 1 },
              sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              uploadedAt: { type: "string", format: "date-time" },
            },
          },
          review: { $ref: "#/components/schemas/EvidenceReview" },
          machineProposal: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: { $ref: "#/components/schemas/CanonicalValue" },
              },
            ],
          },
          confirmedFacts: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/EvidenceConfirmedFacts" }],
          },
          evidence: {
            type: "array",
            items: {
              oneOf: [
                { $ref: "#/components/schemas/ExtractionCitation" },
                { $ref: "#/components/schemas/EndorsementPageAttestation" },
              ],
            },
          },
          requirementSnapshot: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/EvidenceRequirementSnapshot" }],
          },
          findings: {
            type: "array",
            items: { $ref: "#/components/schemas/EvidenceFinding" },
          },
          exceptions: {
            type: "array",
            items: { $ref: "#/components/schemas/EvidenceException" },
          },
          statusAtExport: {
            type: "object",
            additionalProperties: false,
            required: ["documentCheck", "documentLifecycle", "asOf", "limitation"],
            properties: {
              documentCheck: {
                type: "string",
                enum: ["meets", "deficient", "needs_review", "approved_exception", "not_submitted"],
              },
              documentLifecycle: {
                type: "string",
                enum: ["current", "expiring", "expired", "future", "unknown"],
              },
              asOf: { type: "string", format: "date-time" },
              limitation: { type: "string", minLength: 1 },
            },
          },
          audit: { $ref: "#/components/schemas/EvidenceAudit" },
        },
      },
      EvidenceReview: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "reviewedBy",
          "reviewedAt",
          "evaluationDate",
          "requirementVersion",
          "evaluationVendorType",
        ],
        properties: {
          status: {
            type: "string",
            enum: ["draft", "confirmed", "superseded", "rejected"],
          },
          reviewedBy: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["id", "name"],
                properties: {
                  id: { type: "string", minLength: 1 },
                  name: { type: ["string", "null"] },
                },
              },
            ],
          },
          reviewedAt: { type: ["string", "null"], format: "date-time" },
          evaluationDate: { type: ["string", "null"], format: "date" },
          requirementVersion: { type: ["integer", "null"], minimum: 1 },
          evaluationVendorType: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/Identity" }],
          },
        },
      },
      EvidenceConfirmedFacts: {
        type: "object",
        additionalProperties: false,
        required: ["namedInsured", "issueDate", "producer", "certificateHolder", "policies"],
        properties: {
          namedInsured: { type: ["string", "null"] },
          issueDate: { type: ["string", "null"], format: "date" },
          producer: { type: ["string", "null"] },
          certificateHolder: { type: ["string", "null"] },
          policies: {
            type: "array",
            items: { $ref: "#/components/schemas/CertificatePolicy" },
          },
        },
      },
      EvidenceRequirementSnapshot: {
        type: "object",
        additionalProperties: false,
        required: ["version", "vendorType", "evaluatedRuleset", "publication"],
        properties: {
          version: { type: "integer", minimum: 1 },
          vendorType: { $ref: "#/components/schemas/Identity" },
          evaluatedRuleset: {
            type: "object",
            additionalProperties: { $ref: "#/components/schemas/CanonicalValue" },
          },
          publication: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["id", "publishedAt", "publishedBy", "requirements"],
                properties: {
                  id: { type: "string", minLength: 1 },
                  publishedAt: { type: "string", format: "date-time" },
                  publishedBy: {
                    oneOf: [{ type: "null" }, { $ref: "#/components/schemas/Identity" }],
                  },
                  requirements: {
                    type: "array",
                    items: { $ref: "#/components/schemas/CanonicalValue" },
                  },
                },
              },
            ],
          },
        },
      },
      EvidenceFinding: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "requirementId",
          "category",
          "outcome",
          "code",
          "severity",
          "coverageType",
          "title",
          "message",
          "expected",
          "observed",
          "evidenceIds",
          "evaluatedAt",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          requirementId: { type: ["string", "null"] },
          category: { type: "string" },
          outcome: { type: "string" },
          code: { type: "string" },
          severity: { type: "string" },
          coverageType: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          message: { type: "string" },
          expected: { $ref: "#/components/schemas/CanonicalValue" },
          observed: { $ref: "#/components/schemas/CanonicalValue" },
          evidenceIds: { type: "array", items: { type: "string" } },
          evaluatedAt: { type: "string", format: "date-time" },
        },
      },
      EvidenceException: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "findingId",
          "status",
          "request",
          "decisionReason",
          "requestedBy",
          "requestedAt",
          "decidedBy",
          "decidedAt",
          "expiresAt",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          findingId: { type: "string", minLength: 1 },
          status: {
            type: "string",
            enum: ["pending", "approved", "rejected", "revoked", "expired"],
          },
          request: { $ref: "#/components/schemas/CanonicalValue" },
          decisionReason: { type: ["string", "null"] },
          requestedBy: { $ref: "#/components/schemas/Identity" },
          requestedAt: { type: "string", format: "date-time" },
          decidedBy: {
            oneOf: [{ type: "null" }, { $ref: "#/components/schemas/Identity" }],
          },
          decidedAt: { type: ["string", "null"], format: "date-time" },
          expiresAt: { type: ["string", "null"], format: "date" },
        },
      },
      EvidenceAudit: {
        type: "object",
        additionalProperties: false,
        required: [
          "organizationChainVerifiedAtExport",
          "checkedEvents",
          "error",
          "head",
          "certificateEvents",
        ],
        properties: {
          organizationChainVerifiedAtExport: { type: "boolean" },
          checkedEvents: { type: "integer", minimum: 0 },
          error: { type: ["string", "null"] },
          head: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["sequence", "eventHash", "occurredAt"],
                properties: {
                  sequence: { type: "integer", minimum: 1 },
                  eventHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  occurredAt: { type: "string", format: "date-time" },
                },
              },
            ],
          },
          certificateEvents: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "sequence",
                "id",
                "actorType",
                "actorUserId",
                "action",
                "entityType",
                "entityId",
                "occurredAt",
                "metadata",
                "previousHash",
                "eventHash",
              ],
              properties: {
                sequence: { type: "integer", minimum: 1 },
                id: { type: "string", minLength: 1 },
                actorType: { type: "string" },
                actorUserId: { type: ["string", "null"] },
                action: { type: "string" },
                entityType: { type: "string" },
                entityId: { type: ["string", "null"] },
                occurredAt: { type: "string", format: "date-time" },
                metadata: { $ref: "#/components/schemas/CanonicalValue" },
                previousHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                eventHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
            },
          },
        },
      },
      EvidenceBundleIntegrity: {
        type: "object",
        additionalProperties: false,
        required: ["canonicalization", "digest", "signature"],
        properties: {
          canonicalization: { type: "string", const: "OPENCOI_CANONICAL_JSON_V1" },
          digest: {
            type: "object",
            additionalProperties: false,
            required: ["algorithm", "value"],
            properties: {
              algorithm: { type: "string", const: "SHA-256" },
              value: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
          },
          signature: {
            type: "object",
            additionalProperties: false,
            required: ["algorithm", "keyId", "publicKeySpki", "publicKeyFingerprint", "value"],
            properties: {
              algorithm: { type: "string", const: "Ed25519" },
              keyId: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$",
                description:
                  "Unauthenticated legacy v1 display metadata outside the canonical signed record. Do not use it for signer identity.",
              },
              publicKeySpki: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 8_192 },
              publicKeyFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
              value: { type: "string", pattern: "^[A-Za-z0-9_-]{86}$" },
            },
          },
        },
      },
      VendorTypePage: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/VendorType" },
          },
        },
      },
      VendorType: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "description", "active", "requirements", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          active: { type: "boolean" },
          requirements: {
            type: "array",
            items: { $ref: "#/components/schemas/CoverageRequirement" },
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CoverageRequirement: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "coverageType",
          "minimumEachOccurrence",
          "minimumAggregate",
          "minimumCombinedSingleLimit",
          "maximumDeductible",
          "requiresAdditionalInsured",
          "requiresWaiverOfSubrogation",
          "requiresPrimaryNoncontributory",
          "requiresCancellationNotice",
          "requiredEndorsements",
        ],
        properties: {
          id: { type: "string" },
          coverageType: { type: "string" },
          minimumEachOccurrence: { type: ["integer", "null"], minimum: 0 },
          minimumAggregate: { type: ["integer", "null"], minimum: 0 },
          minimumCombinedSingleLimit: { type: ["integer", "null"], minimum: 0 },
          maximumDeductible: { type: ["integer", "null"], minimum: 0 },
          requiresAdditionalInsured: { type: "boolean" },
          requiresWaiverOfSubrogation: { type: "boolean" },
          requiresPrimaryNoncontributory: { type: "boolean" },
          requiresCancellationNotice: { type: "boolean" },
          requiredEndorsements: {
            type: "array",
            items: { $ref: "#/components/schemas/CanonicalValue" },
          },
        },
      },
      ComplianceEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: {
            type: "object",
            additionalProperties: false,
            required: ["vendorId", "certificate", "findings", "policies"],
            properties: {
              vendorId: { type: "string" },
              certificate: {
                oneOf: [{ type: "null" }, { $ref: "#/components/schemas/ComplianceCertificate" }],
              },
              findings: {
                type: "array",
                items: { $ref: "#/components/schemas/ComplianceFindingRow" },
              },
              policies: {
                type: "array",
                items: { $ref: "#/components/schemas/CompliancePolicyRow" },
              },
            },
          },
        },
      },
      ComplianceCertificate: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "confirmation_status",
          "compliance_status",
          "earliest_effective_date",
          "earliest_expiration_date",
          "confirmed_at",
          "updated_at",
        ],
        properties: {
          id: { type: "string" },
          confirmation_status: {
            type: "string",
            enum: ["draft", "confirmed", "superseded", "rejected"],
          },
          compliance_status: {
            type: "string",
            enum: ["pending_review", "compliant", "non_compliant", "exception", "expired"],
          },
          earliest_effective_date: { type: ["string", "null"], format: "date" },
          earliest_expiration_date: { type: ["string", "null"], format: "date" },
          confirmed_at: { type: ["string", "null"], format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      ComplianceFindingRow: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "category",
          "evaluation_status",
          "code",
          "severity",
          "coverage_type",
          "title",
          "message",
          "expected_json",
          "actual_json",
          "evidence_ids_json",
          "status",
          "created_at",
          "updated_at",
        ],
        properties: {
          id: { type: "string" },
          category: { type: "string" },
          evaluation_status: {
            type: "string",
            enum: ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"],
          },
          code: { type: "string" },
          severity: { type: "string", enum: ["critical", "warning", "info"] },
          coverage_type: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          message: { type: "string" },
          expected_json: { type: ["string", "null"] },
          actual_json: { type: ["string", "null"] },
          evidence_ids_json: { type: "string" },
          status: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      CompliancePolicyRow: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "coverage_type",
          "insurer_name",
          "insurer_naic",
          "policy_number",
          "effective_date",
          "expiration_date",
          "each_occurrence_limit",
          "aggregate_limit",
          "combined_single_limit",
          "deductible",
          "additional_insured",
          "waiver_of_subrogation",
          "primary_noncontributory",
          "cancellation_notice",
        ],
        properties: {
          id: { type: "string" },
          coverage_type: { type: "string" },
          insurer_name: { type: ["string", "null"] },
          insurer_naic: { type: ["string", "null"] },
          policy_number: { type: ["string", "null"] },
          effective_date: { type: ["string", "null"], format: "date" },
          expiration_date: { type: ["string", "null"], format: "date" },
          each_occurrence_limit: { type: ["integer", "null"], minimum: 0 },
          aggregate_limit: { type: ["integer", "null"], minimum: 0 },
          combined_single_limit: { type: ["integer", "null"], minimum: 0 },
          deductible: { type: ["integer", "null"], minimum: 0 },
          additional_insured: { type: ["integer", "null"], enum: [0, 1, null] },
          waiver_of_subrogation: { type: ["integer", "null"], enum: [0, 1, null] },
          primary_noncontributory: { type: ["integer", "null"], enum: [0, 1, null] },
          cancellation_notice: { type: ["integer", "null"], enum: [0, 1, null] },
        },
      },
      DomainEvent: {
        type: "object",
        additionalProperties: false,
        required: ["id", "sequence", "type", "occurredAt", "resource", "data"],
        properties: {
          id: { type: "string", format: "uuid" },
          sequence: { type: "integer", minimum: 1 },
          type: { type: "string" },
          occurredAt: { type: "string", format: "date-time" },
          resource: {
            type: "object",
            additionalProperties: false,
            required: ["type", "id"],
            properties: {
              type: { type: "string" },
              id: { type: ["string", "null"] },
            },
          },
          data: {},
        },
      },
      PageMeta: {
        type: "object",
        additionalProperties: false,
        required: ["limit", "hasMore", "nextCursor"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
          hasMore: { type: "boolean" },
          nextCursor: { type: ["string", "null"] },
        },
      },
      VendorPage: {
        type: "object",
        additionalProperties: false,
        required: ["data", "meta"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Vendor" } },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      EventPage: {
        type: "object",
        additionalProperties: false,
        required: ["data", "meta"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/DomainEvent" } },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      Problem: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "status", "detail", "instance", "requestId"],
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
          instance: { type: "string" },
          requestId: { type: "string", format: "uuid" },
          errors: {},
        },
      },
    },
  },
} as const;

export const createApiV1Router = (dependencies: ApiV1Dependencies): Router => {
  const router = Router();
  const now = dependencies.now ?? (() => new Date());
  router.use(apiV1RequestMetadata);
  router.get("/openapi.json", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.json(openApiDocument);
  });
  router.use(authenticateApi(dependencies));
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/vendors", requireScope("vendors:read"), (request, response) => {
    const context = apiContext(response);
    const limit = numberParameter(request.query.limit, 50);
    const cursor = decodeVendorCursor(request.query.cursor);
    const status = request.query.status;
    if (
      status !== undefined &&
      (typeof status !== "string" || !["active", "inactive", "archived"].includes(status))
    ) {
      throw new ApiProblem(400, "status is invalid", "Invalid query parameter");
    }
    const rows = dependencies.database
      .prepare(
        `SELECT v.*, vt.name AS vendor_type_name,
                c.id AS latest_certificate_id,
                c.compliance_status AS latest_compliance_status,
                c.earliest_expiration_date AS latest_expiration_date
         FROM vendors v
         JOIN vendor_types vt
           ON vt.organization_id = v.organization_id AND vt.id = v.vendor_type_id
         LEFT JOIN certificates c
           ON c.organization_id = v.organization_id AND c.vendor_id = v.id
          AND c.id = (
            SELECT c2.id FROM certificates c2
            WHERE c2.organization_id = v.organization_id AND c2.vendor_id = v.id
              AND c2.confirmation_status <> 'rejected'
            ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1
          )
         WHERE v.organization_id = ?
           AND (? IS NULL OR v.status = ?)
           AND (
             ? IS NULL OR v.legal_name > ? COLLATE NOCASE OR
             (v.legal_name = ? COLLATE NOCASE AND v.id > ?)
           )
         ORDER BY v.legal_name COLLATE NOCASE, v.id LIMIT ?`,
      )
      .all(
        context.serviceAccount.organizationId,
        status ?? null,
        status ?? null,
        cursor?.name ?? null,
        cursor?.name ?? null,
        cursor?.name ?? null,
        cursor?.id ?? null,
        limit + 1,
      ) as unknown as VendorApiRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ name: last.legal_name, id: last.id }) : null;
    response.json({
      data: page.map(vendorResource),
      meta: { limit, hasMore: Boolean(nextCursor), nextCursor },
    });
  });

  router.post("/vendors", requireScope("vendors:write"), (request, response) => {
    const idempotency = prepareIdempotencyRequest(request);
    const existing = findIdempotentResponse(dependencies, request, response, idempotency);
    if (existing) {
      sendIdempotentResponse(dependencies, response, existing);
      return;
    }
    const input = vendorCreateSchema.parse(request.body);
    const context = apiContext(response);
    const organizationId = context.serviceAccount.organizationId;
    const payload = transaction(dependencies.database, () => {
      const concurrent = findIdempotentResponse(dependencies, request, response, idempotency);
      if (concurrent) return { kind: "replayed" as const, record: concurrent };
      const repository = createOrganizationRepository(dependencies.database, organizationId);
      if (!repository.getVendorType(input.vendorTypeId)) {
        throw new ApiProblem(
          400,
          "vendorTypeId does not identify a vendor type in this organization",
          "Invalid reference",
        );
      }
      const vendor = repository.createVendor({
        vendorTypeId: input.vendorTypeId,
        legalName: input.legalName,
        tradeName: input.tradeName ?? undefined,
        contactName: input.contactName ?? undefined,
        contactEmail: input.contactEmail ?? undefined,
        contactPhone: input.contactPhone ?? undefined,
        externalReference: input.externalReference ?? undefined,
        notes: input.notes ?? undefined,
      });
      publishDomainEvent(dependencies.database, {
        organizationId,
        type: "vendor.created",
        resourceType: "vendor",
        resourceId: vendor.id,
        data: { legalName: vendor.legal_name, vendorTypeId: vendor.vendor_type_id },
        actorType: "service_account",
        actorId: context.serviceAccount.id,
        at: now().toISOString(),
      });
      appendApiAuditEvent(dependencies, request, response, organizationId, {
        action: "vendor.created_via_api",
        entityType: "vendor",
        entityId: vendor.id,
        occurredAt: now().toISOString(),
        metadata: {
          legalName: vendor.legal_name,
          vendorTypeId: vendor.vendor_type_id,
        },
      });
      const selected = selectVendor(dependencies.database, organizationId, vendor.id);
      if (!selected) throw new ApiProblem(500, "Created vendor could not be read");
      const resource = vendorResource(selected);
      const body = {
        data: { id: selected.id, result: "created" as const, updatedAt: selected.updated_at },
      };
      const location = `/api/v1/vendors/${selected.id}`;
      const etag = etagFor(resource);
      storeIdempotentResponse(
        dependencies,
        request,
        response,
        idempotency.key,
        idempotency.hash,
        201,
        body,
        { etag, location },
      );
      return { kind: "created" as const, body, etag, location };
    });
    if (payload.kind === "replayed") {
      sendIdempotentResponse(dependencies, response, payload.record);
      return;
    }
    response.status(201).setHeader("Location", payload.location);
    response.setHeader("ETag", payload.etag);
    response.json(payload.body);
  });

  router.get("/vendors/:vendorId", requireScope("vendors:read"), (request, response) => {
    const context = apiContext(response);
    const row = selectVendor(
      dependencies.database,
      context.serviceAccount.organizationId,
      String(request.params.vendorId),
    );
    if (!row) throw new ApiProblem(404, "Vendor not found", "Not Found");
    const resource = vendorResource(row);
    response.setHeader("ETag", etagFor(resource));
    response.json({ data: resource });
  });

  router.patch("/vendors/:vendorId", requireScope("vendors:write"), (request, response) => {
    const idempotency = prepareIdempotencyRequest(request);
    const existing = findIdempotentResponse(dependencies, request, response, idempotency);
    if (existing) {
      sendIdempotentResponse(dependencies, response, existing);
      return;
    }
    const input = vendorPatchSchema.parse(request.body);
    const context = apiContext(response);
    const organizationId = context.serviceAccount.organizationId;
    const ifMatch = request.get("if-match");
    if (!ifMatch)
      throw new ApiProblem(428, "If-Match is required for updates", "Precondition Required");
    const payload = transaction(dependencies.database, () => {
      // Read and validate the precondition only after obtaining SQLite's write
      // reservation. This prevents two processes that read the same ETag from
      // both succeeding when their clocks produce the same updated_at value.
      const concurrent = findIdempotentResponse(dependencies, request, response, idempotency);
      if (concurrent) return { kind: "replayed" as const, record: concurrent };
      const current = selectVendor(
        dependencies.database,
        organizationId,
        String(request.params.vendorId),
      );
      if (!current) throw new ApiProblem(404, "Vendor not found", "Not Found");
      if (ifMatch !== etagFor(vendorResource(current))) {
        throw new ApiProblem(412, "The vendor changed after it was read", "Precondition Failed");
      }
      if (input.vendorTypeId) {
        const repository = createOrganizationRepository(dependencies.database, organizationId);
        if (!repository.getVendorType(input.vendorTypeId)) {
          throw new ApiProblem(
            400,
            "vendorTypeId does not identify a vendor type in this organization",
            "Invalid reference",
          );
        }
      }
      const value = <T>(key: keyof typeof input, fallback: T): T =>
        Object.hasOwn(input, key) ? (input[key] as T) : fallback;
      const at = now().toISOString();
      const update = dependencies.database
        .prepare(
          `UPDATE vendors SET vendor_type_id = ?, legal_name = ?, trade_name = ?,
               contact_name = ?, contact_email = ?, contact_phone = ?, external_reference = ?,
               status = ?, notes = ?, updated_at = ?
           WHERE organization_id = ? AND id = ? AND updated_at = ?`,
        )
        .run(
          input.vendorTypeId ?? current.vendor_type_id,
          input.legalName ?? current.legal_name,
          value("tradeName", current.trade_name),
          value("contactName", current.contact_name),
          value("contactEmail", current.contact_email),
          value("contactPhone", current.contact_phone),
          value("externalReference", current.external_reference),
          input.status ?? current.status,
          value("notes", current.notes),
          at,
          organizationId,
          current.id,
          current.updated_at,
        );
      if (Number(update.changes) !== 1) {
        throw new ApiProblem(412, "The vendor changed after it was read", "Precondition Failed");
      }
      if ((input.status ?? current.status) !== "active") {
        const cancelledRequests = cancelOpenCertificateRequestsForVendor(dependencies.database, {
          organizationId,
          vendorId: current.id,
          at,
        });
        for (const cancelled of cancelledRequests) {
          publishDomainEvent(dependencies.database, {
            organizationId,
            type: "certificate_request.cancelled",
            resourceType: "certificate_request",
            resourceId: cancelled.id,
            data: {
              vendorId: current.id,
              kind: cancelled.kind,
              reason: "vendor_inactive",
            },
            actorType: "service_account",
            actorId: context.serviceAccount.id,
            at,
          });
          appendApiAuditEvent(dependencies, request, response, organizationId, {
            action: "certificate_request.cancelled_via_api",
            entityType: "certificate_request",
            entityId: cancelled.id,
            occurredAt: at,
            metadata: {
              vendorId: current.id,
              kind: cancelled.kind,
              reason: "vendor_inactive",
            },
          });
        }
      }
      publishDomainEvent(dependencies.database, {
        organizationId,
        type: "vendor.updated",
        resourceType: "vendor",
        resourceId: current.id,
        data: { changedFields: Object.keys(input).sort() },
        actorType: "service_account",
        actorId: context.serviceAccount.id,
        at,
      });
      appendApiAuditEvent(dependencies, request, response, organizationId, {
        action: "vendor.updated_via_api",
        entityType: "vendor",
        entityId: current.id,
        occurredAt: at,
        metadata: {
          changedFields: Object.keys(input).sort(),
        },
      });
      const selected = selectVendor(dependencies.database, organizationId, current.id);
      if (!selected) throw new ApiProblem(500, "Updated vendor could not be read");
      const resource = vendorResource(selected);
      const body = {
        data: { id: selected.id, result: "updated" as const, updatedAt: selected.updated_at },
      };
      const etag = etagFor(resource);
      storeIdempotentResponse(
        dependencies,
        request,
        response,
        idempotency.key,
        idempotency.hash,
        200,
        body,
        { etag },
      );
      return { kind: "updated" as const, body, etag };
    });
    if (payload.kind === "replayed") {
      sendIdempotentResponse(dependencies, response, payload.record);
      return;
    }
    response.setHeader("ETag", payload.etag);
    response.json(payload.body);
  });

  router.post(
    "/vendors/:vendorId/certificates",
    requireScope("certificates:write"),
    dependencies.uploadCapacity,
    certificateUpload(dependencies.config),
    async (request, response) => {
      if (!request.file) {
        throw new ApiProblem(400, "A PDF document field is required", "Invalid multipart upload");
      }
      const metadata = multipartMetadata(request.body?.metadata);
      const documentSha256 = createHash("sha256").update(request.file.buffer).digest("hex");
      const idempotency = prepareIdempotencyRequest(request, {
        metadata,
        document: {
          sha256: documentSha256,
          byteSize: request.file.size,
          originalFilename: request.file.originalname,
        },
      });
      const existing = findIdempotentResponse(dependencies, request, response, idempotency);
      if (existing) {
        sendIdempotentResponse(dependencies, response, existing);
        return;
      }
      const context = apiContext(response);
      const organizationId = context.serviceAccount.organizationId;
      const repository = createOrganizationRepository(dependencies.database, organizationId);
      const vendor = repository.getVendor(String(request.params.vendorId));
      if (vendor?.status !== "active") {
        throw new ApiProblem(404, "Active vendor not found", "Not Found");
      }

      let body: {
        data: {
          id: string;
          vendorId: string;
          result: "submitted";
          reviewStatus: "UNCONFIRMED";
          submittedAt: string;
        };
      } | null = null;
      const locationFor = (certificateId: string): string =>
        `/api/v1/certificates/${certificateId}`;
      try {
        const result = await ingestCertificate({
          database: dependencies.database,
          repository,
          documentStore: dependencies.documentStore,
          vendorId: vendor.id,
          originalFilename: request.file.originalname,
          bytes: request.file.buffer,
          metadata,
          forceUnconfirmed: true,
          submittedByServiceAccountId: context.serviceAccount.id,
          now: now(),
          withinTransaction: (created) => {
            const concurrent = findIdempotentResponse(dependencies, request, response, idempotency);
            if (concurrent) throw new IdempotentReplay(concurrent);
            body = {
              data: {
                id: created.certificate.id,
                vendorId: vendor.id,
                result: "submitted",
                reviewStatus: "UNCONFIRMED",
                submittedAt: created.certificate.created_at,
              },
            };
            const at = now().toISOString();
            appendApiAuditEvent(dependencies, request, response, organizationId, {
              action: "certificate.submitted_via_api",
              entityType: "certificate",
              entityId: created.certificate.id,
              occurredAt: at,
              metadata: {
                vendorId: vendor.id,
                documentId: created.document.id,
                sha256: created.document.sha256,
                forcedReviewStatus: "UNCONFIRMED",
              },
            });
            storeIdempotentResponse(
              dependencies,
              request,
              response,
              idempotency.key,
              idempotency.hash,
              201,
              body,
              { location: locationFor(created.certificate.id) },
            );
          },
        });
        if (!body) throw new ApiProblem(500, "Created certificate response is unavailable");
        response.status(201).setHeader("Location", locationFor(result.certificate.id));
        response.json(body);
      } catch (error) {
        if (error instanceof IdempotentReplay) {
          sendIdempotentResponse(dependencies, response, error.record);
          return;
        }
        if (
          error instanceof UnsafeDocumentError ||
          error instanceof TypeError ||
          error instanceof RangeError
        ) {
          throw new ApiProblem(400, error.message, "Certificate submission rejected");
        }
        throw error;
      }
    },
  );

  router.get(
    "/certificates/:certificateId",
    requireScope("certificates:read"),
    (request, response) => {
      const context = apiContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        context.serviceAccount.organizationId,
      );
      const view = certificateView(
        dependencies.database,
        repository,
        String(request.params.certificateId),
        now(),
      );
      if (!view) throw new ApiProblem(404, "Certificate not found", "Not Found");
      response.json({ data: view });
    },
  );

  router.get(
    "/certificates/:certificateId/evidence-bundle",
    requireScope("evidence:read"),
    (request, response) => {
      const context = apiContext(response);
      let bundle: ReturnType<typeof buildSignedEvidenceBundle>;
      try {
        bundle = buildSignedEvidenceBundle({
          database: dependencies.database,
          organizationId: context.serviceAccount.organizationId,
          certificateId: String(request.params.certificateId),
          exportedByServiceAccount: {
            id: context.serviceAccount.id,
            name: context.serviceAccount.name,
          },
          appOrigin: dependencies.config.appOrigin,
          tokenPepper: dependencies.config.tokenPepper,
          now: now(),
        });
      } catch (error) {
        if (error instanceof RangeError && error.message.includes("TOKEN_PEPPER")) {
          throw new ApiProblem(503, error.message, "Evidence export unavailable");
        }
        throw error;
      }
      if (!bundle) throw new ApiProblem(404, "Certificate not found", "Not Found");
      appendApiAuditEvent(dependencies, request, response, context.serviceAccount.organizationId, {
        action: "evidence_bundle.exported_via_api",
        entityType: "certificate",
        entityId: String(request.params.certificateId),
        occurredAt: now().toISOString(),
        metadata: {
          digest: bundle.integrity.digest.value,
          signingKeyFingerprint: bundle.integrity.signature.publicKeyFingerprint,
        },
      });
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="opencoi-evidence-${String(request.params.certificateId)}.json"`,
      );
      response.type("application/json").send(`${JSON.stringify(bundle, null, 2)}\n`);
    },
  );

  router.get(
    "/vendors/:vendorId/certificate-requests",
    requireScope("requests:read"),
    (request, response) => {
      const context = apiContext(response);
      const repository = createOrganizationRepository(
        dependencies.database,
        context.serviceAccount.organizationId,
      );
      const vendor = repository.getVendor(String(request.params.vendorId));
      if (!vendor) throw new ApiProblem(404, "Vendor not found", "Not Found");
      const limit = numberParameter(request.query.limit, 50);
      const cursor = decodeCertificateRequestCursor(request.query.cursor);
      const records = listCertificateRequests(dependencies.database, repository.organizationId, {
        vendorId: vendor.id,
        limit: limit + 1,
        ...(cursor ? { before: cursor } : {}),
      });
      const page = records.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        records.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      response.json({
        data: page.map((record) => certificateRequestResource(record, now())),
        meta: { limit, hasMore: Boolean(nextCursor), nextCursor },
      });
    },
  );

  router.post(
    "/vendors/:vendorId/certificate-requests",
    requireScope("requests:write"),
    (request, response) => {
      if (!dependencies.config.tokenPepper) {
        throw new ApiProblem(
          503,
          "TOKEN_PEPPER is required for secure idempotent certificate requests",
          "Certificate requests unavailable",
        );
      }
      const input = certificateRequestCreateSchema.parse(request.body);
      if (input.deliveryMethod === "smtp" && !dependencies.config.smtp) {
        throw new ApiProblem(409, "SMTP delivery is not configured", "Delivery unavailable");
      }
      const context = apiContext(response);
      const organizationId = context.serviceAccount.organizationId;
      const canReadRecipient = context.serviceAccount.scopes.some(
        (scope) => scope === "vendors:read" || scope === "requests:read",
      );
      if (
        input.sourceCertificateId &&
        !context.serviceAccount.scopes.includes("certificates:read")
      ) {
        throw new ApiProblem(
          403,
          "The certificates:read scope is required when sourceCertificateId is supplied",
          "Forbidden",
        );
      }
      const idempotency = prepareIdempotencyRequest(request);
      const existing = findIdempotentResponse(dependencies, request, response, idempotency);
      if (existing) {
        sendIdempotentResponse(
          dependencies,
          response,
          existing,
          canReadRecipient ? undefined : redactCertificateRequestCreateResponse,
        );
        return;
      }
      const repository = createOrganizationRepository(dependencies.database, organizationId);
      const vendor = repository.getVendor(String(request.params.vendorId));
      if (vendor?.status !== "active") {
        throw new ApiProblem(404, "Active vendor not found", "Not Found");
      }
      const at = now();
      const random = createUploadLinkToken(dependencies.config.tokenPepper);
      const uploadToken = tokenForOrganization(organizationId, random.token);
      let payload:
        | { kind: "replayed"; record: IdempotencyRecord }
        | { kind: "created"; body: unknown; location: string };
      try {
        payload = transaction(dependencies.database, () => {
          const concurrent = findIdempotentResponse(dependencies, request, response, idempotency);
          if (concurrent) return { kind: "replayed" as const, record: concurrent };
          const selectedRecipient = input.recipientEmail ?? vendor.contact_email ?? undefined;
          const created = createCertificateRequest(dependencies.database, {
            organizationId,
            vendorId: vendor.id,
            uploadToken,
            expiresAt: new Date(at.getTime() + input.ttlDays * 86_400_000).toISOString(),
            kind: input.kind,
            deliveryMethod: input.deliveryMethod,
            tokenPepper: dependencies.config.tokenPepper,
            recipientName: input.recipientName ?? vendor.contact_name ?? undefined,
            recipientEmail: selectedRecipient,
            sourceCertificateId: input.sourceCertificateId ?? undefined,
            at: at.toISOString(),
          });
          publishDomainEvent(dependencies.database, {
            organizationId,
            type: "certificate_request.created",
            resourceType: "certificate_request",
            resourceId: created.id,
            data: {
              vendorId: vendor.id,
              kind: created.kind,
              deliveryMethod: created.deliveryMethod,
              expiresAt: created.expiresAt,
            },
            actorType: "service_account",
            actorId: context.serviceAccount.id,
            at: at.toISOString(),
          });
          appendApiAuditEvent(dependencies, request, response, organizationId, {
            action: "certificate_request.created_via_api",
            entityType: "certificate_request",
            entityId: created.id,
            occurredAt: at.toISOString(),
            metadata: {
              vendorId: vendor.id,
              kind: created.kind,
              deliveryMethod: created.deliveryMethod,
              expiresAt: created.expiresAt,
            },
          });
          const body = {
            data: {
              request: certificateRequestResource(created, at, {
                redactRecipient: !canReadRecipient,
              }),
              uploadUrl:
                created.deliveryMethod === "manual"
                  ? publicUploadUrl(dependencies.config.appOrigin, uploadToken)
                  : null,
              disclosure:
                created.deliveryMethod === "smtp"
                  ? "Queued for SMTP acceptance; OpenCOI does not claim inbox delivery or opening."
                  : "The upload URL is a bearer secret. It is replayable with this idempotency key for 24 hours and must be shared only with the intended recipient.",
            },
          };
          const location = `/api/v1/certificate-requests/${created.id}`;
          storeIdempotentResponse(
            dependencies,
            request,
            response,
            idempotency.key,
            idempotency.hash,
            201,
            body,
            { location },
          );
          return { kind: "created" as const, body, location };
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiProblem(409, error.message, "Certificate request conflict");
        }
        if (error instanceof TypeError) {
          throw new ApiProblem(400, error.message, "Certificate request rejected");
        }
        throw error;
      }
      if (payload.kind === "replayed") {
        sendIdempotentResponse(
          dependencies,
          response,
          payload.record,
          canReadRecipient ? undefined : redactCertificateRequestCreateResponse,
        );
        return;
      }
      response.status(201).setHeader("Location", payload.location);
      response.json(payload.body);
    },
  );

  router.get(
    "/certificate-requests/:requestId",
    requireScope("requests:read"),
    (request, response) => {
      const context = apiContext(response);
      const record = getCertificateRequest(
        dependencies.database,
        context.serviceAccount.organizationId,
        String(request.params.requestId),
      );
      if (!record) throw new ApiProblem(404, "Certificate request not found", "Not Found");
      response.json({ data: certificateRequestResource(record, now()) });
    },
  );

  router.post(
    "/certificate-requests/:requestId/cancel",
    requireScope("requests:write"),
    (request, response) => {
      const context = apiContext(response);
      const organizationId = context.serviceAccount.organizationId;
      const idempotency = prepareIdempotencyRequest(request);
      const existing = findIdempotentResponse(dependencies, request, response, idempotency);
      if (existing) {
        sendIdempotentResponse(dependencies, response, existing);
        return;
      }
      const at = now();
      let payload:
        | { kind: "replayed"; record: IdempotencyRecord }
        | { kind: "cancelled"; body: unknown };
      try {
        payload = transaction(dependencies.database, () => {
          const concurrent = findIdempotentResponse(dependencies, request, response, idempotency);
          if (concurrent) return { kind: "replayed" as const, record: concurrent };
          const before = getCertificateRequest(
            dependencies.database,
            organizationId,
            String(request.params.requestId),
          );
          if (!before) throw new ApiProblem(404, "Certificate request not found", "Not Found");
          const cancelled =
            before.state === "cancelled"
              ? before
              : cancelCertificateRequest(dependencies.database, {
                  organizationId,
                  requestId: before.id,
                  at: at.toISOString(),
                });
          if (!cancelled) throw new ApiProblem(404, "Certificate request not found", "Not Found");
          if (cancelled.state !== "cancelled" || !cancelled.cancelledAt) {
            throw new Error("Cancelled certificate request is missing its cancellation timestamp");
          }
          if (before.state !== "cancelled") {
            publishDomainEvent(dependencies.database, {
              organizationId,
              type: "certificate_request.cancelled",
              resourceType: "certificate_request",
              resourceId: cancelled.id,
              data: { vendorId: cancelled.vendorId, kind: cancelled.kind },
              actorType: "service_account",
              actorId: context.serviceAccount.id,
              at: at.toISOString(),
            });
            appendApiAuditEvent(dependencies, request, response, organizationId, {
              action: "certificate_request.cancelled_via_api",
              entityType: "certificate_request",
              entityId: cancelled.id,
              occurredAt: at.toISOString(),
              metadata: {
                vendorId: cancelled.vendorId,
                kind: cancelled.kind,
              },
            });
          }
          const body = {
            data: {
              id: cancelled.id,
              result: "cancelled" as const,
              state: "cancelled" as const,
              cancelledAt: cancelled.cancelledAt,
              updatedAt: cancelled.updatedAt,
            },
          };
          storeIdempotentResponse(
            dependencies,
            request,
            response,
            idempotency.key,
            idempotency.hash,
            200,
            body,
            {},
          );
          return { kind: "cancelled" as const, body };
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiProblem(409, error.message, "Certificate request cannot be cancelled");
        }
        throw error;
      }
      if (payload.kind === "replayed") {
        sendIdempotentResponse(dependencies, response, payload.record);
        return;
      }
      response.json(payload.body);
    },
  );

  router.get("/vendor-types", requireScope("requirements:read"), (_request, response) => {
    const organizationId = apiContext(response).serviceAccount.organizationId;
    const rows = dependencies.database
      .prepare(
        `SELECT vt.id, vt.name, vt.description, vt.is_active, vt.created_at, vt.updated_at,
                COALESCE(json_group_array(
                  CASE WHEN r.id IS NULL THEN NULL ELSE json_object(
                    'id', r.id,
                    'coverageType', r.coverage_type,
                    'minimumEachOccurrence', r.minimum_each_occurrence,
                    'minimumAggregate', r.minimum_aggregate,
                    'minimumCombinedSingleLimit', r.minimum_combined_single_limit,
                    'maximumDeductible', r.maximum_deductible,
                    'requiresAdditionalInsured', json(r.requires_additional_insured),
                    'requiresWaiverOfSubrogation', json(r.requires_waiver_of_subrogation),
                    'requiresPrimaryNoncontributory', json(r.requires_primary_noncontributory),
                    'requiresCancellationNotice', json(r.requires_cancellation_notice),
                    'requiredEndorsements', json(r.required_endorsements_json)
                  ) END
                ), '[]') AS requirements_json
         FROM vendor_types vt
         LEFT JOIN coverage_requirements r
           ON r.organization_id = vt.organization_id AND r.vendor_type_id = vt.id AND r.is_active = 1
         WHERE vt.organization_id = ?
         GROUP BY vt.id ORDER BY vt.name COLLATE NOCASE, vt.id`,
      )
      .all(organizationId) as Array<Record<string, unknown> & { requirements_json: string }>;
    response.json({
      data: rows.map(({ requirements_json: encoded, ...row }) => {
        const requirements = (JSON.parse(encoded) as unknown[])
          .filter(
            (value): value is Record<string, unknown> =>
              Boolean(value) && typeof value === "object" && !Array.isArray(value),
          )
          .map((requirement) => ({
            ...requirement,
            requiresAdditionalInsured:
              requirement.requiresAdditionalInsured === true ||
              requirement.requiresAdditionalInsured === 1,
            requiresWaiverOfSubrogation:
              requirement.requiresWaiverOfSubrogation === true ||
              requirement.requiresWaiverOfSubrogation === 1,
            requiresPrimaryNoncontributory:
              requirement.requiresPrimaryNoncontributory === true ||
              requirement.requiresPrimaryNoncontributory === 1,
            requiresCancellationNotice:
              requirement.requiresCancellationNotice === true ||
              requirement.requiresCancellationNotice === 1,
          }));
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          active: row.is_active === 1,
          requirements,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    });
  });

  router.get(
    "/vendors/:vendorId/compliance",
    requireScope("compliance:read"),
    (request, response) => {
      const organizationId = apiContext(response).serviceAccount.organizationId;
      const vendor = selectVendor(
        dependencies.database,
        organizationId,
        String(request.params.vendorId),
      );
      if (!vendor) throw new ApiProblem(404, "Vendor not found", "Not Found");
      if (!vendor.latest_certificate_id) {
        response.json({
          data: { vendorId: vendor.id, certificate: null, findings: [], policies: [] },
        });
        return;
      }
      const certificate = dependencies.database
        .prepare(
          `SELECT id, confirmation_status, compliance_status, earliest_effective_date,
                earliest_expiration_date, confirmed_at, updated_at
         FROM certificates WHERE organization_id = ? AND id = ?`,
        )
        .get(organizationId, vendor.latest_certificate_id);
      const findings = dependencies.database
        .prepare(
          `SELECT id, category, evaluation_status, code, severity, coverage_type, title,
                message, expected_json, actual_json, evidence_ids_json, status, created_at, updated_at
         FROM findings WHERE organization_id = ? AND certificate_id = ?
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id`,
        )
        .all(organizationId, vendor.latest_certificate_id);
      const policies = dependencies.database
        .prepare(
          `SELECT id, coverage_type, insurer_name, insurer_naic, policy_number,
                effective_date, expiration_date, each_occurrence_limit, aggregate_limit,
                combined_single_limit, deductible, additional_insured,
                waiver_of_subrogation, primary_noncontributory, cancellation_notice
         FROM policies WHERE organization_id = ? AND certificate_id = ?
         ORDER BY coverage_type, id`,
        )
        .all(organizationId, vendor.latest_certificate_id);
      response.json({ data: { vendorId: vendor.id, certificate, findings, policies } });
    },
  );

  router.get("/events", requireScope("events:read"), (request, response) => {
    const organizationId = apiContext(response).serviceAccount.organizationId;
    const limit = numberParameter(request.query.limit, 50);
    const afterSequence = decodeSequenceCursor(request.query.cursor);
    const result = listDomainEvents(dependencies.database, organizationId, {
      afterSequence,
      limit,
    });
    const last = result.events.at(-1);
    response.json({
      data: result.events,
      meta: {
        limit,
        hasMore: result.hasMore,
        nextCursor: result.hasMore && last ? String(last.sequence) : null,
      },
    });
  });

  router.use((_request, _response, next) =>
    next(new ApiProblem(404, "API route not found", "Not Found")),
  );
  router.use(problemHandler);
  return router;
};
