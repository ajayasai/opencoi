import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertEvidenceBundleEnvelope,
  assertEvidenceBundlePayload,
  type CanonicalJsonObject,
  canonicalizeJson,
  type EvidenceBundleEnvelope,
  type UnsignedEvidenceBundle,
  unsignedEvidenceBundle,
  verifyEvidenceBundleEnvelope,
} from "./evidenceBundle.js";

const EXPORTED_AT = "2026-08-31T12:34:56.789Z";

const validPayload = (sha256 = "a".repeat(64)): CanonicalJsonObject => ({
  generator: { name: "OpenCOI", version: "0.4.0", origin: "https://coi.example.test" },
  scope: {
    organization: { id: "org-1", name: "Example Organization" },
    vendor: {
      id: "vendor-1",
      legalName: "Example Vendor LLC",
      vendorTypeAtExport: { id: "vendor-type-1", name: "Contractor" },
    },
    certificateId: "certificate-1",
  },
  exportedBy: { id: "user-1", name: "Example Reviewer" },
  sourceDocument: {
    id: "document-1",
    originalFilename: "synthetic.pdf",
    mimeType: "application/pdf",
    byteSize: 128,
    sha256,
    uploadedAt: "2026-08-30T12:00:00.000Z",
  },
  review: {
    status: "draft",
    reviewedBy: null,
    reviewedAt: null,
    evaluationDate: null,
    requirementVersion: null,
    evaluationVendorType: null,
  },
  machineProposal: {},
  confirmedFacts: null,
  evidence: [],
  requirementSnapshot: null,
  findings: [],
  exceptions: [],
  statusAtExport: {
    documentCheck: "needs_review",
    documentLifecycle: "unknown",
    asOf: EXPORTED_AT,
    limitation: "Document assessment only; not live policy verification.",
  },
  audit: {
    organizationChainVerifiedAtExport: true,
    checkedEvents: 0,
    error: null,
    head: null,
    certificateEvents: [],
  },
});

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const signedEnvelope = (payload: CanonicalJsonObject = validPayload()): EvidenceBundleEnvelope => {
  const unsigned: UnsignedEvidenceBundle = {
    schemaVersion: "1.0",
    exportedAt: EXPORTED_AT,
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
    record(payloadTampered.payload.scope).certificateId = "certificate-tampered";
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

  it("validates the complete payload shape and rejects unknown or missing fields", () => {
    const valid = validPayload();
    expect(() => assertEvidenceBundlePayload(valid, EXPORTED_AT)).not.toThrow();

    const missingField = structuredClone(valid);
    delete record(missingField).generator;
    expect(() => assertEvidenceBundlePayload(missingField, EXPORTED_AT)).toThrow(
      /must contain exactly/i,
    );

    const unknownNestedField = structuredClone(valid);
    record(record(unknownNestedField).sourceDocument).unpublished = true;
    expect(() => assertEvidenceBundlePayload(unknownNestedField, EXPORTED_AT)).toThrow(
      /sourceDocument must contain exactly/i,
    );
  });

  it("enforces review, source-document, endorsement-page, and requirement invariants", () => {
    const payload = structuredClone(validPayload());
    const review = record(payload.review);
    review.status = "confirmed";
    review.reviewedBy = { id: "reviewer-1", name: "Reviewer One" };
    review.reviewedAt = "2026-08-31T11:00:00.000Z";
    review.evaluationDate = "2026-08-31";
    review.requirementVersion = 2;
    review.evaluationVendorType = { id: "vendor-type-1", name: "Contractor" };
    payload.confirmedFacts = {
      namedInsured: "Example Vendor LLC",
      issueDate: "2026-08-30",
      producer: "Example Broker",
      certificateHolder: "Example Organization",
      policies: [
        {
          endorsements: [
            {
              name: "Additional Insured",
              formCode: "CG 20 10",
              evidenceLevel: "HUMAN_VERIFIED",
              sourcePages: [1, 3],
            },
          ],
        },
      ],
    };
    payload.requirementSnapshot = {
      version: 2,
      vendorType: { id: "vendor-type-1", name: "Contractor" },
      evaluatedRuleset: {},
      publication: null,
    };
    payload.evidence = [
      {
        kind: "endorsement_page_attestation",
        policyIndex: 0,
        endorsementIndex: 0,
        endorsementName: "Additional Insured",
        formCode: "CG 20 10",
        evidenceLevel: "HUMAN_VERIFIED",
        sourcePages: [1, 3],
        sourceDocumentSha256: "a".repeat(64),
        origin: "submitted_endorsement_page_reference",
        attestationStatus: "reviewer_attested",
        attestedByUserId: "reviewer-1",
        attestedAt: "2026-08-31T11:00:00.000Z",
      },
    ];

    expect(() => assertEvidenceBundlePayload(payload, EXPORTED_AT)).not.toThrow();

    const wrongHash = structuredClone(payload);
    record((wrongHash.evidence as CanonicalJsonObject[])[0]).sourceDocumentSha256 = "b".repeat(64);
    expect(() => assertEvidenceBundlePayload(wrongHash, EXPORTED_AT)).toThrow(
      /must equal payload\.sourceDocument\.sha256/i,
    );

    const unsortedPages = structuredClone(payload);
    record((unsortedPages.evidence as CanonicalJsonObject[])[0]).sourcePages = [3, 1];
    expect(() => assertEvidenceBundlePayload(unsortedPages, EXPORTED_AT)).toThrow(
      /strictly increasing/i,
    );

    const mismatchedReviewer = structuredClone(payload);
    record((mismatchedReviewer.evidence as CanonicalJsonObject[])[0]).attestedByUserId =
      "different-reviewer";
    expect(() => assertEvidenceBundlePayload(mismatchedReviewer, EXPORTED_AT)).toThrow(
      /reviewer and time must match/i,
    );

    const danglingPolicy = structuredClone(payload);
    record((danglingPolicy.evidence as CanonicalJsonObject[])[0]).policyIndex = 1;
    expect(() => assertEvidenceBundlePayload(danglingPolicy, EXPORTED_AT)).toThrow(
      /policyIndex must reference/i,
    );

    const danglingEndorsement = structuredClone(payload);
    record((danglingEndorsement.evidence as CanonicalJsonObject[])[0]).endorsementIndex = 1;
    expect(() => assertEvidenceBundlePayload(danglingEndorsement, EXPORTED_AT)).toThrow(
      /endorsementIndex must reference/i,
    );

    const contradictoryEndorsement = structuredClone(payload);
    const policies = record(contradictoryEndorsement.confirmedFacts).policies as unknown[];
    const endorsements = record(policies[0]).endorsements as unknown[];
    record(endorsements[0]).sourcePages = [1];
    expect(() => assertEvidenceBundlePayload(contradictoryEndorsement, EXPORTED_AT)).toThrow(
      /must exactly match/i,
    );

    const mismatchedRequirement = structuredClone(payload);
    record(mismatchedRequirement.requirementSnapshot).version = 3;
    expect(() => assertEvidenceBundlePayload(mismatchedRequirement, EXPORTED_AT)).toThrow(
      /must match review\.requirementVersion/i,
    );
  });

  it("keeps the legacy keyId label outside v1 signed bytes and treats it as unauthenticated", async () => {
    const envelope = signedEnvelope();
    envelope.integrity.signature.keyId = "different-display-label";

    expect(await verifyEvidenceBundleEnvelope(envelope)).toMatchObject({ valid: true });
  });
});
