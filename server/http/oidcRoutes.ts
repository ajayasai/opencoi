import type { RequestHandler } from "express";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  beginOidcLogin,
  completeOidcLogin,
  OidcLoginError,
  type OidcProtocol,
} from "../auth/oidc.js";
import type { AppConfig } from "../config.js";
import type { OpenCoiDatabase, OrganizationRow } from "../db.js";
import { asyncRoute, HttpError } from "./errors.js";
import {
  cookiesFor,
  csrfCookieName,
  csrfCookieOptions,
  enforceTrustedOrigin,
  sessionCookieOptions,
} from "./middleware.js";

export interface OidcRouterDependencies {
  config: AppConfig;
  database: OpenCoiDatabase;
  protocol?: OidcProtocol;
  now?: () => Date;
}

export const oidcTransactionCookieName = (config: AppConfig): string =>
  `${config.sessionCookieName}_oidc`;

export const oidcTransactionCookieOptions = (config: AppConfig) => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: "lax" as const,
  path: "/api/auth/oidc/callback",
  maxAge: config.oidc?.transactionTtlMs ?? 10 * 60 * 1000,
});

const oidcTransactionCookieClearOptions = (config: AppConfig) => {
  const { maxAge: _maxAge, ...options } = oidcTransactionCookieOptions(config);
  return options;
};

const oidcHttpError = (error: OidcLoginError): HttpError => {
  if (error.code === "not_configured") {
    return new HttpError(503, "Single sign-on is not available");
  }
  if (error.code === "provider_unavailable") {
    return new HttpError(502, "The identity provider is temporarily unavailable");
  }
  return new HttpError(400, "Single sign-on could not be started");
};

export const createOidcRouter = (dependencies: OidcRouterDependencies): Router => {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  router.get("/config", (_request, response) => {
    const provider = dependencies.config.oidc;
    const organization = provider
      ? (dependencies.database
          .prepare("SELECT name FROM organizations WHERE slug = ? COLLATE NOCASE")
          .get(provider.organizationSlug) as Pick<OrganizationRow, "name"> | undefined)
      : undefined;
    response.json({
      data: {
        enabled: Boolean(provider && organization && dependencies.protocol),
        displayName: provider?.displayName ?? null,
        organizationName: organization?.name ?? null,
      },
    });
  });

  router.post(
    "/start",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_request, _response, next) =>
        next(new HttpError(429, "Too many requests; try again later")),
    }),
    enforceTrustedOrigin(dependencies.config),
    asyncRoute(async (_request, response) => {
      if (!dependencies.protocol) {
        throw new HttpError(503, "Single sign-on is not available");
      }
      try {
        const result = await beginOidcLogin({
          config: dependencies.config,
          database: dependencies.database,
          protocol: dependencies.protocol,
          now: dependencies.now?.(),
        });
        response.cookie(
          oidcTransactionCookieName(dependencies.config),
          result.transactionToken,
          oidcTransactionCookieOptions(dependencies.config),
        );
        response.json({
          data: { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt },
        });
      } catch (error) {
        if (error instanceof OidcLoginError) throw oidcHttpError(error);
        throw error;
      }
    }),
  );

  const callback: RequestHandler = (request, response, next) => {
    const run = async () => {
      if (!dependencies.protocol || !dependencies.config.oidc) {
        throw new OidcLoginError("not_configured", "OIDC is not configured");
      }
      const transactionToken =
        cookiesFor(request).get(oidcTransactionCookieName(dependencies.config)) ?? "";
      const returnedState = typeof request.query.state === "string" ? request.query.state : "";
      if (!transactionToken || !returnedState) {
        throw new OidcLoginError("invalid_transaction", "OIDC transaction is missing");
      }
      const result = await completeOidcLogin({
        config: dependencies.config,
        database: dependencies.database,
        protocol: dependencies.protocol,
        currentUrl: new URL(request.originalUrl, `${dependencies.config.appOrigin}/`),
        transactionToken,
        returnedState,
        ipAddress: request.ip,
        userAgent: request.get("user-agent"),
        now: dependencies.now?.(),
      });
      response.cookie(
        dependencies.config.sessionCookieName,
        result.sessionToken,
        sessionCookieOptions(dependencies.config),
      );
      response.cookie(
        csrfCookieName(dependencies.config),
        result.csrfToken,
        csrfCookieOptions(dependencies.config),
      );
      response.clearCookie(
        oidcTransactionCookieName(dependencies.config),
        oidcTransactionCookieClearOptions(dependencies.config),
      );
      response.redirect(303, "/login?sso=success");
    };

    void run().catch((error: unknown) => {
      response.clearCookie(
        oidcTransactionCookieName(dependencies.config),
        oidcTransactionCookieClearOptions(dependencies.config),
      );
      if (error instanceof OidcLoginError) {
        response.redirect(303, "/login?sso=failed");
        return;
      }
      next(error);
    });
  };
  router.get("/callback", callback);

  return router;
};
