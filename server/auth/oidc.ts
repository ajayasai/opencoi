import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretBasic,
  ClientSecretPost,
  type Configuration,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";
import { appendAuditEvent } from "../audit.js";
import type { AppConfig, OidcConfig } from "../config.js";
import type { OpenCoiDatabase, OrganizationRow, SessionRow, UserRow } from "../db.js";
import { createOrganizationRepository } from "../db.js";
import {
  createSessionTokens,
  hashOpaqueToken,
  randomToken,
  verifyOpaqueToken,
} from "../security.js";

const CALLBACK_PATH = "/api/auth/oidc/callback";

export class OidcLoginError extends Error {
  readonly code:
    | "not_configured"
    | "provider_unavailable"
    | "invalid_transaction"
    | "invalid_identity"
    | "access_denied";

  constructor(code: OidcLoginError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcLoginError";
    this.code = code;
  }
}

export interface OidcAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentityClaims {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
}

export interface OidcProtocol {
  createAuthorizationRequest(input: {
    provider: OidcConfig;
    redirectUri: string;
  }): Promise<OidcAuthorizationRequest>;
  exchangeAuthorizationCode(input: {
    provider: OidcConfig;
    currentUrl: URL;
    redirectUri: string;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentityClaims>;
}

/** Standards-based OIDC Authorization Code implementation backed by openid-client. */
export class OpenIdClientProtocol implements OidcProtocol {
  #configuration: Promise<Configuration> | undefined;

  async #getConfiguration(provider: OidcConfig, redirectUri: string): Promise<Configuration> {
    if (!this.#configuration) {
      const clientAuthentication =
        provider.clientAuthMethod === "client_secret_post"
          ? ClientSecretPost(provider.clientSecret)
          : ClientSecretBasic(provider.clientSecret);
      this.#configuration = discovery(
        new URL(provider.issuer),
        provider.clientId,
        {
          client_secret: provider.clientSecret,
          redirect_uris: [redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: provider.clientAuthMethod,
        },
        clientAuthentication,
        {
          timeout: 10,
          execute:
            new URL(provider.issuer).protocol === "http:" ? [allowInsecureRequests] : undefined,
        },
      );
    }
    try {
      return await this.#configuration;
    } catch (cause) {
      this.#configuration = undefined;
      throw new OidcLoginError(
        "provider_unavailable",
        "The identity provider is temporarily unavailable",
        { cause },
      );
    }
  }

  async createAuthorizationRequest(input: {
    provider: OidcConfig;
    redirectUri: string;
  }): Promise<OidcAuthorizationRequest> {
    const configuration = await this.#getConfiguration(input.provider, input.redirectUri);
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const state = randomState();
    const nonce = randomNonce();
    const authorizationUrl = buildAuthorizationUrl(configuration, {
      redirect_uri: input.redirectUri,
      scope: "openid email profile",
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { authorizationUrl: authorizationUrl.href, state, nonce, codeVerifier };
  }

  async exchangeAuthorizationCode(input: {
    provider: OidcConfig;
    currentUrl: URL;
    redirectUri: string;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentityClaims> {
    if (`${input.currentUrl.origin}${input.currentUrl.pathname}` !== input.redirectUri) {
      throw new OidcLoginError("invalid_transaction", "OIDC callback URL does not match");
    }
    const configuration = await this.#getConfiguration(input.provider, input.redirectUri);
    try {
      const tokens = await authorizationCodeGrant(configuration, input.currentUrl, {
        pkceCodeVerifier: input.codeVerifier,
        expectedState: input.expectedState,
        expectedNonce: input.expectedNonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string" || !claims.sub.trim()) {
        throw new OidcLoginError("invalid_identity", "The ID token has no valid subject");
      }
      const email =
        typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;
      return {
        issuer: input.provider.issuer,
        subject: claims.sub,
        email: email || undefined,
        emailVerified: claims.email_verified === true,
      };
    } catch (cause) {
      if (cause instanceof OidcLoginError) throw cause;
      throw new OidcLoginError("invalid_identity", "OIDC response validation failed", { cause });
    }
  }
}

export const oidcRedirectUri = (config: AppConfig): string =>
  new URL(CALLBACK_PATH, `${config.appOrigin}/`).href;

const configuredOrganization = (
  database: OpenCoiDatabase,
  provider: OidcConfig,
): OrganizationRow => {
  const organization = database
    .prepare("SELECT * FROM organizations WHERE slug = ? COLLATE NOCASE")
    .get(provider.organizationSlug) as unknown as OrganizationRow | undefined;
  if (!organization) {
    throw new OidcLoginError(
      "not_configured",
      "The configured OIDC organization has not been provisioned",
    );
  }
  return organization;
};

const validProtocolValue = (value: string, minimum: number, maximum: number): boolean =>
  value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9._~-]+$/.test(value);

export interface BeginOidcLoginResult {
  authorizationUrl: string;
  transactionToken: string;
  expiresAt: string;
}

export const beginOidcLogin = async (input: {
  config: AppConfig;
  database: OpenCoiDatabase;
  protocol: OidcProtocol;
  now?: Date;
}): Promise<BeginOidcLoginResult> => {
  const provider = input.config.oidc;
  if (!provider) throw new OidcLoginError("not_configured", "OIDC is not configured");
  const organization = configuredOrganization(input.database, provider);
  const repository = createOrganizationRepository(input.database, organization.id);
  const at = input.now ?? new Date();
  const redirectUri = oidcRedirectUri(input.config);
  const authorization = await input.protocol.createAuthorizationRequest({ provider, redirectUri });
  if (
    !validProtocolValue(authorization.state, 32, 256) ||
    !validProtocolValue(authorization.nonce, 32, 256) ||
    !validProtocolValue(authorization.codeVerifier, 43, 256)
  ) {
    throw new OidcLoginError("provider_unavailable", "OIDC protocol values are invalid");
  }
  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(authorization.authorizationUrl);
  } catch (cause) {
    throw new OidcLoginError("provider_unavailable", "OIDC authorization URL is invalid", {
      cause,
    });
  }
  const authorizationIsLoopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(
    authorizationUrl.hostname,
  );
  const insecureLoopbackDevelopment =
    new URL(provider.issuer).protocol === "http:" &&
    authorizationUrl.protocol === "http:" &&
    authorizationIsLoopback;
  if (
    (authorizationUrl.protocol !== "https:" && !insecureLoopbackDevelopment) ||
    authorizationUrl.username ||
    authorizationUrl.password ||
    authorizationUrl.hash
  ) {
    throw new OidcLoginError("provider_unavailable", "OIDC authorization URL is invalid");
  }

  const transactionToken = randomToken();
  const expiresAt = new Date(at.getTime() + provider.transactionTtlMs).toISOString();
  repository.transaction(() => {
    repository.deleteExpiredOidcLoginTransactions(at.toISOString());
    repository.createOidcLoginTransaction({
      issuer: provider.issuer,
      transactionTokenHash: hashOpaqueToken(transactionToken, input.config.tokenPepper),
      stateHash: hashOpaqueToken(authorization.state, input.config.tokenPepper),
      codeVerifier: authorization.codeVerifier,
      nonce: authorization.nonce,
      expiresAt,
      createdAt: at.toISOString(),
    });
  });
  return { authorizationUrl: authorizationUrl.href, transactionToken, expiresAt };
};

const resolvePreprovisionedUser = (
  database: OpenCoiDatabase,
  organizationId: string,
  claims: OidcIdentityClaims,
  at: string,
): UserRow => {
  const repository = createOrganizationRepository(database, organizationId);
  return repository.transaction(() => {
    const bound = repository.getUserByOidcIdentity(claims.issuer, claims.subject);
    if (bound) {
      if (bound.status !== "active") {
        throw new OidcLoginError("access_denied", "OIDC access is not provisioned");
      }
      repository.touchOidcIdentity(claims.issuer, claims.subject, at);
      return bound;
    }

    if (!claims.email || !claims.emailVerified) {
      throw new OidcLoginError("access_denied", "OIDC access is not provisioned");
    }
    const user = repository.getUserByEmail(claims.email);
    if (user?.status !== "active") {
      throw new OidcLoginError("access_denied", "OIDC access is not provisioned");
    }
    const existingForUser = repository.getOidcIdentityForUser(claims.issuer, user.id);
    if (existingForUser && existingForUser.subject !== claims.subject) {
      throw new OidcLoginError("access_denied", "OIDC access is not provisioned");
    }
    repository.bindOidcIdentity({
      issuer: claims.issuer,
      subject: claims.subject,
      userId: user.id,
      email: claims.email,
      at,
    });
    const newlyBound = repository.getUserByOidcIdentity(claims.issuer, claims.subject);
    if (!newlyBound || newlyBound.id !== user.id) {
      throw new OidcLoginError("access_denied", "OIDC access is not provisioned");
    }
    appendAuditEvent(database, organizationId, {
      actorType: "system",
      action: "auth.oidc_identity_bound",
      entityType: "user",
      entityId: user.id,
      occurredAt: at,
      metadata: { issuer: claims.issuer },
    });
    return newlyBound;
  });
};

export interface CompleteOidcLoginResult {
  user: UserRow;
  organization: OrganizationRow;
  session: SessionRow;
  sessionToken: string;
  csrfToken: string;
}

export const completeOidcLogin = async (input: {
  config: AppConfig;
  database: OpenCoiDatabase;
  protocol: OidcProtocol;
  currentUrl: URL;
  transactionToken: string;
  returnedState: string;
  ipAddress?: string;
  userAgent?: string;
  now?: Date;
}): Promise<CompleteOidcLoginResult> => {
  const provider = input.config.oidc;
  if (!provider) throw new OidcLoginError("not_configured", "OIDC is not configured");
  const organization = configuredOrganization(input.database, provider);
  const repository = createOrganizationRepository(input.database, organization.id);
  const at = input.now ?? new Date();
  const atIso = at.toISOString();
  const transactionHash = hashOpaqueToken(input.transactionToken, input.config.tokenPepper);
  const transaction = repository.getActiveOidcLoginTransaction(transactionHash, atIso);
  if (
    !transaction ||
    transaction.issuer !== provider.issuer ||
    !verifyOpaqueToken(input.returnedState, transaction.state_hash, input.config.tokenPepper)
  ) {
    throw new OidcLoginError("invalid_transaction", "OIDC login transaction is invalid");
  }
  if (!repository.consumeOidcLoginTransaction(transaction.id, atIso)) {
    throw new OidcLoginError("invalid_transaction", "OIDC login transaction is invalid");
  }

  const claims = await input.protocol.exchangeAuthorizationCode({
    provider,
    currentUrl: input.currentUrl,
    redirectUri: oidcRedirectUri(input.config),
    expectedState: input.returnedState,
    expectedNonce: transaction.nonce,
    codeVerifier: transaction.code_verifier,
  });
  const subject = claims.subject.trim();
  if (
    claims.issuer !== provider.issuer ||
    !subject ||
    subject.length > 512 ||
    (claims.email !== undefined && claims.email.length > 320)
  ) {
    throw new OidcLoginError("invalid_identity", "OIDC identity claims are invalid");
  }
  const user = resolvePreprovisionedUser(
    input.database,
    organization.id,
    { ...claims, subject },
    atIso,
  );
  const tokens = createSessionTokens(input.config.tokenPepper);
  const expiresAt = new Date(at.getTime() + input.config.sessionTtlMs).toISOString();
  const session = repository.transaction(() => {
    const created = repository.createSession({
      userId: user.id,
      tokenHash: tokens.sessionTokenHash,
      csrfTokenHash: tokens.csrfTokenHash,
      expiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    input.database
      .prepare(
        "UPDATE users SET last_login_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?",
      )
      .run(atIso, atIso, organization.id, user.id);
    appendAuditEvent(input.database, organization.id, {
      actorType: "user",
      actorUserId: user.id,
      action: "auth.oidc_login",
      entityType: "session",
      entityId: created.id,
      occurredAt: atIso,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: { issuer: provider.issuer, authenticationMethod: "oidc" },
    });
    return created;
  });

  return {
    user,
    organization,
    session,
    sessionToken: tokens.sessionToken,
    csrfToken: tokens.csrfToken,
  };
};
