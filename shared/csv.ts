import type { DocumentComplianceLabel, FindingStatus, IsoDate } from "./domain.js";

export type CsvScalar = string | number | boolean | null | undefined;

/**
 * Prevents spreadsheet applications from interpreting untrusted text as a
 * formula. Quoting a CSV cell is not sufficient; a leading apostrophe is.
 */
export function neutralizeCsvInjection(value: string): string {
  if (value.startsWith("'")) return value;
  const startsWithControl =
    value.startsWith("\t") || value.startsWith("\r") || value.startsWith("\n");
  const firstVisibleCharacter = value.trimStart().charAt(0);
  if (startsWithControl || ["=", "+", "-", "@"].includes(firstVisibleCharacter)) {
    return `'${value}`;
  }
  return value;
}

export const sanitizeCsvCell = neutralizeCsvInjection;

export function escapeCsvCell(value: CsvScalar): string {
  const serialized = neutralizeCsvInjection(
    value === null || value === undefined ? "" : String(value),
  );
  return /[",\r\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
}

/** Serializes already ordered rows with CRLF for broad spreadsheet support. */
export function serializeCsv(rows: readonly (readonly CsvScalar[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

export interface ComplianceStatusExportRow {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly vendorType: string;
  readonly documentId: string;
  readonly evaluationDate: IsoDate | string;
  readonly documentLabel: DocumentComplianceLabel;
  readonly findingStatus?: FindingStatus | "";
  readonly deficiencyCode?: string;
  readonly deficiency?: string;
  readonly expirationDate?: IsoDate | string;
}

export const COMPLIANCE_CSV_HEADERS = [
  "Vendor ID",
  "Vendor name",
  "Vendor type",
  "Document ID",
  "Evaluation date",
  "Document compliance",
  "Finding status",
  "Deficiency code",
  "Deficiency",
  "Expiration date",
] as const;

export function buildComplianceStatusCsv(rows: readonly ComplianceStatusExportRow[]): string {
  return serializeCsv([
    COMPLIANCE_CSV_HEADERS,
    ...rows.map((row) => [
      row.vendorId,
      row.vendorName,
      row.vendorType,
      row.documentId,
      row.evaluationDate,
      row.documentLabel,
      row.findingStatus ?? "",
      row.deficiencyCode ?? "",
      row.deficiency ?? "",
      row.expirationDate ?? "",
    ]),
  ]);
}

export const toComplianceCsv = buildComplianceStatusCsv;
