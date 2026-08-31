import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { bootstrapOrganization, createOrganizationRepository, openDatabase } from "../db.js";
import { hashPassword } from "../security.js";
import { ensureApiSchema } from "../services/schema.js";

const config = loadConfig();
if (!config.bootstrap) {
  throw new Error(
    "The explicit db:seed command requires BOOTSTRAP_ORG_* and BOOTSTRAP_ADMIN_* values",
  );
}
const database = openDatabase(config.databasePath);
ensureApiSchema(database);
try {
  const passwordHash = await hashPassword(config.bootstrap.administratorPassword);
  const bootstrap = bootstrapOrganization(database, {
    organizationName: config.bootstrap.organizationName,
    organizationSlug: config.bootstrap.organizationSlug,
    administratorName: config.bootstrap.administratorName,
    administratorEmail: config.bootstrap.administratorEmail,
    administratorPasswordHash: passwordHash,
  });
  if (!("organizationId" in bootstrap)) {
    throw new Error("Database contains users unrelated to the configured bootstrap organization");
  }
  const repository = createOrganizationRepository(database, bootstrap.organizationId);
  let vendorType = repository
    .listVendorTypes(false)
    .find((row) => row.name.toLowerCase() === "general contractor");
  if (!vendorType) {
    vendorType = repository.createVendorType({
      name: "General Contractor",
      description: "Sample profile created by the explicit seed command.",
    });
  }
  if (repository.listCoverageRequirements(vendorType.id).length === 0) {
    const publishedAt = new Date().toISOString();
    const requirements = [
      {
        coverageType: "general_liability",
        label: "Commercial General Liability",
        required: true,
        minimumEachOccurrence: 100_000_000,
        minimumAggregate: 200_000_000,
        currency: "USD",
        requiredEndorsements: ["Additional insured", "Waiver of subrogation"],
        endorsementEvidence: "document",
        expirationWarningDays: 30,
      },
    ];
    repository.transaction(() => {
      database
        .prepare(
          `INSERT INTO requirement_versions
            (id, organization_id, vendor_type_id, version, requirements_json,
             published_by_user_id, published_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          repository.organizationId,
          vendorType?.id,
          JSON.stringify(requirements),
          bootstrap.userId,
          publishedAt,
        );
      repository.createCoverageRequirement({
        vendorTypeId: vendorType?.id as string,
        coverageType: requirements[0]?.coverageType as string,
        minimumEachOccurrence: requirements[0]?.minimumEachOccurrence,
        minimumAggregate: requirements[0]?.minimumAggregate,
        requiredEndorsements: requirements[0]?.requiredEndorsements,
        ruleConfig: { ...requirements[0], version: 1, publishedAt },
      });
    });
  }
  if (repository.listVendors().length === 0) {
    repository.createVendor({
      vendorTypeId: vendorType.id,
      legalName: "Sample Electrical Contractor",
      contactName: "Vendor Insurance Contact",
      contactEmail: "vendor@example.test",
      externalReference: "SAMPLE-001",
      notes: "Safe sample data; replace or remove before production use.",
    });
  }
  process.stdout.write(
    `Seed complete for ${config.bootstrap.organizationName}. Existing records were preserved.\n`,
  );
} finally {
  database.close();
}
