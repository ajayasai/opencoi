import { createHash, randomUUID } from "node:crypto";
import { type ErrorRequestHandler, type RequestHandler, type Response, Router } from "express";
import { ZodError, z } from "zod";
import { appendAuditEvent } from "../audit.js";
import type { AppConfig } from "../config.js";
import { createOrganizationRepository, type OpenCoiDatabase, type VendorRow } from "../db.js";
import { cancelOpenCertificateRequestsForVendor } from "../services/certificateRequests.js";
import { listDomainEvents, publishDomainEvent } from "../services/domainEvents.js";
import {
  type AuthenticatedServiceAccount,
  authenticateServiceAccount,
  type ServiceAccountScope,
} from "../services/serviceAccounts.js";

export const API_VERSION = "2026-08-31";
const MAX_PAGE_SIZE = 100;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface ApiV1Dependencies {
  config: AppConfig;
  database: OpenCoiDatabase;
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

const prepareIdempotencyRequest = (request: Parameters<RequestHandler>[0]): IdempotencyRequest => ({
  key: idempotencyKey(request),
  hash: requestHash(request.method, request.path, request.body),
});

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
      `SELECT method, path, request_hash, response_status, response_json,
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

const sendIdempotentResponse = (response: Response, record: IdempotencyRecord): void => {
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
  response.status(record.response_status).json(JSON.parse(record.response_json));
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
      JSON.stringify(payload),
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
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorPage" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "403": { $ref: "#/components/responses/Problem" },
        },
      },
      post: {
        summary: "Create a vendor",
        operationId: "createVendor",
        tags: ["Vendors"],
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/VendorInput" } },
          },
        },
        responses: {
          "201": {
            description: "Vendor created",
            headers: {
              ETag: { schema: { type: "string" } },
              Location: { schema: { type: "string" } },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorEnvelope" } },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendors/{vendorId}": {
      parameters: [{ $ref: "#/components/parameters/VendorId" }],
      get: {
        summary: "Get a vendor",
        operationId: "getVendor",
        tags: ["Vendors"],
        responses: {
          "200": {
            description: "Vendor and ETag",
            headers: { ETag: { schema: { type: "string" } } },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorEnvelope" } },
            },
          },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
      patch: {
        summary: "Update a vendor",
        operationId: "updateVendor",
        tags: ["Vendors"],
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
            description: "Updated vendor and ETag",
            headers: { ETag: { schema: { type: "string" } } },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorEnvelope" } },
            },
          },
          "412": { $ref: "#/components/responses/Problem" },
          "428": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendors/{vendorId}/compliance": {
      get: {
        summary: "Get the latest document compliance result",
        operationId: "getVendorCompliance",
        tags: ["Compliance"],
        parameters: [{ $ref: "#/components/parameters/VendorId" }],
        responses: {
          "200": {
            description: "Uploaded-document compliance result",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/vendor-types": {
      get: {
        summary: "List vendor types and active requirements",
        operationId: "listVendorTypes",
        tags: ["Requirements"],
        responses: {
          "200": {
            description: "Vendor types and rules",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    "/events": {
      get: {
        summary: "Read the ordered domain-event feed",
        operationId: "listEvents",
        tags: ["Events"],
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" },
        ],
        responses: {
          "200": {
            description: "Ordered event page",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/EventPage" } },
            },
          },
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
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 128 },
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
    responses: {
      Problem: {
        description: "RFC 9457 Problem Details",
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
          latestCertificate: { type: ["object", "null"], additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
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
      sendIdempotentResponse(response, existing);
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
      appendAuditEvent(dependencies.database, organizationId, {
        actorType: "system",
        action: "vendor.created_via_api",
        entityType: "vendor",
        entityId: vendor.id,
        occurredAt: now().toISOString(),
        metadata: {
          serviceAccountId: context.serviceAccount.id,
          legalName: vendor.legal_name,
          vendorTypeId: vendor.vendor_type_id,
        },
      });
      const selected = selectVendor(dependencies.database, organizationId, vendor.id);
      if (!selected) throw new ApiProblem(500, "Created vendor could not be read");
      const body = { data: vendorResource(selected) };
      const location = `/api/v1/vendors/${body.data.id}`;
      const etag = etagFor(body.data);
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
      sendIdempotentResponse(response, payload.record);
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
      sendIdempotentResponse(response, existing);
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
          appendAuditEvent(dependencies.database, organizationId, {
            actorType: "system",
            action: "certificate_request.cancelled_via_api",
            entityType: "certificate_request",
            entityId: cancelled.id,
            occurredAt: at,
            metadata: {
              serviceAccountId: context.serviceAccount.id,
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
      appendAuditEvent(dependencies.database, organizationId, {
        actorType: "system",
        action: "vendor.updated_via_api",
        entityType: "vendor",
        entityId: current.id,
        occurredAt: at,
        metadata: {
          serviceAccountId: context.serviceAccount.id,
          changedFields: Object.keys(input).sort(),
        },
      });
      const selected = selectVendor(dependencies.database, organizationId, current.id);
      if (!selected) throw new ApiProblem(500, "Updated vendor could not be read");
      const body = { data: vendorResource(selected) };
      const etag = etagFor(body.data);
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
      sendIdempotentResponse(response, payload.record);
      return;
    }
    response.setHeader("ETag", payload.etag);
    response.json(payload.body);
  });

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
      data: rows.map(({ requirements_json: encoded, ...row }) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        active: row.is_active === 1,
        requirements: (JSON.parse(encoded) as unknown[]).filter(Boolean),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
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
