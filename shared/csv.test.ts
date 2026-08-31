import { describe, expect, it } from "vitest";
import {
  buildComplianceStatusCsv,
  escapeCsvCell,
  neutralizeCsvInjection,
  serializeCsv,
} from "./csv.js";

describe("CSV export security", () => {
  it.each([
    ["=2+2", "'=2+2"],
    ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
    ["-1+2", "'-1+2"],
    ["@SUM(1,2)", "'@SUM(1,2)"],
    ['  =HYPERLINK("https://evil.invalid")', '\'  =HYPERLINK("https://evil.invalid")'],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", "'\r=1+1"],
    ["\n=1+1", "'\n=1+1"],
  ])("neutralizes formula-like cell %j", (input, expected) => {
    expect(neutralizeCsvInjection(input)).toBe(expected);
  });

  it("does not modify ordinary text or double-prefix already neutralized text", () => {
    expect(neutralizeCsvInjection("Acme - East")).toBe("Acme - East");
    expect(neutralizeCsvInjection("2026-01-01")).toBe("2026-01-01");
    expect(neutralizeCsvInjection("'=2+2")).toBe("'=2+2");
  });

  it("quotes delimiters, quotes, and line breaks after neutralization", () => {
    expect(escapeCsvCell('Acme, "North"')).toBe('"Acme, ""North"""');
    expect(escapeCsvCell("=SUM(1,2)")).toBe('"\'=SUM(1,2)"');
    expect(escapeCsvCell("a\nb")).toBe('"a\nb"');
  });

  it("serializes a deterministic RFC-style CRLF table", () => {
    expect(
      serializeCsv([
        ["A", "B"],
        [1, null],
      ]),
    ).toBe("A,B\r\n1,");
  });

  it("neutralizes untrusted vendor and deficiency values in compliance exports", () => {
    const csv = buildComplianceStatusCsv([
      {
        vendorId: "vendor-1",
        vendorName: '=WEBSERVICE("https://evil.invalid")',
        vendorType: "Contractor",
        documentId: "doc-1",
        evaluationDate: "2026-01-01",
        documentLabel: "DOCUMENT_NON_COMPLIANT",
        findingStatus: "FAIL",
        deficiencyCode: "LIMIT_INADEQUATE",
        deficiency: "+malicious",
      },
    ]);
    expect(csv).toContain("'=WEBSERVICE");
    expect(csv).toContain("'+malicious");
    expect(csv).toContain("DOCUMENT_NON_COMPLIANT");
  });
});
