import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import { ensureApiSchema } from "./schema.js";

describe("API schema migration", () => {
  let database: OpenCoiDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("preserves v1 requirement references and permits one active replacement", () => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin@example.test",
      administratorPasswordHash: "test-password-hash",
    });
    const repository = createOrganizationRepository(database, "org-a");
    const vendorType = repository.createVendorType({ id: "type-a", name: "Contractor" });
    const vendor = repository.createVendor({
      id: "vendor-a",
      vendorTypeId: vendorType.id,
      legalName: "Vendor A",
    });
    const requirementId = repository.createCoverageRequirement({
      id: "requirement-v1",
      vendorTypeId: vendorType.id,
      coverageType: "general_liability",
      minimumEachOccurrence: 100_000_000,
      ruleConfig: { version: 1 },
    });
    const document = repository.createDocument({
      id: "document-a",
      vendorId: vendor.id,
      uploadedByUserId: "admin-a",
      originalFilename: "certificate.pdf",
      storageKey: "legacy/certificate.pdf",
      byteSize: 100,
      sha256: "a".repeat(64),
    });
    const certificate = repository.createCertificate({
      id: "certificate-a",
      vendorId: vendor.id,
      documentId: document.id,
    });
    const finding = repository.replaceFindings(certificate.id, [
      {
        id: "finding-v1",
        requirementId,
        category: "LIMIT",
        evaluationStatus: "FAIL",
        code: "LIMIT_BELOW_MINIMUM",
        severity: "critical",
        message: "The submitted limit is below the v1 requirement.",
      },
    ])[0];

    ensureApiSchema(database);
    ensureApiSchema(database);

    expect(repository.listFindings(certificate.id)[0]).toMatchObject({
      id: finding?.id,
      requirement_id: "requirement-v1",
      message: "The submitted limit is below the v1 requirement.",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database
      .prepare(
        `UPDATE coverage_requirements SET is_active = 0
         WHERE organization_id = ? AND id = ?`,
      )
      .run("org-a", "requirement-v1");
    repository.createCoverageRequirement({
      id: "requirement-v2",
      vendorTypeId: vendorType.id,
      coverageType: "general_liability",
      minimumEachOccurrence: 200_000_000,
      ruleConfig: { version: 2 },
    });

    expect(repository.listCoverageRequirements(vendorType.id)).toEqual([
      expect.objectContaining({
        id: "requirement-v2",
        is_active: 1,
        minimum_each_occurrence: 200_000_000,
      }),
    ]);
    expect(
      database
        .prepare(
          `SELECT id, is_active FROM coverage_requirements
           WHERE organization_id = ? AND vendor_type_id = ? ORDER BY id`,
        )
        .all("org-a", vendorType.id),
    ).toEqual([
      { id: "requirement-v1", is_active: 0 },
      { id: "requirement-v2", is_active: 1 },
    ]);
    expect(() =>
      repository.createCoverageRequirement({
        id: "requirement-v2-duplicate",
        vendorTypeId: vendorType.id,
        coverageType: "general_liability",
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
