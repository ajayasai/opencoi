import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Serializes benchmark artifacts deterministically while keeping the output
 * readable. Primitive arrays stay on one line when they fit the formatter's
 * line width; objects and structured arrays retain a stable expanded shape.
 */
export function serializeBenchmarkJson(value: unknown, indent = 0): string {
  const scalar = JSON.stringify(value);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (scalar === undefined) throw new TypeError("Benchmark JSON cannot contain undefined");
    return scalar;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const containsOnlyScalars = value.every(
      (item) => item === null || ["string", "number", "boolean"].includes(typeof item),
    );
    const compact = containsOnlyScalars
      ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
      : JSON.stringify(value);
    if (containsOnlyScalars && compact.length + indent <= 100) return compact;
    const childIndent = indent + 2;
    return `[\n${value
      .map((item) => `${" ".repeat(childIndent)}${serializeBenchmarkJson(item, childIndent)}`)
      .join(",\n")}\n${" ".repeat(indent)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const childIndent = indent + 2;
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${" ".repeat(childIndent)}${JSON.stringify(key)}: ${serializeBenchmarkJson(item, childIndent)}`,
      )
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  throw new TypeError(`Unsupported benchmark JSON value: ${typeof value}`);
}

/**
 * Canonical semantic JSON used for corpus identity. Object keys are sorted,
 * array order is retained, and scalar encoding follows JSON.stringify. This
 * makes the checksum independent of indentation and checkout line endings.
 */
export function canonicalBenchmarkJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Benchmark JSON cannot contain undefined");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalBenchmarkJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalBenchmarkJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported benchmark JSON value: ${typeof value}`);
}

export function corpusSha256(corpus: unknown): string {
  return createHash("sha256").update(canonicalBenchmarkJson(corpus), "utf8").digest("hex");
}

export function assertSha256(value: string, label = "SHA-256"): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters`);
  }
}
