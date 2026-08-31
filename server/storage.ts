import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { assertPdfMagicBytes } from "./security.js";

export interface StoredDocument {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  detectedMime: "application/pdf";
  pageCountEstimate: number;
}

export interface PdfInspection {
  pageCountEstimate: number;
  encrypted: boolean;
  activeContentMarkers: string[];
}

export interface DocumentStore {
  putPdf(input: Uint8Array): Promise<StoredDocument>;
  get(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

export class UnsafeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDocumentError";
  }
}

const MAX_PAGE_COUNT = 75;

/**
 * Conservative byte-level triage. This is not a substitute for AV/CDR in a
 * managed deployment, but it rejects common active-PDF features before storage.
 */
export function inspectPdf(input: Uint8Array): PdfInspection {
  assertPdfMagicBytes(input);
  const text = Buffer.from(input).toString("latin1");
  const markers = [
    ["JavaScript", /\/JavaScript\b/i],
    ["JavaScript action", /\/JS\b/i],
    ["launch action", /\/Launch\b/i],
    ["embedded file", /\/EmbeddedFile\b/i],
    ["rich media", /\/RichMedia\b/i],
    ["XFA form", /\/XFA\b/i],
  ] as const;
  const activeContentMarkers = markers
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  const pageCountEstimate = Math.max(1, (text.match(/\/Type\s*\/Page\b/g) ?? []).length);

  return {
    pageCountEstimate,
    encrypted: /\/Encrypt\b/.test(text),
    activeContentMarkers,
  };
}

function validateStorageKey(storageKey: string): string {
  if (!/^[a-f0-9]{2}\/[a-f0-9-]{36}\.pdf$/.test(storageKey)) {
    throw new TypeError("Invalid document storage key");
  }
  return storageKey;
}

export class FileSystemDocumentStore implements DocumentStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(storageKey: string) {
    const target = resolve(this.root, validateStorageKey(storageKey));
    if (!target.startsWith(`${this.root}${sep}`)) {
      throw new TypeError("Document storage path escaped its root");
    }
    return target;
  }

  async putPdf(input: Uint8Array): Promise<StoredDocument> {
    const inspection = inspectPdf(input);
    if (inspection.encrypted) {
      throw new UnsafeDocumentError("Encrypted PDFs are not accepted; upload an unlocked copy");
    }
    if (inspection.activeContentMarkers.length > 0) {
      throw new UnsafeDocumentError(
        `PDF contains unsupported active content: ${inspection.activeContentMarkers.join(", ")}`,
      );
    }
    if (inspection.pageCountEstimate > MAX_PAGE_COUNT) {
      throw new UnsafeDocumentError(`PDF exceeds the ${MAX_PAGE_COUNT}-page safety limit`);
    }

    const sha256 = createHash("sha256").update(input).digest("hex");
    const id = randomUUID();
    const storageKey = `${id.slice(0, 2)}/${id}.pdf`;
    const target = this.pathFor(storageKey);
    await mkdir(resolve(target, ".."), { recursive: true });
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(input);
    } finally {
      await handle.close();
    }

    return {
      storageKey,
      sha256,
      sizeBytes: input.byteLength,
      detectedMime: "application/pdf",
      pageCountEstimate: inspection.pageCountEstimate,
    };
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function safeDownloadFilename(originalFilename: string): string {
  const normalized = Array.from(originalFilename.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? "_" : character;
  }).join("");
  const base = normalized
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const withoutExtension = extname(base).toLowerCase() === ".pdf" ? base.slice(0, -4) : base;
  const boundedStem = Array.from(withoutExtension).slice(0, 116).join("").trim();
  return `${boundedStem || "certificate"}.pdf`;
}

export function attachmentContentDisposition(originalFilename: string): string {
  const filename = safeDownloadFilename(originalFilename);
  const asciiFallback = Array.from(filename, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint <= 0x7e ? character : "_";
  }).join("");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback || "certificate.pdf"}"; filename*=UTF-8''${encoded}`;
}
