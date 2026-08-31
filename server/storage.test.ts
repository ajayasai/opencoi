import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachmentContentDisposition,
  FileSystemDocumentStore,
  inspectPdf,
  safeDownloadFilename,
  UnsafeDocumentError,
} from "./storage.js";

const minimalPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids[3 0 R] /Count 1>> endobj\n3 0 obj <</Type /Page /Parent 2 0 R>> endobj\n%%EOF",
);

describe("PDF storage", () => {
  it("stores a PDF under a generated path and returns a digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencoi-store-"));
    const store = new FileSystemDocumentStore(directory);
    const stored = await store.putPdf(minimalPdf);

    expect(stored.storageKey).toMatch(/^[a-f0-9]{2}\/[a-f0-9-]{36}\.pdf$/);
    expect(stored.sha256).toHaveLength(64);
    expect(stored.pageCountEstimate).toBe(1);
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
