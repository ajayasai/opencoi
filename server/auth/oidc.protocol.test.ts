import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OidcConfig } from "../config.js";
import { OpenIdClientProtocol } from "./oidc.js";

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const json = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
};

describe("openid-client protocol adapter", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  let issuer = "";
  let expectedChallenge = "";
  let expectedNonce = "";
  let expectedClientAuthMethod: OidcConfig["clientAuthMethod"] = "client_secret_basic";
  let tokenRequestVerified = false;
  let tokenRequest: Record<string, string | null> = {};

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      json(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "email", "profile"],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json(response, { keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }] });
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request));
      const verifier = body.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorization = request.headers.authorization ?? "";
      tokenRequest = {
        grantType: body.get("grant_type"),
        code: body.get("code"),
        redirectUri: body.get("redirect_uri"),
        challenge,
        authorization,
        clientId: body.get("client_id"),
        clientSecret: body.get("client_secret"),
      };
      const clientAuthenticationVerified =
        expectedClientAuthMethod === "client_secret_basic"
          ? authorization ===
              `Basic ${Buffer.from("opencoi%2Dclient:provider%2Dsecret").toString("base64")}` &&
            body.get("client_id") === null &&
            body.get("client_secret") === null
          : authorization === "" &&
            body.get("client_id") === "opencoi-client" &&
            body.get("client_secret") === "provider-secret";
      tokenRequestVerified =
        body.get("grant_type") === "authorization_code" &&
        body.get("code") === "one-use-code" &&
        body.get("redirect_uri") === "https://coi.example.test/api/auth/oidc/callback" &&
        challenge === expectedChallenge &&
        clientAuthenticationVerified;
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          sub: "employee-123",
          aud: "opencoi-client",
          exp: now + 300,
          iat: now,
          nonce: expectedNonce,
          email: "USER@EXAMPLE.TEST",
          email_verified: true,
        }),
      ).toString("base64url");
      const signingInput = `${header}.${payload}`;
      const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
        "base64url",
      );
      json(response, {
        access_token: "unused-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: `${signingInput}.${signature}`,
      });
      return;
    }
    response.writeHead(404).end();
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    issuer = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const provider = (
    clientAuthMethod: OidcConfig["clientAuthMethod"] = "client_secret_basic",
  ): OidcConfig => ({
    issuer,
    clientId: "opencoi-client",
    clientSecret: "provider-secret",
    clientAuthMethod,
    organizationSlug: "organization-a",
    displayName: "Test SSO",
    transactionTtlMs: 10 * 60_000,
  });

  it("performs discovery, PKCE S256, state, nonce, code exchange, and ID-token validation", async () => {
    expectedClientAuthMethod = "client_secret_basic";
    const redirectUri = "https://coi.example.test/api/auth/oidc/callback";
    const protocol = new OpenIdClientProtocol();
    const authorization = await protocol.createAuthorizationRequest({
      provider: provider(),
      redirectUri,
    });
    const authorizationUrl = new URL(authorization.authorizationUrl);

    expectedChallenge = authorizationUrl.searchParams.get("code_challenge") ?? "";
    expectedNonce = authorization.nonce;
    expect(authorizationUrl.origin).toBe(issuer);
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(authorizationUrl.searchParams.get("state")).toBe(authorization.state);
    expect(authorizationUrl.searchParams.get("nonce")).toBe(authorization.nonce);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(expectedChallenge).toBe(
      createHash("sha256").update(authorization.codeVerifier).digest("base64url"),
    );

    const claims = await protocol.exchangeAuthorizationCode({
      provider: provider(),
      currentUrl: new URL(
        `${redirectUri}?code=one-use-code&state=${encodeURIComponent(authorization.state)}`,
      ),
      redirectUri,
      expectedState: authorization.state,
      expectedNonce: authorization.nonce,
      codeVerifier: authorization.codeVerifier,
    });

    expect(tokenRequest).toEqual({
      grantType: "authorization_code",
      code: "one-use-code",
      redirectUri,
      challenge: expectedChallenge,
      authorization: `Basic ${Buffer.from("opencoi%2Dclient:provider%2Dsecret").toString("base64")}`,
      clientId: null,
      clientSecret: null,
    });
    expect(tokenRequestVerified).toBe(true);
    expect(claims).toEqual({
      issuer,
      subject: "employee-123",
      email: "user@example.test",
      emailVerified: true,
    });
  });

  it("supports providers that require client_secret_post", async () => {
    expectedClientAuthMethod = "client_secret_post";
    const redirectUri = "https://coi.example.test/api/auth/oidc/callback";
    const protocol = new OpenIdClientProtocol();
    const authorization = await protocol.createAuthorizationRequest({
      provider: provider("client_secret_post"),
      redirectUri,
    });
    const authorizationUrl = new URL(authorization.authorizationUrl);
    expectedChallenge = authorizationUrl.searchParams.get("code_challenge") ?? "";
    expectedNonce = authorization.nonce;

    await protocol.exchangeAuthorizationCode({
      provider: provider("client_secret_post"),
      currentUrl: new URL(
        `${redirectUri}?code=one-use-code&state=${encodeURIComponent(authorization.state)}`,
      ),
      redirectUri,
      expectedState: authorization.state,
      expectedNonce: authorization.nonce,
      codeVerifier: authorization.codeVerifier,
    });

    expect(tokenRequest).toMatchObject({
      authorization: "",
      clientId: "opencoi-client",
      clientSecret: "provider-secret",
    });
    expect(tokenRequestVerified).toBe(true);
  });

  it("rejects a validly signed ID token when its nonce does not match", async () => {
    expectedClientAuthMethod = "client_secret_basic";
    const redirectUri = "https://coi.example.test/api/auth/oidc/callback";
    const protocol = new OpenIdClientProtocol();
    const authorization = await protocol.createAuthorizationRequest({
      provider: provider(),
      redirectUri,
    });
    const authorizationUrl = new URL(authorization.authorizationUrl);
    expectedChallenge = authorizationUrl.searchParams.get("code_challenge") ?? "";
    expectedNonce = authorization.nonce;

    await expect(
      protocol.exchangeAuthorizationCode({
        provider: provider(),
        currentUrl: new URL(
          `${redirectUri}?code=one-use-code&state=${encodeURIComponent(authorization.state)}`,
        ),
        redirectUri,
        expectedState: authorization.state,
        expectedNonce: "different-nonce".padEnd(43, "x"),
        codeVerifier: authorization.codeVerifier,
      }),
    ).rejects.toMatchObject({ code: "invalid_identity" });
  });
});
