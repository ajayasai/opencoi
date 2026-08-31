import { describe, expect, it } from "vitest";
import { documentFacts, parseCertificateMetadata } from "./certificates.js";

const baseMetadata = {
  reviewStatus: "UNCONFIRMED" as const,
  rawText:
    "--- Page 1 ---\nNAMED INSURED: Acme Electric LLC\n\n--- Page 2 ---\nPOLICY NUMBER GL-123\nEACH OCCURRENCE $1,000,000\n\n--- Page 3 ---\nADDITIONAL INSURED",
  pages: [
    {
      page: 1,
      text: "  NAMED   INSURED: Acme Electric LLC  ",
      method: "text_layer" as const,
      confidenceBps: 10_000,
    },
    {
      page: 2,
      text: "POLICY NUMBER GL-123\nEACH OCCURRENCE $1,000,000",
      method: "ocr" as const,
      confidenceBps: 8_400,
    },
    { page: 3, text: "ADDITIONAL INSURED", method: "ocr" as const, confidenceBps: 8_000 },
  ],
  namedInsured: "Acme Electric LLC",
  certificateHolder: null,
  issueDate: null,
  producer: null,
  policies: [
    {
      coverageType: "COMMERCIAL_GENERAL_LIABILITY",
      insurer: "Example Mutual",
      policyNumber: "GL-123",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      limits: { EACH_OCCURRENCE: 100_000_000 },
      endorsements: [{ name: "Additional insured", evidenceLevel: "MENTIONED" as const }],
    },
  ],
  provenance: [
    {
      field: "NAMED_INSURED" as const,
      extractedValue: "Acme Electric LLC",
      source: "OCR" as const,
      confidenceBps: 9_000,
      rawText: "NAMED INSURED: Acme Electric LLC",
      page: 1,
    },
    {
      field: "POLICY_NUMBER" as const,
      extractedValue: "GL-123",
      policyIndex: 0,
      source: "OCR" as const,
      confidenceBps: 8_400,
      rawText: "POLICY NUMBER GL-123",
      page: 2,
    },
    {
      field: "LIMIT" as const,
      extractedValue: 100_000_000,
      policyIndex: 0,
      limitType: "EACH_OCCURRENCE" as const,
      source: "OCR" as const,
      rawText: "EACH OCCURRENCE $1,000,000",
      page: 2,
    },
    {
      field: "ENDORSEMENT_NAME" as const,
      extractedValue: "Additional insured",
      endorsementIndex: 0,
      source: "OCR" as const,
      rawText: "ADDITIONAL INSURED",
      page: 3,
    },
    {
      field: "ENDORSEMENT_EVIDENCE_LEVEL" as const,
      extractedValue: "MENTIONED",
      endorsementIndex: 0,
      source: "OCR" as const,
      rawText: "ADDITIONAL INSURED",
      page: 3,
    },
  ],
};

describe("certificate extraction provenance", () => {
  it("carries normalized page citations into rule facts", () => {
    const facts = documentFacts("document-a", parseCertificateMetadata(baseMetadata));
    expect(facts.namedInsured).toMatchObject({
      value: "Acme Electric LLC",
      source: "OCR",
      page: 1,
      rawText: "NAMED INSURED: Acme Electric LLC",
      confidenceBps: 9_000,
      confirmation: "UNCONFIRMED",
    });
    expect(facts.policies[0]?.policyNumber).toMatchObject({
      value: "GL-123",
      source: "OCR",
      page: 2,
      rawText: "POLICY NUMBER GL-123",
    });
    expect(facts.policies[0]?.limits.EACH_OCCURRENCE).toMatchObject({
      value: 100_000_000,
      source: "OCR",
      page: 2,
    });
    expect(facts.endorsements[0]?.name).toMatchObject({ source: "OCR", page: 3 });
    expect(facts.endorsements[0]?.evidenceLevel).toMatchObject({
      value: "MENTIONED",
      source: "OCR",
      page: 3,
    });
  });

  it("marks a human-corrected value as manual while preserving immutable OCR evidence", () => {
    const metadata = parseCertificateMetadata({
      ...baseMetadata,
      reviewStatus: "CONFIRMED",
      policies: [{ ...baseMetadata.policies[0], policyNumber: "GL-124" }],
    });
    const facts = documentFacts("document-a", metadata);
    expect(facts.policies[0]?.policyNumber).toMatchObject({
      value: "GL-124",
      source: "MANUAL",
      confirmation: "CONFIRMED",
      confidenceBps: 10_000,
    });
    expect(metadata.provenance).toContainEqual(
      expect.objectContaining({ field: "POLICY_NUMBER", extractedValue: "GL-123", page: 2 }),
    );
  });

  it("rejects provenance whose page is not in submitted page metadata", () => {
    expect(() =>
      parseCertificateMetadata({
        ...baseMetadata,
        provenance: [{ ...baseMetadata.provenance[0], page: 4 }],
      }),
    ).toThrow(/not present/i);
  });

  it("rejects provenance whose normalized source line is absent from the cited page", () => {
    expect(() =>
      parseCertificateMetadata({
        ...baseMetadata,
        provenance: [
          { ...baseMetadata.provenance[0], rawText: "NAMED INSURED: Fabricated Company" },
        ],
      }),
    ).toThrow(/does not match/i);
  });

  it("rejects duplicate or structurally untrusted page metadata", () => {
    expect(() =>
      parseCertificateMetadata({
        ...baseMetadata,
        pages: [...baseMetadata.pages, { ...baseMetadata.pages[0] }],
      }),
    ).toThrow(/duplicated/i);
    expect(() =>
      parseCertificateMetadata({
        ...baseMetadata,
        pages: [{ page: 1, text: "text", method: "text_layer", source: "spoofed" }],
        provenance: [],
      }),
    ).toThrow();
    expect(() =>
      parseCertificateMetadata({
        ...baseMetadata,
        pages: baseMetadata.pages.filter((page) => page.page !== 2),
        provenance: [],
      }),
    ).toThrow(/contiguous/i);
  });

  it("never accepts machine provenance above mentioned for endorsement evidence", () => {
    expect(() =>
      parseCertificateMetadata({
        ...baseMetadata,
        provenance: baseMetadata.provenance.map((citation) =>
          citation.field === "ENDORSEMENT_EVIDENCE_LEVEL"
            ? { ...citation, extractedValue: "HUMAN_VERIFIED" }
            : citation,
        ),
      }),
    ).toThrow(/cannot exceed MENTIONED/i);
  });
});
