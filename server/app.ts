import { existsSync } from "node:fs";
import { resolve } from "node:path";
import compression from "compression";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import type { OpenCoiDatabase } from "./db.js";
import { errorHandler, HttpError, notFound } from "./http/errors.js";
import { createApiRouter } from "./http/routes.js";
import { ensureApiSchema } from "./services/schema.js";
import type { DocumentStore } from "./storage.js";

export interface CreateAppOptions {
  config: AppConfig;
  database: OpenCoiDatabase;
  documentStore: DocumentStore;
  now?: () => Date;
  staticDirectory?: string | false;
}

export const createApp = (options: CreateAppOptions): Express => {
  ensureApiSchema(options.database);
  const app = express();
  app.disable("x-powered-by");
  // API responses carry authentication and document metadata; do not emit
  // validators that could encourage intermediary or shared-cache retention.
  app.disable("etag");
  // A numeric hop count is explicit and fail-closed by default. Operators must
  // set it to the exact number of controlled proxies in front of this process.
  app.set("trust proxy", options.config.trustProxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:", "blob:"],
          objectSrc: ["'none'"],
          // Tesseract's bundled WebAssembly core needs CSP's narrow WASM
          // compilation capability; JavaScript eval remains disallowed.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          workerSrc: ["'self'", "blob:"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );
  // Bound application work—including health checks and static-file reads—per
  // client. Sensitive endpoints retain their stricter, purpose-specific limits.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_request, _response, next) =>
        next(new HttpError(429, "Too many requests; try again later")),
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/api/health", (_request, response) => {
    const database = options.database.prepare("SELECT 1 AS ok").get() as { ok: number };
    response.setHeader("Cache-Control", "no-store");
    response.json({
      data: {
        status: database.ok === 1 ? "ok" : "degraded",
        version: "0.1.2",
      },
    });
  });
  app.use(
    "/api",
    createApiRouter({
      config: options.config,
      database: options.database,
      documentStore: options.documentStore,
      now: options.now,
    }),
  );
  app.use("/api", notFound);

  const staticDirectory =
    options.staticDirectory === false
      ? null
      : resolve(options.staticDirectory ?? resolve(process.cwd(), "dist/client"));
  if (staticDirectory && existsSync(staticDirectory)) {
    app.use(express.static(staticDirectory, { index: false, fallthrough: true }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || !request.accepts("html")) {
        next();
        return;
      }
      response.sendFile(resolve(staticDirectory, "index.html"));
    });
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
};
