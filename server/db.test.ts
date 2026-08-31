import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  initializeDatabase,
  openDatabase,
} from "./db.js";
import { createSessionTokens, createUploadLinkToken } from "./security.js";

const databases: DatabaseSync[] = [];

const setupTwoOrganizations = () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const first = bootstrapOrganization(database, {
    organizationId: "org-a",
    organizationName: "Organization A",
    organizationSlug: "organization-a",
    administratorId: "user-a",
    administratorName: "Admin A",
    administratorEmail: "a@example.test",
    administratorPasswordHash: "test-password-hash",
  });
  if (!("organizationId" in first)) {
    throw new Error("Bootstrap failed");
  }
  const timestamp = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO organizations (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("org-b", "organization-b", "Organization B", timestamp, timestamp);
  const repositoryA = createOrganizationRepository(database, "org-a");
  const repositoryB = createOrganizationRepository(database, "org-b");
  repositoryB.createUser({
    id: "user-b",
    email: "b@example.test",
    displayName: "Admin B",
    passwordHash: "test-password-hash",
    role: "owner",
  });
  const typeA = repositoryA.createVendorType({ id: "type-a", name: "A type" });
  const typeB = repositoryB.createVendorType({ id: "type-b", name: "B type" });
  const vendorA = repositoryA.createVendor({
    id: "vendor-a",
    vendorTypeId: typeA.id,
    legalName: "Vendor A",
  });
  const vendorB = repositoryB.createVendor({
    id: "vendor-b",
    vendorTypeId: typeB.id,
    legalName: "Vendor B",
  });
  return { database, repositoryA, repositoryB, vendorA, vendorB };
};

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("database initialization", () => {
  it("enables foreign keys and installs the complete schema", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "organizations",
        "users",
        "sessions",
        "vendor_types",
        "coverage_requirements",
        "vendors",
        "documents",
        "certificates",
        "policies",
        "findings",
        "exceptions",
        "upload_links",
        "reminders",
        "audit_events",
      ]),
    );
  });

  it("bootstraps exactly once and refuses takeover of a non-empty install", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const input = {
      organizationName: "Bootstrap Org",
      organizationSlug: "bootstrap-org",
      administratorName: "Bootstrap Admin",
      administratorEmail: "admin@example.test",
      administratorPasswordHash: "test-password-hash",
    };
    expect(bootstrapOrganization(database, input).status).toBe("created");
    expect(bootstrapOrganization(database, input).status).toBe("already_configured");
    expect(
      bootstrapOrganization(database, {
        ...input,
        organizationSlug: "hostile-second-org",
        administratorEmail: "other@example.test",
      }).status,
    ).toBe("skipped_nonempty");
  });

  it("migrates reminder retry scheduling from schema version 1", () => {
    const database = openDatabase(":memory:", { initialize: false });
    databases.push(database);
    database.exec(`
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_for TEXT NOT NULL
      );
      CREATE INDEX reminders_due_idx
        ON reminders (organization_id, status, scheduled_for);
      PRAGMA user_version = 1;
    `);

    initializeDatabase(database);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    const columns = database
      .prepare("PRAGMA table_info(reminders)")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["retry_eligible", "next_attempt_at"]));
  });
});

describe("strict organization scoping", () => {
  it("never exposes or mutates another organization's rows", () => {
    const { repositoryA, repositoryB, vendorA, vendorB } = setupTwoOrganizations();
    expect(repositoryA.getVendor(vendorB.id)).toBeNull();
    expect(repositoryB.getVendor(vendorA.id)).toBeNull();
    expect(repositoryA.setVendorStatus(vendorB.id, "archived")).toBe(false);
    expect(repositoryB.getVendor(vendorB.id)?.status).toBe("active");
    expect(repositoryA.listVendors().map((vendor) => vendor.id)).toEqual(["vendor-a"]);
  });

  it("rejects cross-organization foreign-key references on inserts", () => {
    const { repositoryA } = setupTwoOrganizations();
    expect(() =>
      repositoryA.createDocument({
        vendorId: "vendor-b",
        originalFilename: "certificate.pdf",
        storageKey: "org-a/certificate.pdf",
        byteSize: 100,
        sha256: "a".repeat(64),
      }),
    ).toThrow(/FOREIGN KEY/);

    const session = createSessionTokens();
    expect(() =>
      repositoryA.createSession({
        userId: "user-b",
        tokenHash: session.sessionTokenHash,
        csrfTokenHash: session.csrfTokenHash,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("scopes bearer-token lookup and performs atomic single-use consumption", () => {
    const { repositoryA, repositoryB } = setupTwoOrganizations();
    const token = createUploadLinkToken();
    const link = repositoryB.createUploadLink({
      vendorId: "vendor-b",
      tokenHash: token.tokenHash,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(repositoryA.getActiveUploadLinkByHash(token.tokenHash)).toBeNull();
    expect(repositoryA.consumeUploadLink(link.id)).toBe(false);
    expect(repositoryB.consumeUploadLink(link.id)).toBe(true);
    expect(repositoryB.consumeUploadLink(link.id)).toBe(false);
    expect(repositoryB.getActiveUploadLinkByHash(token.tokenHash)).toBeNull();
  });

  it("rejects cross-organization certificate replacement", () => {
    const { repositoryA, repositoryB } = setupTwoOrganizations();
    const document = repositoryB.createDocument({
      vendorId: "vendor-b",
      originalFilename: "certificate.pdf",
      storageKey: "org-b/certificate.pdf",
      byteSize: 100,
      sha256: "b".repeat(64),
    });
    const certificate = repositoryB.createCertificate({
      vendorId: "vendor-b",
      documentId: document.id,
    });
    expect(() =>
      repositoryA.replacePolicies(certificate.id, [
        { coverageType: "general_liability", policyNumber: "GL-1" },
      ]),
    ).toThrow(/does not exist in this organization/);
    expect(repositoryA.listPolicies(certificate.id)).toEqual([]);
  });
});
