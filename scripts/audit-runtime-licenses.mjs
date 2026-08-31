import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const projectRoot = process.cwd();
const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8"));
const outputPath = process.argv[2] ? resolve(projectRoot, process.argv[2]) : null;
const curatedByPackage = new Map([
  ["@tesseract.js-data/eng@1.0.0", "third_party_licenses/tesseract-eng-package-MIT.txt"],
  ["tr46@0.0.3", "third_party_licenses/tr46-MIT.txt"],
]);
const licenseName = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const packages = [];
const gaps = [];

for (const [installPath, lockEntry] of Object.entries(lock.packages ?? {})) {
  if (!installPath.startsWith("node_modules/") || lockEntry.dev === true) continue;
  const packageDirectory = resolve(projectRoot, installPath);
  const manifestPath = resolve(packageDirectory, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packageKey = `${manifest.name}@${manifest.version}`;
  const shippedLicenseFiles = readdirSync(packageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => `${installPath}/${entry.name}`)
    .sort();
  let curatedLicense = curatedByPackage.get(packageKey) ?? null;
  if (
    !curatedLicense &&
    manifest.name.startsWith("@napi-rs/canvas-") &&
    manifest.license === "MIT"
  ) {
    curatedLicense = "third_party_licenses/napi-rs-canvas-MIT.txt";
  }
  if (curatedLicense && !existsSync(resolve(projectRoot, curatedLicense))) {
    gaps.push(`${packageKey}: curated license file ${curatedLicense} is missing`);
  } else if (shippedLicenseFiles.length === 0 && !curatedLicense) {
    gaps.push(`${packageKey}: no shipped or curated license/notice file`);
  }
  packages.push({
    name: manifest.name,
    version: manifest.version,
    declaredLicense: manifest.license ?? null,
    installPath,
    shippedLicenseFiles,
    curatedLicense,
  });
}

packages.sort((left, right) =>
  `${left.name}@${left.version}:${left.installPath}`.localeCompare(
    `${right.name}@${right.version}:${right.installPath}`,
  ),
);

if (gaps.length > 0) {
  console.error("Runtime dependency license audit failed:");
  for (const gap of gaps.sort()) console.error(`- ${gap}`);
  process.exitCode = 1;
} else {
  console.log(`Runtime dependency license audit passed for ${packages.length} installed packages.`);
}

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceLockfile: "package-lock.json",
        packageCount: packages.length,
        packages,
      },
      null,
      2,
    )}\n`,
  );
}
