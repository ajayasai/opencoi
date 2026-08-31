import { writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  openDatabase,
} from "../../server/db.js";
import { ensureIntegrationSchema } from "../../server/services/integrationSchema.js";
import { listVendorSummaryViews } from "../../server/services/projections.js";
import { ensureApiSchema } from "../../server/services/schema.js";

const parseSizes = (): number[] => {
  const argument = process.argv.find((value) => value.startsWith("--sizes="));
  const values = (argument?.slice("--sizes=".length) ?? "100,1000,10000").split(",").map(Number);
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 100_000)
  ) {
    throw new TypeError("--sizes must be a comma-separated list of integers from 1 to 100000");
  }
  return [...new Set(values)].sort((left, right) => left - right);
};

const outputPath = (): string | null => {
  const index = process.argv.indexOf("--output");
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new TypeError("--output requires a file path");
  return value;
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
};

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

const seedTo = (
  count: number,
  current: number,
  insertVendor: ReturnType<ReturnType<typeof openDatabase>["prepare"]>,
): void => {
  for (let index = current; index < count; index += 1) {
    const id = `vendor-${String(index).padStart(6, "0")}`;
    insertVendor.run(
      id,
      "org-scale",
      "type-scale",
      `Vendor ${String(index).padStart(6, "0")}`,
      index % 3 === 0 ? `Trade ${index}` : null,
      `Contact ${index}`,
      `insurance-${index}@example.test`,
      `EXT-${index}`,
      "2026-08-31T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    );
  }
};

const main = async (): Promise<void> => {
  const sizes = parseSizes();
  const database = openDatabase(":memory:");
  try {
    bootstrapOrganization(database, {
      organizationId: "org-scale",
      organizationName: "Scale Benchmark",
      organizationSlug: "scale-benchmark",
      administratorId: "scale-admin",
      administratorName: "Scale Admin",
      administratorEmail: "scale@example.test",
      administratorPasswordHash: "not-a-login-credential",
    });
    const repository = createOrganizationRepository(database, "org-scale");
    repository.createVendorType({ id: "type-scale", name: "Synthetic contractor" });
    ensureApiSchema(database);
    ensureIntegrationSchema(database);
    const insertVendor = database.prepare(
      `INSERT INTO vendors
        (id, organization_id, vendor_type_id, legal_name, trade_name, contact_name,
         contact_email, external_reference, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    );
    let seeded = 0;
    const results: Array<Record<string, unknown>> = [];
    for (const size of sizes) {
      database.exec("BEGIN IMMEDIATE");
      try {
        seedTo(size, seeded, insertVendor);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
      seeded = size;
      const execute = () =>
        listVendorSummaryViews(database, repository, {}, new Date("2026-08-31T00:00:00.000Z"));
      execute();
      const samples: number[] = [];
      let rowCount = 0;
      for (let run = 0; run < 10; run += 1) {
        const start = performance.now();
        rowCount = execute().length;
        samples.push(performance.now() - start);
      }
      results.push({
        vendors: size,
        rowsReturned: rowCount,
        samples: samples.length,
        latencyMs: {
          min: round(Math.min(...samples)),
          median: round(percentile(samples, 0.5)),
          p95: round(percentile(samples, 0.95)),
          max: round(Math.max(...samples)),
        },
        processRssMb: round(process.memoryUsage().rss / 1024 / 1024),
      });
    }
    const report = {
      schemaVersion: "opencoi-scale-v1",
      generatedAt: new Date().toISOString(),
      workload: {
        name: "tenant vendor summary list",
        implementation: "single aggregate SQL statement plus in-process status mapping",
        database: "SQLite :memory:",
        documents: 0,
        warmupRuns: 1,
        measuredRuns: 10,
        warning: "Latency is hardware-specific and is not a capacity guarantee.",
      },
      runtime: {
        node: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        totalMemoryMb: round(totalmem() / 1024 / 1024),
        freeMemoryMbAtEnd: round(freemem() / 1024 / 1024),
      },
      results,
    };
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    const destination = outputPath();
    if (destination) await writeFile(destination, encoded, "utf8");
    process.stdout.write(encoded);
  } finally {
    database.close();
  }
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
