import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapOrganization,
  createOrganizationRepository,
  type OpenCoiDatabase,
  openDatabase,
} from "../db.js";
import type { DocumentStore, StoredDocument } from "../storage.js";
import {
  createCertificateRequest,
  getCertificateRequest,
  markCertificateRequestSubmitted,
} from "./certificateRequests.js";
import { ingestCertificate } from "./certificates.js";
import { ensureIntegrationSchema } from "./integrationSchema.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const PDF = Buffer.from("%PDF-1.7\ntransaction fixture\n", "utf8");

describe("certificate ingest transaction boundary", () => {
  let database: OpenCoiDatabase;
  let removed: string[];
  let store: DocumentStore;

  beforeEach(() => {
    database = openDatabase(":memory:");
    bootstrapOrganization(database, {
      organizationId: "org-a",
      organizationName: "Organization A",
      organizationSlug: "organization-a",
      administratorId: "admin-a",
      administratorName: "Admin A",
      administratorEmail: "admin@example.test",
      administratorPasswordHash: "hash",
    });
    ensureIntegrationSchema(database);
    const repository = createOrganizationRepository(database, "org-a");
    const vendorType = repository.createVendorType({ id: "type-a", name: "Contractor" });
    repository.createCoverageRequirement({
      id: "requirement-a",
      vendorTypeId: vendorType.id,
      coverageType: "general_liability",
      minimumEachOccurrence: 100_000_000,
      ruleConfig: { version: 1, required: true },
    });
    repository.createVendor({
      id: "vendor-a",
      vendorTypeId: vendorType.id,
      legalName: "Vendor A",
    });
    createCertificateRequest(database, {
      organizationId: "org-a",
      vendorId: "vendor-a",
      uploadToken: `v1.org-a.${"x".repeat(48)}`,
      expiresAt: "2026-09-15T10:00:00.000Z",
      kind: "initial",
      deliveryMethod: "manual",
      createdByUserId: "admin-a",
      requestId: "request-a",
      uploadLinkId: "link-a",
      at: NOW.toISOString(),
    });
    removed = [];
    store = {
      async putPdf(input): Promise<StoredDocument> {
        return {
          storageKey: "aa/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf",
          sha256: createHash("sha256").update(input).digest("hex"),
          sizeBytes: input.byteLength,
          detectedMime: "application/pdf",
          pageCountEstimate: 1,
        };
      },
      async get() {
        return PDF;
      },
      async remove(storageKey) {
        removed.push(storageKey);
      },
    };
  });

  afterEach(() => database.close());

  it("rolls back link consumption, persisted records, and request completion when the in-transaction hook fails", async () => {
    const repository = createOrganizationRepository(database, "org-a");
    await expect(
      ingestCertificate({
        database,
        repository,
        documentStore: store,
        vendorId: "vendor-a",
        originalFilename: "certificate.pdf",
        bytes: PDF,
        metadata: { reviewStatus: "UNCONFIRMED", policies: [] },
        uploadLinkId: "link-a",
        consumeUploadLink: true,
        forceUnconfirmed: true,
        now: NOW,
        withinTransaction: (result) => {
          expect(
            markCertificateRequestSubmitted(database, {
              organizationId: "org-a",
              uploadLinkId: "link-a",
              certificateId: result.certificate.id,
              at: NOW.toISOString(),
            }),
          ).toMatchObject({ state: "submitted" });
          throw new Error("simulated audit failure");
        },
      }),
    ).rejects.toThrow("simulated audit failure");

    expect(database.prepare("SELECT count(*) AS count FROM documents").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM certificates").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT count(*) AS count FROM domain_events").get()).toEqual({
      count: 0,
    });
    expect(
      database.prepare("SELECT use_count, revoked_at FROM upload_links WHERE id = ?").get("link-a"),
    ).toEqual({ use_count: 0, revoked_at: null });
    expect(getCertificateRequest(database, "org-a", "request-a")).toMatchObject({
      state: "open",
      submittedCertificateId: null,
    });
    expect(removed).toEqual(["aa/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf"]);
  });
});
