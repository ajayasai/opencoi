import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.js";
import { type OpenCoiDatabase, openDatabase } from "../db.js";
import {
  databaseMigrationsCurrent,
  type MigrationPlanEntry,
  migrateDatabase,
  planDatabaseMigrations,
} from "../migrations.js";

type Mode = "apply" | "plan" | "check";

interface CliOptions {
  mode: Mode;
  databasePath?: string;
  help: boolean;
}

const usage = `Usage: npm run db:migrate -- [--plan | --check] [--database PATH]

  (no mode)        Apply or adopt all known migrations.
  --plan           Read-only preview; exits successfully when migrations are pending.
  --check          Read-only readiness check; exits 1 when migrations are pending.
  --database PATH  Override DATABASE_PATH for this command.
  --help            Show this help.
`;

const parseArguments = (arguments_: string[]): CliOptions => {
  let mode: Mode = "apply";
  let explicitMode = false;
  let databasePath: string | undefined;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--plan" || argument === "--check") {
      if (explicitMode) throw new Error("Choose only one of --plan or --check");
      mode = argument === "--plan" ? "plan" : "check";
      explicitMode = true;
      continue;
    }
    if (argument === "--database") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--database requires a path");
      }
      databasePath = resolve(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--database=")) {
      const value = argument.slice("--database=".length);
      if (!value) throw new Error("--database requires a path");
      databasePath = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { mode, databasePath, help };
};

const openReadOnly = (databasePath: string): OpenCoiDatabase => {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000,
  });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const renderPlan = (entries: MigrationPlanEntry[]): string =>
  entries
    .map((entry) => {
      const state =
        entry.action === "recorded"
          ? `ok (${entry.appliedKind ?? "recorded"})`
          : entry.action === "adopt"
            ? "adopt existing schema"
            : "apply";
      return `${String(entry.sequence).padStart(4, "0")}  ${state.padEnd(22)}  ${entry.id}\n      sha256:${entry.checksum}`;
    })
    .join("\n");

const main = (): void => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  const databasePath = options.databasePath ?? loadConfig().databasePath;
  const targetExists = existsSync(databasePath);
  let database: OpenCoiDatabase;
  if (options.mode === "apply") {
    database = openDatabase(databasePath, { initialize: false });
  } else if (targetExists) {
    database = openReadOnly(databasePath);
  } else {
    // Planning a new installation must not create the target file. An empty
    // in-memory database has the same migration state as an absent target.
    database = openDatabase(":memory:", { initialize: false });
  }

  try {
    const absentReadOnlyTarget = options.mode !== "apply" && !targetExists;
    process.stdout.write(
      `Database: ${databasePath}${absentReadOnlyTarget ? " (not created)" : ""}\n`,
    );
    if (options.mode === "apply") {
      const result = migrateDatabase(database);
      process.stdout.write(
        `${result
          .map(
            (entry) =>
              `${String(entry.sequence).padStart(4, "0")}  ${entry.result.padEnd(9)}  ${entry.id}`,
          )
          .join("\n")}\n`,
      );
      process.stdout.write("Migration complete; ledger and foreign-key checks passed.\n");
      return;
    }

    const plan = planDatabaseMigrations(database);
    process.stdout.write(`${renderPlan(plan)}\n`);
    const current = databaseMigrationsCurrent(database);
    if (options.mode === "check" && !current) {
      process.stderr.write("Database migrations are not current. Run npm run db:migrate.\n");
      process.exitCode = 1;
    } else if (current) {
      process.stdout.write("Database migrations are current.\n");
    } else {
      process.stdout.write("Plan only; no database changes were made.\n");
    }
  } finally {
    database.close();
  }
};

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
