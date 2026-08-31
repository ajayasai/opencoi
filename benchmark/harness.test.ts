import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BenchmarkCorpusV1, BenchmarkPredictionFileV1 } from "../shared/benchmark.js";
import { scoreBenchmark, validateBenchmarkCorpus } from "../shared/benchmark.js";
import corpusJson from "./corpus/synthetic-text-v1.json" with { type: "json" };
import { openCoiPredictionForPages } from "./openCoiAdapter.js";
import { corpusSha256, serializeBenchmarkJson } from "./serialization.js";

const corpus = corpusJson as unknown as BenchmarkCorpusV1;
const CORPUS_SHA256 = corpusSha256(corpus);

const predictions = (): BenchmarkPredictionFileV1 => ({
  schemaVersion: "1.0",
  corpusId: corpus.corpusId,
  corpusSha256: CORPUS_SHA256,
  mode: "ZERO_TOUCH_TEXT_PARSE",
  system: { id: "opencoi-shared-parser", name: "OpenCOI shared text parser", version: "test" },
  cases: corpus.cases.map((testCase) => openCoiPredictionForPages(testCase.id, testCase.pages)),
});

describe("public synthetic text benchmark", () => {
  it("has valid, marked, original synthetic page-text cases", () => {
    expect(() => validateBenchmarkCorpus(corpus)).not.toThrow();
    expect(corpus.cases).toHaveLength(6);
    for (const testCase of corpus.cases) {
      for (const page of testCase.pages) {
        expect(page.text).toContain("SYNTHETIC TEST FIXTURE - VOID");
        expect(page.text).not.toMatch(/\bACORD\b/i);
      }
    }
  });

  it("freezes the current shared-parser baseline without claiming OCR accuracy", () => {
    const first = scoreBenchmark(corpus, predictions(), CORPUS_SHA256);
    const second = scoreBenchmark(corpus, predictions(), CORPUS_SHA256);

    expect(first).toEqual(second);
    expect(first.facts).toMatchObject({
      truePositive: 63,
      falsePositive: 0,
      falseNegative: 2,
      precision: 1,
      recall: 0.969231,
      f1: 0.984375,
    });
    expect(first.macroF1).toBe(0.992481);
    expect(first.exactDocumentRate).toBe(0.833333);
    expect(first.citations).toMatchObject({ attempted: 63, correct: 63, recall: 0.969231 });
    expect(first.warnings).toMatchObject({ truePositive: 4, falsePositive: 0, falseNegative: 0 });
    expect(first.durationMs.reportedCases).toBe(0);
  });

  it("keeps every machine-proposed endorsement at mentioned", () => {
    const output = predictions();
    const endorsements = output.cases.flatMap((testCase) => testCase.facts.endorsements);
    expect(endorsements).toHaveLength(2);
    expect(
      endorsements.every((endorsement) => endorsement.evidenceLevel.value === "MENTIONED"),
    ).toBe(true);
  });

  it("recreates the published prediction and score bytes exactly", () => {
    const publishedPredictions = {
      ...predictions(),
      system: {
        id: "opencoi-shared-parser",
        name: "OpenCOI shared text parser",
        version: "v0.4.0",
      },
    };
    const publishedScore = scoreBenchmark(corpus, publishedPredictions, CORPUS_SHA256);
    const predictionBytes = readFileSync(
      fileURLToPath(
        new URL("./results/synthetic-text-v1-opencoi-v0.4.0.predictions.json", import.meta.url),
      ),
      "utf8",
    );
    const scoreBytes = readFileSync(
      fileURLToPath(
        new URL("./results/synthetic-text-v1-opencoi-v0.4.0.score.json", import.meta.url),
      ),
      "utf8",
    );
    expect(predictionBytes).toBe(`${serializeBenchmarkJson(publishedPredictions)}\n`);
    expect(scoreBytes).toBe(`${serializeBenchmarkJson(publishedScore)}\n`);
  });
});
