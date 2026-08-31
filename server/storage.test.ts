import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import {
  attachmentContentDisposition,
  FileSystemDocumentStore,
  inspectPdf,
  safeDownloadFilename,
  UnsafeDocumentError,
} from "./storage.js";

const validPdf = (pageCount = 1): Buffer => {
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => index + 3);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...pageObjectNumbers.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
};

const minimalPdf = validPdf();

const pdfWithUnderreportedPageTree = (actualPageCount: number): Buffer => {
  const pageObjectNumbers = Array.from({ length: actualPageCount }, (_, index) => index + 3);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count 1 >>`,
    ...pageObjectNumbers.map(
      () =>
        "<< /Type % a legal PDF comment defeats byte-pattern counting\n/Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
};

describe("PDF storage", () => {
  it("stores a PDF under a generated path and returns a digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);
    const stored = await store.putPdf(minimalPdf);

    expect(stored.storageKey).toMatch(/^[a-f0-9]{2}\/[a-f0-9-]{36}\.pdf$/);
    expect(stored.sha256).toHaveLength(64);
    expect(stored.pageCount).toBe(1);
    expect(await readFile(join(directory, stored.storageKey))).toEqual(minimalPdf);
  });

  it("rejects active content and encryption markers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);

    await expect(
      store.putPdf(Buffer.concat([minimalPdf, Buffer.from(" /JavaScript")])),
    ).rejects.toBeInstanceOf(UnsafeDocumentError);
    await expect(
      store.putPdf(Buffer.concat([minimalPdf, Buffer.from(" /Encrypt")])),
    ).rejects.toBeInstanceOf(UnsafeDocumentError);
  });

  it("parses and returns the trusted PDF page count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);

    expect((await store.putPdf(validPdf(3))).pageCount).toBe(3);
  });

  it("agrees on page counts in a PDF with compressed object streams", async () => {
    const source = await PDFDocument.create();
    source.addPage();
    source.addPage();
    source.addPage();
    const bytes = await source.save({ useObjectStreams: true });
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);

    expect((await store.putPdf(bytes)).pageCount).toBe(3);
  });

  it("rejects a page tree whose declared count hides additional page objects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);

    await expect(store.putPdf(pdfWithUnderreportedPageTree(80))).rejects.toThrow(
      "PDF contains an inconsistent page tree",
    );
  });

  it("does not allow a storage-key path escape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);
    await expect(store.get("../secret.pdf")).rejects.toThrow("Invalid document storage key");
  });
});

describe("PDF helpers", () => {
  it("inspects page objects without trusting a declared MIME type", () => {
    expect(inspectPdf(minimalPdf)).toEqual({
      pageCountEstimate: 1,
      encrypted: false,
      activeContentMarkers: [],
    });
  });

  it("creates inert download filenames", () => {
    expect(safeDownloadFilename("../Q1\r\nreport.PDF")).toBe(".._Q1__report.pdf");
    expect(safeDownloadFilename("<>.pdf")).toBe("__.pdf");
  });

  it("creates an ASCII-safe header while preserving a UTF-8 filename", () => {
    expect(attachmentContentDisposition("बीमा प्रमाणपत्र.pdf")).toBe(
      "attachment; filename=\"____ __________.pdf\"; filename*=UTF-8''%E0%A4%AC%E0%A5%80%E0%A4%AE%E0%A4%BE%20%E0%A4%AA%E0%A5%8D%E0%A4%B0%E0%A4%AE%E0%A4%BE%E0%A4%A3%E0%A4%AA%E0%A4%A4%E0%A5%8D%E0%A4%B0.pdf",
    );
  });

  it("truncates long Unicode filenames without splitting a surrogate pair", () => {
    const header = attachmentContentDisposition(`${"a".repeat(119)}😀.pdf`);
    const preservedBoundary = attachmentContentDisposition(`${"a".repeat(115)}😀.pdf`);

    expect(header).toContain("filename*=UTF-8''");
    expect(header).not.toContain("%EF%BF%BD");
    expect(() => decodeURIComponent(header.split("UTF-8''")[1] ?? "")).not.toThrow();
    expect(preservedBoundary).toContain("%F0%9F%98%80.pdf");
    expect(Array.from(safeDownloadFilename(`${"a".repeat(119)}😀.pdf`))).toHaveLength(120);
  });
});
