import { describe, expect, it } from "vitest";
import {
  type BenchmarkCorpusV1,
  type BenchmarkPredictionFileV1,
  compareBenchmarkScores,
  flattenBenchmarkFacts,
  scoreBenchmark,
  validateBenchmarkCorpus,
  validateBenchmarkScore,
} from "./benchmark.js";

const CORPUS_SHA256 = "a".repeat(64);

const corpus = (): BenchmarkCorpusV1 => ({
  schemaVersion: "1.0",
  corpusId: "synthetic-unit-v1",
  title: "Synthetic unit corpus",
  license: "CC0-1.0",
  limitations: ["Text parser only"],
  cases: [
    {
      id: "case-a",
      description: "One complete policy",
      strata: ["text", "single-page"],
      pages: [{ page: 1, text: "synthetic" }],
      truth: {
        namedInsured: { value: "Example Builder LLC", evidencePages: [1] },
        policies: [
          {
            coverageType: {
              value: "COMMERCIAL_GENERAL_LIABILITY",
              evidencePages: [1],
            },
            insurerName: { value: "Example Mutual", evidencePages: [1] },
            policyNumber: { value: "GL-123", evidencePages: [1] },
            limits: { EACH_OCCURRENCE: { value: 100_000_000, evidencePages: [1] } },
          },
        ],
        endorsements: [
          {
            name: { value: "Additional insured", evidencePages: [1] },
            formCode: { value: "CG 20 10", evidencePages: [1] },
            evidenceLevel: { value: "MENTIONED", evidencePages: [1] },
          },
        ],
      },
      warningCodes: ["SYNTHETIC_WARNING"],
    },
    {
      id: "case-b",
      description: "No extracted facts",
      strata: ["text", "negative"],
      pages: [{ page: 1, text: "synthetic blank" }],
      truth: { policies: [], endorsements: [] },
      warningCodes: [],
    },
  ],
});

const predictions = (): BenchmarkPredictionFileV1 => ({
  schemaVersion: "1.0",
  corpusId: "synthetic-unit-v1",
  corpusSha256: CORPUS_SHA256,
  mode: "ZERO_TOUCH_TEXT_PARSE",
  system: { id: "perfect", name: "Perfect fixture", version: "1" },
  cases: corpus().cases.map((testCase, index) => ({
    caseId: testCase.id,
    facts: testCase.truth,
    warningCodes: testCase.warningCodes,
    durationMs: index === 0 ? 10 : 30,
  })),
});

describe("vendor-neutral benchmark scoring", () => {
  it("gives a perfect, deterministic score to exact predictions", () => {
    const first = scoreBenchmark(corpus(), predictions(), CORPUS_SHA256);
    const second = scoreBenchmark(corpus(), predictions(), CORPUS_SHA256);

    expect(first).toEqual(second);
    expect(first.facts).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(first.macroF1).toBe(1);
    expect(first.citations).toMatchObject({ precision: 1, recall: 1 });
    expect(first.warnings).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(first.exactDocumentRate).toBe(1);
    expect(first.durationMs).toEqual({ reportedCases: 2, median: 10, p95: 30 });
  });

  it("counts a wrong value as both a false positive and false negative", () => {
    const input = predictions();
    const firstCase = input.cases[0];
    if (!firstCase) throw new Error("Fixture is incomplete");
    const altered: BenchmarkPredictionFileV1 = {
      ...input,
      cases: [
        {
          ...firstCase,
          facts: {
            ...firstCase.facts,
            namedInsured: { value: "Wrong Company", evidencePages: [1] },
          },
        },
        ...(input.cases[1] ? [input.cases[1]] : []),
      ],
    };

    const score = scoreBenchmark(corpus(), altered, CORPUS_SHA256);
    const party = score.fields.find((field) => field.fieldType === "namedInsured");
    expect(party).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 1, f1: 0 });
    expect(score.exactDocuments).toBe(1);
    expect(score.citations.attempted).toBeGreaterThan(score.citations.correct);
  });

  it("normalizes display differences in identifiers without changing exact money", () => {
    const facts = corpus().cases[0]?.truth;
    const policy = facts?.policies[0];
    const endorsement = facts?.endorsements[0];
    if (!facts || !policy || !endorsement) throw new Error("Fixture is incomplete");
    const changed = {
      ...facts,
      policies: [
        {
          ...policy,
          policyNumber: { value: " gl 123 ", evidencePages: [1] },
        },
      ],
      endorsements: [
        {
          ...endorsement,
          formCode: { value: "cg-20-10", evidencePages: [1] },
        },
      ],
    };
    expect(flattenBenchmarkFacts(changed)).toEqual(flattenBenchmarkFacts(facts));
  });

  it("rejects truth citations to pages that are not in the case", () => {
    const invalid = corpus();
    const first = invalid.cases[0];
    if (!first) throw new Error("Fixture is incomplete");
    const changed: BenchmarkCorpusV1 = {
      ...invalid,
      cases: [
        {
          ...first,
          truth: { ...first.truth, namedInsured: { value: "Example", evidencePages: [99] } },
        },
        ...invalid.cases.slice(1),
      ],
    };
    expect(() => validateBenchmarkCorpus(changed)).toThrow(/outside the case/i);
  });

  it("rejects duplicate truth coverage types until policy matching is versioned", () => {
    const invalid = corpus();
    const first = invalid.cases[0];
    const policy = first?.truth.policies[0];
    if (!first || !policy) throw new Error("Fixture is incomplete");
    const changed: BenchmarkCorpusV1 = {
      ...invalid,
      cases: [
        {
          ...first,
          truth: { ...first.truth, policies: [policy, { ...policy }] },
        },
        ...invalid.cases.slice(1),
      ],
    };
    expect(() => validateBenchmarkCorpus(changed)).toThrow(/coverage types.*unique/i);
  });

  it("produces alphabetically stable descriptive comparisons", () => {
    const reference = scoreBenchmark(corpus(), predictions(), CORPUS_SHA256);
    const otherInput = predictions();
    const other = scoreBenchmark(
      corpus(),
      {
        ...otherInput,
        system: { id: "alpha", name: "Empty fixture", version: "1" },
        cases: [],
      },
      CORPUS_SHA256,
    );
    const comparison = compareBenchmarkScores([reference, other], "perfect");

    expect(comparison.rows.map((row) => row.system.id)).toEqual(["alpha", "perfect"]);
    expect(comparison.rows[0]?.deltaFromReference.microF1).toBeLessThan(0);
    expect(comparison.rows[1]?.deltaFromReference).toEqual({
      macroF1: 0,
      microF1: 0,
      citationRecall: 0,
      exactDocumentRate: 0,
    });
    expect(comparison.disclaimer).toMatch(/not a browser OCR/i);
  });

  it("rejects predictions and comparisons bound to a different corpus checksum", () => {
    const input = predictions();
    expect(() => scoreBenchmark(corpus(), input, "b".repeat(64))).toThrow(/SHA-256 mismatch/i);

    const first = scoreBenchmark(corpus(), input, CORPUS_SHA256);
    const second = {
      ...first,
      system: { id: "other", name: "Other", version: "1" },
      corpusSha256: "b".repeat(64),
    };
    expect(() => compareBenchmarkScores([first, second], "perfect")).toThrow(
      /same corpus SHA-256/i,
    );
  });

  it("rejects malformed or arithmetically inconsistent score inputs", () => {
    const valid = scoreBenchmark(corpus(), predictions(), CORPUS_SHA256);
    expect(() => validateBenchmarkScore(valid)).not.toThrow();

    const malicious = {
      ...valid,
      facts: { ...valid.facts, truePositive: "lots", precision: 99 },
    };
    expect(() => validateBenchmarkScore(malicious)).toThrow(/truePositive/i);
    expect(() => compareBenchmarkScores([valid, malicious], "perfect")).toThrow(/truePositive/i);
    expect(() =>
      validateBenchmarkScore({ ...valid, unexpected: "not part of the score contract" }),
    ).toThrow(/unexpected properties/i);

    const inconsistent = {
      ...valid,
      exactDocumentRate: 0,
    };
    expect(() => validateBenchmarkScore(inconsistent)).toThrow(/exact-document rate/i);
  });
});
