import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { UnsafeDocumentError } from "../storage.js";

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export const asyncRoute =
  (
    handler: (
      request: Parameters<RequestHandler>[0],
      response: Parameters<RequestHandler>[1],
    ) => Promise<unknown>,
  ): RequestHandler =>
  (request, response, next) => {
    void handler(request, response).catch(next);
  };

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, "Not found"));
};

const sqliteConflict = (message: string): boolean =>
  /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);

const sqliteReferenceFailure = (message: string): boolean =>
  /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(message);

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  let status = 500;
  let message = "Internal server error";
  let details: unknown;

  if (error instanceof HttpError) {
    status = error.status;
    message = error.message;
    details = error.details;
  } else if (error instanceof ZodError) {
    status = 400;
    message = "Request validation failed";
    details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  } else if (error instanceof multer.MulterError) {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message =
      error.code === "LIMIT_FILE_SIZE" ? "PDF exceeds the upload size limit" : error.message;
  } else if (error instanceof UnsafeDocumentError) {
    status = 400;
    message = error.message;
  } else if (error instanceof TypeError || error instanceof RangeError) {
    status = 400;
    message = error.message;
  } else if (error instanceof SyntaxError && "body" in error) {
    status = 400;
    message = "Request body is not valid JSON";
  } else if (error instanceof Error && "type" in error && error.type === "entity.too.large") {
    status = 413;
    message = "Request body exceeds the size limit";
  } else if (error instanceof Error && sqliteConflict(error.message)) {
    status = 409;
    message = "A record with those values already exists";
  } else if (error instanceof Error && sqliteReferenceFailure(error.message)) {
    status = 400;
    message = "A referenced record does not exist in this organization";
  }

  const apiV1Request =
    request.originalUrl === "/api/v1" || request.originalUrl.startsWith("/api/v1/");
  if (apiV1Request) {
    const requestId =
      typeof response.locals.apiRequestId === "string"
        ? response.locals.apiRequestId
        : randomUUID();
    response.setHeader("X-Request-ID", requestId);
    response.setHeader("Cache-Control", "private, no-store");
    const title =
      status === 400
        ? "Bad Request"
        : status === 413
          ? "Payload Too Large"
          : status === 429
            ? "Too Many Requests"
            : status === 404
              ? "Not Found"
              : "Internal Server Error";
    const payload: Record<string, unknown> = {
      type: "about:blank",
      title,
      status,
      detail: message,
      instance: request.originalUrl,
      requestId,
    };
    if (details !== undefined) payload.errors = details;
    response.status(status).type("application/problem+json").json(payload);
    return;
  }

  const payload: { error: string; details?: unknown } = { error: message };
  if (details !== undefined) payload.details = details;
  response.status(status).json(payload);
};
