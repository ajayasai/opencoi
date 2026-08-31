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
  if (
    typeof envelope.exportedAt !== "string" ||
    !ISO_INSTANT_PATTERN.test(envelope.exportedAt) ||
    new Date(envelope.exportedAt).toISOString() !== envelope.exportedAt
  ) {
    throw new TypeError("Evidence bundle exportedAt must be an exact UTC ISO instant");
  }
  assertPlainRecord(envelope.payload, "Evidence bundle payload");
  canonicalizeJson(envelope.payload);

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
