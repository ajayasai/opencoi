import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import { listVendorSummaryViews } from "./projections.js";

describe("vendor summary projection query growth", () => {
  let database: OpenCoiDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("uses one prepared aggregate query regardless of vendor count", () => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-scale",
      organizationName: "Scale Test",
      organizationSlug: "scale-test",
      administratorId: "admin-scale",
      administratorName: "Scale Admin",
      administratorEmail: "scale@example.test",
      administratorPasswordHash: "test-password-hash",
    });
    const repository = createOrganizationRepository(database, "org-scale");
    repository.createVendorType({ id: "type-scale", name: "Contractor" });
    const insert = database.prepare(
      `INSERT INTO vendors
        (id, organization_id, vendor_type_id, legal_name, status, created_at, updated_at)
       VALUES (?, 'org-scale', 'type-scale', ?, 'active', ?, ?)`,
    );
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 250; index += 1) {
      const timestamp = "2026-08-31T00:00:00.000Z";
      insert.run(
        `vendor-${index}`,
        `Vendor ${String(index).padStart(3, "0")}`,
        timestamp,
        timestamp,
      );
    }
    database.exec("COMMIT");
    const prepare = vi.spyOn(database, "prepare");

    const rows = listVendorSummaryViews(
      database,
      repository,
      { q: "vendor", type: "type-scale" },
      new Date("2026-08-31T00:00:00.000Z"),
    );

    expect(rows).toHaveLength(250);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
