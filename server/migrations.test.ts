import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  FOUNDATION_SCHEMA_V1_TO_V2_SQL,
  FOUNDATION_SCHEMA_V2_TO_V3_SQL,
  FOUNDATION_SCHEMA_V3_TO_V4_SQL,
  FOUNDATION_SCHEMA_V4_SQL,
  type OpenCoiDatabase,
  openDatabase,
} from "./db.js";
import {
  databaseMigrationCatalog,
  databaseMigrationsCurrent,
  MIGRATION_LEDGER_TABLE,
  MigrationIntegrityError,
  migrateDatabase,
  planDatabaseMigrations,
} from "./migrations.js";
import { ensureIntegrationSchema } from "./services/integrationSchema.js";
import { ensureApiSchema } from "./services/schema.js";

describe("database migration ledger", () => {
  let database: OpenCoiDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("plans without writes and applies a fresh database in order", () => {
    database = openDatabase(":memory:", { initialize: false });

    expect(planDatabaseMigrations(database).map((entry) => entry.action)).toEqual([
      "apply",
      "apply",
      "apply",
    ]);
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
    ).toEqual([]);

    const result = migrateDatabase(database, {
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    });

    expect(result.map((entry) => entry.result)).toEqual(["applied", "applied", "applied"]);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(databaseMigrationsCurrent(database)).toBe(true);
    expect(
      database
        .prepare(
          `SELECT sequence, migration_id, applied_at, applied_kind
           FROM ${MIGRATION_LEDGER_TABLE} ORDER BY sequence`,
        )
        .all(),
    ).toEqual(
      databaseMigrationCatalog().map((entry) => ({
        sequence: entry.sequence,
        migration_id: entry.id,
        applied_at: "2026-08-31T12:00:00.000Z",
        applied_kind: "applied",
      })),
    );
    expect(migrateDatabase(database).map((entry) => entry.result)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
  });

  it("binds every executable historical foundation transition into migration 0001", () => {
    const foundation = databaseMigrationCatalog().find((entry) => entry.sequence === 1);
    if (!foundation) throw new Error("Foundation migration missing from catalog");
    const checksumFor = (material: string): string =>
      createHash("sha256")
        .update(`${foundation.sequence}\0${foundation.id}\0${foundation.name}\0${material}`)
        .digest("hex");
    const executableMaterial = [
      FOUNDATION_SCHEMA_V4_SQL,
      FOUNDATION_SCHEMA_V1_TO_V2_SQL,
      FOUNDATION_SCHEMA_V2_TO_V3_SQL,
      FOUNDATION_SCHEMA_V3_TO_V4_SQL,
    ].join("\n");

    expect(foundation.checksum).toBe(checksumFor(executableMaterial));
    expect(foundation.checksum).not.toBe(checksumFor(FOUNDATION_SCHEMA_V4_SQL));
    expect(foundation.checksum).not.toBe(
      checksumFor(executableMaterial.replace("PRAGMA user_version = 4", "PRAGMA user_version = 5")),
    );
  });

  it("adopts a complete v0.3 database without rewriting application data", () => {
    database = openDatabase(":memory:");
    const bootstrap = bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin@example.test",
      administratorPasswordHash: "test-password-hash",
    });
    if (!("organizationId" in bootstrap)) throw new Error("Bootstrap failed");
    const repository = createOrganizationRepository(database, bootstrap.organizationId);
    const vendorType = repository.createVendorType({ id: "type-a", name: "Contractor" });
    repository.createVendor({
      id: "vendor-a",
      vendorTypeId: vendorType.id,
      legalName: "Preserved Vendor",
    });
    ensureApiSchema(database);
    ensureIntegrationSchema(database);

    expect(planDatabaseMigrations(database).map((entry) => entry.action)).toEqual([
      "adopt",
      "adopt",
      "adopt",
    ]);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(MIGRATION_LEDGER_TABLE),
    ).toBeUndefined();

    const result = migrateDatabase(database);

    expect(result.map((entry) => entry.result)).toEqual(["adopted", "adopted", "adopted"]);
    expect(repository.getVendor("vendor-a")?.legal_name).toBe("Preserved Vendor");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upgrades an unledgered foundation v3 database before applying later migrations", () => {
    database = openDatabase(":memory:");
    database.exec(`
      INSERT INTO organizations
        (id, slug, name, created_at, updated_at)
      VALUES
        ('org-before-upgrade', 'before-upgrade', 'Before upgrade',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      DROP INDEX certificate_requests_delivery_idx;
      DROP INDEX certificate_requests_vendor_idx;
      DROP TABLE certificate_requests;
      PRAGMA user_version = 3;
    `);

    expect(planDatabaseMigrations(database)[0]?.action).toBe("apply");
    const result = migrateDatabase(database);

    expect(result.map((entry) => entry.result)).toEqual(["applied", "applied", "applied"]);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      database.prepare("SELECT name FROM organizations WHERE id = ?").get("org-before-upgrade"),
    ).toEqual({ name: "Before upgrade" });
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("certificate_requests"),
    ).toEqual({ name: "certificate_requests" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refuses checksum tampering and unknown future migrations", () => {
    database = openDatabase(":memory:", { initialize: false });
    migrateDatabase(database);
    database
      .prepare(`UPDATE ${MIGRATION_LEDGER_TABLE} SET checksum = ? WHERE sequence = 2`)
      .run("a".repeat(64));

    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(
      MigrationIntegrityError,
    );
    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(/checksum/);

    const apiMigration = databaseMigrationCatalog().find((entry) => entry.sequence === 2);
    if (!apiMigration) throw new Error("API migration missing from catalog");
    database
      .prepare(`UPDATE ${MIGRATION_LEDGER_TABLE} SET checksum = ? WHERE sequence = 2`)
      .run(apiMigration.checksum);
    database
      .prepare(
        `INSERT INTO ${MIGRATION_LEDGER_TABLE}
          (sequence, migration_id, name, checksum, applied_at, applied_kind, duration_ms)
         VALUES (999, '0999-future', 'Future migration', ?, ?, 'applied', 0)`,
      )
      .run("f".repeat(64), "2026-08-31T12:00:00.000Z");

    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(
      /unknown or future migration 0999-future/,
    );
  });

  it("rejects a named append-only trigger whose body was replaced with a no-op", () => {
    database = openDatabase(":memory:", { initialize: false });
    migrateDatabase(database);
    database.exec(`
      DROP TRIGGER domain_events_no_update;
      CREATE TRIGGER domain_events_no_update
      BEFORE UPDATE ON domain_events
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() => databaseMigrationsCurrent(database as OpenCoiDatabase)).toThrow(
      /0003-service-accounts-events-and-webhooks.*required schema objects are missing/,
    );
    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(
      MigrationIntegrityError,
    );
  });

  it("accepts an equivalent append-only trigger despite formatting and identifier quoting", () => {
    database = openDatabase(":memory:", { initialize: false });
    migrateDatabase(database);
    database.exec(`
      DROP TRIGGER domain_events_no_update;
      CREATE TRIGGER IF NOT EXISTS "domain_events_no_update"
        BEFORE UPDATE ON "domain_events"
        BEGIN SELECT RAISE ( ABORT, 'domain events are append-only' ); END;
    `);

    expect(databaseMigrationsCurrent(database)).toBe(true);
  });

  it("rejects a signing-key index with the right name but no uniqueness guarantee", () => {
    database = openDatabase(":memory:", { initialize: false });
    migrateDatabase(database);
    database.exec(`
      DROP INDEX evidence_signing_keys_active_idx;
      CREATE INDEX evidence_signing_keys_active_idx
        ON evidence_signing_keys (organization_id)
        WHERE status = 'active';
    `);

    expect(() => databaseMigrationsCurrent(database as OpenCoiDatabase)).toThrow(
      /0002-requirement-history-and-evidence-keys.*required schema objects are missing/,
    );
  });

  it("rejects incorrect partial predicates and index sort contracts", () => {
    database = openDatabase(":memory:", { initialize: false });
    migrateDatabase(database);
    database.exec(`
      DROP INDEX coverage_requirements_active_unique_idx;
      CREATE UNIQUE INDEX coverage_requirements_active_unique_idx
        ON coverage_requirements (organization_id, vendor_type_id, coverage_type)
        WHERE is_active = 0;
    `);

    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(
      /0002-requirement-history-and-evidence-keys.*required schema objects are missing/,
    );

    database.exec(`
      DROP INDEX coverage_requirements_active_unique_idx;
      CREATE UNIQUE INDEX coverage_requirements_active_unique_idx
        ON coverage_requirements (organization_id, vendor_type_id, coverage_type)
        WHERE is_active = 1;
      DROP INDEX domain_events_feed_idx;
      CREATE INDEX domain_events_feed_idx
        ON domain_events (organization_id, sequence_number ASC);
    `);

    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(
      /0003-service-accounts-events-and-webhooks.*required schema objects are missing/,
    );
  });

  it("rejects a lookalike ledger that omits its integrity checks", () => {
    database = openDatabase(":memory:", { initialize: false });
    database.exec(`
      CREATE TABLE ${MIGRATION_LEDGER_TABLE} (
        sequence INTEGER PRIMARY KEY,
        migration_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        applied_kind TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      ) STRICT;
    `);

    expect(() => planDatabaseMigrations(database as OpenCoiDatabase)).toThrow(
      /ledger does not match its required schema contract/,
    );
  });

  it("refuses a future foundation user_version before applying anything", () => {
    database = openDatabase(":memory:", { initialize: false });
    database.exec("PRAGMA user_version = 999");

    expect(() => migrateDatabase(database as OpenCoiDatabase)).toThrow(
      /newer than supported version 4/,
    );
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(MIGRATION_LEDGER_TABLE),
    ).toBeUndefined();
  });

  it("refuses to adopt or report current when foreign-key integrity is broken", () => {
    database = openDatabase(":memory:", { initialize: false });
    migrateDatabase(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO vendors
        (id, organization_id, vendor_type_id, legal_name, status, created_at, updated_at)
      VALUES
        ('invalid-vendor', 'missing-org', 'missing-type', 'Invalid Vendor', 'active',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA foreign_keys = ON;
    `);

    expect(() => databaseMigrationsCurrent(database as OpenCoiDatabase)).toThrow(
      /foreign-key violation/,
    );
    expect(() => migrateDatabase(database as OpenCoiDatabase)).toThrow(/foreign-key violation/);

    database.close();
    database = openDatabase(":memory:");
    database.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO vendors
        (id, organization_id, vendor_type_id, legal_name, status, created_at, updated_at)
      VALUES
        ('invalid-adoption', 'missing-org', 'missing-type', 'Invalid Adoption', 'active',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA foreign_keys = ON;
    `);

    expect(() => migrateDatabase(database as OpenCoiDatabase)).toThrow(/foreign-key violation/);
    expect(database.prepare(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`).all()).toEqual(
      [],
    );
  });

  it("rolls back a failed transactional migration and retains foreign-key enforcement", () => {
    database = openDatabase(":memory:", { initialize: false });
    database.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO organizations (id) VALUES ('preexisting');
    `);

    expect(() => migrateDatabase(database as OpenCoiDatabase)).toThrow(/already exists/);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(database.prepare("SELECT id FROM organizations").all()).toEqual([{ id: "preexisting" }]);
    expect(database.prepare(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`).all()).toEqual(
      [],
    );
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
