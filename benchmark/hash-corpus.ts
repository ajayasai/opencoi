import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { corpusSha256 } from "./serialization.js";

const defaultCorpus = fileURLToPath(new URL("./corpus/synthetic-text-v1.json", import.meta.url));

const main = async () => {
  const corpusPath = process.argv[2] ?? defaultCorpus;
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as unknown;
  process.stdout.write(`${corpusSha256(corpus)}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
