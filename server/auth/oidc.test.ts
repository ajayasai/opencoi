import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import { verifyOpaqueToken } from "../security.js";
import { beginOidcLogin, completeOidcLogin, OidcLoginError, type OidcProtocol } from "./oidc.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const ISSUER = "https://identity.example.test/tenant";
const STATE = "state".padEnd(43, "s");

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  trustProxyHops: 0,
  appOrigin: "https://coi.example.test",
  dataDirectory: "C:/tmp/opencoi-oidc-test",
  databasePath: ":memory:",
  uploadDirectory: "C:/tmp/opencoi-oidc-test/uploads",
  maxUploadBytes: 5 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1000,
  uploadLinkTtlMs: 14 * 86_400_000,
  sessionCookieName: "opencoi_test_session",
  secureCookies: true,
  tokenPepper: "oidc-test-token-pepper-at-least-32-bytes",
  oidc: {
    issuer: ISSUER,
    clientId: "opencoi-client",
    clientSecret: "provider-secret",
    clientAuthMethod: "client_secret_basic",
    organizationSlug: "organization-a",
    displayName: "Company SSO",
    transactionTtlMs: 10 * 60_000,
  },
  smtp: null,
  remindersEnabled: false,
  reminderPollMs: 60_000,
  bootstrap: null,
};

const protocol = (
  claims = {
    issuer: ISSUER,
    subject: "employee-123",
    email: "admin-a@example.test",
    emailVerified: true,
  },
): OidcProtocol => ({
  createAuthorizationRequest: vi.fn().mockResolvedValue({
    authorizationUrl: `https://identity.example.test/authorize?state=${STATE}`,
    state: STATE,
    nonce: "nonce".padEnd(43, "n"),
    codeVerifier: "verifier".padEnd(64, "v"),
  }),
  exchangeAuthorizationCode: vi.fn().mockResolvedValue(claims),
});

describe("OIDC login service", () => {
  let database: OpenCoiDatabase;

  beforeEach(() => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin-a@example.test",
      administratorPasswordHash: "local-break-glass-password-hash",
    });
    const at = NOW.toISOString();
    database
      .prepare(
        `INSERT INTO organizations (id, slug, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("org-b", "organization-b", "Organization B", at, at);
    createOrganizationRepository(database, "org-b").createUser({
      id: "admin-b",
      email: "admin-a@example.test",
      displayName: "Same Email Other Tenant",
      passwordHash: "local-break-glass-password-hash",
      role: "owner",
    });
  });

  afterEach(() => database.close());

  const begin = (oidcProtocol: OidcProtocol) =>
    beginOidcLogin({ config, database, protocol: oidcProtocol, now: NOW });

  const complete = (
    oidcProtocol: OidcProtocol,
    transactionToken: string,
    state = STATE,
    now = NOW,
  ) =>
    completeOidcLogin({
      config,
      database,
      protocol: oidcProtocol,
      currentUrl: new URL(
        `https://coi.example.test/api/auth/oidc/callback?code=test-code&state=${state}`,
      ),
      transactionToken,
      returnedState: state,
      ipAddress: "203.0.113.10",
      userAgent: "OIDC service test",
      now,
    });

  it("binds a verified identity only to an active pre-provisioned user and issues a session", async () => {
    const oidcProtocol = protocol();
    const started = await begin(oidcProtocol);
    const result = await complete(oidcProtocol, started.transactionToken);

    expect(result.user.id).toBe("admin-a");
    expect(result.organization.id).toBe("org-a");
    expect(result.session.organization_id).toBe("org-a");
    expect(
      verifyOpaqueToken(result.sessionToken, result.session.token_hash, config.tokenPepper),
    ).toBe(true);
    expect(
      verifyOpaqueToken(result.csrfToken, result.session.csrf_token_hash, config.tokenPepper),
    ).toBe(true);
    expect(
      createOrganizationRepository(database, "org-a").getUserByOidcIdentity(ISSUER, "employee-123")
        ?.id,
    ).toBe("admin-a");
    expect(
      createOrganizationRepository(database, "org-b").getUserByOidcIdentity(ISSUER, "employee-123"),
    ).toBeNull();
    expect(
      database
        .prepare(
          "SELECT action FROM audit_events WHERE organization_id = ? ORDER BY sequence_number",
        )
        .all("org-a"),
    ).toEqual([{ action: "auth.oidc_identity_bound" }, { action: "auth.oidc_login" }]);
  });

  it("uses the immutable issuer and subject binding after first login", async () => {
    const firstProtocol = protocol();
    const first = await begin(firstProtocol);
    await complete(firstProtocol, first.transactionToken);

    const changedEmailProtocol = protocol({
      issuer: ISSUER,
      subject: "employee-123",
      email: "attacker@example.test",
      emailVerified: false,
    });
    const second = await begin(changedEmailProtocol);
    const result = await complete(changedEmailProtocol, second.transactionToken);

    expect(result.user.id).toBe("admin-a");
    expect(database.prepare("SELECT count(*) AS count FROM oidc_identities").get()).toEqual({
      count: 1,
    });
  });

  it("rejects unprovisioned, unverified, disabled, and conflicting identities", async () => {
    const cases = [
      protocol({
        issuer: ISSUER,
        subject: "unknown-subject",
        email: "unknown@example.test",
        emailVerified: true,
      }),
      protocol({
        issuer: ISSUER,
        subject: "unverified-subject",
        email: "admin-a@example.test",
        emailVerified: false,
      }),
    ];
    for (const oidcProtocol of cases) {
      const started = await begin(oidcProtocol);
      await expect(complete(oidcProtocol, started.transactionToken)).rejects.toMatchObject({
        code: "access_denied",
      });
    }

    createOrganizationRepository(database, "org-a").setUserStatus("admin-a", "disabled");
    const disabledProtocol = protocol();
    const disabled = await begin(disabledProtocol);
    await expect(complete(disabledProtocol, disabled.transactionToken)).rejects.toBeInstanceOf(
      OidcLoginError,
    );
    expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("rejects state substitution, expiry, and replay without a second code exchange", async () => {
    const oidcProtocol = protocol();
    const first = await begin(oidcProtocol);
    await expect(
      complete(oidcProtocol, first.transactionToken, "x".repeat(43)),
    ).rejects.toMatchObject({ code: "invalid_transaction" });
    await complete(oidcProtocol, first.transactionToken);
    await expect(complete(oidcProtocol, first.transactionToken)).rejects.toMatchObject({
      code: "invalid_transaction",
    });

    const expired = await begin(oidcProtocol);
    await expect(
      complete(
        oidcProtocol,
        expired.transactionToken,
        STATE,
        new Date(NOW.getTime() + 11 * 60_000),
      ),
    ).rejects.toMatchObject({ code: "invalid_transaction" });
    expect(oidcProtocol.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("consumes a valid transaction even when provider validation fails", async () => {
    const oidcProtocol = protocol();
    vi.mocked(oidcProtocol.exchangeAuthorizationCode).mockRejectedValueOnce(
      new OidcLoginError("invalid_identity", "bad ID token"),
    );
    const started = await begin(oidcProtocol);
    await expect(complete(oidcProtocol, started.transactionToken)).rejects.toMatchObject({
      code: "invalid_identity",
    });
    await expect(complete(oidcProtocol, started.transactionToken)).rejects.toMatchObject({
      code: "invalid_transaction",
    });
  });

  it("rejects a downgraded authorization endpoint before storing a transaction", async () => {
    const oidcProtocol = protocol();
    vi.mocked(oidcProtocol.createAuthorizationRequest).mockResolvedValueOnce({
      authorizationUrl: `http://identity.example.test/authorize?state=${STATE}`,
      state: STATE,
      nonce: "nonce".padEnd(43, "n"),
      codeVerifier: "verifier".padEnd(64, "v"),
    });

    await expect(begin(oidcProtocol)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(database.prepare("SELECT count(*) AS count FROM oidc_login_transactions").get()).toEqual(
      { count: 0 },
    );
  });
});
