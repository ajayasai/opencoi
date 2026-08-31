import {
  type CoiDocumentFacts,
  type CoiEndorsementEvidence,
  type CoiPolicyFacts,
  type CoverageType,
  type EvidenceField,
  evidenceField,
  type IsoDate,
  isoDate,
  type LimitType,
  type MoneyMinor,
  moneyMinor,
} from "./domain.js";

export interface CoiOcrWarning {
  readonly code:
    | "NO_COVERAGE_SECTIONS"
    | "NO_POLICY_NUMBER"
    | "NO_POLICY_DATES"
    | "MULTIPLE_INSURERS_UNASSIGNED";
  readonly message: string;
  readonly policyId?: string;
}

export interface CoiOcrCandidates {
  readonly insurerNames: readonly EvidenceField<string>[];
  readonly policyNumbers: readonly EvidenceField<string>[];
  readonly dates: readonly EvidenceField<IsoDate>[];
}

export interface CoiOcrExtraction {
  readonly document: CoiDocumentFacts;
  readonly candidates: CoiOcrCandidates;
  readonly warnings: readonly CoiOcrWarning[];
  readonly normalizedText: string;
}

export interface ParseCoiTextOptions {
  /** Stable caller-provided id; defaults to a deterministic placeholder. */
  readonly documentId?: string;
  /** Currency decimal places. USD and most currencies use 2. */
  readonly currencyFractionDigits?: number;
}

const COVERAGE_PATTERNS: readonly {
  readonly type: CoverageType;
  readonly pattern: RegExp;
}[] = [
  {
    type: "UMBRELLA_EXCESS_LIABILITY",
    pattern: /\b(?:UMBRELLA|EXCESS)\s+(?:LIAB(?:ILITY)?|COVERAGE)\b/i,
  },
  {
    type: "PROFESSIONAL_LIABILITY",
    pattern: /\b(?:PROFESSIONAL\s+LIABILITY|ERRORS?\s*(?:&|AND)\s*OMISSIONS|E\s*&\s*O)\b/i,
  },
  {
    type: "CYBER_LIABILITY",
    pattern: /\b(?:CYBER|NETWORK\s+SECURITY|PRIVACY)\s+(?:LIAB(?:ILITY)?|COVERAGE|INSURANCE)\b/i,
  },
  { type: "POLLUTION_LIABILITY", pattern: /\b(?:POLLUTION|ENVIRONMENTAL)\s+LIAB(?:ILITY)?\b/i },
  { type: "AUTOMOBILE_LIABILITY", pattern: /\b(?:AUTOMOBILE|AUTO)\s+LIAB(?:ILITY)?\b/i },
  { type: "WORKERS_COMPENSATION", pattern: /\bWORKERS?'?\s+COMPENSATION\b/i },
  { type: "EMPLOYERS_LIABILITY", pattern: /\bEMPLOYERS?'?\s+LIAB(?:ILITY)?\b/i },
  {
    type: "COMMERCIAL_GENERAL_LIABILITY",
    pattern: /\b(?:COMMERCIAL\s+)?GENERAL\s+LIAB(?:ILITY)?\b/i,
  },
  { type: "PROPERTY", pattern: /\b(?:COMMERCIAL\s+)?PROPERTY\s+(?:COVERAGE|INSURANCE)\b/i },
];

const LIMIT_PATTERNS: readonly { readonly type: LimitType; readonly pattern: RegExp }[] = [
  {
    type: "PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE",
    pattern: /\bPRODUCTS?\s*[-/]?\s*COMP(?:LETED)?\s*[/.-]?\s*OP(?:ERATIONS)?\s+AGG(?:REGATE)?\b/i,
  },
  { type: "DAMAGE_TO_RENTED_PREMISES", pattern: /\bDAMAGE\s+TO\s+RENTED\s+PREMISES\b/i },
  {
    type: "PERSONAL_ADVERTISING_INJURY",
    pattern: /\bPERSONAL\s*(?:&|AND|[/])?\s*ADV(?:ERTISING)?\s+INJURY\b/i,
  },
  {
    type: "BODILY_INJURY_PER_ACCIDENT",
    pattern: /\bBODILY\s+INJURY\s*\(?\s*PER\s+ACCIDENT\s*\)?\b/i,
  },
  { type: "BODILY_INJURY_PER_PERSON", pattern: /\bBODILY\s+INJURY\s*\(?\s*PER\s+PERSON\s*\)?\b/i },
  {
    type: "PROPERTY_DAMAGE_PER_ACCIDENT",
    pattern: /\bPROPERTY\s+DAMAGE\s*\(?\s*PER\s+ACCIDENT\s*\)?\b/i,
  },
  { type: "DISEASE_EACH_EMPLOYEE", pattern: /\bDISEASE\s*[-–]\s*EA(?:CH)?\s+EMPLOYEE\b/i },
  { type: "DISEASE_POLICY_LIMIT", pattern: /\bDISEASE\s*[-–]\s*POLICY\s+LIMIT\b/i },
  { type: "COMBINED_SINGLE_LIMIT", pattern: /\bCOMBINED\s+SINGLE\s+LIMIT\b/i },
  { type: "GENERAL_AGGREGATE", pattern: /\bGENERAL\s+AGG(?:REGATE)?\b/i },
  { type: "EACH_OCCURRENCE", pattern: /\bEACH\s+OCCURRENCE\b/i },
  { type: "EACH_ACCIDENT", pattern: /\bE\.?L\.?\s+EACH\s+ACCIDENT\b|\bEACH\s+ACCIDENT\b/i },
  { type: "EACH_CLAIM", pattern: /\bEACH\s+CLAIM\b/i },
  { type: "MEDICAL_EXPENSE", pattern: /\bMED(?:ICAL)?\s+EXP(?:ENSE)?\b/i },
  { type: "AGGREGATE", pattern: /\bAGGREGATE\b/i },
];

const DATE_TOKEN_PATTERN = /\b(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/g;

/** Normalizes OCR typography without changing line boundaries or semantic text. */
export function normalizeOcrText(text: string): string {
  return text
    .replaceAll("\u0000", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parses a displayed major-unit amount into exact integer minor units.
 * Values that would require rounding are rejected instead of silently rounded.
 */
export function parseMoneyMinorUnits(raw: string, fractionDigits = 2): MoneyMinor | null {
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) {
    throw new RangeError("fractionDigits must be an integer from 0 through 6.");
  }

  let value = raw.trim().toUpperCase();
  if (!value || value.includes("-") || /^\(.*\)$/.test(value)) return null;
  value = value
    .replace(/\b(?:USD|US\s*DOLLARS?|DOLLARS?)\b/g, "")
    .replace(/(?:US)?[$€£¥]/g, "")
    .replace(/[,_\s]/g, "");
  const match = /^(\d+)(?:\.(\d+))?([KMB])?$/.exec(value);
  if (!match) return null;

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const suffix = match[3] ?? "";
  const suffixMultiplier =
    suffix === "K" ? 1_000n : suffix === "M" ? 1_000_000n : suffix === "B" ? 1_000_000_000n : 1n;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator =
    BigInt(`${whole}${fraction}`) * suffixMultiplier * 10n ** BigInt(fractionDigits);
  if (numerator % denominator !== 0n) return null;
  const result = numerator / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return moneyMinor(Number(result));
}

/** Parses US-style numeric COI dates and unambiguous ISO dates. */
export function parseDateCandidate(raw: string): IsoDate | null {
  const value = raw.trim();
  let year: number;
  let month: number;
  let day: number;

  let match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(value);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(value);
    if (match) {
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
    } else {
      const named =
        /^(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+(\d{1,2})(?:,)?\s+(\d{4})$/i.exec(
          value,
        );
      if (!named) return null;
      const monthIndex = [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ].indexOf((named[1] ?? "").slice(0, 3).toUpperCase());
      month = monthIndex + 1;
      day = Number(named[2]);
      year = Number(named[3]);
    }
  }

  const serialized = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  try {
    return isoDate(serialized);
  } catch {
    return null;
  }
}

export function findDateCandidates(line: string): readonly IsoDate[] {
  const numeric = [...line.matchAll(DATE_TOKEN_PATTERN)]
    .map((match) => parseDateCandidate(match[0]))
    .filter((value): value is IsoDate => value !== null);
  const named = [
    ...line.matchAll(
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi,
    ),
  ]
    .map((match) => parseDateCandidate(match[0]))
    .filter((value): value is IsoDate => value !== null);
  return [...numeric, ...named];
}

export function parsePolicyNumberFromLine(line: string): string | null {
  const labelled =
    /\bPOLICY\s*(?:NUMBER|NO\.?|#)\s*(?::|#|-)?\s*([A-Z0-9][A-Z0-9./_-]{2,})\b/i.exec(line);
  if (labelled && isPlausiblePolicyNumber(labelled[1] ?? "")) {
    return (labelled[1] ?? "").toUpperCase();
  }

  const dateMatch = DATE_TOKEN_PATTERN.exec(line);
  DATE_TOKEN_PATTERN.lastIndex = 0;
  if (!dateMatch || dateMatch.index === undefined) return null;
  const prefixTokens = line
    .slice(0, dateMatch.index)
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Z0-9]+|[^A-Z0-9./_-]+$/gi, ""))
    .filter(Boolean)
    .reverse();
  return prefixTokens.find(isPlausiblePolicyNumber)?.toUpperCase() ?? null;
}

export function parseInsurerNameFromLine(line: string): string | null {
  if (/INSURER\(S\)\s+AFFORDING\s+COVERAGE/i.test(line)) return null;
  const match = /^INSURER(?:\s+[A-F])?(?:\s+NAIC\s*#)?\s*[:#-]\s*(.+)$/i.exec(line.trim());
  if (!match) return null;
  const value = (match[1] ?? "").replace(/\s+\d{5,6}\s*$/, "").trim();
  return value.length >= 2 ? value : null;
}

export function parseCoiText(text: string, options: ParseCoiTextOptions = {}): CoiOcrExtraction {
  const normalizedText = normalizeOcrText(text);
  const lines = normalizedText ? normalizedText.split("\n") : [];
  const documentId = options.documentId?.trim() || "ocr-document";
  const fractionDigits = options.currencyFractionDigits ?? 2;
  // Validate even when the document contains no money values.
  parseMoneyMinorUnits("0", fractionDigits);

  const insurerNames = uniqueFields(
    lines
      .map((line) => ({ value: parseInsurerNameFromLine(line), rawText: line }))
      .filter((candidate): candidate is { value: string; rawText: string } =>
        Boolean(candidate.value),
      )
      .map((candidate) => ocrField(candidate.value, candidate.rawText, 8_800)),
  );
  const allPolicyNumbers = uniqueFields(
    lines
      .map((line) => ({ value: parsePolicyNumberFromLine(line), rawText: line }))
      .filter((candidate): candidate is { value: string; rawText: string } =>
        Boolean(candidate.value),
      )
      .map((candidate) => ocrField(candidate.value, candidate.rawText, 8_500)),
  );
  const allDates = uniqueFields(
    lines.flatMap((line) => findDateCandidates(line).map((value) => ocrField(value, line, 8_700))),
  );

  const markers = findCoverageMarkers(lines);
  const warnings: CoiOcrWarning[] = [];
  if (markers.length === 0) {
    warnings.push({
      code: "NO_COVERAGE_SECTIONS",
      message:
        "No standard coverage heading was recognized; extracted fields need manual assignment.",
    });
  }
  if (insurerNames.length > 1) {
    warnings.push({
      code: "MULTIPLE_INSURERS_UNASSIGNED",
      message: "Multiple insurers were found; confirm which insurer belongs to each policy.",
    });
  }

  const segments = markers.length
    ? markers.map((marker, index) => ({
        ...marker,
        lines: lines.slice(marker.lineIndex, markers[index + 1]?.lineIndex ?? lines.length),
      }))
    : [
        {
          type: "OTHER" as CoverageType,
          lineIndex: 0,
          heading: lines[0] ?? "Unclassified coverage",
          lines,
        },
      ];

  const policies: CoiPolicyFacts[] = segments
    .map((segment, index) => {
      const policy = parsePolicySegment(
        segment.type,
        segment.heading,
        segment.lines,
        `ocr-policy-${index + 1}`,
        insurerNames,
        fractionDigits,
      );
      if (!policy.policyNumber) {
        warnings.push({
          code: "NO_POLICY_NUMBER",
          message: `No policy number was confidently assigned to ${segment.type}.`,
          policyId: policy.id,
        });
      }
      if (!policy.effectiveDate || !policy.expirationDate) {
        warnings.push({
          code: "NO_POLICY_DATES",
          message: `A complete effective/expiration date pair was not found for ${segment.type}.`,
          policyId: policy.id,
        });
      }
      return policy;
    })
    .filter((policy) =>
      markers.length > 0
        ? true
        : Boolean(
            policy.policyNumber ||
              policy.effectiveDate ||
              policy.expirationDate ||
              Object.keys(policy.limits).length,
          ),
    );

  return {
    document: {
      id: documentId,
      reviewStatus: "UNCONFIRMED",
      policies,
      endorsements: parseEndorsements(lines),
    },
    candidates: {
      insurerNames,
      policyNumbers: allPolicyNumbers,
      dates: allDates,
    },
    warnings,
    normalizedText,
  };
}

/** Compatibility-oriented name for callers that think of OCR as field extraction. */
export const extractCoiFields = parseCoiText;

function findCoverageMarkers(lines: readonly string[]): readonly {
  readonly type: CoverageType;
  readonly lineIndex: number;
  readonly heading: string;
}[] {
  const markers: { type: CoverageType; lineIndex: number; heading: string }[] = [];
  lines.forEach((line, lineIndex) => {
    const match = COVERAGE_PATTERNS.find((candidate) => candidate.pattern.test(line));
    if (!match) return;
    const previous = markers.at(-1);
    // ACORD headings sometimes span or repeat on adjacent OCR lines.
    if (previous?.type === match.type && lineIndex - previous.lineIndex <= 2) return;
    markers.push({ type: match.type, lineIndex, heading: line });
  });
  return markers;
}

function parsePolicySegment(
  coverageType: CoverageType,
  heading: string,
  lines: readonly string[],
  id: string,
  insurerCandidates: readonly EvidenceField<string>[],
  fractionDigits: number,
): CoiPolicyFacts {
  const labelledPolicyNumber = lines
    .map(parsePolicyNumberFromLine)
    .find((value): value is string => value !== null);
  const datesByLine = lines
    .map((line) => ({ line, dates: findDateCandidates(line) }))
    .filter((candidate) => candidate.dates.length > 0);
  const labelledEffective = findLabelledDate(
    lines,
    /\b(?:POLICY\s+)?EFF(?:ECTIVE)?(?:\s+DATE)?\b/i,
    "FIRST",
  );
  const labelledExpiration = findLabelledDate(
    lines,
    /\b(?:POLICY\s+)?EXP(?:IRATION|IRY)?(?:\s+DATE)?\b/i,
    "LAST",
  );
  const pairedDates = datesByLine.find((candidate) => candidate.dates.length >= 2);
  const flattenedDates = datesByLine.flatMap((candidate) => candidate.dates);
  const effectiveDate = labelledEffective ?? pairedDates?.dates[0] ?? flattenedDates[0];
  const expirationDate = labelledExpiration ?? pairedDates?.dates[1] ?? flattenedDates[1];
  const effectiveSource = datesByLine.find((candidate) =>
    candidate.dates.includes(effectiveDate as IsoDate),
  );
  const expirationSource = datesByLine.find((candidate) =>
    candidate.dates.includes(expirationDate as IsoDate),
  );

  const limits: Partial<Record<LimitType, EvidenceField<MoneyMinor>>> = {};
  for (const line of lines) {
    const definition = LIMIT_PATTERNS.find((candidate) => candidate.pattern.test(line));
    if (!definition || limits[definition.type]) continue;
    const amount = extractMoneyFromLine(line, fractionDigits);
    if (amount !== null) limits[definition.type] = ocrField(amount, line, 8_900);
  }

  return {
    id,
    coverageType: ocrField(coverageType, heading, coverageType === "OTHER" ? 5_000 : 9_300),
    ...(insurerCandidates.length === 1 ? { insurerName: insurerCandidates[0] } : {}),
    ...(labelledPolicyNumber
      ? {
          policyNumber: ocrField(
            labelledPolicyNumber,
            policySource(lines, labelledPolicyNumber),
            8_500,
          ),
        }
      : {}),
    ...(effectiveDate
      ? {
          effectiveDate: ocrField(
            effectiveDate,
            effectiveSource?.line ?? String(effectiveDate),
            8_700,
          ),
        }
      : {}),
    ...(expirationDate
      ? {
          expirationDate: ocrField(
            expirationDate,
            expirationSource?.line ?? String(expirationDate),
            8_700,
          ),
        }
      : {}),
    limits,
  };
}

function findLabelledDate(
  lines: readonly string[],
  label: RegExp,
  position: "FIRST" | "LAST",
): IsoDate | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!label.test(line)) continue;
    const sameLineDates = findDateCandidates(line);
    const sameLine = position === "FIRST" ? sameLineDates[0] : sameLineDates.at(-1);
    if (sameLine) return sameLine;
    const nextLine = lines[index + 1];
    if (nextLine) {
      const nextLineDates = findDateCandidates(nextLine);
      const next = position === "FIRST" ? nextLineDates[0] : nextLineDates.at(-1);
      if (next) return next;
    }
  }
  return undefined;
}

function extractMoneyFromLine(line: string, fractionDigits: number): MoneyMinor | null {
  const matches = [
    ...line.matchAll(
      /(?:\bUSD\s*|\bUS\$\s*|[$€£¥]\s*)?\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?\s*[KMB]?|(?:\bUSD\s*|\bUS\$\s*|[$€£¥]\s*)\d+(?:\.\d+)?\s*[KMB]?|\b\d{4,}\b|\b\d+(?:\.\d+)?\s*[KMB]\b/gi,
    ),
  ];
  for (const match of matches.reverse()) {
    const parsed = parseMoneyMinorUnits(match[0], fractionDigits);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseEndorsements(lines: readonly string[]): readonly CoiEndorsementEvidence[] {
  const results: CoiEndorsementEvidence[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const isEndorsementLine =
      /\b(?:ENDORSE(?:MENT|D)|ADDITIONAL\s+INSURED|WAIVER\s+OF\s+SUBROGATION|PRIMARY\s+(?:AND|&)\s+NONCONTRIBUTORY)\b/i.test(
        line,
      );
    const formMatch = /\b([A-Z]{1,4})\s*(\d{2})\s*(\d{2})(?:\s*(\d{2}))?\b/.exec(line);
    if (!isEndorsementLine && !formMatch) continue;

    const formCode = formMatch
      ? [formMatch[1], formMatch[2], formMatch[3], formMatch[4]].filter(Boolean).join(" ")
      : undefined;
    const commonName = /ADDITIONAL\s+INSURED/i.test(line)
      ? "Additional insured"
      : /WAIVER\s+OF\s+SUBROGATION/i.test(line)
        ? "Waiver of subrogation"
        : /PRIMARY\s+(?:AND|&)\s+NONCONTRIBUTORY/i.test(line)
          ? "Primary and noncontributory"
          : undefined;
    const identity = `${formCode ?? ""}|${commonName ?? line}`
      .toUpperCase()
      .replace(/[^A-Z0-9|]/g, "");
    if (seen.has(identity)) continue;
    seen.add(identity);

    const evidenceLevel = /\bATTACHED\b/i.test(line)
      ? "ATTACHED"
      : /\bSCHEDULED?\b/i.test(line)
        ? "SCHEDULED"
        : "MENTIONED";
    results.push({
      id: `ocr-endorsement-${results.length + 1}`,
      ...(formCode ? { formCode: ocrField(formCode, line, 8_500) } : {}),
      ...(commonName ? { name: ocrField(commonName, line, 8_200) } : {}),
      evidenceLevel: ocrField(evidenceLevel, line, 8_000),
    });
  }
  return results;
}

function policySource(lines: readonly string[], policyNumber: string): string {
  return (
    lines.find((line) => line.toUpperCase().includes(policyNumber.toUpperCase())) ?? policyNumber
  );
}

function isPlausiblePolicyNumber(value: string): boolean {
  const normalized = value.toUpperCase();
  return (
    normalized.length >= 3 &&
    /\d/.test(normalized) &&
    !/^(?:POLICY|NUMBER|EFF|EXP|DATE|YES|NO|[YN])$/.test(normalized)
  );
}

function ocrField<T>(value: T, rawText: string, confidenceBps: number): EvidenceField<T> {
  return evidenceField(value, {
    confirmation: "UNCONFIRMED",
    source: "OCR",
    confidenceBps,
    rawText,
  });
}

function uniqueFields<T extends string | number>(
  fields: readonly EvidenceField<T>[],
): readonly EvidenceField<T>[] {
  const seen = new Set<T>();
  return fields.filter((field) => {
    if (seen.has(field.value)) return false;
    seen.add(field.value);
    return true;
  });
}
