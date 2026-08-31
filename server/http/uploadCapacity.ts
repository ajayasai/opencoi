import type { RequestHandler } from "express";

/**
 * Bounds simultaneous in-memory multipart parsing across browser and service
 * API routes. Reverse-proxy request limits remain a separate deployment layer.
 */
export const createUploadCapacityLimiter = (maximumActive = 2): RequestHandler => {
  if (!Number.isSafeInteger(maximumActive) || maximumActive < 1 || maximumActive > 16) {
    throw new RangeError("Upload concurrency limit must be between 1 and 16");
  }
  let active = 0;
  return (request, response, next) => {
    if (active >= maximumActive) {
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Retry-After", "1");
      if (request.baseUrl === "/api/v1") {
        response.status(503).type("application/problem+json").json({
          type: "about:blank",
          title: "Upload capacity reached",
          status: 503,
          detail: "Too many certificate uploads are being processed; retry shortly",
          instance: request.originalUrl,
          requestId: response.locals.apiRequestId,
        });
      } else {
        response
          .status(503)
          .json({ error: "Too many certificate uploads are being processed; retry shortly" });
      }
      return;
    }

    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
};
