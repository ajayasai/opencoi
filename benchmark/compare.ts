import { readFile } from "node:fs/promises";
import { compareBenchmarkScores } from "../shared/benchmark.js";
import { serializeBenchmarkJson } from "./serialization.js";

const main = async () => {
  const referenceSystemId = process.argv[2];
  const scorePaths = process.argv.slice(3);
  if (!referenceSystemId || scorePaths.length < 2) {
    throw new TypeError(
      "Usage: npx tsx benchmark/compare.ts <reference-system-id> <score-a.json> <score-b.json> [more.json]",
    );
  }
  const scores = await Promise.all(
    scorePaths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  process.stdout.write(
    `${serializeBenchmarkJson(compareBenchmarkScores(scores, referenceSystemId))}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
