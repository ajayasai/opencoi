import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BenchmarkCorpusV1, BenchmarkPredictionFileV1 } from "../shared/benchmark.js";
import { openCoiPredictionForPages } from "./openCoiAdapter.js";
import { corpusSha256, serializeBenchmarkJson } from "./serialization.js";

const defaultCorpus = fileURLToPath(new URL("./corpus/synthetic-text-v1.json", import.meta.url));

const main = async () => {
  const corpusPath = process.argv[2] ?? defaultCorpus;
  const outputPath = process.argv[3];
  const version = process.argv[4] ?? "working-tree";
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as BenchmarkCorpusV1;
  const predictions: BenchmarkPredictionFileV1 = {
    schemaVersion: "1.0",
    corpusId: corpus.corpusId,
    corpusSha256: corpusSha256(corpus),
    mode: "ZERO_TOUCH_TEXT_PARSE",
    system: { id: "opencoi-shared-parser", name: "OpenCOI shared text parser", version },
    cases: corpus.cases.map((testCase) => openCoiPredictionForPages(testCase.id, testCase.pages)),
  };
  const serialized = `${serializeBenchmarkJson(predictions)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
