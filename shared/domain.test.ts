import { describe, expect, it } from "vitest";
import {
  addIsoDateDays,
  deriveDocumentComplianceLabel,
  evidenceField,
  isIsoDate,
  isoDate,
  isoDateToEpochDay,
  moneyMinor,
} from "./domain.js";

describe("domain primitives", () => {
  it("accepts only integer, non-negative, safely representable minor units", () => {
    expect(moneyMinor(0)).toBe(0);
    expect(moneyMinor(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => moneyMinor(1.1)).toThrow(/integer/i);
    expect(() => moneyMinor(-1)).toThrow(/non-negative/i);
    expect(() => moneyMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/i);
  });

  it("validates real Gregorian dates rather than only their shape", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("01/01/2026")).toBe(false);
    expect(() => isoDate("2026-04-31")).toThrow(/invalid/i);
  });

  it("performs date arithmetic on UTC calendar days", () => {
    expect(addIsoDateDays(isoDate("2024-02-28"), 1)).toBe("2024-02-29");
    expect(addIsoDateDays(isoDate("2024-12-31"), 1)).toBe("2025-01-01");
    expect(
      isoDateToEpochDay(isoDate("2025-01-02")) - isoDateToEpochDay(isoDate("2025-01-01")),
    ).toBe(1);
  });

  it("validates OCR confidence and page metadata", () => {
    expect(
      evidenceField("ABC", {
        confirmation: "UNCONFIRMED",
        source: "OCR",
        confidenceBps: 10_000,
        page: 1,
      }),
    ).toMatchObject({ value: "ABC", confidenceBps: 10_000, page: 1 });
    expect(() =>
      evidenceField("ABC", {
        confirmation: "UNCONFIRMED",
        source: "OCR",
        confidenceBps: 10_001,
      }),
    ).toThrow(/basis points/i);
    expect(() =>
      evidenceField("ABC", { confirmation: "UNCONFIRMED", source: "OCR", page: 0 }),
    ).toThrow(/positive integer/i);
  });

  it("derives document labels with FAIL then UNKNOWN precedence", () => {
    expect(deriveDocumentComplianceLabel([])).toBe("DOCUMENT_NOT_APPLICABLE");
    expect(deriveDocumentComplianceLabel([{ status: "NOT_APPLICABLE" }])).toBe(
      "DOCUMENT_NOT_APPLICABLE",
    );
    expect(deriveDocumentComplianceLabel([{ status: "PASS" }])).toBe("DOCUMENT_COMPLIANT");
    expect(deriveDocumentComplianceLabel([{ status: "PASS" }, { status: "UNKNOWN" }])).toBe(
      "DOCUMENT_REVIEW_REQUIRED",
    );
    expect(
      deriveDocumentComplianceLabel([
        { status: "PASS" },
        { status: "UNKNOWN" },
        { status: "FAIL" },
      ]),
    ).toBe("DOCUMENT_NON_COMPLIANT");
  });
});
