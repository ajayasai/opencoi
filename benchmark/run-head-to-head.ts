import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildHeadToHeadReport,
  type HeadToHeadProvidedSystemV1,
  renderHeadToHeadMarkdown,
} from "./headToHead.js";
import { serializeBenchmarkJson } from "./serialization.js";

const readJson = async (path: string): Promise<unknown> => {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const readPrediction = async (path: string) => {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  try {
    return {
      value: JSON.parse(text) as unknown,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    throw new TypeError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const main = async () => {
  const corpusPath = process.argv[2];
  const manifestPath = process.argv[3];
  const outputPrefix = process.argv[4];
  if (!corpusPath || !manifestPath || !outputPrefix) {
    throw new TypeError(
      "Usage: npm run benchmark:head-to-head -- <corpus.json> <manifest.json> <output-prefix>",
    );
  }

  const absoluteManifestPath = resolve(manifestPath);
  const manifestDirectory = dirname(absoluteManifestPath);
  const report = await buildHeadToHeadReport(
    await readJson(resolve(corpusPath)),
    await readJson(absoluteManifestPath),
    async (entry: HeadToHeadProvidedSystemV1) =>
      readPrediction(resolve(manifestDirectory, entry.predictionPath)),
  );
  const jsonPath = `${outputPrefix}.json`;
  const markdownPath = `${outputPrefix}.md`;
  await Promise.all([
    writeFile(jsonPath, `${serializeBenchmarkJson(report)}\n`, "utf8"),
    writeFile(markdownPath, renderHeadToHeadMarkdown(report), "utf8"),
  ]);
  process.stdout.write(`${jsonPath}\n${markdownPath}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
