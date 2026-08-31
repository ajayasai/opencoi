import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertEvidenceBundleEnvelope,
  type CanonicalJsonObject,
  canonicalizeJson,
  type EvidenceBundleEnvelope,
  type UnsignedEvidenceBundle,
  unsignedEvidenceBundle,
  verifyEvidenceBundleEnvelope,
} from "./evidenceBundle.js";

const signedEnvelope = (
  payload: CanonicalJsonObject = {
    sourceDocument: { sha256: "a".repeat(64) },
    decision: { status: "PASS", evidencePages: [1, 3] },
  },
): EvidenceBundleEnvelope => {
  const unsigned: UnsignedEvidenceBundle = {
    schemaVersion: "1.0",
    exportedAt: "2026-08-31T12:34:56.789Z",
    payload,
  };
  const canonical = canonicalizeJson(unsigned);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    ...unsigned,
    integrity: {
      canonicalization: "OPENCOI_CANONICAL_JSON_V1",
      digest: {
        algorithm: "SHA-256",
        value: createHash("sha256").update(canonical, "utf8").digest("hex"),
      },
      signature: {
        algorithm: "Ed25519",
        keyId: "test-key:v1",
        publicKeySpki: publicKeySpki.toString("base64url"),
        publicKeyFingerprint: createHash("sha256").update(publicKeySpki).digest("hex"),
        value: sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url"),
      },
    },
  };
};

describe("OpenCOI canonical JSON v1", () => {
  it("sorts object keys recursively while preserving arrays and JSON scalar encoding", () => {
    const left = {
      z: "line\nvalue",
      a: [3, { b: 2, a: 1 }],
      negativeZero: -0,
    };
    const right = {
      negativeZero: 0,
      a: [3, { a: 1, b: 2 }],
      z: "line\nvalue",
    };

    expect(canonicalizeJson(left)).toBe(
      '{"a":[3,{"a":1,"b":2}],"negativeZero":0,"z":"line\\nvalue"}',
    );
    expect(canonicalizeJson(right)).toBe(canonicalizeJson(left));
  });

  it("rejects values that JSON would silently discard or coerce", () => {
    expect(() => canonicalizeJson({ omitted: undefined })).toThrow(/undefined/i);
    expect(() => canonicalizeJson({ invalid: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalizeJson({ invalid: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
    expect(() => canonicalizeJson(new Date("2026-08-31T00:00:00.000Z"))).toThrow(/plain objects/i);

    const sparse = Array<string>(2);
    sparse[1] = "present";
    expect(() => canonicalizeJson(sparse)).toThrow(/sparse/i);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalizeJson(circular)).toThrow(/circular/i);
  });
});

describe("evidence bundle envelope", () => {
  it("selects the signed fields and verifies a Node-generated Ed25519 signature", async () => {
    const envelope = signedEnvelope();

    expect(unsignedEvidenceBundle(envelope)).toEqual({
      schemaVersion: envelope.schemaVersion,
      exportedAt: envelope.exportedAt,
      payload: envelope.payload,
    });
    expect(await verifyEvidenceBundleEnvelope(envelope)).toEqual({
      valid: true,
      digestValid: true,
      publicKeyFingerprintValid: true,
      signatureChecked: true,
      signatureValid: true,
      errors: [],
    });
  });

  it("detects payload and digest tampering independently", async () => {
    const payloadTampered = structuredClone(signedEnvelope());
    payloadTampered.payload.sourceDocument = { sha256: "b".repeat(64) };
    const payloadResult = await verifyEvidenceBundleEnvelope(payloadTampered);
    expect(payloadResult).toMatchObject({
      valid: false,
      digestValid: false,
      publicKeyFingerprintValid: true,
      signatureChecked: true,
      signatureValid: false,
    });
    expect(payloadResult.errors.map((error) => error.code)).toEqual([
      "DIGEST_MISMATCH",
      "SIGNATURE_MISMATCH",
    ]);

    const digestTampered = structuredClone(signedEnvelope());
    digestTampered.integrity.digest.value = "0".repeat(64);
    const digestResult = await verifyEvidenceBundleEnvelope(digestTampered);
    expect(digestResult).toMatchObject({
      valid: false,
      digestValid: false,
      signatureChecked: true,
      signatureValid: true,
    });
  });

  it("checks the SPKI fingerprint before importing or verifying the public key", async () => {
    const envelope = signedEnvelope();
    envelope.integrity.signature.publicKeySpki = Buffer.from([0]).toString("base64url");

    const result = await verifyEvidenceBundleEnvelope(envelope);

    expect(result).toMatchObject({
      valid: false,
      publicKeyFingerprintValid: false,
      signatureChecked: false,
      signatureValid: false,
    });
    expect(result.errors.map((error) => error.code)).toContain("PUBLIC_KEY_FINGERPRINT_MISMATCH");
    expect(result.errors.map((error) => error.code)).not.toContain("INVALID_ED25519_PUBLIC_KEY");
  });

  it("rejects a non-Ed25519 key even when its fingerprint is internally consistent", async () => {
    const envelope = signedEnvelope();
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaSpki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    envelope.integrity.signature.publicKeySpki = rsaSpki.toString("base64url");
    envelope.integrity.signature.publicKeyFingerprint = createHash("sha256")
      .update(rsaSpki)
      .digest("hex");

    const result = await verifyEvidenceBundleEnvelope(envelope);

    expect(result).toMatchObject({
      valid: false,
      publicKeyFingerprintValid: true,
      signatureChecked: false,
      signatureValid: false,
    });
    expect(result.errors.map((error) => error.code)).toContain("INVALID_ED25519_PUBLIC_KEY");
  });

  it("strictly rejects unknown keys, malformed encodings, and noncanonical timestamps", () => {
    const withUnknownKey = structuredClone(signedEnvelope()) as EvidenceBundleEnvelope & {
      ignored?: boolean;
    };
    withUnknownKey.ignored = true;
    expect(() => assertEvidenceBundleEnvelope(withUnknownKey)).toThrow(/exactly/i);

    const paddedSignature = structuredClone(signedEnvelope());
    paddedSignature.integrity.signature.value += "=";
    expect(() => assertEvidenceBundleEnvelope(paddedSignature)).toThrow(/base64url/i);

    const badTimestamp = structuredClone(signedEnvelope());
    badTimestamp.exportedAt = "2026-08-31T12:34:56Z";
    expect(() => assertEvidenceBundleEnvelope(badTimestamp)).toThrow(/ISO instant/i);

    const nonObjectPayload = structuredClone(signedEnvelope()) as unknown as Record<
      string,
      unknown
    >;
    nonObjectPayload.payload = [];
    expect(() => assertEvidenceBundleEnvelope(nonObjectPayload)).toThrow(
      /payload must be an object/i,
    );
  });
});
