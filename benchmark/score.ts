import { readFile, writeFile } from "node:fs/promises";
import type { BenchmarkCorpusV1, BenchmarkPredictionFileV1 } from "../shared/benchmark.js";
import { scoreBenchmark } from "../shared/benchmark.js";
import { corpusSha256, serializeBenchmarkJson } from "./serialization.js";

const main = async () => {
  const corpusPath = process.argv[2];
  const predictionPath = process.argv[3];
  const outputPath = process.argv[4];
  if (!corpusPath || !predictionPath) {
    throw new TypeError(
      "Usage: npx tsx benchmark/score.ts <corpus.json> <predictions.json> [output.json]",
    );
  }
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as BenchmarkCorpusV1;
  const predictions = JSON.parse(
    await readFile(predictionPath, "utf8"),
  ) as BenchmarkPredictionFileV1;
  const serialized = `${serializeBenchmarkJson(
    scoreBenchmark(corpus, predictions, corpusSha256(corpus)),
  )}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
