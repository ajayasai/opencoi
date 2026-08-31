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
