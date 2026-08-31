/**
 * Dependency-free benchmark contracts and deterministic scoring for COI text
 * extraction. This module does not run PDF.js, OCR, or a human review flow.
 */

export const BENCHMARK_SCHEMA_VERSION = "1.0" as const;

export type BenchmarkScalar = string | number | boolean;

export interface BenchmarkField<T extends BenchmarkScalar = BenchmarkScalar> {
  readonly value: T;
  readonly evidencePages?: readonly number[];
}

export interface BenchmarkPolicyV1 {
  readonly coverageType: BenchmarkField<string>;
  readonly insurerName?: BenchmarkField<string>;
  readonly policyNumber?: BenchmarkField<string>;
  readonly effectiveDate?: BenchmarkField<string>;
  readonly expirationDate?: BenchmarkField<string>;
  readonly limits?: Readonly<Record<string, BenchmarkField<number>>>;
}

export interface BenchmarkEndorsementV1 {
  readonly name?: BenchmarkField<string>;
  readonly formCode?: BenchmarkField<string>;
  readonly evidenceLevel: BenchmarkField<string>;
}

export interface BenchmarkDocumentFactsV1 {
  readonly namedInsured?: BenchmarkField<string>;
  readonly certificateHolder?: BenchmarkField<string>;
  readonly policies: readonly BenchmarkPolicyV1[];
  readonly endorsements: readonly BenchmarkEndorsementV1[];
}

export interface BenchmarkTextPageV1 {
  readonly page: number;
  readonly text: string;
}

export interface BenchmarkCaseV1 {
  readonly id: string;
  readonly description: string;
  readonly strata: readonly string[];
  readonly pages: readonly BenchmarkTextPageV1[];
  readonly truth: BenchmarkDocumentFactsV1;
  readonly warningCodes: readonly string[];
}

export interface BenchmarkCorpusV1 {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly corpusId: string;
  readonly title: string;
  readonly license: string;
  readonly limitations: readonly string[];
  readonly cases: readonly BenchmarkCaseV1[];
}

export interface BenchmarkSystemV1 {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface BenchmarkPredictionCaseV1 {
  readonly caseId: string;
  readonly facts: BenchmarkDocumentFactsV1;
  readonly warningCodes: readonly string[];
  readonly durationMs?: number;
}

export interface BenchmarkPredictionFileV1 {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly corpusId: string;
  /** SHA-256 of the canonical semantic corpus JSON. */
  readonly corpusSha256: string;
  readonly mode: "ZERO_TOUCH_TEXT_PARSE";
  readonly system: BenchmarkSystemV1;
  readonly cases: readonly BenchmarkPredictionCaseV1[];
}

export interface BenchmarkMetric {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface BenchmarkFieldMetric extends BenchmarkMetric {
  readonly fieldType: string;
}

export interface BenchmarkCitationMetric {
  /** Correctly extracted facts that included at least one citation. */
  readonly coverage: number;
  /** Correct value and at least one cited page shared with the truth pages. */
  readonly correct: number;
  /** All predicted facts that attempted at least one page citation. */
  readonly attempted: number;
  /** Truth facts for which the corpus provides at least one evidence page. */
  readonly truthWithEvidence: number;
  readonly precision: number;
  readonly recall: number;
}

export interface BenchmarkCaseScore {
  readonly caseId: string;
  readonly exactDocument: boolean;
  readonly facts: BenchmarkMetric;
  readonly citations: BenchmarkCitationMetric;
  readonly warnings: BenchmarkMetric;
}

export interface BenchmarkScoreV1 {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly corpusId: string;
  readonly corpusSha256: string;
  readonly system: BenchmarkSystemV1;
  readonly mode: "ZERO_TOUCH_TEXT_PARSE";
  readonly facts: BenchmarkMetric;
  readonly macroF1: number;
  readonly fields: readonly BenchmarkFieldMetric[];
  readonly citations: BenchmarkCitationMetric;
  readonly warnings: BenchmarkMetric;
  readonly exactDocuments: number;
  readonly documentCount: number;
  readonly exactDocumentRate: number;
  readonly durationMs: {
    readonly reportedCases: number;
    readonly median: number;
    readonly p95: number;
  };
  readonly cases: readonly BenchmarkCaseScore[];
}

export interface BenchmarkComparisonV1 {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly corpusId: string;
  readonly corpusSha256: string;
  readonly referenceSystemId: string;
  readonly disclaimer: string;
  readonly rows: readonly {
    readonly system: BenchmarkSystemV1;
    readonly macroF1: number;
    readonly microF1: number;
    readonly citationRecall: number;
    readonly exactDocumentRate: number;
    readonly deltaFromReference: {
      readonly macroF1: number;
      readonly microF1: number;
      readonly citationRecall: number;
      readonly exactDocumentRate: number;
    };
  }[];
}

interface AtomicFact {
  readonly key: string;
  readonly type: string;
  readonly value: BenchmarkScalar;
  readonly evidencePages: readonly number[];
}

interface Counts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
}

interface CitationCounts {
  coverage: number;
  correct: number;
  attempted: number;
  truthWithEvidence: number;
}

const emptyCounts = (): Counts => ({ truePositive: 0, falsePositive: 0, falseNegative: 0 });
const emptyCitationCounts = (): CitationCounts => ({
  coverage: 0,
  correct: 0,
  attempted: 0,
  truthWithEvidence: 0,
});

const addCounts = (target: Counts, source: Readonly<Counts>): void => {
  target.truePositive += source.truePositive;
  target.falsePositive += source.falsePositive;
  target.falseNegative += source.falseNegative;
};

const addCitationCounts = (target: CitationCounts, source: Readonly<CitationCounts>): void => {
  target.coverage += source.coverage;
  target.correct += source.correct;
  target.attempted += source.attempted;
  target.truthWithEvidence += source.truthWithEvidence;
};

const rounded = (value: number): number =>
  Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000 : 0;

const divide = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : rounded(numerator / denominator);

const metricFor = (counts: Readonly<Counts>): BenchmarkMetric => {
  const precision = divide(counts.truePositive, counts.truePositive + counts.falsePositive);
  const recall = divide(counts.truePositive, counts.truePositive + counts.falseNegative);
  const f1 =
    precision + recall === 0 ? 0 : rounded((2 * precision * recall) / (precision + recall));
  return { ...counts, precision, recall, f1 };
};

const citationMetricFor = (counts: Readonly<CitationCounts>): BenchmarkCitationMetric => ({
  ...counts,
  precision: divide(counts.correct, counts.attempted),
  recall: divide(counts.correct, counts.truthWithEvidence),
});

const normalizedPages = (pages: readonly number[] | undefined): readonly number[] =>
  [...new Set((pages ?? []).filter((page) => Number.isSafeInteger(page) && page > 0))].sort(
    (left, right) => left - right,
  );

const normalizedString = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();

const normalizedIdentifier = (value: string): string =>
  normalizedString(value).replace(/[^A-Z0-9]/g, "");

const normalizedValue = (type: string, value: BenchmarkScalar): BenchmarkScalar => {
  if (typeof value !== "string") return value;
  if (["policyNumber", "formCode"].includes(type)) return normalizedIdentifier(value);
  return normalizedString(value);
};

const identity = (field: BenchmarkField<string> | undefined): string | undefined =>
  field ? normalizedIdentifier(field.value) : undefined;

const atomic = (
  key: string,
  type: string,
  field: BenchmarkField | undefined,
): AtomicFact | undefined =>
  field
    ? {
        key,
        type,
        value: normalizedValue(type, field.value),
        evidencePages: normalizedPages(field.evidencePages),
      }
    : undefined;

/**
 * Flattens a vendor-neutral prediction into comparable atomic facts. Corpus v1
 * intentionally allows at most one policy per normalized coverage type.
 */
export function flattenBenchmarkFacts(facts: BenchmarkDocumentFactsV1): readonly AtomicFact[] {
  const result: AtomicFact[] = [];
  const push = (fact: AtomicFact | undefined) => {
    if (fact) result.push(fact);
  };
  push(atomic("document.namedInsured", "namedInsured", facts.namedInsured));
  push(atomic("document.certificateHolder", "certificateHolder", facts.certificateHolder));

  const coverageOccurrences = new Map<string, number>();
  for (const policy of facts.policies) {
    const coverage = normalizedString(policy.coverageType.value);
    const occurrence = (coverageOccurrences.get(coverage) ?? 0) + 1;
    coverageOccurrences.set(coverage, occurrence);
    const prefix = `policy.${coverage}.${occurrence}`;
    push(atomic(`${prefix}.coverageType`, "coverageType", policy.coverageType));
    push(atomic(`${prefix}.insurerName`, "insurerName", policy.insurerName));
    push(atomic(`${prefix}.policyNumber`, "policyNumber", policy.policyNumber));
    push(atomic(`${prefix}.effectiveDate`, "effectiveDate", policy.effectiveDate));
    push(atomic(`${prefix}.expirationDate`, "expirationDate", policy.expirationDate));
    for (const [limitType, field] of Object.entries(policy.limits ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      push(atomic(`${prefix}.limit.${normalizedString(limitType)}`, `limit.${limitType}`, field));
    }
  }

  const endorsementOccurrences = new Map<string, number>();
  for (const endorsement of facts.endorsements) {
    const endorsementIdentity =
      identity(endorsement.formCode) ??
      (endorsement.name ? normalizedString(endorsement.name.value) : "UNNAMED");
    const occurrence = (endorsementOccurrences.get(endorsementIdentity) ?? 0) + 1;
    endorsementOccurrences.set(endorsementIdentity, occurrence);
    const prefix = `endorsement.${endorsementIdentity}.${occurrence}`;
    push(atomic(`${prefix}.name`, "endorsementName", endorsement.name));
    push(atomic(`${prefix}.formCode`, "formCode", endorsement.formCode));
    push(atomic(`${prefix}.evidenceLevel`, "endorsementEvidenceLevel", endorsement.evidenceLevel));
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function scoreFacts(expectedFacts: readonly AtomicFact[], observedFacts: readonly AtomicFact[]) {
  const expected = new Map(expectedFacts.map((fact) => [fact.key, fact]));
  const observed = new Map(observedFacts.map((fact) => [fact.key, fact]));
  const keys = [...new Set([...expected.keys(), ...observed.keys()])].sort();
  const counts = emptyCounts();
  const byType = new Map<string, Counts>();
  const citations = emptyCitationCounts();
  let exact = true;

  for (const key of keys) {
    const truth = expected.get(key);
    const prediction = observed.get(key);
    const type = truth?.type ?? prediction?.type ?? "unknown";
    const typeCounts = byType.get(type) ?? emptyCounts();
    byType.set(type, typeCounts);
    if (truth?.evidencePages.length) citations.truthWithEvidence += 1;
    if (prediction?.evidencePages.length) citations.attempted += 1;

    if (truth && prediction && truth.value === prediction.value) {
      counts.truePositive += 1;
      typeCounts.truePositive += 1;
      if (prediction.evidencePages.length > 0) {
        citations.coverage += 1;
        if (prediction.evidencePages.some((page) => truth.evidencePages.includes(page))) {
          citations.correct += 1;
        }
      }
      continue;
    }

    exact = false;
    if (truth) {
      counts.falseNegative += 1;
      typeCounts.falseNegative += 1;
    }
    if (prediction) {
      counts.falsePositive += 1;
      typeCounts.falsePositive += 1;
    }
  }

  return { counts, byType, citations, exact };
}

function scoreCodes(expectedCodes: readonly string[], observedCodes: readonly string[]): Counts {
  const expected = new Set(expectedCodes.map(normalizedString));
  const observed = new Set(observedCodes.map(normalizedString));
  const counts = emptyCounts();
  for (const code of expected) {
    if (observed.has(code)) counts.truePositive += 1;
    else counts.falseNegative += 1;
  }
  for (const code of observed) {
    if (!expected.has(code)) counts.falsePositive += 1;
  }
  return counts;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const assertSha256 = (value: string, label: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters`);
  }
};

/** Validates invariants that affect deterministic scoring, without a JSON-schema dependency. */
export function validateBenchmarkCorpus(corpus: BenchmarkCorpusV1): void {
  if (corpus.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported benchmark schema version: ${corpus.schemaVersion}`);
  }
  if (!corpus.corpusId.trim() || corpus.cases.length === 0) {
    throw new TypeError("A benchmark corpus needs an id and at least one case");
  }
  assertUnique(
    corpus.cases.map((testCase) => testCase.id),
    "Case ids",
  );
  for (const testCase of corpus.cases) {
    assertUnique(
      testCase.pages.map((page) => String(page.page)),
      `Page numbers in ${testCase.id}`,
    );
    const availablePages = new Set(testCase.pages.map((page) => page.page));
    if ([...availablePages].some((page) => !Number.isSafeInteger(page) || page < 1)) {
      throw new TypeError(`Page numbers in ${testCase.id} must be positive integers`);
    }
    assertUnique(
      testCase.truth.policies.map((policy) => normalizedString(policy.coverageType.value)),
      `Truth coverage types in ${testCase.id}`,
    );
    const facts = flattenBenchmarkFacts(testCase.truth);
    assertUnique(
      facts.map((fact) => fact.key),
      `Fact keys in ${testCase.id}`,
    );
    for (const fact of facts) {
      if (fact.evidencePages.some((page) => !availablePages.has(page))) {
        throw new TypeError(`${testCase.id} cites a page outside the case: ${fact.key}`);
      }
    }
  }
}

export function validateBenchmarkPredictions(
  corpus: BenchmarkCorpusV1,
  predictions: BenchmarkPredictionFileV1,
  expectedCorpusSha256: string,
): void {
  assertSha256(expectedCorpusSha256, "Expected corpus SHA-256");
  if (predictions.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported prediction schema version: ${predictions.schemaVersion}`);
  }
  if (predictions.corpusId !== corpus.corpusId)
    throw new TypeError("Prediction corpus id mismatch");
  assertSha256(predictions.corpusSha256, "Prediction corpus SHA-256");
  if (predictions.corpusSha256 !== expectedCorpusSha256) {
    throw new TypeError("Prediction corpus SHA-256 mismatch");
  }
  if (predictions.mode !== "ZERO_TOUCH_TEXT_PARSE") {
    throw new TypeError("Corpus v1 accepts only ZERO_TOUCH_TEXT_PARSE predictions");
  }
  if (
    !predictions.system.id.trim() ||
    !predictions.system.name.trim() ||
    !predictions.system.version.trim()
  ) {
    throw new TypeError("Prediction system identity is incomplete");
  }
  assertUnique(
    predictions.cases.map((testCase) => testCase.caseId),
    "Prediction case ids",
  );
  const corpusCases = new Set(corpus.cases.map((testCase) => testCase.id));
  if (predictions.cases.some((testCase) => !corpusCases.has(testCase.caseId))) {
    throw new TypeError("Predictions include a case that is not in the corpus");
  }
}

export function scoreBenchmark(
  corpus: BenchmarkCorpusV1,
  predictions: BenchmarkPredictionFileV1,
  expectedCorpusSha256: string,
): BenchmarkScoreV1 {
  validateBenchmarkCorpus(corpus);
  validateBenchmarkPredictions(corpus, predictions, expectedCorpusSha256);
  const predictionsByCase = new Map(
    predictions.cases.map((testCase) => [testCase.caseId, testCase]),
  );
  const totalCounts = emptyCounts();
  const totalCitations = emptyCitationCounts();
  const totalWarnings = emptyCounts();
  const totalByType = new Map<string, Counts>();
  const caseScores: BenchmarkCaseScore[] = [];
  const durations: number[] = [];
  let exactDocuments = 0;

  for (const testCase of corpus.cases) {
    const prediction = predictionsByCase.get(testCase.id);
    const observedFacts = prediction
      ? flattenBenchmarkFacts(prediction.facts)
      : ([] as readonly AtomicFact[]);
    const scored = scoreFacts(flattenBenchmarkFacts(testCase.truth), observedFacts);
    const warningCounts = scoreCodes(testCase.warningCodes, prediction?.warningCodes ?? []);
    addCounts(totalCounts, scored.counts);
    addCitationCounts(totalCitations, scored.citations);
    addCounts(totalWarnings, warningCounts);
    for (const [type, counts] of scored.byType) {
      const aggregate = totalByType.get(type) ?? emptyCounts();
      addCounts(aggregate, counts);
      totalByType.set(type, aggregate);
    }
    if (scored.exact) exactDocuments += 1;
    if (prediction?.durationMs !== undefined && Number.isFinite(prediction.durationMs)) {
      durations.push(Math.max(0, prediction.durationMs));
    }
    caseScores.push({
      caseId: testCase.id,
      exactDocument: scored.exact,
      facts: metricFor(scored.counts),
      citations: citationMetricFor(scored.citations),
      warnings: metricFor(warningCounts),
    });
  }

  const fields = [...totalByType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldType, counts]) => ({ fieldType, ...metricFor(counts) }));
  const macroF1 = divide(
    fields.reduce((total, field) => total + field.f1, 0),
    fields.length,
  );
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const percentile = (fraction: number): number => {
    if (sortedDurations.length === 0) return 0;
    const index = Math.max(0, Math.ceil(sortedDurations.length * fraction) - 1);
    return rounded(sortedDurations[index] ?? 0);
  };

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    corpusId: corpus.corpusId,
    corpusSha256: expectedCorpusSha256,
    system: predictions.system,
    mode: predictions.mode,
    facts: metricFor(totalCounts),
    macroF1,
    fields,
    citations: citationMetricFor(totalCitations),
    warnings: metricFor(totalWarnings),
    exactDocuments,
    documentCount: corpus.cases.length,
    exactDocumentRate: divide(exactDocuments, corpus.cases.length),
    durationMs: {
      reportedCases: durations.length,
      median: percentile(0.5),
      p95: percentile(0.95),
    },
    cases: caseScores,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unexpected properties: ${unexpected.join(", ")}`);
  }
};

const assertFiniteRate = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number from 0 through 1`);
  }
  return value;
};

const assertCount = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const validateMetric = (
  value: unknown,
  label: string,
  allowedExtras: readonly string[] = [],
): BenchmarkMetric => {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "truePositive",
      "falsePositive",
      "falseNegative",
      "precision",
      "recall",
      "f1",
      ...allowedExtras,
    ],
    label,
  );
  const truePositive = assertCount(value.truePositive, `${label}.truePositive`);
  const falsePositive = assertCount(value.falsePositive, `${label}.falsePositive`);
  const falseNegative = assertCount(value.falseNegative, `${label}.falseNegative`);
  const precision = assertFiniteRate(value.precision, `${label}.precision`);
  const recall = assertFiniteRate(value.recall, `${label}.recall`);
  const f1 = assertFiniteRate(value.f1, `${label}.f1`);
  const expected = metricFor({ truePositive, falsePositive, falseNegative });
  if (precision !== expected.precision || recall !== expected.recall || f1 !== expected.f1) {
    throw new TypeError(`${label} rates do not match its counts`);
  }
  return { truePositive, falsePositive, falseNegative, precision, recall, f1 };
};

const validateCitationMetric = (value: unknown, label: string): BenchmarkCitationMetric => {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["coverage", "correct", "attempted", "truthWithEvidence", "precision", "recall"],
    label,
  );
  const coverage = assertCount(value.coverage, `${label}.coverage`);
  const correct = assertCount(value.correct, `${label}.correct`);
  const attempted = assertCount(value.attempted, `${label}.attempted`);
  const truthWithEvidence = assertCount(value.truthWithEvidence, `${label}.truthWithEvidence`);
  const precision = assertFiniteRate(value.precision, `${label}.precision`);
  const recall = assertFiniteRate(value.recall, `${label}.recall`);
  if (coverage > attempted || correct > coverage || correct > truthWithEvidence) {
    throw new TypeError(`${label} contains impossible citation counts`);
  }
  const expected = citationMetricFor({ coverage, correct, attempted, truthWithEvidence });
  if (precision !== expected.precision || recall !== expected.recall) {
    throw new TypeError(`${label} rates do not match its counts`);
  }
  return { coverage, correct, attempted, truthWithEvidence, precision, recall };
};

/**
 * Validates a machine-readable score before it can be used as comparison
 * evidence. This checks both structure and arithmetic consistency.
 */
export function validateBenchmarkScore(value: unknown): asserts value is BenchmarkScoreV1 {
  if (!isRecord(value)) throw new TypeError("Benchmark score must be an object");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "corpusId",
      "corpusSha256",
      "system",
      "mode",
      "facts",
      "macroF1",
      "fields",
      "citations",
      "warnings",
      "exactDocuments",
      "documentCount",
      "exactDocumentRate",
      "durationMs",
      "cases",
    ],
    "Benchmark score",
  );
  if (value.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported score schema version: ${String(value.schemaVersion)}`);
  }
  if (typeof value.corpusId !== "string" || !value.corpusId.trim()) {
    throw new TypeError("Score corpus id is missing");
  }
  if (typeof value.corpusSha256 !== "string")
    throw new TypeError("Score corpus SHA-256 is missing");
  assertSha256(value.corpusSha256, "Score corpus SHA-256");
  if (value.mode !== "ZERO_TOUCH_TEXT_PARSE") {
    throw new TypeError("Score mode must be ZERO_TOUCH_TEXT_PARSE");
  }
  if (!isRecord(value.system)) throw new TypeError("Score system identity is missing");
  assertExactKeys(value.system, ["id", "name", "version"], "Score system identity");
  for (const key of ["id", "name", "version"] as const) {
    if (typeof value.system[key] !== "string" || !value.system[key].trim()) {
      throw new TypeError(`Score system ${key} is missing`);
    }
  }

  const facts = validateMetric(value.facts, "score.facts");
  const warnings = validateMetric(value.warnings, "score.warnings");
  const citations = validateCitationMetric(value.citations, "score.citations");
  const macroF1 = assertFiniteRate(value.macroF1, "score.macroF1");
  const exactDocuments = assertCount(value.exactDocuments, "score.exactDocuments");
  const documentCount = assertCount(value.documentCount, "score.documentCount");
  if (documentCount < 1 || exactDocuments > documentCount) {
    throw new TypeError("Score exact-document counts are impossible");
  }
  const exactDocumentRate = assertFiniteRate(value.exactDocumentRate, "score.exactDocumentRate");
  if (exactDocumentRate !== divide(exactDocuments, documentCount)) {
    throw new TypeError("Score exact-document rate does not match its counts");
  }

  if (!Array.isArray(value.fields)) {
    throw new TypeError("Score field metrics are missing");
  }
  const fieldNames: string[] = [];
  const fieldMetrics = value.fields.map((field, index) => {
    if (!isRecord(field) || typeof field.fieldType !== "string" || !field.fieldType.trim()) {
      throw new TypeError(`score.fields[${index}] has no field type`);
    }
    fieldNames.push(field.fieldType);
    return validateMetric(field, `score.fields[${index}]`, ["fieldType"]);
  });
  assertUnique(fieldNames, "Score field types");
  if (
    macroF1 !==
    divide(
      fieldMetrics.reduce((total, field) => total + field.f1, 0),
      fieldMetrics.length,
    )
  ) {
    throw new TypeError("Score macro F1 does not match field metrics");
  }

  if (!isRecord(value.durationMs)) throw new TypeError("Score duration summary is missing");
  assertExactKeys(value.durationMs, ["reportedCases", "median", "p95"], "Score duration summary");
  const reportedCases = assertCount(
    value.durationMs.reportedCases,
    "score.durationMs.reportedCases",
  );
  const median = value.durationMs.median;
  const p95 = value.durationMs.p95;
  if (
    typeof median !== "number" ||
    !Number.isFinite(median) ||
    median < 0 ||
    typeof p95 !== "number" ||
    !Number.isFinite(p95) ||
    p95 < median ||
    reportedCases > documentCount
  ) {
    throw new TypeError("Score duration summary is invalid");
  }

  if (!Array.isArray(value.cases) || value.cases.length !== documentCount) {
    throw new TypeError("Score cases must match the document count");
  }
  const caseIds: string[] = [];
  const aggregateFacts = emptyCounts();
  const aggregateWarnings = emptyCounts();
  const aggregateCitations = emptyCitationCounts();
  let aggregateExact = 0;
  for (const [index, item] of value.cases.entries()) {
    if (!isRecord(item) || typeof item.caseId !== "string" || !item.caseId.trim()) {
      throw new TypeError(`score.cases[${index}] has no case id`);
    }
    assertExactKeys(
      item,
      ["caseId", "exactDocument", "facts", "citations", "warnings"],
      `score.cases[${index}]`,
    );
    if (typeof item.exactDocument !== "boolean") {
      throw new TypeError(`score.cases[${index}] has no exact-document flag`);
    }
    caseIds.push(item.caseId);
    const caseFacts = validateMetric(item.facts, `score.cases[${index}].facts`);
    const caseWarnings = validateMetric(item.warnings, `score.cases[${index}].warnings`);
    const caseCitations = validateCitationMetric(item.citations, `score.cases[${index}].citations`);
    addCounts(aggregateFacts, caseFacts);
    addCounts(aggregateWarnings, caseWarnings);
    addCitationCounts(aggregateCitations, caseCitations);
    if (item.exactDocument) aggregateExact += 1;
  }
  assertUnique(caseIds, "Score case ids");
  if (
    JSON.stringify(aggregateFacts) !==
      JSON.stringify({
        truePositive: facts.truePositive,
        falsePositive: facts.falsePositive,
        falseNegative: facts.falseNegative,
      }) ||
    JSON.stringify(aggregateWarnings) !==
      JSON.stringify({
        truePositive: warnings.truePositive,
        falsePositive: warnings.falsePositive,
        falseNegative: warnings.falseNegative,
      }) ||
    JSON.stringify(aggregateCitations) !==
      JSON.stringify({
        coverage: citations.coverage,
        correct: citations.correct,
        attempted: citations.attempted,
        truthWithEvidence: citations.truthWithEvidence,
      }) ||
    aggregateExact !== exactDocuments
  ) {
    throw new TypeError("Score aggregates do not match per-case results");
  }
}

/**
 * Produces descriptive deltas only. It deliberately does not rank products or
 * claim statistical significance from the small synthetic corpus.
 */
export function compareBenchmarkScores(
  scoreInputs: readonly unknown[],
  referenceSystemId: string,
): BenchmarkComparisonV1 {
  for (const score of scoreInputs) validateBenchmarkScore(score);
  const scores = scoreInputs as readonly BenchmarkScoreV1[];
  if (scores.length < 2) throw new TypeError("A comparison needs at least two score files");
  const corpusId = scores[0]?.corpusId;
  if (!corpusId || scores.some((score) => score.corpusId !== corpusId)) {
    throw new TypeError("Comparison score files must use the same corpus");
  }
  const corpusSha256 = scores[0]?.corpusSha256;
  if (!corpusSha256 || scores.some((score) => score.corpusSha256 !== corpusSha256)) {
    throw new TypeError("Comparison score files must use the same corpus SHA-256");
  }
  assertUnique(
    scores.map((score) => score.system.id),
    "Comparison system ids",
  );
  const reference = scores.find((score) => score.system.id === referenceSystemId);
  if (!reference) throw new TypeError("Reference system was not found");
  const delta = (value: number, baseline: number) => rounded(value - baseline);

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    corpusId,
    corpusSha256,
    referenceSystemId,
    disclaimer:
      "Descriptive synthetic-text deltas only; this comparison is not a browser OCR, real-world, usability, or universal-superiority result.",
    rows: [...scores]
      .sort((left, right) => left.system.id.localeCompare(right.system.id))
      .map((score) => ({
        system: score.system,
        macroF1: score.macroF1,
        microF1: score.facts.f1,
        citationRecall: score.citations.recall,
        exactDocumentRate: score.exactDocumentRate,
        deltaFromReference: {
          macroF1: delta(score.macroF1, reference.macroF1),
          microF1: delta(score.facts.f1, reference.facts.f1),
          citationRecall: delta(score.citations.recall, reference.citations.recall),
          exactDocumentRate: delta(score.exactDocumentRate, reference.exactDocumentRate),
        },
      })),
  };
}
