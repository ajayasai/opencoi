import { describe, expect, it } from "vitest";
import type { CertificateRecord } from "../types";
import {
  correctionDraftFromCertificate,
  correctionInputFromDraft,
} from "./CertificateCorrectionEditor";

const certificate = (): CertificateRecord => ({
  id: "certificate-1",
  vendorId: "vendor-1",
  originalFilename: "certificate.pdf",
  sha256: "a".repeat(64),
  documentStatus: "pending_review",
  checkStatus: "needs_review",
  lifecycleStatus: "current",
  issueDate: "2026-01-02",
  namedInsured: "Example Vendor LLC",
  producer: "Example Broker",
  certificateHolder: "Example Holder",
  uploadedAt: "2026-01-02T12:00:00.000Z",
  policies: [
    {
      id: "policy-1",
      coverageType: "PROFESSIONAL_LIABILITY",
      insurer: "Example Specialty Insurance",
      policyNumber: "PRO-1",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      eachOccurrence: 9,
      aggregate: 10,
      limits: { EACH_CLAIM: 500_000_000, AGGREGATE: 1_000_000_000 },
      currency: "USD",
      additionalInsured: false,
      waiverOfSubrogation: false,
      primaryNoncontributory: false,
      endorsements: [
        {
          name: "Professional liability endorsement",
          formCode: "PL-100",
          evidenceLevel: "HUMAN_VERIFIED",
          evidence: "reviewed_document",
        },
      ],
    },
  ],
  findings: [],
});

describe("certificate correction mapping", () => {
  it("round-trips exact limit types and endorsement evidence", () => {
    const draft = correctionDraftFromCertificate(certificate());

    expect(draft.policies[0]?.limits).toEqual([
      { id: "policy-1:EACH_CLAIM", type: "EACH_CLAIM", amount: "5000000" },
      { id: "policy-1:AGGREGATE", type: "AGGREGATE", amount: "10000000" },
    ]);
    const input = correctionInputFromDraft(draft);
    expect(input.policies[0]).toMatchObject({
      limits: { EACH_CLAIM: 500_000_000, AGGREGATE: 1_000_000_000 },
      endorsements: [
        {
          name: "Professional liability endorsement",
          formCode: "PL-100",
          evidenceLevel: "HUMAN_VERIFIED",
        },
      ],
    });
    expect(input.policies[0]?.limits).not.toHaveProperty("EACH_OCCURRENCE");
  });

  it("rejects duplicate exact types and blank limit amounts", () => {
    const draft = correctionDraftFromCertificate(certificate());
    const firstLimit = draft.policies[0]?.limits[0];
    if (!firstLimit || !draft.policies[0]) throw new Error("Fixture is incomplete");
    draft.policies[0].limits.push({ ...firstLimit, id: "duplicate" });
    expect(() => correctionInputFromDraft(draft)).toThrow(/cannot contain two/i);

    const blankDraft = correctionDraftFromCertificate(certificate());
    if (!blankDraft.policies[0]?.limits[0]) throw new Error("Fixture is incomplete");
    blankDraft.policies[0].limits[0].amount = "";
    expect(() => correctionInputFromDraft(blankDraft)).toThrow(/needs an amount/i);
  });
});
