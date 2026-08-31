import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../server/http/apiV1.js";

const outputPath = fileURLToPath(new URL("../docs/api/openapi-v1.yaml", import.meta.url));
const serialized = `${JSON.stringify(openApiDocument, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== serialized) {
    throw new Error("The checked-in OpenAPI file is stale; run npm run openapi:generate");
  }
  process.stdout.write("Checked-in OpenAPI contract matches the runtime document.\n");
} else {
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(`${outputPath}\n`);
}
