import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BenchmarkCorpusV1, BenchmarkScoreV1 } from "../shared/benchmark.js";
import { compareBenchmarkScores } from "../shared/benchmark.js";
import corpusDocument from "./corpus/synthetic-text-v1.json" with { type: "json" };
import predictionsDocument from "./results/synthetic-text-v1-opencoi-v0.2.0.predictions.json" with {
  type: "json",
};
import scoreDocument from "./results/synthetic-text-v1-opencoi-v0.2.0.score.json" with {
  type: "json",
};
import comparisonSchema from "./schemas/comparison-v1.schema.json" with { type: "json" };
import corpusSchema from "./schemas/corpus-v1.schema.json" with { type: "json" };
import predictionSchema from "./schemas/prediction-v1.schema.json" with { type: "json" };
import scoreSchema from "./schemas/score-v1.schema.json" with { type: "json" };
import { corpusSha256 } from "./serialization.js";

type JsonSchema = Record<string, unknown>;

function resolvedReference(root: JsonSchema, reference: string): JsonSchema {
  if (!reference.startsWith("#/"))
    throw new TypeError(`External reference is not standalone: ${reference}`);
  const result = reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      root,
    );
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(`Unresolvable local reference: ${reference}`);
  }
  return result as JsonSchema;
}

function validate(
  schema: JsonSchema,
  value: unknown,
  root = schema,
  path = "$",
  errors: string[] = [],
) {
  if (typeof schema.$ref === "string") {
    return validate(resolvedReference(root, schema.$ref), value, root, path, errors);
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path} violates const`);
  const type = schema.type;
  const correctType =
    type === undefined ||
    (type === "object" && Boolean(value) && typeof value === "object" && !Array.isArray(value)) ||
    (type === "array" && Array.isArray(value)) ||
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
    (type === "boolean" && typeof value === "boolean");
  if (!correctType) {
    errors.push(`${path} is not ${String(type)}`);
    return errors;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path} is too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path} is too long`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      errors.push(`${path} does not match pattern`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path} is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${path} has too few items`);
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size < value.length
    )
      errors.push(`${path} has duplicate items`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => {
        validate(schema.items as JsonSchema, item, root, `${path}[${index}]`, errors);
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === "string" && !(required in record))
        errors.push(`${path}.${required} is required`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) validate(properties[key], item, root, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        validate(schema.additionalProperties as JsonSchema, item, root, `${path}.${key}`, errors);
      if (schema.propertyNames && typeof schema.propertyNames === "object")
        validate(schema.propertyNames as JsonSchema, key, root, `${path} key`, errors);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter(
      (option) =>
        option &&
        typeof option === "object" &&
        validate(option as JsonSchema, value, root, path, []).length === 0,
    );
    if (matches.length === 0) errors.push(`${path} does not match anyOf`);
  }
  return errors;
}

const schemas = [corpusSchema, predictionSchema, scoreSchema, comparisonSchema] as JsonSchema[];

describe("public benchmark JSON Schema contracts", () => {
  it("is self-contained, strict at the root, and resolves every local reference", () => {
    for (const schema of schemas) {
      expect(schema.$id).toMatch(/^urn:opencoi:benchmark:/);
      expect(schema.additionalProperties).toBe(false);
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.$ref === "string")
          expect(() => resolvedReference(schema, record.$ref)).not.toThrow();
        Object.values(record).forEach(visit);
      };
      visit(schema);
    }
  });

  it("accepts the published artifacts and rejects a malicious score shape", () => {
    expect(validate(corpusSchema as JsonSchema, corpusDocument)).toEqual([]);
    expect(validate(predictionSchema as JsonSchema, predictionsDocument)).toEqual([]);
    expect(validate(scoreSchema as JsonSchema, scoreDocument)).toEqual([]);

    const malicious = {
      ...scoreDocument,
      facts: { ...scoreDocument.facts, truePositive: "many", f1: 99 },
      unexpected: "accepted by the old schema",
    };
    expect(validate(scoreSchema as JsonSchema, malicious)).toEqual(
      expect.arrayContaining([
        "$.facts.truePositive is not integer",
        "$.facts.f1 is above maximum",
        "$.unexpected is not allowed",
      ]),
    );
  });

  it("binds published and comparison artifacts to the canonical corpus checksum", () => {
    const corpus = corpusDocument as unknown as BenchmarkCorpusV1;
    const score = scoreDocument as unknown as BenchmarkScoreV1;
    const checksum = corpusSha256(corpus);
    const sidecar = readFileSync(
      fileURLToPath(new URL("./corpus/synthetic-text-v1.sha256", import.meta.url)),
      "utf8",
    ).trim();
    expect(sidecar).toBe(checksum);
    expect(predictionsDocument.corpusSha256).toBe(checksum);
    expect(score.corpusSha256).toBe(checksum);

    const comparison = compareBenchmarkScores(
      [score, { ...score, system: { id: "second", name: "Second", version: "test" } }],
      score.system.id,
    );
    expect(comparison.corpusSha256).toBe(checksum);
    expect(validate(comparisonSchema as JsonSchema, comparison)).toEqual([]);
  });
});
