import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url));

const listFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
};

const files = await listFiles(outputDirectory);
const compiledTests = files.filter((path) => path.endsWith(".test.js"));
if (compiledTests.length > 0) {
  throw new Error(`Production output contains compiled tests:\n${compiledTests.join("\n")}`);
}

const browserScripts = files.filter(
  (path) => path.includes("/client/assets/") && path.endsWith(".js"),
);
for (const path of browserScripts) {
  const source = await readFile(path, "utf8");
  if (source.includes("Download the React DevTools for a better development experience")) {
    throw new Error(`Production output contains React's development runtime: ${path}`);
  }
  if (source.includes("jsxDEV")) {
    throw new Error(`Production output contains React's development JSX transform: ${path}`);
  }
}

process.stdout.write(
  `Production build verification passed (${browserScripts.length} browser scripts, no compiled tests).\n`,
);
