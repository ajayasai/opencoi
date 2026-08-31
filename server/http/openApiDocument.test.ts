import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_VERSION, openApiDocument } from "./apiV1.js";

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);

const expectedScopes = {
  "GET /vendors": "vendors:read",
  "POST /vendors": "vendors:write",
  "GET /vendors/{vendorId}": "vendors:read",
  "PATCH /vendors/{vendorId}": "vendors:write",
  "GET /vendors/{vendorId}/compliance": "compliance:read",
  "POST /vendors/{vendorId}/certificates": "certificates:write",
  "GET /certificates/{certificateId}": "certificates:read",
  "GET /certificates/{certificateId}/evidence-bundle": "evidence:read",
  "GET /vendors/{vendorId}/certificate-requests": "requests:read",
  "POST /vendors/{vendorId}/certificate-requests": "requests:write",
  "GET /certificate-requests/{requestId}": "requests:read",
  "POST /certificate-requests/{requestId}/cancel": "requests:write",
  "GET /vendor-types": "requirements:read",
  "GET /events": "events:read",
} as const;

const strictSuccessSchemas = {
  "POST /vendors": "VendorMutationEnvelope",
  "PATCH /vendors/{vendorId}": "VendorMutationEnvelope",
  "GET /vendors/{vendorId}/compliance": "ComplianceEnvelope",
  "POST /vendors/{vendorId}/certificates": "CertificateSubmissionEnvelope",
  "GET /certificates/{certificateId}": "CertificateEnvelope",
  "GET /certificates/{certificateId}/evidence-bundle": "EvidenceBundle",
  "GET /vendors/{vendorId}/certificate-requests": "CertificateRequestPage",
  "POST /vendors/{vendorId}/certificate-requests": "CertificateRequestCreateEnvelope",
  "GET /certificate-requests/{requestId}": "CertificateRequestEnvelope",
  "POST /certificate-requests/{requestId}/cancel": "CertificateRequestCancellationEnvelope",
  "GET /vendor-types": "VendorTypePage",
} as const;

interface OperationContract {
  scope: string;
  responseCodes: string[];
  successHeaders: string[];
  successSchemaRef: string | null;
}

interface ContractProjection {
  version: string;
  componentHeaders: string[];
  operations: Record<string, OperationContract>;
}

const asObject = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an OpenAPI object");
  }
  return value as JsonObject;
};

const runtimeProjection = (input: unknown = openApiDocument): ContractProjection => {
  const document = asObject(input);
  const info = asObject(document.info);
  const components = asObject(document.components);
  const componentHeaders = Object.keys(asObject(components.headers)).sort();
  const operations: Record<string, OperationContract> = {};
  for (const [path, pathItemValue] of Object.entries(asObject(document.paths))) {
    const pathItem = asObject(pathItemValue);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = asObject(operationValue);
      const responses = asObject(operation.responses);
      const successCode = Object.keys(responses)
        .filter((code) => /^2\d\d$/.test(code))
        .sort()[0];
      if (!successCode)
        throw new TypeError(`${method.toUpperCase()} ${path} has no success response`);
      const success = asObject(responses[successCode]);
      const headers = success.headers ? Object.keys(asObject(success.headers)).sort() : [];
      const content = success.content ? asObject(success.content) : {};
      const jsonMediaType = content["application/json"]
        ? asObject(content["application/json"])
        : null;
      const schema = jsonMediaType?.schema ? asObject(jsonMediaType.schema) : null;
      operations[`${method.toUpperCase()} ${path}`] = {
        scope: String(operation["x-required-scope"] ?? ""),
        responseCodes: Object.keys(responses).sort(),
        successHeaders: headers,
        successSchemaRef: typeof schema?.$ref === "string" ? schema.$ref : null,
      };
    }
  }
  return {
    version: String(info.version),
    componentHeaders,
    operations: Object.fromEntries(
      Object.entries(operations).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
};

const yamlOperationProjection = (source: string): ContractProjection => {
  if (source.trimStart().startsWith("{")) {
    return runtimeProjection(JSON.parse(source));
  }
  const version = /^ {2}version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(source)?.[1];
  if (!version) throw new TypeError("The checked-in OpenAPI version is missing");
  const componentsStart = source.indexOf("\ncomponents:\n");
  if (componentsStart < 0) throw new TypeError("The checked-in OpenAPI components are missing");
  const pathsSource = source.slice(source.indexOf("\npaths:\n") + 7, componentsStart);
  const operationStarts = [...pathsSource.matchAll(/^ {4}(get|post|patch|put|delete):\s*$/gm)];
  const pathStarts = [...pathsSource.matchAll(/^ {2}(\/[^:]+):\s*$/gm)];
  const operations: Record<string, OperationContract> = {};

  for (const [index, match] of operationStarts.entries()) {
    const method = String(match[1]).toUpperCase();
    const start = match.index ?? 0;
    const end = operationStarts[index + 1]?.index ?? pathsSource.length;
    const path = pathStarts.filter((candidate) => (candidate.index ?? 0) < start).at(-1)?.[1];
    if (!path) throw new TypeError(`Could not identify the path for ${method}`);
    const chunk = pathsSource.slice(start, end);
    const scope = /^ {6}x-required-scope:\s*(\S+)\s*$/m.exec(chunk)?.[1];
    if (!scope) throw new TypeError(`${method} ${path} has no documented scope`);
    const responseStarts = [...chunk.matchAll(/^ {8}'(\d{3})':/gm)];
    const responseCodes = responseStarts.map((candidate) => String(candidate[1])).sort();
    const successStart = responseStarts.find((candidate) => /^2/.test(String(candidate[1])));
    if (!successStart) throw new TypeError(`${method} ${path} has no documented success response`);
    const successIndex = successStart.index ?? 0;
    const nextResponse = responseStarts.find((candidate) => (candidate.index ?? 0) > successIndex);
    const successChunk = chunk.slice(successIndex, nextResponse?.index ?? chunk.length);
    const headerBlock =
      /^ {10}headers:\s*$([\s\S]*?)(?=^ {10}\S|(?![\s\S]))/m.exec(successChunk)?.[1] ?? "";
    const successHeaders = [...headerBlock.matchAll(/^ {12}([A-Za-z0-9-]+):/gm)]
      .map((candidate) => String(candidate[1]))
      .sort();
    const successSchemaRef =
      /schema:\s*\{\s*\$ref:\s*['"]([^'"]+)['"]\s*\}/.exec(successChunk)?.[1] ?? null;
    operations[`${method} ${path}`] = {
      scope,
      responseCodes,
      successHeaders,
      successSchemaRef,
    };
  }

  const componentSource = source.slice(componentsStart);
  const headersChunk = /^ {2}headers:\s*$([\s\S]*?)(?=^ {2}responses:)/m.exec(componentSource)?.[1];
  if (!headersChunk) throw new TypeError("The checked-in component headers are missing");
  const componentHeaders = [...headersChunk.matchAll(/^ {4}([A-Za-z0-9]+):\s*$/gm)]
    .map((candidate) => String(candidate[1]))
    .sort();
  return {
    version,
    componentHeaders,
    operations: Object.fromEntries(
      Object.entries(operations).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
};

const resolveLocalReference = (root: JsonObject, reference: string): unknown => {
  if (!reference.startsWith("#/")) throw new TypeError(`Not a local reference: ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) => asObject(value)[part], root);
};

describe("runtime OpenAPI contract", () => {
  it("requires the exact least-privilege scope on every protected operation", () => {
    const projection = runtimeProjection();
    expect(
      Object.fromEntries(
        Object.entries(projection.operations).map(([key, value]) => [key, value.scope]),
      ),
    ).toEqual(expectedScopes);
  });

  it("uses named strict response components for certificates, requests, evidence, and compliance", () => {
    const projection = runtimeProjection();
    const schemas = openApiDocument.components.schemas as unknown as Record<string, JsonObject>;
    for (const [operation, schemaName] of Object.entries(strictSuccessSchemas)) {
      expect(projection.operations[operation]?.successSchemaRef).toBe(
        `#/components/schemas/${schemaName}`,
      );
      expect(schemas[schemaName]).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("documents retry semantics for bounded certificate-upload capacity", () => {
    const responses = openApiDocument.paths["/vendors/{vendorId}/certificates"].post.responses;
    expect(responses["503"]).toEqual({
      $ref: "#/components/responses/UploadCapacityProblem",
    });
    expect(openApiDocument.components.responses.UploadCapacityProblem.headers).toHaveProperty(
      "Retry-After",
    );
  });

  it("documents the conditional certificate-read scope for renewal sources", () => {
    const operation = openApiDocument.paths["/vendors/{vendorId}/certificate-requests"].post;
    expect(operation["x-required-scope"]).toBe("requests:write");
    expect(operation["x-conditional-scopes"]).toEqual({
      sourceCertificateId: "certificates:read",
    });
  });

  it("has no dangling local references or unrestricted additionalProperties placeholders", () => {
    const root = openApiDocument as unknown as JsonObject;
    const dangling: string[] = [];
    const unrestricted: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          visit(entry, `${path}[${index}]`);
        });
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as JsonObject;
      if (record.additionalProperties === true) unrestricted.push(path);
      if (typeof record.$ref === "string") {
        try {
          expect(resolveLocalReference(root, record.$ref)).toBeDefined();
        } catch {
          dangling.push(record.$ref);
        }
      }
      for (const [key, entry] of Object.entries(record)) visit(entry, `${path}.${key}`);
    };
    visit(root, "$");
    expect(dangling).toEqual([]);
    expect(unrestricted).toEqual([]);
  });

  it("deep-matches the checked-in route, response, scope, header, and version contract", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../docs/api/openapi-v1.yaml", import.meta.url)),
      "utf8",
    );
    const checkedIn = yamlOperationProjection(source);
    expect(runtimeProjection()).toEqual(checkedIn);
    expect(checkedIn.version).toBe(API_VERSION);
  });

  it("deep-matches every checked-in OpenAPI field and schema", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../docs/api/openapi-v1.yaml", import.meta.url)),
      "utf8",
    );
    expect(JSON.parse(source)).toEqual(openApiDocument);
  });
});
