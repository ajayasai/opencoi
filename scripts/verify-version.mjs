import { readFile } from "node:fs/promises";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const versionSource = await readFile(new URL("../shared/version.ts", import.meta.url), "utf8");
const sourceVersion = versionSource.match(/OPENCOI_VERSION\s*=\s*"([^"]+)"/)?.[1];

if (!sourceVersion) {
  throw new Error("shared/version.ts does not declare OPENCOI_VERSION");
}
if (sourceVersion !== packageMetadata.version) {
  throw new Error(
    `Version mismatch: package.json=${packageMetadata.version}, shared/version.ts=${sourceVersion}`,
  );
}

process.stdout.write(`Version consistency verified (${sourceVersion}).\n`);
