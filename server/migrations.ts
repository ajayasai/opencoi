import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_SCHEMA_VERSION,
  FOUNDATION_SCHEMA_V1_TO_V2_SQL,
  FOUNDATION_SCHEMA_V2_TO_V3_SQL,
  FOUNDATION_SCHEMA_V3_TO_V4_SQL,
  FOUNDATION_SCHEMA_V4_SQL,
  initializeDatabase,
  type OpenCoiDatabase,
} from "./db.js";
import {
  ensureIntegrationSchema,
  IDEMPOTENCY_RESPONSE_HEADERS_MIGRATION_SQL,
  INTEGRATION_SCHEMA_V1_SQL,
} from "./services/integrationSchema.js";
import {
  API_ADDITIVE_SCHEMA_V1_SQL,
  ensureApiSchema,
  REQUIREMENT_HISTORY_MIGRATION_SQL,
} from "./services/schema.js";

export const MIGRATION_LEDGER_TABLE = "opencoi_schema_migrations";
const FOUNDATION_MIGRATION_USER_VERSION = 4;

const LEDGER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
    migration_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL,
    applied_kind TEXT NOT NULL CHECK (applied_kind IN ('applied', 'adopted')),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
  ) STRICT;
`;

const FOUNDATION_TABLES = [
  "organizations",
  "users",
  "sessions",
  "oidc_identities",
  "oidc_login_transactions",
  "vendor_types",
  "coverage_requirements",
  "vendors",
  "upload_links",
  "documents",
  "certificates",
  "policies",
  "certificate_endorsements",
  "findings",
  "exceptions",
  "reminders",
  "certificate_requests",
  "audit_events",
] as const;

const API_TABLES = ["requirement_versions", "evidence_signing_keys"] as const;

const INTEGRATION_TABLES = [
  "service_accounts",
  "service_account_secrets",
  "webhook_endpoints",
  "domain_events",
  "webhook_deliveries",
  "api_idempotency_keys",
] as const;

const FOUNDATION_INDEXES = [
  "sessions_active_lookup_idx",
  "oidc_transactions_active_idx",
  "requirements_vendor_type_idx",
  "vendors_status_idx",
  "documents_vendor_idx",
  "certificates_vendor_idx",
  "certificates_expiration_idx",
  "policies_certificate_idx",
  "findings_open_idx",
  "exceptions_status_idx",
  "upload_links_active_idx",
  "reminders_due_idx",
  "certificate_requests_vendor_idx",
  "certificate_requests_delivery_idx",
  "audit_events_chain_idx",
] as const;

const API_INDEXES = [
  "coverage_requirements_active_unique_idx",
  "requirement_versions_current_idx",
  "evidence_signing_keys_active_idx",
] as const;

const INTEGRATION_INDEXES = [
  "service_account_secrets_lookup_idx",
  "domain_events_feed_idx",
  "webhook_deliveries_due_idx",
  "api_idempotency_expiry_idx",
  "vendors_api_cursor_idx",
] as const;

const FOUNDATION_TRIGGERS = ["audit_events_no_update", "audit_events_no_delete"] as const;
const INTEGRATION_TRIGGERS = ["domain_events_no_update", "domain_events_no_delete"] as const;

interface LedgerRow {
  sequence: number;
  migration_id: string;
  name: string;
  checksum: string;
  applied_at: string;
  applied_kind: "applied" | "adopted";
  duration_ms: number;
}

interface MigrationDefinition {
  sequence: number;
  id: string;
  name: string;
  checksumMaterial: string;
  transactional: boolean;
  isInstalled: (database: OpenCoiDatabase) => boolean;
  apply: (database: OpenCoiDatabase) => void;
}

export type MigrationPlanAction = "recorded" | "adopt" | "apply";

export interface MigrationPlanEntry {
  sequence: number;
  id: string;
  name: string;
  checksum: string;
  action: MigrationPlanAction;
  appliedAt: string | null;
  appliedKind: "applied" | "adopted" | null;
}

export interface MigrationRunEntry extends MigrationPlanEntry {
  result: "unchanged" | "applied" | "adopted";
  durationMs: number;
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

const checksum = (migration: MigrationDefinition): string =>
  createHash("sha256")
    .update(
      `${migration.sequence}\0${migration.id}\0${migration.name}\0${migration.checksumMaterial}`,
    )
    .digest("hex");

const userVersion = (database: OpenCoiDatabase): number => {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
};

interface ColumnContract {
  name: string;
  type: string;
  notNull: boolean;
  defaultTokens: readonly string[] | null;
  primaryKeyPosition: number;
  hidden: number;
}

interface IndexColumnContract {
  name: string | null;
  descending: boolean;
  collation: string;
}

interface IndexContract {
  name: string;
  table: string;
  unique: boolean;
  partial: boolean;
  columns: readonly IndexColumnContract[];
  predicateTokens: readonly string[];
}

interface TableContract {
  name: string;
  columns: ReadonlyMap<string, ColumnContract>;
  checkClauses: readonly (readonly string[])[];
  foreignKeys: readonly string[];
  requiredUniqueKeys: readonly string[];
  strict: boolean;
  withoutRowid: boolean;
}

interface TriggerContract {
  name: string;
  table: string;
  tokens: readonly string[];
}

interface SchemaContract {
  tables: ReadonlyMap<string, TableContract>;
  indexes: ReadonlyMap<string, IndexContract>;
  triggers: ReadonlyMap<string, TriggerContract>;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

const assertInternalIdentifier = (identifier: string): void => {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe internal schema identifier: ${identifier}`);
  }
};

/**
 * Tokenize SQLite DDL so contract checks are insensitive to whitespace,
 * comments, keyword casing, and harmless identifier quoting differences.
 */
const tokenizeSql = (sql: string): string[] => {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const character = sql[cursor] ?? "";
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      cursor += 2;
      while (cursor < sql.length && sql[cursor] !== "\n") cursor += 1;
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      const end = sql.indexOf("*/", cursor + 2);
      cursor = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (character === "'") {
      let value = "";
      cursor += 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          value += "'";
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") {
          cursor += 1;
          break;
        }
        value += sql[cursor] ?? "";
        cursor += 1;
      }
      tokens.push(`string:${value}`);
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let value = "";
      cursor += 1;
      while (cursor < sql.length) {
        if (sql[cursor] === closing && sql[cursor + 1] === closing) {
          value += closing;
          cursor += 2;
        } else if (sql[cursor] === closing) {
          cursor += 1;
          break;
        } else {
          value += sql[cursor] ?? "";
          cursor += 1;
        }
      }
      tokens.push(value.toLowerCase());
      continue;
    }
    if (/[a-z_]/i.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < sql.length && /[a-z0-9_$]/i.test(sql[cursor] ?? "")) cursor += 1;
      tokens.push(sql.slice(start, cursor).toLowerCase());
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < sql.length && /[0-9.e+-]/i.test(sql[cursor] ?? "")) cursor += 1;
      tokens.push(sql.slice(start, cursor).toLowerCase());
      continue;
    }
    const doubleOperator = sql.slice(cursor, cursor + 2);
    if ([">=", "<=", "<>", "!=", "==", "||", "->"].includes(doubleOperator)) {
      tokens.push(doubleOperator);
      cursor += 2;
      continue;
    }
    tokens.push(character.toLowerCase());
    cursor += 1;
  }
  return tokens;
};

const containsTokens = (tokens: readonly string[], expected: readonly string[]): boolean => {
  if (expected.length === 0) return true;
  for (let start = 0; start <= tokens.length - expected.length; start += 1) {
    if (expected.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
};

const checkClauses = (tokens: readonly string[]): string[][] => {
  const result: string[][] = [];
  for (let start = 0; start < tokens.length - 1; start += 1) {
    if (tokens[start] !== "check" || tokens[start + 1] !== "(") continue;
    let depth = 0;
    for (let end = start + 1; end < tokens.length; end += 1) {
      if (tokens[end] === "(") depth += 1;
      if (tokens[end] === ")") depth -= 1;
      if (depth === 0) {
        result.push(tokens.slice(start, end + 1));
        start = end;
        break;
      }
    }
  }
  return result;
};

const normalizedCreateTokens = (tokens: readonly string[]): string[] => {
  const normalized = [...tokens];
  const objectType = normalized[1];
  if (
    (objectType === "trigger" || objectType === "index") &&
    normalized[2] === "if" &&
    normalized[3] === "not" &&
    normalized[4] === "exists"
  ) {
    normalized.splice(2, 3);
  }
  if (normalized.at(-1) === ";") normalized.pop();
  return normalized;
};

const foreignKeyContracts = (database: OpenCoiDatabase, table: string): string[] => {
  assertInternalIdentifier(table);
  const rows = database
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as unknown as ForeignKeyRow[];
  const grouped = new Map<number, ForeignKeyRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.id) ?? [];
    group.push(row);
    grouped.set(row.id, group);
  }
  return [...grouped.values()]
    .map((group) => {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      const first = ordered[0];
      return JSON.stringify({
        table: first?.table.toLowerCase(),
        from: ordered.map((row) => row.from.toLowerCase()),
        to: ordered.map((row) => row.to.toLowerCase()),
        onUpdate: first?.on_update.toLowerCase(),
        onDelete: first?.on_delete.toLowerCase(),
        match: first?.match.toLowerCase(),
      });
    })
    .sort();
};

const indexColumns = (database: OpenCoiDatabase, index: string): IndexColumnContract[] => {
  assertInternalIdentifier(index);
  return (database.prepare(`PRAGMA index_xinfo(${index})`).all() as unknown as IndexInfoRow[])
    .filter((row) => row.key === 1)
    .map((row) => ({
      name: row.name?.toLowerCase() ?? null,
      descending: row.desc === 1,
      collation: row.coll.toLowerCase(),
    }));
};

const indexKey = (database: OpenCoiDatabase, index: string): string =>
  JSON.stringify(indexColumns(database, index));

const requiredUniqueKeys = (database: OpenCoiDatabase, table: string): string[] => {
  assertInternalIdentifier(table);
  return (database.prepare(`PRAGMA index_list(${table})`).all() as unknown as IndexListRow[])
    .filter((row) => row.unique === 1 && (row.origin === "u" || row.origin === "pk"))
    .map((row) => indexKey(database, row.name))
    .sort();
};

const readTableContract = (database: OpenCoiDatabase, table: string): TableContract | null => {
  assertInternalIdentifier(table);
  const schema = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? AND sql IS NOT NULL")
    .get(table) as { sql: string } | undefined;
  if (!schema) return null;
  const tableList = (
    database.prepare("PRAGMA table_list").all() as Array<{
      name: string;
      type: string;
      strict: number;
      wr: number;
    }>
  ).find((row) => row.name === table && row.type === "table");
  if (!tableList) return null;
  const columns = new Map<string, ColumnContract>();
  for (const row of database
    .prepare(`PRAGMA table_xinfo(${table})`)
    .all() as unknown as TableInfoRow[]) {
    columns.set(row.name.toLowerCase(), {
      name: row.name.toLowerCase(),
      type: row.type.trim().toLowerCase(),
      notNull: row.notnull === 1,
      defaultTokens: row.dflt_value === null ? null : tokenizeSql(row.dflt_value),
      primaryKeyPosition: row.pk,
      hidden: row.hidden,
    });
  }
  const tokens = tokenizeSql(schema.sql);
  return {
    name: table,
    columns,
    checkClauses: checkClauses(tokens),
    foreignKeys: foreignKeyContracts(database, table),
    requiredUniqueKeys: requiredUniqueKeys(database, table),
    strict: tableList.strict === 1,
    withoutRowid: tableList.wr === 1,
  };
};

const readIndexContract = (database: OpenCoiDatabase, index: string): IndexContract | null => {
  assertInternalIdentifier(index);
  const schema = database
    .prepare(
      `SELECT tbl_name, sql FROM sqlite_schema
       WHERE type = 'index' AND name = ? AND sql IS NOT NULL`,
    )
    .get(index) as { tbl_name: string; sql: string } | undefined;
  if (!schema) return null;
  assertInternalIdentifier(schema.tbl_name);
  const listRow = (
    database.prepare(`PRAGMA index_list(${schema.tbl_name})`).all() as unknown as IndexListRow[]
  ).find((row) => row.name === index);
  if (!listRow) return null;
  const tokens = tokenizeSql(schema.sql);
  const where = tokens.indexOf("where");
  return {
    name: index,
    table: schema.tbl_name,
    unique: listRow.unique === 1,
    partial: listRow.partial === 1,
    columns: indexColumns(database, index),
    predicateTokens: where === -1 ? [] : tokens.slice(where + 1),
  };
};

const readTriggerContract = (
  database: OpenCoiDatabase,
  trigger: string,
): TriggerContract | null => {
  assertInternalIdentifier(trigger);
  const schema = database
    .prepare(
      `SELECT tbl_name, sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = ? AND sql IS NOT NULL`,
    )
    .get(trigger) as { tbl_name: string; sql: string } | undefined;
  if (!schema) return null;
  return {
    name: trigger,
    table: schema.tbl_name,
    tokens: normalizedCreateTokens(tokenizeSql(schema.sql)),
  };
};

let referenceContract: SchemaContract | null = null;

const getReferenceContract = (): SchemaContract => {
  if (referenceContract) return referenceContract;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(FOUNDATION_SCHEMA_V4_SQL);
    reference.exec(API_ADDITIVE_SCHEMA_V1_SQL);
    reference.exec(INTEGRATION_SCHEMA_V1_SQL);
    reference.exec(LEDGER_SCHEMA_SQL);
    const tables = new Map<string, TableContract>();
    for (const table of [...FOUNDATION_TABLES, ...API_TABLES, ...INTEGRATION_TABLES]) {
      const contract = readTableContract(reference, table);
      if (!contract) throw new Error(`Reference schema omitted table ${table}`);
      tables.set(table, contract);
    }
    const ledgerContract = readTableContract(reference, MIGRATION_LEDGER_TABLE);
    if (!ledgerContract) throw new Error("Reference schema omitted the migration ledger");
    tables.set(MIGRATION_LEDGER_TABLE, ledgerContract);

    const indexes = new Map<string, IndexContract>();
    for (const index of [...FOUNDATION_INDEXES, ...API_INDEXES, ...INTEGRATION_INDEXES]) {
      const contract = readIndexContract(reference, index);
      if (!contract) throw new Error(`Reference schema omitted index ${index}`);
      indexes.set(index, contract);
    }

    const triggers = new Map<string, TriggerContract>();
    for (const trigger of [...FOUNDATION_TRIGGERS, ...INTEGRATION_TRIGGERS]) {
      const contract = readTriggerContract(reference, trigger);
      if (!contract) throw new Error(`Reference schema omitted trigger ${trigger}`);
      triggers.set(trigger, contract);
    }
    referenceContract = { tables, indexes, triggers };
    return referenceContract;
  } finally {
    reference.close();
  }
};

const columnMatches = (actual: ColumnContract, expected: ColumnContract): boolean =>
  actual.type === expected.type &&
  actual.notNull === expected.notNull &&
  JSON.stringify(actual.defaultTokens) === JSON.stringify(expected.defaultTokens) &&
  actual.primaryKeyPosition === expected.primaryKeyPosition &&
  actual.hidden === expected.hidden;

const tableMatches = (database: OpenCoiDatabase, expected: TableContract): boolean => {
  const actual = readTableContract(database, expected.name);
  if (
    !actual ||
    actual.strict !== expected.strict ||
    actual.withoutRowid !== expected.withoutRowid
  ) {
    return false;
  }
  for (const [name, expectedColumn] of expected.columns) {
    const actualColumn = actual.columns.get(name);
    if (!actualColumn || !columnMatches(actualColumn, expectedColumn)) return false;
  }
  if (
    expected.checkClauses.some(
      (clause) => !actual.checkClauses.some((actualClause) => containsTokens(actualClause, clause)),
    )
  ) {
    return false;
  }
  if (expected.foreignKeys.some((foreignKey) => !actual.foreignKeys.includes(foreignKey))) {
    return false;
  }
  if (
    expected.requiredUniqueKeys.some((uniqueKey) => !actual.requiredUniqueKeys.includes(uniqueKey))
  ) {
    return false;
  }
  return true;
};

const indexMatches = (database: OpenCoiDatabase, expected: IndexContract): boolean => {
  const actual = readIndexContract(database, expected.name);
  return Boolean(
    actual &&
      actual.table === expected.table &&
      actual.unique === expected.unique &&
      actual.partial === expected.partial &&
      JSON.stringify(actual.columns) === JSON.stringify(expected.columns) &&
      JSON.stringify(actual.predicateTokens) === JSON.stringify(expected.predicateTokens),
  );
};

const triggerMatches = (database: OpenCoiDatabase, expected: TriggerContract): boolean => {
  const actual = readTriggerContract(database, expected.name);
  return Boolean(
    actual &&
      actual.table === expected.table &&
      JSON.stringify(actual.tokens) === JSON.stringify(expected.tokens),
  );
};

const schemaContractInstalled = (
  database: OpenCoiDatabase,
  contract: {
    tables: readonly string[];
    indexes: readonly string[];
    triggers: readonly string[];
  },
): boolean => {
  const reference = getReferenceContract();
  return (
    contract.tables.every((name) => {
      const expected = reference.tables.get(name);
      return Boolean(expected && tableMatches(database, expected));
    }) &&
    contract.indexes.every((name) => {
      const expected = reference.indexes.get(name);
      return Boolean(expected && indexMatches(database, expected));
    }) &&
    contract.triggers.every((name) => {
      const expected = reference.triggers.get(name);
      return Boolean(expected && triggerMatches(database, expected));
    })
  );
};

const foundationInstalled = (database: OpenCoiDatabase): boolean =>
  userVersion(database) >= FOUNDATION_MIGRATION_USER_VERSION &&
  schemaContractInstalled(database, {
    tables: FOUNDATION_TABLES,
    indexes: FOUNDATION_INDEXES,
    triggers: FOUNDATION_TRIGGERS,
  });

const apiSchemaInstalled = (database: OpenCoiDatabase): boolean =>
  schemaContractInstalled(database, {
    tables: API_TABLES,
    indexes: API_INDEXES,
    triggers: [],
  });

const integrationSchemaInstalled = (database: OpenCoiDatabase): boolean =>
  schemaContractInstalled(database, {
    tables: INTEGRATION_TABLES,
    indexes: INTEGRATION_INDEXES,
    triggers: INTEGRATION_TRIGGERS,
  });

const MIGRATIONS: readonly MigrationDefinition[] = [
  {
    sequence: 1,
    id: "0001-foundation-schema-v4",
    name: "Foundation schema through user_version 4",
    checksumMaterial: [
      FOUNDATION_SCHEMA_V4_SQL,
      FOUNDATION_SCHEMA_V1_TO_V2_SQL,
      FOUNDATION_SCHEMA_V2_TO_V3_SQL,
      FOUNDATION_SCHEMA_V3_TO_V4_SQL,
    ].join("\n"),
    transactional: true,
    isInstalled: foundationInstalled,
    apply: initializeDatabase,
  },
  {
    sequence: 2,
    id: "0002-requirement-history-and-evidence-keys",
    name: "Requirement history and evidence signing keys",
    checksumMaterial: `${REQUIREMENT_HISTORY_MIGRATION_SQL}\n${API_ADDITIVE_SCHEMA_V1_SQL}`,
    // The historical requirement rebuild must disable foreign keys before its
    // own immediate transaction. Its implementation performs rollback and
    // restores enforcement before this runner records the migration.
    transactional: false,
    isInstalled: apiSchemaInstalled,
    apply: ensureApiSchema,
  },
  {
    sequence: 3,
    id: "0003-service-accounts-events-and-webhooks",
    name: "Service accounts, domain events, and durable webhooks",
    checksumMaterial: `${INTEGRATION_SCHEMA_V1_SQL}\n${IDEMPOTENCY_RESPONSE_HEADERS_MIGRATION_SQL}`,
    transactional: true,
    isInstalled: integrationSchemaInstalled,
    apply: ensureIntegrationSchema,
  },
] as const;

const ledgerExists = (database: OpenCoiDatabase): boolean =>
  Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? AND sql IS NOT NULL")
      .get(MIGRATION_LEDGER_TABLE),
  );

const readLedger = (database: OpenCoiDatabase): LedgerRow[] => {
  if (!ledgerExists(database)) return [];
  const ledgerContract = getReferenceContract().tables.get(MIGRATION_LEDGER_TABLE);
  if (!ledgerContract || !tableMatches(database, ledgerContract)) {
    throw new MigrationIntegrityError(
      "Migration ledger does not match its required schema contract",
    );
  }
  try {
    return database
      .prepare(
        `SELECT sequence, migration_id, name, checksum, applied_at, applied_kind, duration_ms
         FROM ${MIGRATION_LEDGER_TABLE}
         ORDER BY sequence`,
      )
      .all() as unknown as LedgerRow[];
  } catch (error) {
    throw new MigrationIntegrityError(
      `Migration ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const validateVersion = (database: OpenCoiDatabase): void => {
  const version = userVersion(database);
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new MigrationIntegrityError(
      `Database schema version ${version} is newer than supported version ${DATABASE_SCHEMA_VERSION}`,
    );
  }
};

const validatedLedgerById = (database: OpenCoiDatabase): Map<string, LedgerRow> => {
  validateVersion(database);
  const knownById = new Map(MIGRATIONS.map((migration) => [migration.id, migration]));
  const result = new Map<string, LedgerRow>();
  for (const row of readLedger(database)) {
    const expected = knownById.get(row.migration_id);
    if (!expected) {
      throw new MigrationIntegrityError(
        `Migration ledger contains unknown or future migration ${row.migration_id}`,
      );
    }
    const expectedChecksum = checksum(expected);
    if (
      row.sequence !== expected.sequence ||
      row.name !== expected.name ||
      row.checksum !== expectedChecksum
    ) {
      throw new MigrationIntegrityError(
        `Migration ledger mismatch for ${expected.id}; expected sequence ${expected.sequence}, name ` +
          `"${expected.name}", and checksum ${expectedChecksum}`,
      );
    }
    if (!expected.isInstalled(database)) {
      throw new MigrationIntegrityError(
        `Migration ${expected.id} is recorded but its required schema objects are missing`,
      );
    }
    result.set(row.migration_id, row);
  }

  let gapSeen = false;
  for (const migration of MIGRATIONS) {
    const recorded = result.has(migration.id);
    if (!recorded) gapSeen = true;
    if (recorded && gapSeen) {
      throw new MigrationIntegrityError(
        `Migration ledger has a gap before recorded migration ${migration.id}`,
      );
    }
  }
  return result;
};

/** Inspect migration state without changing the database or creating the ledger. */
export const planDatabaseMigrations = (database: OpenCoiDatabase): MigrationPlanEntry[] => {
  const ledger = validatedLedgerById(database);
  return MIGRATIONS.map((migration) => {
    const recorded = ledger.get(migration.id);
    return {
      sequence: migration.sequence,
      id: migration.id,
      name: migration.name,
      checksum: checksum(migration),
      action: recorded ? "recorded" : migration.isInstalled(database) ? "adopt" : "apply",
      appliedAt: recorded?.applied_at ?? null,
      appliedKind: recorded?.applied_kind ?? null,
    };
  });
};

const assertForeignKeys = (database: OpenCoiDatabase): void => {
  const enabled = database.prepare("PRAGMA foreign_keys").get() as
    | { foreign_keys: number }
    | undefined;
  if (enabled?.foreign_keys !== 1) {
    throw new MigrationIntegrityError("SQLite foreign-key enforcement is disabled");
  }
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new MigrationIntegrityError(
      `Database has ${violations.length} foreign-key violation(s) after migration`,
    );
  }
};

export const databaseMigrationsCurrent = (database: OpenCoiDatabase): boolean => {
  const current = planDatabaseMigrations(database).every((entry) => entry.action === "recorded");
  if (current) assertForeignKeys(database);
  return current;
};

const recordMigration = (
  database: OpenCoiDatabase,
  migration: MigrationDefinition,
  kind: "applied" | "adopted",
  appliedAt: string,
  durationMs: number,
): void => {
  database
    .prepare(
      `INSERT INTO ${MIGRATION_LEDGER_TABLE}
        (sequence, migration_id, name, checksum, applied_at, applied_kind, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      migration.sequence,
      migration.id,
      migration.name,
      checksum(migration),
      appliedAt,
      kind,
      durationMs,
    );
};

const withImmediateTransaction = <T>(database: OpenCoiDatabase, work: () => T): T => {
  if (database.isTransaction) {
    throw new Error("Migration runner cannot start inside an existing transaction");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
};

const adoptMigration = (
  database: OpenCoiDatabase,
  migration: MigrationDefinition,
  now: () => Date,
): MigrationRunEntry =>
  withImmediateTransaction(database, () => {
    const ledger = validatedLedgerById(database);
    const raced = ledger.get(migration.id);
    if (raced) {
      return {
        sequence: migration.sequence,
        id: migration.id,
        name: migration.name,
        checksum: checksum(migration),
        action: "recorded",
        appliedAt: raced.applied_at,
        appliedKind: raced.applied_kind,
        result: "unchanged",
        durationMs: 0,
      };
    }
    if (!migration.isInstalled(database)) {
      throw new MigrationIntegrityError(
        `Migration ${migration.id} was selected for adoption but its schema is incomplete`,
      );
    }
    assertForeignKeys(database);
    const appliedAt = now().toISOString();
    recordMigration(database, migration, "adopted", appliedAt, 0);
    return {
      sequence: migration.sequence,
      id: migration.id,
      name: migration.name,
      checksum: checksum(migration),
      action: "adopt",
      appliedAt,
      appliedKind: "adopted",
      result: "adopted",
      durationMs: 0,
    };
  });

const applyTransactionalMigration = (
  database: OpenCoiDatabase,
  migration: MigrationDefinition,
  now: () => Date,
): MigrationRunEntry =>
  withImmediateTransaction(database, () => {
    const ledger = validatedLedgerById(database);
    const raced = ledger.get(migration.id);
    if (raced) {
      return {
        sequence: migration.sequence,
        id: migration.id,
        name: migration.name,
        checksum: checksum(migration),
        action: "recorded",
        appliedAt: raced.applied_at,
        appliedKind: raced.applied_kind,
        result: "unchanged",
        durationMs: 0,
      };
    }
    if (migration.isInstalled(database)) {
      assertForeignKeys(database);
      const appliedAt = now().toISOString();
      recordMigration(database, migration, "adopted", appliedAt, 0);
      return {
        sequence: migration.sequence,
        id: migration.id,
        name: migration.name,
        checksum: checksum(migration),
        action: "adopt",
        appliedAt,
        appliedKind: "adopted",
        result: "adopted",
        durationMs: 0,
      };
    }
    const startedAt = Date.now();
    migration.apply(database);
    if (!migration.isInstalled(database)) {
      throw new MigrationIntegrityError(
        `Migration ${migration.id} completed without installing its required schema`,
      );
    }
    assertForeignKeys(database);
    const durationMs = Math.max(0, Date.now() - startedAt);
    const appliedAt = now().toISOString();
    recordMigration(database, migration, "applied", appliedAt, durationMs);
    return {
      sequence: migration.sequence,
      id: migration.id,
      name: migration.name,
      checksum: checksum(migration),
      action: "apply",
      appliedAt,
      appliedKind: "applied",
      result: "applied",
      durationMs,
    };
  });

const applyNonTransactionalMigration = (
  database: OpenCoiDatabase,
  migration: MigrationDefinition,
  now: () => Date,
): MigrationRunEntry => {
  const startedAt = Date.now();
  migration.apply(database);
  if (!migration.isInstalled(database)) {
    throw new MigrationIntegrityError(
      `Migration ${migration.id} completed without installing its required schema`,
    );
  }
  assertForeignKeys(database);
  const durationMs = Math.max(0, Date.now() - startedAt);
  return withImmediateTransaction(database, () => {
    const ledger = validatedLedgerById(database);
    const raced = ledger.get(migration.id);
    if (raced) {
      return {
        sequence: migration.sequence,
        id: migration.id,
        name: migration.name,
        checksum: checksum(migration),
        action: "recorded",
        appliedAt: raced.applied_at,
        appliedKind: raced.applied_kind,
        result: "unchanged",
        durationMs: 0,
      };
    }
    const appliedAt = now().toISOString();
    recordMigration(database, migration, "applied", appliedAt, durationMs);
    return {
      sequence: migration.sequence,
      id: migration.id,
      name: migration.name,
      checksum: checksum(migration),
      action: "apply",
      appliedAt,
      appliedKind: "applied",
      result: "applied",
      durationMs,
    };
  });
};

/**
 * Apply or adopt every known migration in order. Existing v0.3 schema is
 * adopted after structural verification; no application data is rewritten.
 */
export const migrateDatabase = (
  database: OpenCoiDatabase,
  options: { now?: () => Date } = {},
): MigrationRunEntry[] => {
  if (database.isTransaction) {
    throw new Error("Migration runner cannot start inside an existing transaction");
  }
  database.exec("PRAGMA foreign_keys = ON");
  validateVersion(database);
  withImmediateTransaction(database, () => database.exec(LEDGER_SCHEMA_SQL));

  const now = options.now ?? (() => new Date());
  const results: MigrationRunEntry[] = [];
  for (const migration of MIGRATIONS) {
    const plan = planDatabaseMigrations(database).find((entry) => entry.id === migration.id);
    if (!plan) throw new Error(`Migration plan omitted ${migration.id}`);
    if (plan.action === "recorded") {
      results.push({ ...plan, result: "unchanged", durationMs: 0 });
    } else if (plan.action === "adopt") {
      results.push(adoptMigration(database, migration, now));
    } else if (migration.transactional) {
      results.push(applyTransactionalMigration(database, migration, now));
    } else {
      results.push(applyNonTransactionalMigration(database, migration, now));
    }
  }
  assertForeignKeys(database);
  if (!databaseMigrationsCurrent(database)) {
    throw new MigrationIntegrityError("Database migration ledger is not current after migration");
  }
  return results;
};

/** Public, immutable metadata useful for diagnostics and release tooling. */
export const databaseMigrationCatalog = (): ReadonlyArray<
  Pick<MigrationPlanEntry, "sequence" | "id" | "name" | "checksum">
> =>
  MIGRATIONS.map((migration) => ({
    sequence: migration.sequence,
    id: migration.id,
    name: migration.name,
    checksum: checksum(migration),
  }));
