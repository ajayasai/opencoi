import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvidenceBundleVerifier } from "../scripts/verify-evidence-bundle.js";
import {
  canonicalizeJson,
  type EvidenceBundleEnvelope,
  type UnsignedEvidenceBundle,
} from "../shared/evidenceBundle.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async (pdf: Buffer) => {
  const directory = await mkdtemp(join(tmpdir(), "opencoi-evidence-cli-"));
  temporaryDirectories.push(directory);
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  const unsigned: UnsignedEvidenceBundle = {
    schemaVersion: "1.0",
    exportedAt: "2026-08-31T12:34:56.789Z",
    payload: {
      generator: {
        name: "OpenCOI",
        version: "0.4.0",
        origin: "https://coi.example.test",
      },
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
        byteSize: pdf.byteLength,
        sha256: pdfSha256,
        uploadedAt: "2026-08-31T12:00:00.000Z",
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
        asOf: "2026-08-31T12:34:56.789Z",
        limitation: "Document assessment only; not live policy verification.",
      },
      audit: {
        organizationChainVerifiedAtExport: true,
        checkedEvents: 0,
        error: null,
        head: null,
        certificateEvents: [],
      },
    },
  };
  const canonical = canonicalizeJson(unsigned);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const envelope: EvidenceBundleEnvelope = {
    ...unsigned,
    integrity: {
      canonicalization: "OPENCOI_CANONICAL_JSON_V1",
      digest: {
        algorithm: "SHA-256",
        value: createHash("sha256").update(canonical, "utf8").digest("hex"),
      },
      signature: {
        algorithm: "Ed25519",
        keyId: "cli-test-key",
        publicKeySpki: publicKeySpki.toString("base64url"),
        publicKeyFingerprint: createHash("sha256").update(publicKeySpki).digest("hex"),
        value: sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url"),
      },
    },
  };
  const envelopePath = join(directory, "bundle.json");
  const pdfPath = join(directory, "synthetic.pdf");
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await writeFile(pdfPath, pdf);
  return { envelope, envelopePath, pdfPath, pdfSha256 };
};

const capture = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
};

describe("evidence bundle verifier CLI", () => {
  it("verifies the envelope, an out-of-band signer fingerprint, and the PDF bytes", async () => {
    const value = await fixture(Buffer.from("%PDF-1.7\nsynthetic evidence\n", "utf8"));
    const output = capture();

    const exitCode = await runEvidenceBundleVerifier(
      [
        value.envelopePath,
        "--pdf",
        value.pdfPath,
        "--trusted-key-fingerprint",
        value.envelope.integrity.signature.publicKeyFingerprint,
      ],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout.join("")).toContain("Evidence bundle integrity verified");
    expect(output.stdout.join("")).toContain("trusted fingerprint matched");
    expect(output.stdout.join("")).toContain(`PDF SHA-256: ${value.pdfSha256}`);
  });

  it("labels self-contained signature verification as unauthenticated signer identity", async () => {
    const value = await fixture(Buffer.from("%PDF-1.7\nsynthetic evidence\n", "utf8"));
    const output = capture();

    expect(await runEvidenceBundleVerifier([value.envelopePath], output.io)).toBe(0);
    expect(output.stdout.join("")).toContain("Evidence bundle integrity verified");
    expect(output.stdout.join("")).toContain("Signer identity: NOT verified");
    expect(output.stdout.join("")).toContain("Signer key label (unauthenticated metadata)");
  });

  it("rejects a mismatched supplied PDF digest and trusted signer fingerprint", async () => {
    const value = await fixture(Buffer.from("%PDF-1.7\nsynthetic evidence\n", "utf8"));
    const pdfOutput = capture();
    const pdfExitCode = await runEvidenceBundleVerifier(
      [value.envelopePath, "--pdf-sha256", "b".repeat(64)],
      pdfOutput.io,
    );
    expect(pdfExitCode).toBe(1);
    expect(pdfOutput.stderr.join("")).toContain("payload.sourceDocument.sha256");

    const trustOutput = capture();
    const trustExitCode = await runEvidenceBundleVerifier(
      [value.envelopePath, "--trusted-key-fingerprint", "c".repeat(64)],
      trustOutput.io,
    );
    expect(trustExitCode).toBe(1);
    expect(trustOutput.stderr.join("")).toContain("signer fingerprint");
  });

  it("rejects malformed envelopes and cryptographic tampering", async () => {
    const value = await fixture(Buffer.from("%PDF-1.7\nsynthetic evidence\n", "utf8"));
    const tampered = structuredClone(value.envelope);
    (tampered.payload.scope as Record<string, unknown>).certificateId = "tampered-certificate";
    await writeFile(value.envelopePath, JSON.stringify(tampered), "utf8");

    const tamperOutput = capture();
    expect(await runEvidenceBundleVerifier([value.envelopePath], tamperOutput.io)).toBe(1);
    expect(tamperOutput.stderr.join("")).toContain("DIGEST_MISMATCH");
    expect(tamperOutput.stderr.join("")).toContain("SIGNATURE_MISMATCH");

    await writeFile(value.envelopePath, "{not-json", "utf8");
    const malformedOutput = capture();
    expect(await runEvidenceBundleVerifier([value.envelopePath], malformedOutput.io)).toBe(1);
    expect(malformedOutput.stderr.join("")).toContain("not valid JSON");
  });

  it("rejects a signed-envelope-shaped file with an invalid v1 payload", async () => {
    const value = await fixture(Buffer.from("%PDF-1.7\nsynthetic evidence\n", "utf8"));
    const invalid = structuredClone(value.envelope);
    invalid.payload.sourceDocument = {
      ...(invalid.payload.sourceDocument as Record<string, unknown>),
      mimeType: "text/plain",
    };
    await writeFile(value.envelopePath, JSON.stringify(invalid), "utf8");
    const output = capture();

    expect(await runEvidenceBundleVerifier([value.envelopePath], output.io)).toBe(1);
    expect(output.stderr.join("")).toContain("sourceDocument.mimeType must be application/pdf");
  });
});
