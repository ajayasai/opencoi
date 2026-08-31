import type { OpenCoiDatabase } from "../db.js";

const ACTIVE_REQUIREMENT_INDEX = "coverage_requirements_active_unique_idx";

const hasActiveRequirementIndex = (database: OpenCoiDatabase): boolean =>
  Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ? AND sql IS NOT NULL")
      .get(ACTIVE_REQUIREMENT_INDEX),
  );

/**
 * Foundation schema v1 used a table-level uniqueness constraint across active
 * and historical rows. Rebuild the table once so an inactive publication can
 * coexist with its replacement while findings keep referencing the original ID.
 */
const migrateCoverageRequirementsForHistory = (database: OpenCoiDatabase): void => {
  if (hasActiveRequirementIndex(database)) return;
  if (database.isTransaction) {
    throw new Error("Coverage requirement migration cannot start inside a transaction");
  }

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(`
      CREATE TABLE coverage_requirements_rebuild (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        vendor_type_id TEXT NOT NULL,
        coverage_type TEXT NOT NULL,
        minimum_each_occurrence INTEGER CHECK (minimum_each_occurrence >= 0),
        minimum_aggregate INTEGER CHECK (minimum_aggregate >= 0),
        minimum_combined_single_limit INTEGER CHECK (minimum_combined_single_limit >= 0),
        maximum_deductible INTEGER CHECK (maximum_deductible >= 0),
        requires_additional_insured INTEGER NOT NULL DEFAULT 0
          CHECK (requires_additional_insured IN (0, 1)),
        requires_waiver_of_subrogation INTEGER NOT NULL DEFAULT 0
          CHECK (requires_waiver_of_subrogation IN (0, 1)),
        requires_primary_noncontributory INTEGER NOT NULL DEFAULT 0
          CHECK (requires_primary_noncontributory IN (0, 1)),
        requires_cancellation_notice INTEGER NOT NULL DEFAULT 0
          CHECK (requires_cancellation_notice IN (0, 1)),
        required_endorsements_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(required_endorsements_json)),
        rule_config_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(rule_config_json)),
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id, vendor_type_id)
          REFERENCES vendor_types(organization_id, id) ON DELETE CASCADE
      ) STRICT;

      INSERT INTO coverage_requirements_rebuild (
        id, organization_id, vendor_type_id, coverage_type,
        minimum_each_occurrence, minimum_aggregate, minimum_combined_single_limit,
        maximum_deductible, requires_additional_insured,
        requires_waiver_of_subrogation, requires_primary_noncontributory,
        requires_cancellation_notice, required_endorsements_json, rule_config_json,
        notes, is_active, created_at, updated_at
      )
      SELECT
        id, organization_id, vendor_type_id, coverage_type,
        minimum_each_occurrence, minimum_aggregate, minimum_combined_single_limit,
        maximum_deductible, requires_additional_insured,
        requires_waiver_of_subrogation, requires_primary_noncontributory,
        requires_cancellation_notice, required_endorsements_json, rule_config_json,
        notes, is_active, created_at, updated_at
      FROM coverage_requirements;

      DROP TABLE coverage_requirements;
      ALTER TABLE coverage_requirements_rebuild RENAME TO coverage_requirements;

      CREATE INDEX requirements_vendor_type_idx
        ON coverage_requirements (organization_id, vendor_type_id, is_active);
      CREATE UNIQUE INDEX ${ACTIVE_REQUIREMENT_INDEX}
        ON coverage_requirements (organization_id, vendor_type_id, coverage_type)
        WHERE is_active = 1;
    `);

    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Coverage requirement migration found ${violations.length} foreign-key violation(s)`,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }

  const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as
    | { foreign_keys: number }
    | undefined;
  if (foreignKeys?.foreign_keys !== 1) {
    throw new Error("SQLite foreign-key enforcement was not restored after migration");
  }
};

/**
 * API-owned additive tables. The foundation schema remains versioned separately;
 * these tables preserve immutable requirement publications and evaluation context.
 */
export const ensureApiSchema = (database: OpenCoiDatabase): void => {
  migrateCoverageRequirementsForHistory(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS requirement_versions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      vendor_type_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      requirements_json TEXT NOT NULL CHECK (json_valid(requirements_json)),
      published_by_user_id TEXT,
      published_at TEXT NOT NULL,
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, vendor_type_id, version),
      FOREIGN KEY (organization_id, vendor_type_id)
        REFERENCES vendor_types(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, published_by_user_id)
        REFERENCES users(organization_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS requirement_versions_current_idx
      ON requirement_versions (organization_id, vendor_type_id, version DESC);
  `);
};
