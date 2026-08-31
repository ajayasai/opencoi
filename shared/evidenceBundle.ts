export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "1.0" as const;
export const EVIDENCE_BUNDLE_CANONICALIZATION = "OPENCOI_CANONICAL_JSON_V1" as const;
export const EVIDENCE_BUNDLE_DIGEST_ALGORITHM = "SHA-256" as const;
export const EVIDENCE_BUNDLE_SIGNATURE_ALGORITHM = "Ed25519" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };
export type CanonicalJsonObject = { [key: string]: CanonicalJsonValue };

export interface UnsignedEvidenceBundle<TPayload = CanonicalJsonObject> {
  schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  exportedAt: string;
  payload: TPayload;
}

export interface EvidenceBundleEnvelope<TPayload = CanonicalJsonObject>
  extends UnsignedEvidenceBundle<TPayload> {
  integrity: {
    canonicalization: typeof EVIDENCE_BUNDLE_CANONICALIZATION;
    digest: {
      algorithm: typeof EVIDENCE_BUNDLE_DIGEST_ALGORITHM;
      /** Lowercase hexadecimal SHA-256 of the UTF-8 canonical unsigned bundle. */
      value: string;
    };
    signature: {
      algorithm: typeof EVIDENCE_BUNDLE_SIGNATURE_ALGORITHM;
      /**
       * Human-readable key label. This legacy v1 metadata is intentionally not
       * part of the canonical signed record; never use it to establish identity.
       */
      keyId: string;
      /** Base64url, without padding, of the DER SubjectPublicKeyInfo bytes. */
      publicKeySpki: string;
      /** Lowercase hexadecimal SHA-256 of the DER SubjectPublicKeyInfo bytes. */
      publicKeyFingerprint: string;
      /** Base64url, without padding, of the 64-byte Ed25519 signature. */
      value: string;
    };
  };
}

export type EvidenceBundleVerificationErrorCode =
  | "DIGEST_MISMATCH"
  | "PUBLIC_KEY_FINGERPRINT_MISMATCH"
  | "INVALID_ED25519_PUBLIC_KEY"
  | "SIGNATURE_MISMATCH";

export interface EvidenceBundleVerificationError {
  code: EvidenceBundleVerificationErrorCode;
  message: string;
}

export interface EvidenceBundleVerification {
  valid: boolean;
  digestValid: boolean;
  publicKeyFingerprintValid: boolean;
  signatureChecked: boolean;
  signatureValid: boolean;
  errors: EvidenceBundleVerificationError[];
}

const canonicalize = (value: unknown, ancestors: Set<object>): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON cannot contain a circular reference");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
        throw new TypeError("Canonical JSON arrays cannot be sparse or have extra properties");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON arrays cannot be sparse or have extra properties");
        }
      }
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new TypeError("Canonical JSON objects cannot have symbol properties");
    }
    return `{${keys
      .map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("Canonical JSON objects require enumerable data properties");
        }
        return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * OpenCOI canonical JSON v1. Object keys are sorted by UTF-16 code units,
 * array order is retained, and primitive encoding follows JSON.stringify.
 * Values outside the JSON data model are rejected rather than silently lost.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new Set());
}

/** Select the only fields covered by an evidence-bundle digest and signature. */
export function unsignedEvidenceBundle<TPayload>(
  envelope: Pick<UnsignedEvidenceBundle<TPayload>, "schemaVersion" | "exportedAt" | "payload">,
): UnsignedEvidenceBundle<TPayload> {
  return {
    schemaVersion: envelope.schemaVersion,
    exportedAt: envelope.exportedAt,
    payload: envelope.payload,
  };
}

const assertPlainRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${label} must contain exactly: ${sortedExpected.join(", ")}`);
  }
};

const decodeCanonicalBase64Url = (
  value: unknown,
  label: string,
  expectedByteLength?: number,
): Uint8Array<ArrayBuffer> => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8192 ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be unpadded base64url`);
  }
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
    decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      decoded[index] = binary.charCodeAt(index);
    }
  } catch {
    throw new TypeError(`${label} must be unpadded base64url`);
  }
  const canonical = btoa(String.fromCharCode(...decoded))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  if (canonical !== value) {
    throw new TypeError(`${label} must use canonical unpadded base64url encoding`);
  }
  if (expectedByteLength !== undefined && decoded.byteLength !== expectedByteLength) {
    throw new TypeError(`${label} must encode exactly ${expectedByteLength} bytes`);
  }
  return decoded;
};

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters`);
  }
}

const assertString: (
  value: unknown,
  label: string,
  options?: { minLength?: number; maxLength?: number },
) => asserts value is string = (value, label, options = {}) => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const length = [...value].length;
  if (options.minLength !== undefined && length < options.minLength) {
    throw new TypeError(`${label} must contain at least ${options.minLength} character(s)`);
  }
  if (options.maxLength !== undefined && length > options.maxLength) {
    throw new TypeError(`${label} must contain at most ${options.maxLength} character(s)`);
  }
};

const assertNullableString = (value: unknown, label: string): void => {
  if (value !== null) assertString(value, label);
};

const assertInteger: (
  value: unknown,
  label: string,
  options?: { minimum?: number; maximum?: number },
) => asserts value is number = (value, label, options = {}) => {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  const integer = value as number;
  if (options.minimum !== undefined && integer < options.minimum) {
    throw new TypeError(`${label} must be at least ${options.minimum}`);
  }
  if (options.maximum !== undefined && integer > options.maximum) {
    throw new TypeError(`${label} must be at most ${options.maximum}`);
  }
};

const assertArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
};

const assertBoolean: (value: unknown, label: string) => asserts value is boolean = (
  value,
  label,
) => {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
};

const assertInstant: (value: unknown, label: string) => asserts value is string = (
  value,
  label,
) => {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an exact UTC ISO instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be an exact UTC ISO instant`);
  }
};

const assertNullableInstant = (value: unknown, label: string): void => {
  if (value !== null) assertInstant(value, label);
};

const assertDate: (value: unknown, label: string) => asserts value is string = (value, label) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${label} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} must be an ISO calendar date`);
  }
};

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

const assertIdentity = (
  value: unknown,
  label: string,
  options: { nullableName?: boolean } = {},
): Record<string, unknown> => {
  const identity = assertPlainRecord(value, label);
  assertExactKeys(identity, ["id", "name"], label);
  assertString(identity.id, `${label}.id`, { minLength: 1 });
  if (options.nullableName) assertNullableString(identity.name, `${label}.name`);
  else assertString(identity.name, `${label}.name`);
  return identity;
};

const assertNullableIdentity = (
  value: unknown,
  label: string,
  options: { nullableName?: boolean } = {},
): Record<string, unknown> | null => {
  if (value === null) return null;
  return assertIdentity(value, label, options);
};

const assertExtractionCitation = (value: unknown, label: string): Record<string, unknown> => {
  const citation = assertPlainRecord(value, label);
  assertExactKeys(
    citation,
    [
      "kind",
      "field",
      "extractedValue",
      "policyIndex",
      "endorsementIndex",
      "limitType",
      "confidenceBps",
      "rawText",
      "page",
      "origin",
      "attestationStatus",
    ],
    label,
  );
  if (citation.kind !== "extraction_citation") {
    throw new TypeError(`${label}.kind must be extraction_citation`);
  }
  assertString(citation.field, `${label}.field`, { minLength: 1 });
  if (typeof citation.extractedValue !== "string" && typeof citation.extractedValue !== "number") {
    throw new TypeError(`${label}.extractedValue must be a string or number`);
  }
  if (typeof citation.extractedValue === "number" && !Number.isFinite(citation.extractedValue)) {
    throw new TypeError(`${label}.extractedValue must be finite`);
  }
  if (citation.policyIndex !== null) {
    assertInteger(citation.policyIndex, `${label}.policyIndex`, { minimum: 0 });
  }
  if (citation.endorsementIndex !== null) {
    assertInteger(citation.endorsementIndex, `${label}.endorsementIndex`, { minimum: 0 });
  }
  assertNullableString(citation.limitType, `${label}.limitType`);
  if (citation.confidenceBps !== null) {
    assertInteger(citation.confidenceBps, `${label}.confidenceBps`, {
      minimum: 0,
      maximum: 10_000,
    });
  }
  assertString(citation.rawText, `${label}.rawText`, { minLength: 1 });
  assertInteger(citation.page, `${label}.page`, { minimum: 1, maximum: 100 });
  if (citation.origin !== "client_submitted_extraction") {
    throw new TypeError(`${label}.origin must be client_submitted_extraction`);
  }
  assertEnum(
    citation.attestationStatus,
    ["unverified", "reviewer_attested"] as const,
    `${label}.attestationStatus`,
  );
  return citation;
};

const ENDORSEMENT_EVIDENCE_LEVELS = [
  "NONE",
  "MENTIONED",
  "SCHEDULED",
  "ATTACHED",
  "HUMAN_VERIFIED",
] as const;

const assertEndorsementPageAttestation = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  const attestation = assertPlainRecord(value, label);
  assertExactKeys(
    attestation,
    [
      "kind",
      "policyIndex",
      "endorsementIndex",
      "endorsementName",
      "formCode",
      "evidenceLevel",
      "sourcePages",
      "sourceDocumentSha256",
      "origin",
      "attestationStatus",
      "attestedByUserId",
      "attestedAt",
    ],
    label,
  );
  if (attestation.kind !== "endorsement_page_attestation") {
    throw new TypeError(`${label}.kind must be endorsement_page_attestation`);
  }
  assertInteger(attestation.policyIndex, `${label}.policyIndex`, { minimum: 0, maximum: 49 });
  assertInteger(attestation.endorsementIndex, `${label}.endorsementIndex`, {
    minimum: 0,
    maximum: 99,
  });
  assertString(attestation.endorsementName, `${label}.endorsementName`, {
    minLength: 1,
    maxLength: 300,
  });
  if (attestation.formCode !== null) {
    assertString(attestation.formCode, `${label}.formCode`, { maxLength: 100 });
  }
  assertEnum(attestation.evidenceLevel, ENDORSEMENT_EVIDENCE_LEVELS, `${label}.evidenceLevel`);
  const pages = assertArray(attestation.sourcePages, `${label}.sourcePages`);
  if (pages.length < 1 || pages.length > 100) {
    throw new TypeError(`${label}.sourcePages must contain between 1 and 100 pages`);
  }
  pages.forEach((page, index) => {
    assertInteger(page, `${label}.sourcePages[${index}]`, { minimum: 1, maximum: 100 });
    if (index > 0 && (pages[index - 1] as number) >= page) {
      throw new TypeError(`${label}.sourcePages must be unique and strictly increasing`);
    }
  });
  assertSha256(attestation.sourceDocumentSha256, `${label}.sourceDocumentSha256`);
  if (attestation.origin !== "submitted_endorsement_page_reference") {
    throw new TypeError(`${label}.origin must be submitted_endorsement_page_reference`);
  }
  if (attestation.attestationStatus !== "reviewer_attested") {
    throw new TypeError(`${label}.attestationStatus must be reviewer_attested`);
  }
  assertString(attestation.attestedByUserId, `${label}.attestedByUserId`, { minLength: 1 });
  assertInstant(attestation.attestedAt, `${label}.attestedAt`);
  return attestation;
};

const assertEvidenceReview = (value: unknown): Record<string, unknown> => {
  const review = assertPlainRecord(value, "Evidence bundle payload.review");
  assertExactKeys(
    review,
    [
      "status",
      "reviewedBy",
      "reviewedAt",
      "evaluationDate",
      "requirementVersion",
      "evaluationVendorType",
    ],
    "Evidence bundle payload.review",
  );
  assertEnum(
    review.status,
    ["draft", "confirmed", "superseded", "rejected"] as const,
    "Evidence bundle payload.review.status",
  );
  assertNullableIdentity(review.reviewedBy, "Evidence bundle payload.review.reviewedBy", {
    nullableName: true,
  });
  assertNullableInstant(review.reviewedAt, "Evidence bundle payload.review.reviewedAt");
  if (review.evaluationDate !== null) {
    assertDate(review.evaluationDate, "Evidence bundle payload.review.evaluationDate");
  }
  if (review.requirementVersion !== null) {
    assertInteger(review.requirementVersion, "Evidence bundle payload.review.requirementVersion", {
      minimum: 1,
    });
  }
  assertNullableIdentity(
    review.evaluationVendorType,
    "Evidence bundle payload.review.evaluationVendorType",
  );
  return review;
};

const assertConfirmedFacts = (value: unknown): Record<string, unknown> | null => {
  if (value === null) return null;
  const facts = assertPlainRecord(value, "Evidence bundle payload.confirmedFacts");
  assertExactKeys(
    facts,
    ["namedInsured", "issueDate", "producer", "certificateHolder", "policies"],
    "Evidence bundle payload.confirmedFacts",
  );
  assertNullableString(facts.namedInsured, "Evidence bundle payload.confirmedFacts.namedInsured");
  assertNullableString(facts.issueDate, "Evidence bundle payload.confirmedFacts.issueDate");
  assertNullableString(facts.producer, "Evidence bundle payload.confirmedFacts.producer");
  assertNullableString(
    facts.certificateHolder,
    "Evidence bundle payload.confirmedFacts.certificateHolder",
  );
  assertArray(facts.policies, "Evidence bundle payload.confirmedFacts.policies");
  return facts;
};

const assertRequirementSnapshot = (value: unknown): Record<string, unknown> | null => {
  if (value === null) return null;
  const snapshot = assertPlainRecord(value, "Evidence bundle payload.requirementSnapshot");
  assertExactKeys(
    snapshot,
    ["version", "vendorType", "evaluatedRuleset", "publication"],
    "Evidence bundle payload.requirementSnapshot",
  );
  assertInteger(snapshot.version, "Evidence bundle payload.requirementSnapshot.version", {
    minimum: 1,
  });
  assertIdentity(snapshot.vendorType, "Evidence bundle payload.requirementSnapshot.vendorType");
  assertPlainRecord(
    snapshot.evaluatedRuleset,
    "Evidence bundle payload.requirementSnapshot.evaluatedRuleset",
  );
  if (snapshot.publication !== null) {
    const publication = assertPlainRecord(
      snapshot.publication,
      "Evidence bundle payload.requirementSnapshot.publication",
    );
    assertExactKeys(
      publication,
      ["id", "publishedAt", "publishedBy", "requirements"],
      "Evidence bundle payload.requirementSnapshot.publication",
    );
    assertString(publication.id, "Evidence bundle payload.requirementSnapshot.publication.id", {
      minLength: 1,
    });
    assertInstant(
      publication.publishedAt,
      "Evidence bundle payload.requirementSnapshot.publication.publishedAt",
    );
    assertNullableIdentity(
      publication.publishedBy,
      "Evidence bundle payload.requirementSnapshot.publication.publishedBy",
    );
    assertArray(
      publication.requirements,
      "Evidence bundle payload.requirementSnapshot.publication.requirements",
    );
  }
  return snapshot;
};

const assertFinding = (value: unknown, index: number): Record<string, unknown> => {
  const label = `Evidence bundle payload.findings[${index}]`;
  const finding = assertPlainRecord(value, label);
  assertExactKeys(
    finding,
    [
      "id",
      "requirementId",
      "category",
      "outcome",
      "code",
      "severity",
      "coverageType",
      "title",
      "message",
      "expected",
      "observed",
      "evidenceIds",
      "evaluatedAt",
    ],
    label,
  );
  assertString(finding.id, `${label}.id`, { minLength: 1 });
  assertNullableString(finding.requirementId, `${label}.requirementId`);
  assertString(finding.category, `${label}.category`);
  assertString(finding.outcome, `${label}.outcome`);
  assertString(finding.code, `${label}.code`);
  assertString(finding.severity, `${label}.severity`);
  assertNullableString(finding.coverageType, `${label}.coverageType`);
  assertNullableString(finding.title, `${label}.title`);
  assertString(finding.message, `${label}.message`);
  const evidenceIds = assertArray(finding.evidenceIds, `${label}.evidenceIds`);
  evidenceIds.forEach((id, evidenceIndex) => {
    assertString(id, `${label}.evidenceIds[${evidenceIndex}]`);
  });
  assertInstant(finding.evaluatedAt, `${label}.evaluatedAt`);
  return finding;
};

const assertException = (value: unknown, index: number): Record<string, unknown> => {
  const label = `Evidence bundle payload.exceptions[${index}]`;
  const exception = assertPlainRecord(value, label);
  assertExactKeys(
    exception,
    [
      "id",
      "findingId",
      "status",
      "request",
      "decisionReason",
      "requestedBy",
      "requestedAt",
      "decidedBy",
      "decidedAt",
      "expiresAt",
    ],
    label,
  );
  assertString(exception.id, `${label}.id`, { minLength: 1 });
  assertString(exception.findingId, `${label}.findingId`, { minLength: 1 });
  assertEnum(
    exception.status,
    ["pending", "approved", "rejected", "revoked", "expired"] as const,
    `${label}.status`,
  );
  assertNullableString(exception.decisionReason, `${label}.decisionReason`);
  assertIdentity(exception.requestedBy, `${label}.requestedBy`);
  assertInstant(exception.requestedAt, `${label}.requestedAt`);
  assertNullableIdentity(exception.decidedBy, `${label}.decidedBy`);
  assertNullableInstant(exception.decidedAt, `${label}.decidedAt`);
  if (exception.expiresAt !== null) assertDate(exception.expiresAt, `${label}.expiresAt`);
  const hasDecider = exception.decidedBy !== null;
  const hasDecisionTime = exception.decidedAt !== null;
  if (hasDecider !== hasDecisionTime) {
    throw new TypeError(
      `${label}.decidedBy and ${label}.decidedAt must both be null or both be set`,
    );
  }
  if (exception.status === "pending" && hasDecider) {
    throw new TypeError(`${label} cannot contain decision metadata while status is pending`);
  }
  if (["approved", "rejected", "revoked"].includes(exception.status as string) && !hasDecider) {
    throw new TypeError(`${label} must contain decision metadata for status ${exception.status}`);
  }
  return exception;
};

const assertAudit = (value: unknown): Record<string, unknown> => {
  const audit = assertPlainRecord(value, "Evidence bundle payload.audit");
  assertExactKeys(
    audit,
    ["organizationChainVerifiedAtExport", "checkedEvents", "error", "head", "certificateEvents"],
    "Evidence bundle payload.audit",
  );
  assertBoolean(
    audit.organizationChainVerifiedAtExport,
    "Evidence bundle payload.audit.organizationChainVerifiedAtExport",
  );
  assertInteger(audit.checkedEvents, "Evidence bundle payload.audit.checkedEvents", { minimum: 0 });
  assertNullableString(audit.error, "Evidence bundle payload.audit.error");
  let head: Record<string, unknown> | null = null;
  if (audit.head !== null) {
    head = assertPlainRecord(audit.head, "Evidence bundle payload.audit.head");
    assertExactKeys(
      head,
      ["sequence", "eventHash", "occurredAt"],
      "Evidence bundle payload.audit.head",
    );
    assertInteger(head.sequence, "Evidence bundle payload.audit.head.sequence", { minimum: 1 });
    assertSha256(head.eventHash, "Evidence bundle payload.audit.head.eventHash");
    assertInstant(head.occurredAt, "Evidence bundle payload.audit.head.occurredAt");
  }
  const events = assertArray(
    audit.certificateEvents,
    "Evidence bundle payload.audit.certificateEvents",
  );
  let previousSequence = 0;
  events.forEach((value, index) => {
    const label = `Evidence bundle payload.audit.certificateEvents[${index}]`;
    const event = assertPlainRecord(value, label);
    assertExactKeys(
      event,
      [
        "sequence",
        "id",
        "actorType",
        "actorUserId",
        "action",
        "entityType",
        "entityId",
        "occurredAt",
        "metadata",
        "previousHash",
        "eventHash",
      ],
      label,
    );
    assertInteger(event.sequence, `${label}.sequence`, { minimum: 1 });
    if ((event.sequence as number) <= previousSequence) {
      throw new TypeError(
        "Evidence bundle payload.audit.certificateEvents must be ordered by sequence",
      );
    }
    previousSequence = event.sequence as number;
    assertString(event.id, `${label}.id`, { minLength: 1 });
    assertString(event.actorType, `${label}.actorType`);
    assertNullableString(event.actorUserId, `${label}.actorUserId`);
    assertString(event.action, `${label}.action`);
    assertString(event.entityType, `${label}.entityType`);
    assertNullableString(event.entityId, `${label}.entityId`);
    assertInstant(event.occurredAt, `${label}.occurredAt`);
    assertSha256(event.previousHash, `${label}.previousHash`);
    assertSha256(event.eventHash, `${label}.eventHash`);
  });
  if (audit.organizationChainVerifiedAtExport === true && audit.error !== null) {
    throw new TypeError("Evidence bundle payload.audit.error must be null for a verified chain");
  }
  if (audit.organizationChainVerifiedAtExport === false && audit.error === null) {
    throw new TypeError("Evidence bundle payload.audit.error must describe an unverified chain");
  }
  if (audit.organizationChainVerifiedAtExport === true) {
    if (audit.checkedEvents === 0 && head !== null) {
      throw new TypeError(
        "Evidence bundle payload.audit.head must be null when checkedEvents is zero",
      );
    }
    if (audit.checkedEvents !== 0 && (head === null || head.sequence !== audit.checkedEvents)) {
      throw new TypeError("Evidence bundle payload.audit.head.sequence must equal checkedEvents");
    }
  }
  return audit;
};

/**
 * Strict runtime validation for every field in the published v1 payload plus
 * invariants that JSON Schema cannot express clearly.
 */
export function assertEvidenceBundlePayload(
  value: unknown,
  exportedAt?: string,
): asserts value is CanonicalJsonObject {
  canonicalizeJson(value);
  const payload = assertPlainRecord(value, "Evidence bundle payload");
  assertExactKeys(
    payload,
    [
      "generator",
      "scope",
      "exportedBy",
      "sourceDocument",
      "review",
      "machineProposal",
      "confirmedFacts",
      "evidence",
      "requirementSnapshot",
      "findings",
      "exceptions",
      "statusAtExport",
      "audit",
    ],
    "Evidence bundle payload",
  );

  const generator = assertPlainRecord(payload.generator, "Evidence bundle payload.generator");
  assertExactKeys(generator, ["name", "version", "origin"], "Evidence bundle payload.generator");
  if (generator.name !== "OpenCOI") {
    throw new TypeError("Evidence bundle payload.generator.name must be OpenCOI");
  }
  assertString(generator.version, "Evidence bundle payload.generator.version", { minLength: 1 });
  assertString(generator.origin, "Evidence bundle payload.generator.origin", { minLength: 1 });

  const scope = assertPlainRecord(payload.scope, "Evidence bundle payload.scope");
  assertExactKeys(
    scope,
    ["organization", "vendor", "certificateId"],
    "Evidence bundle payload.scope",
  );
  assertIdentity(scope.organization, "Evidence bundle payload.scope.organization");
  const vendor = assertPlainRecord(scope.vendor, "Evidence bundle payload.scope.vendor");
  assertExactKeys(
    vendor,
    ["id", "legalName", "vendorTypeAtExport"],
    "Evidence bundle payload.scope.vendor",
  );
  assertString(vendor.id, "Evidence bundle payload.scope.vendor.id", { minLength: 1 });
  assertString(vendor.legalName, "Evidence bundle payload.scope.vendor.legalName");
  assertIdentity(
    vendor.vendorTypeAtExport,
    "Evidence bundle payload.scope.vendor.vendorTypeAtExport",
  );
  assertString(scope.certificateId, "Evidence bundle payload.scope.certificateId", {
    minLength: 1,
  });
  assertIdentity(payload.exportedBy, "Evidence bundle payload.exportedBy");

  const sourceDocument = assertPlainRecord(
    payload.sourceDocument,
    "Evidence bundle payload.sourceDocument",
  );
  assertExactKeys(
    sourceDocument,
    ["id", "originalFilename", "mimeType", "byteSize", "sha256", "uploadedAt"],
    "Evidence bundle payload.sourceDocument",
  );
  assertString(sourceDocument.id, "Evidence bundle payload.sourceDocument.id", { minLength: 1 });
  assertString(
    sourceDocument.originalFilename,
    "Evidence bundle payload.sourceDocument.originalFilename",
  );
  if (sourceDocument.mimeType !== "application/pdf") {
    throw new TypeError("Evidence bundle payload.sourceDocument.mimeType must be application/pdf");
  }
  assertInteger(sourceDocument.byteSize, "Evidence bundle payload.sourceDocument.byteSize", {
    minimum: 1,
  });
  assertSha256(sourceDocument.sha256, "Evidence bundle payload.sourceDocument.sha256");
  assertInstant(sourceDocument.uploadedAt, "Evidence bundle payload.sourceDocument.uploadedAt");

  const review = assertEvidenceReview(payload.review);
  if (payload.machineProposal !== null) {
    assertPlainRecord(payload.machineProposal, "Evidence bundle payload.machineProposal");
  }
  const confirmedFacts = assertConfirmedFacts(payload.confirmedFacts);

  const evidence = assertArray(payload.evidence, "Evidence bundle payload.evidence").map(
    (item, index) => {
      const record = assertPlainRecord(item, `Evidence bundle payload.evidence[${index}]`);
      if (record.kind === "extraction_citation") {
        return assertExtractionCitation(item, `Evidence bundle payload.evidence[${index}]`);
      }
      if (record.kind === "endorsement_page_attestation") {
        return assertEndorsementPageAttestation(item, `Evidence bundle payload.evidence[${index}]`);
      }
      throw new TypeError(
        `Evidence bundle payload.evidence[${index}].kind must identify a supported evidence record`,
      );
    },
  );
  const requirementSnapshot = assertRequirementSnapshot(payload.requirementSnapshot);
  const findings = assertArray(payload.findings, "Evidence bundle payload.findings").map(
    assertFinding,
  );
  const exceptions = assertArray(payload.exceptions, "Evidence bundle payload.exceptions").map(
    assertException,
  );

  const status = assertPlainRecord(
    payload.statusAtExport,
    "Evidence bundle payload.statusAtExport",
  );
  assertExactKeys(
    status,
    ["documentCheck", "documentLifecycle", "asOf", "limitation"],
    "Evidence bundle payload.statusAtExport",
  );
  assertEnum(
    status.documentCheck,
    ["meets", "deficient", "needs_review", "approved_exception", "not_submitted"] as const,
    "Evidence bundle payload.statusAtExport.documentCheck",
  );
  assertEnum(
    status.documentLifecycle,
    ["current", "expiring", "expired", "future", "unknown"] as const,
    "Evidence bundle payload.statusAtExport.documentLifecycle",
  );
  assertInstant(status.asOf, "Evidence bundle payload.statusAtExport.asOf");
  assertString(status.limitation, "Evidence bundle payload.statusAtExport.limitation", {
    minLength: 1,
  });
  assertAudit(payload.audit);

  const humanConfirmed = review.status === "confirmed" || review.status === "superseded";
  if (humanConfirmed !== (confirmedFacts !== null)) {
    throw new TypeError(
      "Evidence bundle payload.confirmedFacts must be present exactly for confirmed or superseded reviews",
    );
  }
  const hasReviewer = review.reviewedBy !== null;
  const hasReviewTime = review.reviewedAt !== null;
  if (hasReviewer !== hasReviewTime) {
    throw new TypeError(
      "Evidence bundle payload.review.reviewedBy and reviewedAt must both be null or both be set",
    );
  }
  for (const item of evidence) {
    if (item.kind === "extraction_citation" && item.attestationStatus === "reviewer_attested") {
      if (!humanConfirmed || !hasReviewer) {
        throw new TypeError(
          "Reviewer-attested extraction citations require a confirmed review with reviewer identity and time",
        );
      }
    }
    if (item.kind === "endorsement_page_attestation") {
      if (!humanConfirmed || !hasReviewer) {
        throw new TypeError(
          "Endorsement page attestations require a confirmed review with reviewer identity and time",
        );
      }
      if (item.sourceDocumentSha256 !== sourceDocument.sha256) {
        throw new TypeError(
          "Endorsement page attestation sourceDocumentSha256 must equal payload.sourceDocument.sha256",
        );
      }
      const reviewer = review.reviewedBy as Record<string, unknown>;
      if (item.attestedByUserId !== reviewer.id || item.attestedAt !== review.reviewedAt) {
        throw new TypeError(
          "Endorsement page attestation reviewer and time must match payload.review",
        );
      }
      const policies = (confirmedFacts as Record<string, unknown>).policies as unknown[];
      const policy = policies[item.policyIndex as number];
      if (policy === undefined) {
        throw new TypeError(
          "Endorsement page attestation policyIndex must reference payload.confirmedFacts.policies",
        );
      }
      const policyRecord = assertPlainRecord(
        policy,
        `Evidence bundle payload.confirmedFacts.policies[${item.policyIndex}]`,
      );
      const endorsements = assertArray(
        policyRecord.endorsements,
        `Evidence bundle payload.confirmedFacts.policies[${item.policyIndex}].endorsements`,
      );
      const endorsement = endorsements[item.endorsementIndex as number];
      if (endorsement === undefined) {
        throw new TypeError(
          "Endorsement page attestation endorsementIndex must reference the signed confirmed policy",
        );
      }
      const endorsementRecord = assertPlainRecord(
        endorsement,
        `Evidence bundle payload.confirmedFacts.policies[${item.policyIndex}].endorsements[${item.endorsementIndex}]`,
      );
      const confirmedSourcePages = assertArray(
        endorsementRecord.sourcePages,
        "Referenced confirmed endorsement sourcePages",
      );
      const attestedSourcePages = item.sourcePages as unknown[];
      if (
        endorsementRecord.name !== item.endorsementName ||
        (endorsementRecord.formCode ?? null) !== item.formCode ||
        endorsementRecord.evidenceLevel !== item.evidenceLevel ||
        confirmedSourcePages.length !== attestedSourcePages.length ||
        confirmedSourcePages.some((page, index) => page !== attestedSourcePages[index])
      ) {
        throw new TypeError(
          "Endorsement page attestation must exactly match the referenced signed confirmed endorsement",
        );
      }
    }
  }
  if (requirementSnapshot !== null) {
    if (review.requirementVersion !== requirementSnapshot.version) {
      throw new TypeError(
        "Evidence bundle payload.requirementSnapshot.version must match review.requirementVersion",
      );
    }
    const evaluationVendorType = review.evaluationVendorType as Record<string, unknown> | null;
    const snapshotVendorType = requirementSnapshot.vendorType as Record<string, unknown>;
    if (
      evaluationVendorType === null ||
      evaluationVendorType.id !== snapshotVendorType.id ||
      evaluationVendorType.name !== snapshotVendorType.name
    ) {
      throw new TypeError(
        "Evidence bundle payload.requirementSnapshot.vendorType must match review.evaluationVendorType",
      );
    }
  }
  const findingIds = new Set<string>();
  for (const finding of findings) {
    const findingId = finding.id as string;
    if (findingIds.has(findingId)) {
      throw new TypeError("Evidence bundle payload.findings must use unique IDs");
    }
    findingIds.add(findingId);
  }
  const exceptionIds = new Set<string>();
  for (const exception of exceptions) {
    const exceptionId = exception.id as string;
    if (exceptionIds.has(exceptionId)) {
      throw new TypeError("Evidence bundle payload.exceptions must use unique IDs");
    }
    exceptionIds.add(exceptionId);
    if (!findingIds.has(exception.findingId as string)) {
      throw new TypeError(
        `Evidence bundle payload exception ${exceptionId} references an unknown finding`,
      );
    }
  }
  if (exportedAt !== undefined && status.asOf !== exportedAt) {
    throw new TypeError("Evidence bundle payload.statusAtExport.asOf must equal exportedAt");
  }
}

/** Strictly validate the versioned envelope before performing cryptography. */
export function assertEvidenceBundleEnvelope(
  value: unknown,
): asserts value is EvidenceBundleEnvelope {
  const envelope = assertPlainRecord(value, "Evidence bundle");
  assertExactKeys(
    envelope,
    ["schemaVersion", "exportedAt", "payload", "integrity"],
    "Evidence bundle",
  );
  if (envelope.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    throw new TypeError(`Evidence bundle schemaVersion must be ${EVIDENCE_BUNDLE_SCHEMA_VERSION}`);
  }
  assertInstant(envelope.exportedAt, "Evidence bundle exportedAt");
  assertEvidenceBundlePayload(envelope.payload, envelope.exportedAt);

  const integrity = assertPlainRecord(envelope.integrity, "Evidence bundle integrity");
  assertExactKeys(
    integrity,
    ["canonicalization", "digest", "signature"],
    "Evidence bundle integrity",
  );
  if (integrity.canonicalization !== EVIDENCE_BUNDLE_CANONICALIZATION) {
    throw new TypeError(
      `Evidence bundle canonicalization must be ${EVIDENCE_BUNDLE_CANONICALIZATION}`,
    );
  }

  const digest = assertPlainRecord(integrity.digest, "Evidence bundle digest");
  assertExactKeys(digest, ["algorithm", "value"], "Evidence bundle digest");
  if (digest.algorithm !== EVIDENCE_BUNDLE_DIGEST_ALGORITHM) {
    throw new TypeError(
      `Evidence bundle digest algorithm must be ${EVIDENCE_BUNDLE_DIGEST_ALGORITHM}`,
    );
  }
  assertSha256(digest.value, "Evidence bundle digest value");

  const signature = assertPlainRecord(integrity.signature, "Evidence bundle signature");
  assertExactKeys(
    signature,
    ["algorithm", "keyId", "publicKeySpki", "publicKeyFingerprint", "value"],
    "Evidence bundle signature",
  );
  if (signature.algorithm !== EVIDENCE_BUNDLE_SIGNATURE_ALGORITHM) {
    throw new TypeError(
      `Evidence bundle signature algorithm must be ${EVIDENCE_BUNDLE_SIGNATURE_ALGORITHM}`,
    );
  }
  if (typeof signature.keyId !== "string" || !KEY_ID_PATTERN.test(signature.keyId)) {
    throw new TypeError("Evidence bundle signature keyId has an invalid format");
  }
  decodeCanonicalBase64Url(signature.publicKeySpki, "Evidence bundle signature publicKeySpki");
  assertSha256(signature.publicKeyFingerprint, "Evidence bundle signature publicKeyFingerprint");
  decodeCanonicalBase64Url(signature.value, "Evidence bundle signature value", 64);
  canonicalizeJson(envelope);
}

const sha256Hex = async (value: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Verify a self-contained bundle. Callers that need signer identity must also
 * compare publicKeyFingerprint with a value obtained through a trusted channel.
 */
export async function verifyEvidenceBundleEnvelope(
  value: unknown,
): Promise<EvidenceBundleVerification> {
  assertEvidenceBundleEnvelope(value);
  const envelope = value;
  const canonicalBytes = new TextEncoder().encode(
    canonicalizeJson(unsignedEvidenceBundle(envelope)),
  );
  const publicKeyBytes = decodeCanonicalBase64Url(
    envelope.integrity.signature.publicKeySpki,
    "Evidence bundle signature publicKeySpki",
  );
  const signatureBytes = decodeCanonicalBase64Url(
    envelope.integrity.signature.value,
    "Evidence bundle signature value",
    64,
  );
  const errors: EvidenceBundleVerificationError[] = [];

  const digestValid = (await sha256Hex(canonicalBytes)) === envelope.integrity.digest.value;
  if (!digestValid) {
    errors.push({
      code: "DIGEST_MISMATCH",
      message: "The canonical unsigned bundle does not match the embedded SHA-256 digest.",
    });
  }

  const publicKeyFingerprintValid =
    (await sha256Hex(publicKeyBytes)) === envelope.integrity.signature.publicKeyFingerprint;
  if (!publicKeyFingerprintValid) {
    errors.push({
      code: "PUBLIC_KEY_FINGERPRINT_MISMATCH",
      message: "The embedded public key does not match its SHA-256 fingerprint.",
    });
    return {
      valid: false,
      digestValid,
      publicKeyFingerprintValid: false,
      signatureChecked: false,
      signatureValid: false,
      errors,
    };
  }

  const publicKey = await globalThis.crypto.subtle
    .importKey("spki", publicKeyBytes, { name: "Ed25519" }, false, ["verify"])
    .catch(() => null);
  if (!publicKey) {
    errors.push({
      code: "INVALID_ED25519_PUBLIC_KEY",
      message: "The embedded SubjectPublicKeyInfo is not a valid Ed25519 public key.",
    });
    return {
      valid: false,
      digestValid,
      publicKeyFingerprintValid: true,
      signatureChecked: false,
      signatureValid: false,
      errors,
    };
  }

  const signatureValid = await globalThis.crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    signatureBytes,
    canonicalBytes,
  );
  if (!signatureValid) {
    errors.push({
      code: "SIGNATURE_MISMATCH",
      message: "The Ed25519 signature does not match the canonical unsigned bundle.",
    });
  }
  return {
    valid: digestValid && publicKeyFingerprintValid && signatureValid,
    digestValid,
    publicKeyFingerprintValid,
    signatureChecked: true,
    signatureValid,
    errors,
  };
}
