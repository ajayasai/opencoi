import type { Request, RequestHandler, Response } from "express";
import type { AppConfig } from "../config.js";
import type { OpenCoiDatabase, SessionRow, UserRow } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import { hashCsrfToken, hashSessionToken, randomToken, verifyOpaqueToken } from "../security.js";
import { HttpError } from "./errors.js";

export interface AuthContext {
  session: SessionRow;
  user: UserRow;
  organizationName: string;
  csrfToken: string;
}

interface SessionLookupRow extends SessionRow {
  user_id_value: string;
  user_organization_id: string;
  user_email: string;
  user_display_name: string;
  user_password_hash: string;
  user_role: UserRow["role"];
  user_status: UserRow["status"];
  user_last_login_at: string | null;
  user_created_at: string;
  user_updated_at: string;
  organization_name: string;
}

const parseCookies = (header: string | undefined): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(raw);
    } catch {
      // Ignore malformed cookie values instead of throwing before authentication.
    }
  }
  return result;
};

export const csrfCookieName = (config: AppConfig): string => `${config.sessionCookieName}_csrf`;

export const sessionCookieOptions = (config: AppConfig) => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: "strict" as const,
  path: "/",
  maxAge: config.sessionTtlMs,
});

export const csrfCookieOptions = (config: AppConfig) => ({
  httpOnly: false,
  secure: config.secureCookies,
  sameSite: "strict" as const,
  path: "/",
  maxAge: config.sessionTtlMs,
});

export const cookiesFor = (request: Request): Readonly<Record<string, string>> =>
  parseCookies(request.headers.cookie);

const mapUser = (row: SessionLookupRow): UserRow => ({
  id: row.user_id_value,
  organization_id: row.user_organization_id,
  email: row.user_email,
  display_name: row.user_display_name,
  password_hash: row.user_password_hash,
  role: row.user_role,
  status: row.user_status,
  last_login_at: row.user_last_login_at,
  created_at: row.user_created_at,
  updated_at: row.user_updated_at,
});

export const authenticate =
  (database: OpenCoiDatabase, config: AppConfig): RequestHandler =>
  (request, response, next) => {
    const token = cookiesFor(request)[config.sessionCookieName];
    if (!token) {
      next(new HttpError(401, "Authentication required"));
      return;
    }
    const tokenHash = hashSessionToken(token, config.tokenPepper);
    const now = new Date().toISOString();
    const row = database
      .prepare(
        `SELECT s.*,
                u.id AS user_id_value, u.organization_id AS user_organization_id,
                u.email AS user_email, u.display_name AS user_display_name,
                u.password_hash AS user_password_hash, u.role AS user_role,
                u.status AS user_status, u.last_login_at AS user_last_login_at,
                u.created_at AS user_created_at, u.updated_at AS user_updated_at,
                o.name AS organization_name
         FROM sessions s
         JOIN users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         JOIN organizations o ON o.id = s.organization_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND u.status = 'active'
         LIMIT 1`,
      )
      .get(tokenHash, now) as unknown as SessionLookupRow | undefined;
    if (!row) {
      response.clearCookie(config.sessionCookieName, sessionCookieOptions(config));
      response.clearCookie(csrfCookieName(config), csrfCookieOptions(config));
      next(new HttpError(401, "Authentication required"));
      return;
    }

    const repository = createOrganizationRepository(database, row.organization_id);
    repository.touchSession(row.id, now);
    let csrfToken = cookiesFor(request)[csrfCookieName(config)] ?? "";
    if (!csrfToken || !verifyOpaqueToken(csrfToken, row.csrf_token_hash, config.tokenPepper)) {
      csrfToken = randomToken();
      // A missing readable CSRF cookie should not invalidate a valid HttpOnly session.
      // Rotate the stored digest and issue a replacement token.
      database
        .prepare("UPDATE sessions SET csrf_token_hash = ? WHERE organization_id = ? AND id = ?")
        .run(hashCsrfToken(csrfToken, config.tokenPepper), row.organization_id, row.id);
      row.csrf_token_hash = hashCsrfToken(csrfToken, config.tokenPepper);
      response.cookie(csrfCookieName(config), csrfToken, csrfCookieOptions(config));
    }

    response.locals.auth = {
      session: row,
      user: mapUser(row),
      organizationName: row.organization_name,
      csrfToken,
    } satisfies AuthContext;
    next();
  };

export const authContext = (response: Response): AuthContext => {
  const auth = response.locals.auth as AuthContext | undefined;
  if (!auth) throw new HttpError(500, "Authentication context is unavailable");
  return auth;
};

export const requireCsrf =
  (config: AppConfig): RequestHandler =>
  (request, response, next) => {
    const auth = authContext(response);
    const header = request.header("X-CSRF-Token") ?? "";
    const cookie = cookiesFor(request)[csrfCookieName(config)] ?? "";
    const headerValid =
      Boolean(header) &&
      verifyOpaqueToken(header, auth.session.csrf_token_hash, config.tokenPepper);
    const cookieValid =
      Boolean(cookie) &&
      verifyOpaqueToken(cookie, auth.session.csrf_token_hash, config.tokenPepper);
    if (!headerValid || !cookieValid || header !== cookie) {
      next(new HttpError(403, "CSRF token is missing or invalid"));
      return;
    }
    next();
  };

export const enforceTrustedOrigin =
  (config: AppConfig): RequestHandler =>
  (request, _response, next) => {
    const origin = request.header("Origin");
    const referer = request.header("Referer");
    const fetchSite = request.header("Sec-Fetch-Site");
    let candidate = origin;
    if (!candidate && referer) {
      try {
        candidate = new URL(referer).origin;
      } catch {
        next(new HttpError(403, "Request origin is invalid"));
        return;
      }
    }
    if ((candidate && candidate !== config.appOrigin) || fetchSite === "cross-site") {
      next(new HttpError(403, "Request origin is not allowed"));
      return;
    }
    next();
  };

export const requireRole =
  (...roles: UserRow["role"][]): RequestHandler =>
  (_request, response, next) => {
    if (!roles.includes(authContext(response).user.role)) {
      next(new HttpError(403, "Your role does not permit this action"));
      return;
    }
    next();
  };

interface RateBucket {
  count: number;
  resetAt: number;
}

export const rateLimit = (options: {
  windowMs: number;
  max: number;
  prefix: string;
}): RequestHandler => {
  const buckets = new Map<string, RateBucket>();
  return (request, response, next) => {
    const now = Date.now();
    const key = `${options.prefix}:${request.ip ?? request.socket.remoteAddress ?? "unknown"}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      response.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))),
      );
      next(new HttpError(429, "Too many requests; try again later"));
      return;
    }
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    next();
  };
};

export const requestAuditContext = (request: Request) => ({
  ipAddress: request.ip,
  userAgent: request.get("user-agent"),
});
