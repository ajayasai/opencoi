import { describe, expect, it } from "vitest";
import {
  extractCoiFields,
  findDateCandidates,
  normalizeOcrText,
  parseCoiText,
  parseDateCandidate,
  parseInsurerNameFromLine,
  parseMoneyMinorUnits,
  parsePolicyNumberFromLine,
} from "./ocr.js";

describe("OCR field parsers", () => {
  it.each([
    ["$1,000,000", 100_000_000],
    ["USD 250,000.50", 25_000_050],
    ["1 000 000", 100_000_000],
    ["1.5M", 150_000_000],
    ["750K", 75_000_000],
    ["0", 0],
    ["US$ 2B", 200_000_000_000],
  ])("parses %s into exact minor units", (input, expected) => {
    expect(parseMoneyMinorUnits(input)).toBe(expected);
  });

  it("rejects negative, rounded, malformed, and unsafe money values", () => {
    expect(parseMoneyMinorUnits("-$1,000")).toBeNull();
    expect(parseMoneyMinorUnits("(1,000)")).toBeNull();
    expect(parseMoneyMinorUnits("12.345")).toBeNull();
    expect(parseMoneyMinorUnits("not money")).toBeNull();
    expect(parseMoneyMinorUnits("999999999999999999999")).toBeNull();
    expect(() => parseMoneyMinorUnits("1", 7)).toThrow(/fractionDigits/i);
  });

  it("respects currencies with a different number of fraction digits", () => {
    expect(parseMoneyMinorUnits("100", 0)).toBe(100);
    expect(parseMoneyMinorUnits("100.5", 0)).toBeNull();
    expect(parseMoneyMinorUnits("1.5K", 0)).toBe(1_500);
    expect(parseMoneyMinorUnits("1.234", 3)).toBe(1_234);
  });

  it.each([
    ["01/31/2026", "2026-01-31"],
    ["1-2-26", "2026-01-02"],
    ["12/31/70", "1970-12-31"],
    ["2024-02-29", "2024-02-29"],
    ["September 7, 2026", "2026-09-07"],
    ["Sep 7 2026", "2026-09-07"],
  ])("parses supported date %s", (input, expected) => {
    expect(parseDateCandidate(input)).toBe(expected);
  });

  it("rejects impossible and ambiguous non-US dates", () => {
    expect(parseDateCandidate("02/29/2023")).toBeNull();
    expect(parseDateCandidate("31/01/2026")).toBeNull();
    expect(parseDateCandidate("2026-00-01")).toBeNull();
    expect(parseDateCandidate("tomorrow")).toBeNull();
  });

  it("finds multiple dates embedded in a policy row", () => {
    expect(findDateCandidates("ABC-123 01/01/2026 01/01/2027")).toEqual([
      "2026-01-01",
      "2027-01-01",
    ]);
  });

  it.each([
    ["POLICY NUMBER: GL-ABC-12345", "GL-ABC-12345"],
    ["Policy No. WC.987654", "WC.987654"],
    ["Y Y AUTO-55-991 01/01/2026 01/01/2027", "AUTO-55-991"],
    ["POLICY # CYB/123_ABC", "CYB/123_ABC"],
  ])("parses a policy number from %s", (input, expected) => {
    expect(parsePolicyNumberFromLine(input)).toBe(expected);
  });

  it("does not treat a policy table header as a policy number", () => {
    expect(parsePolicyNumberFromLine("POLICY NUMBER POLICY EFF POLICY EXP")).toBeNull();
  });

  it("parses insurer labels and excludes the table heading and NAIC number", () => {
    expect(parseInsurerNameFromLine("INSURER A: Example Mutual Insurance 12345")).toBe(
      "Example Mutual Insurance",
    );
    expect(parseInsurerNameFromLine("Insurer - ABC Underwriters Ltd")).toBe("ABC Underwriters Ltd");
    expect(parseInsurerNameFromLine("INSURER(S) AFFORDING COVERAGE")).toBeNull();
  });

  it("normalizes OCR typography while preserving useful line boundaries", () => {
    expect(normalizeOcrText(" A\u00a0 B\r\n\r\n\r\nC—D\u0000 ")).toBe("A B\n\nC-D");
  });
});

describe("COI OCR-assisted extraction", () => {
  it("extracts review candidates from a representative ACORD-style block", () => {
    const result = parseCoiText(
      `
      INSURER(S) AFFORDING COVERAGE
      INSURER A: Example Mutual Insurance 12345

      COMMERCIAL GENERAL LIABILITY
      POLICY NUMBER: GL-ABC-12345
      POLICY EFF: 01/01/2026
      POLICY EXP: 01/01/2027
      EACH OCCURRENCE $1,000,000
      GENERAL AGGREGATE $2,000,000
      PRODUCTS - COMP/OP AGG $2,000,000
      CG 20 10 Additional Insured endorsement attached
      `,
      { documentId: "doc-upload-7" },
    );

    expect(result.document.id).toBe("doc-upload-7");
    expect(result.document.reviewStatus).toBe("UNCONFIRMED");
    expect(result.document.policies).toHaveLength(1);
    const policy = result.document.policies[0];
    expect(policy?.coverageType).toMatchObject({
      value: "COMMERCIAL_GENERAL_LIABILITY",
      confirmation: "UNCONFIRMED",
      source: "OCR",
    });
    expect(policy?.insurerName?.value).toBe("Example Mutual Insurance");
    expect(policy?.policyNumber?.value).toBe("GL-ABC-12345");
    expect(policy?.effectiveDate?.value).toBe("2026-01-01");
    expect(policy?.expirationDate?.value).toBe("2027-01-01");
    expect(policy?.limits.EACH_OCCURRENCE?.value).toBe(100_000_000);
    expect(policy?.limits.GENERAL_AGGREGATE?.value).toBe(200_000_000);
    expect(policy?.limits.PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE?.value).toBe(200_000_000);
    expect(result.document.endorsements[0]).toMatchObject({
      formCode: { value: "CG 20 10", confirmation: "UNCONFIRMED" },
      name: { value: "Additional insured" },
      evidenceLevel: { value: "ATTACHED", confirmation: "UNCONFIRMED" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("segments multiple coverages and parses compact policy rows and suffix amounts", () => {
    const result = extractCoiFields(`
      AUTOMOBILE LIABILITY
      AUTO-555 01/01/26 01/01/27
      COMBINED SINGLE LIMIT $1M

      CYBER LIABILITY
      POLICY NO. CYB-7788
      02/01/2026 02/01/2027
      EACH CLAIM 2.5M
      AGGREGATE 5M
    `);
    expect(result.document.policies.map((policy) => policy.coverageType.value)).toEqual([
      "AUTOMOBILE_LIABILITY",
      "CYBER_LIABILITY",
    ]);
    expect(result.document.policies[0]?.policyNumber?.value).toBe("AUTO-555");
    expect(result.document.policies[0]?.limits.COMBINED_SINGLE_LIMIT?.value).toBe(100_000_000);
    expect(result.document.policies[1]?.policyNumber?.value).toBe("CYB-7788");
    expect(result.document.policies[1]?.limits.EACH_CLAIM?.value).toBe(250_000_000);
    expect(result.document.policies[1]?.limits.AGGREGATE?.value).toBe(500_000_000);
  });

  it("assigns both dates correctly when they sit below a shared ACORD table header", () => {
    const result = parseCoiText(`
      COMMERCIAL GENERAL LIABILITY
      POLICY NUMBER POLICY EFF POLICY EXP
      GL-HEADER-22 04/15/2026 04/15/2027
      EACH OCCURRENCE $1,000,000
    `);
    expect(result.document.policies[0]?.policyNumber?.value).toBe("GL-HEADER-22");
    expect(result.document.policies[0]?.effectiveDate?.value).toBe("2026-04-15");
    expect(result.document.policies[0]?.expirationDate?.value).toBe("2027-04-15");
  });

  it("keeps multiple insurers as unassigned candidates for human confirmation", () => {
    const result = parseCoiText(`
      INSURER A: Alpha Insurance 12345
      INSURER B: Beta Insurance 67890
      COMMERCIAL GENERAL LIABILITY
      GL-1X2 01/01/2026 01/01/2027
      EACH OCCURRENCE $1,000,000
    `);
    expect(result.candidates.insurerNames.map((field) => field.value)).toEqual([
      "Alpha Insurance",
      "Beta Insurance",
    ]);
    expect(result.document.policies[0]?.insurerName).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MULTIPLE_INSURERS_UNASSIGNED" }),
    );
  });

  it("returns an unclassified policy only when useful evidence exists", () => {
    const useful = parseCoiText(`
      POLICY NUMBER: MISC-1234
      POLICY EFF: 03/01/2026
      POLICY EXP: 03/01/2027
    `);
    expect(useful.document.policies[0]?.coverageType.value).toBe("OTHER");
    expect(useful.warnings).toContainEqual(
      expect.objectContaining({ code: "NO_COVERAGE_SECTIONS" }),
    );

    const empty = parseCoiText("This page was intentionally left blank");
    expect(empty.document.policies).toEqual([]);
  });

  it("never promotes OCR evidence to human-verified or confirmed", () => {
    const result = parseCoiText(`
      COMMERCIAL GENERAL LIABILITY
      GL-123 01/01/2026 01/01/2027
      CG 20 10 endorsement verified and attached
    `);
    const endorsement = result.document.endorsements[0];
    expect(endorsement?.evidenceLevel.value).toBe("ATTACHED");
    expect(endorsement?.evidenceLevel.value).not.toBe("HUMAN_VERIFIED");
    expect(endorsement?.evidenceLevel.confirmation).toBe("UNCONFIRMED");
    expect(result.document.policies[0]?.coverageType.confirmation).toBe("UNCONFIRMED");
  });
});
