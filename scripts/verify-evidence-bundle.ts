#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  assertEvidenceBundleEnvelope,
  type EvidenceBundleEnvelope,
  verifyEvidenceBundleEnvelope,
} from "../shared/evidenceBundle.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface EvidenceBundleVerifierOptions {
  envelopePath: string;
  pdfPath?: string;
  pdfSha256?: string;
  trustedKeyFingerprint?: string;
}

export interface EvidenceBundleVerifierResult {
  valid: boolean;
  envelope: EvidenceBundleEnvelope;
  pdfSha256?: string;
  errors: string[];
}

interface VerifierIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const USAGE = `Usage: npx tsx scripts/verify-evidence-bundle.ts <bundle.json> [options]

Options:
  --pdf <document.pdf>                 Compute and verify the source PDF SHA-256
  --pdf-sha256 <lowercase-hex>         Verify a previously computed source PDF SHA-256
  --trusted-key-fingerprint <hex>      Require a fingerprint obtained out of band
  --help                               Show this help
`;

const assertSha256 = (value: string, label: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters`);
  }
};

const parseArguments = (
  argv: readonly string[],
): EvidenceBundleVerifierOptions | { help: true } => {
  const positional: string[] = [];
  const options: Omit<EvidenceBundleVerifierOptions, "envelopePath"> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--help" || argument === "-h") return { help: true };
    if (
      argument === "--pdf" ||
      argument === "--pdf-sha256" ||
      argument === "--trusted-key-fingerprint"
    ) {
      const optionValue = argv[index + 1];
      if (!optionValue || optionValue.startsWith("--")) {
        throw new TypeError(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--pdf") options.pdfPath = optionValue;
      if (argument === "--pdf-sha256") options.pdfSha256 = optionValue;
      if (argument === "--trusted-key-fingerprint") {
        options.trustedKeyFingerprint = optionValue;
      }
      continue;
    }
    if (argument.startsWith("-")) throw new TypeError(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length !== 1) {
    throw new TypeError("Exactly one evidence-bundle JSON path is required");
  }
  if (options.pdfPath && options.pdfSha256) {
    throw new TypeError("Use either --pdf or --pdf-sha256, not both");
  }
  if (options.pdfSha256) assertSha256(options.pdfSha256, "--pdf-sha256");
  if (options.trustedKeyFingerprint) {
    assertSha256(options.trustedKeyFingerprint, "--trusted-key-fingerprint");
  }
  return { envelopePath: positional[0] as string, ...options };
};

const sourceDocumentSha256 = (envelope: EvidenceBundleEnvelope): string => {
  const payload = envelope.payload;
  const sourceDocument = payload.sourceDocument;
  if (
    sourceDocument === null ||
    typeof sourceDocument !== "object" ||
    Array.isArray(sourceDocument)
  ) {
    throw new TypeError(
      "Evidence bundle payload.sourceDocument must be present to verify a PDF SHA-256",
    );
  }
  const value = sourceDocument.sha256;
  if (typeof value !== "string") {
    throw new TypeError(
      "Evidence bundle payload.sourceDocument.sha256 must be present to verify a PDF SHA-256",
    );
  }
  assertSha256(value, "Evidence bundle payload.sourceDocument.sha256");
  return value;
};

const fileSha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

export async function verifyEvidenceBundleFile(
  options: EvidenceBundleVerifierOptions,
): Promise<EvidenceBundleVerifierResult> {
  const serialized = await readFile(options.envelopePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("Evidence bundle is not valid JSON");
  }
  assertEvidenceBundleEnvelope(parsed);
  const envelope = parsed;
  const errors: string[] = [];

  if (
    options.trustedKeyFingerprint &&
    envelope.integrity.signature.publicKeyFingerprint !== options.trustedKeyFingerprint
  ) {
    errors.push("The signer fingerprint does not match --trusted-key-fingerprint.");
    return { valid: false, envelope, errors };
  }

  const verification = await verifyEvidenceBundleEnvelope(envelope);
  errors.push(...verification.errors.map((error) => `${error.code}: ${error.message}`));

  let suppliedPdfSha256: string | undefined;
  if (options.pdfPath) suppliedPdfSha256 = await fileSha256(options.pdfPath);
  if (options.pdfSha256) suppliedPdfSha256 = options.pdfSha256;
  if (suppliedPdfSha256) {
    const embeddedPdfSha256 = sourceDocumentSha256(envelope);
    if (suppliedPdfSha256 !== embeddedPdfSha256) {
      errors.push("The supplied PDF SHA-256 does not match payload.sourceDocument.sha256.");
    }
  }

  return {
    valid: verification.valid && errors.length === 0,
    envelope,
    pdfSha256: suppliedPdfSha256,
    errors,
  };
}

export async function runEvidenceBundleVerifier(
  argv: readonly string[],
  io: VerifierIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  try {
    const options = parseArguments(argv);
    if ("help" in options) {
      io.stdout(USAGE);
      return 0;
    }
    const result = await verifyEvidenceBundleFile({
      ...options,
      envelopePath: resolve(options.envelopePath),
      pdfPath: options.pdfPath ? resolve(options.pdfPath) : undefined,
    });
    if (!result.valid) {
      io.stderr(
        `Evidence bundle verification failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`,
      );
      return 1;
    }
    const pdfLine = result.pdfSha256 ? `PDF SHA-256: ${result.pdfSha256}\n` : "";
    const identityLine = options.trustedKeyFingerprint
      ? "Signer identity: trusted fingerprint matched.\n"
      : "Signer identity: NOT verified; compare the fingerprint through a trusted channel.\n";
    io.stdout(
      `Evidence bundle integrity verified; v1 payload structure and invariants verified.\n${identityLine}Digest: ${result.envelope.integrity.digest.value}\nSigner key label (unauthenticated metadata): ${result.envelope.integrity.signature.keyId}\nPublic-key fingerprint: ${result.envelope.integrity.signature.publicKeyFingerprint}\n${pdfLine}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown verification error";
    io.stderr(`Evidence bundle verification failed: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runEvidenceBundleVerifier(process.argv.slice(2));
}
