import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns safe, absolute development defaults", () => {
    const workingDirectory = resolve("test-config-root");
    const config = loadConfig({}, workingDirectory);
    expect(config.environment).toBe("development");
    expect(config.databasePath).toBe(resolve(workingDirectory, "data/opencoi.sqlite"));
    expect(config.maxUploadBytes).toBe(15 * 1024 * 1024);
    expect(config.trustProxyHops).toBe(0);
    expect(config.bootstrap).toBeNull();
    expect(config.smtp).toBeNull();
    expect(config.oidc).toBeNull();
  });

  it("derives database and upload paths from DATA_DIR", () => {
    const workingDirectory = resolve("test-config-root");
    const config = loadConfig({ DATA_DIR: "./state" }, workingDirectory);
    expect(config.databasePath).toBe(resolve(workingDirectory, "state/opencoi.sqlite"));
    expect(config.uploadDirectory).toBe(resolve(workingDirectory, "state/uploads"));
  });

  it("parses a complete bootstrap configuration", () => {
    const config = loadConfig(
      {
        BOOTSTRAP_ORG_NAME: "Northwind Construction",
        BOOTSTRAP_ADMIN_NAME: "Ada Admin",
        BOOTSTRAP_ADMIN_EMAIL: "ADA@EXAMPLE.COM",
        BOOTSTRAP_ADMIN_PASSWORD: "a-long-test-password",
      },
      resolve("test-config-root"),
    );
    expect(config.bootstrap).toMatchObject({
      organizationSlug: "northwind-construction",
      administratorEmail: "ada@example.com",
    });
  });

  it("accepts only a bounded explicit reverse-proxy hop count", () => {
    expect(loadConfig({ TRUST_PROXY_HOPS: "2" }).trustProxyHops).toBe(2);
    expect(() => loadConfig({ TRUST_PROXY_HOPS: "-1" })).toThrow(ConfigError);
    expect(() => loadConfig({ TRUST_PROXY_HOPS: "9" })).toThrow(/between 0 and 8/);
    expect(() => loadConfig({ TRUST_PROXY_HOPS: "true" })).toThrow(ConfigError);
  });

  it("parses a complete tenant-bound OIDC provider", () => {
    const config = loadConfig({
      OIDC_ISSUER: "https://identity.example.test/tenant",
      OIDC_CLIENT_ID: "opencoi-client",
      OIDC_CLIENT_SECRET: "provider-issued-secret",
      OIDC_CLIENT_AUTH_METHOD: "client_secret_post",
      OIDC_ORGANIZATION_SLUG: "organization-a",
      OIDC_DISPLAY_NAME: "Company SSO",
      OIDC_TRANSACTION_TTL_MINUTES: "7",
    });

    expect(config.oidc).toEqual({
      issuer: "https://identity.example.test/tenant",
      clientId: "opencoi-client",
      clientSecret: "provider-issued-secret",
      clientAuthMethod: "client_secret_post",
      organizationSlug: "organization-a",
      displayName: "Company SSO",
      transactionTtlMs: 7 * 60_000,
    });
    expect(
      loadConfig({
        OIDC_ISSUER: "https://identity.example.test/tenant/",
        OIDC_CLIENT_ID: "opencoi-client",
        OIDC_CLIENT_SECRET: "provider-issued-secret",
        OIDC_ORGANIZATION_SLUG: "organization-a",
      }).oidc?.issuer,
    ).toBe("https://identity.example.test/tenant/");
  });

  it("rejects partial or insecure OIDC configuration", () => {
    expect(() => loadConfig({ OIDC_ISSUER: "https://identity.example.test" })).toThrow(
      /must be provided together/,
    );
    const complete = {
      OIDC_CLIENT_ID: "opencoi-client",
      OIDC_CLIENT_SECRET: "provider-issued-secret",
      OIDC_ORGANIZATION_SLUG: "organization-a",
    };
    expect(() => loadConfig({ ...complete, OIDC_ISSUER: "http://identity.example.test" })).toThrow(
      /HTTPS issuer/,
    );
    expect(() =>
      loadConfig({ ...complete, OIDC_ISSUER: "https://identity.example.test?tenant=a" }),
    ).toThrow(/HTTPS issuer/);
    expect(() =>
      loadConfig({
        ...complete,
        NODE_ENV: "production",
        APP_ORIGIN: "https://coi.example.test",
        OIDC_ISSUER: "http://localhost:5556",
      }),
    ).toThrow(/HTTPS issuer/);
    expect(() =>
      loadConfig({
        ...complete,
        OIDC_ISSUER: "https://identity.example.test",
        OIDC_CLIENT_AUTH_METHOD: "none",
      }),
    ).toThrow(/client_secret_basic/);
  });

  it("rejects partial or unsafe production configuration", () => {
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_PASSWORD: "a-long-test-password" })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        APP_ORIGIN: "http://coi.example.test",
      }),
    ).toThrow(/https/);
    expect(() => loadConfig({ MAX_UPLOAD_MB: "0" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        APP_ORIGIN: "https://coi.example.test",
        BOOTSTRAP_ORG_NAME: "Acme General Contractors",
        BOOTSTRAP_ADMIN_NAME: "OpenCOI Admin",
        BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
        BOOTSTRAP_ADMIN_PASSWORD: "replace-with-a-long-unique-password",
      }),
    ).toThrow(/example value/);
  });
});
