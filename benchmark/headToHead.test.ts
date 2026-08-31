import { describe, expect, it, vi } from "vitest";
import type { BenchmarkPredictionFileV1 } from "../shared/benchmark.js";
import corpusDocument from "./corpus/synthetic-text-v1.json" with { type: "json" };
import manifestDocument from "./examples/head-to-head-synthetic-v1.manifest.json" with {
  type: "json",
};
import {
  buildHeadToHeadReport,
  type HeadToHeadProvidedSystemV1,
  renderHeadToHeadMarkdown,
} from "./headToHead.js";
import predictionDocument from "./results/synthetic-text-v1-opencoi-v0.4.0.predictions.json" with {
  type: "json",
};
import { serializeBenchmarkJson } from "./serialization.js";

const PUBLISHED_PREDICTION_SHA256 =
  "d63d21e3ab223ee98d71fce0cd474866307f2c4116617590822c4758270f8963";

const loader = async (entry: HeadToHeadProvidedSystemV1) => {
  if (!entry.predictionPath.endsWith("synthetic-text-v1-opencoi-v0.4.0.predictions.json")) {
    throw new TypeError(`Unexpected test artifact: ${entry.predictionPath}`);
  }
  return { value: predictionDocument, artifactSha256: PUBLISHED_PREDICTION_SHA256 };
};

describe("authorization-aware head-to-head benchmark", () => {
  it("scores supplied artifacts once and represents every missing comparator as NOT_TESTED", async () => {
    const trackedLoader = vi.fn(loader);
    const report = await buildHeadToHeadReport(corpusDocument, manifestDocument, trackedLoader);

    expect(trackedLoader).toHaveBeenCalledTimes(1);
    expect(report.rows.map((row) => row.system.id)).toEqual([
      "certfocus",
      "certificial",
      "mycoi-illumend",
      "opencoi-shared-parser",
      "smartcompliance",
      "trustlayer",
    ]);
    expect(report.rows.filter((row) => row.status === "NOT_TESTED")).toHaveLength(5);
    const tested = report.rows.find((row) => row.status === "TESTED");
    expect(tested).toMatchObject({
      system: { id: "opencoi-shared-parser", version: "v0.4.0" },
      authorizationEvidence: "SELF_ATTESTED_NOT_INDEPENDENTLY_VERIFIED",
      score: {
        facts: { f1: 0.984375 },
        macroF1: 0.992481,
        exactDocumentRate: 0.833333,
      },
      deltaFromReference: {
        macroF1: 0,
        factsF1: 0,
        citationRecall: 0,
        warningF1: 0,
        exactDocumentRate: 0,
      },
    });
    if (tested?.status !== "TESTED") throw new TypeError("Missing tested row");
    expect(tested.provenance.normalizedPredictionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tested.provenance.deterministicScoreSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces byte-stable JSON and Markdown without a generated clock", async () => {
    const first = await buildHeadToHeadReport(corpusDocument, manifestDocument, loader);
    const second = await buildHeadToHeadReport(corpusDocument, manifestDocument, loader);
    expect(serializeBenchmarkJson(first)).toBe(serializeBenchmarkJson(second));
    expect(renderHeadToHeadMarkdown(first)).toBe(renderHeadToHeadMarkdown(second));

    const markdown = renderHeadToHeadMarkdown(first);
    expect(markdown).toContain("`NOT_TESTED` is not a zero score");
    expect(markdown).toContain("Certificial | — | NOT_TESTED");
    expect(markdown).toContain("SELF_ATTESTATION_RECORDED_NOT_VERIFIED");
    expect(markdown).toContain("Rows are ordered by stable system id, never by score.");
    expect(markdown).not.toMatch(/better|winner|ranked first/i);
  });

  it("requires positive access and publication declarations for supplied artifacts", async () => {
    const invalid = structuredClone(manifestDocument) as Record<string, unknown>;
    const systems = invalid.systems as Array<Record<string, unknown>>;
    const provided = systems.find((entry) => entry.status === "PROVIDED");
    if (!provided) throw new TypeError("Fixture has no provided system");
    (provided.authorization as Record<string, unknown>).publicationPermission = false;

    await expect(buildHeadToHeadReport(corpusDocument, invalid, loader)).rejects.toThrow(
      "manifest schema v1",
    );
  });

  it("strictly rejects unknown prediction fields before scoring", async () => {
    const invalidPrediction = { ...predictionDocument, inventedVendorScore: 1 };
    await expect(
      buildHeadToHeadReport(corpusDocument, manifestDocument, async () => ({
        value: invalidPrediction,
        artifactSha256: PUBLISHED_PREDICTION_SHA256,
      })),
    ).rejects.toThrow("violates prediction schema v1");
  });

  it("rejects an artifact bound to a different frozen corpus", async () => {
    const invalidPrediction: BenchmarkPredictionFileV1 = {
      ...(predictionDocument as BenchmarkPredictionFileV1),
      corpusSha256: "0".repeat(64),
    };
    await expect(
      buildHeadToHeadReport(corpusDocument, manifestDocument, async () => ({
        value: invalidPrediction,
        artifactSha256: PUBLISHED_PREDICTION_SHA256,
      })),
    ).rejects.toThrow("Prediction corpus SHA-256 mismatch");
  });

  it("rejects a normalized prediction whose exact-byte hash does not match provenance", async () => {
    await expect(
      buildHeadToHeadReport(corpusDocument, manifestDocument, async () => ({
        value: predictionDocument,
        artifactSha256: "0".repeat(64),
      })),
    ).rejects.toThrow("Prediction artifact SHA-256 mismatch");
  });
});
