import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ExtractedPage {
  page: number;
  text: string;
  method: "text_layer" | "ocr";
  confidenceBps?: number;
}

export interface BrowserExtractionResult {
  rawText: string;
  pages: ExtractedPage[];
  pageCount: number;
  method: "text_layer" | "ocr" | "hybrid";
  warnings: string[];
}

export interface ExtractionProgress {
  stage: "opening" | "reading" | "ocr" | "complete";
  page?: number;
  pageCount?: number;
  progress?: number;
  message: string;
}

export class ExtractionCancelledError extends Error {
  constructor() {
    super("Document extraction was cancelled");
    this.name = "ExtractionCancelledError";
  }
}

const MIN_USABLE_TEXT = 80;
const MAX_OCR_PAGES = 20;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ExtractionCancelledError();
}

async function pageText(pdf: PDFDocumentProxy, pageNumber: number) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const lines: string[] = [];
  let currentLine = "";
  let currentY: number | undefined;
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const y = item.transform[5];
    if (currentY !== undefined && Math.abs(y - currentY) > 2.5 && currentLine.trim()) {
      lines.push(currentLine.trim());
      currentLine = "";
    }
    currentLine += `${currentLine ? " " : ""}${item.str}`;
    currentY = y;
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function renderPageForOcr(pdf: PDFDocumentProxy, pageNumber: number) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.65 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

/**
 * Extracts text entirely in the browser. Digital text layers are preferred;
 * Tesseract is loaded only for pages without enough usable text.
 */
export async function extractPdfInBrowser(
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ExtractionProgress) => void;
  } = {},
): Promise<BrowserExtractionResult> {
  const { signal, onProgress } = options;
  throwIfAborted(signal);
  onProgress?.({ stage: "opening", message: "Opening PDF safely in your browser" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new TypeError("The selected file is not a PDF");
  }

  const loadingTask = getDocument({
    data: bytes,
    useWorkerFetch: true,
    stopAtErrors: true,
  });
  const pdf = await loadingTask.promise;
  const pages: ExtractedPage[] = [];
  const warnings: string[] = [];
  const needsOcr: number[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      onProgress?.({
        stage: "reading",
        page: pageNumber,
        pageCount: pdf.numPages,
        progress: pageNumber / pdf.numPages,
        message: `Reading page ${pageNumber} of ${pdf.numPages}`,
      });
      const text = await pageText(pdf, pageNumber);
      if (text.length >= MIN_USABLE_TEXT) {
        pages.push({ page: pageNumber, text, method: "text_layer", confidenceBps: 10_000 });
      } else {
        needsOcr.push(pageNumber);
        pages.push({ page: pageNumber, text, method: "ocr" });
      }
    }

    if (needsOcr.length > 0) {
      if (needsOcr.length > MAX_OCR_PAGES) {
        warnings.push(
          `Only the first ${MAX_OCR_PAGES} scanned pages were OCR-processed; confirm remaining fields manually.`,
        );
      }
      const { createWorker } = await import("tesseract.js");
      let currentPage = needsOcr[0] ?? 1;
      const worker = await createWorker("eng", 1, {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract/core",
        langPath: "/tesseract/lang",
        workerBlobURL: false,
        logger: (message) => {
          if (message.status !== "recognizing text") return;
          onProgress?.({
            stage: "ocr",
            page: currentPage,
            pageCount: pdf.numPages,
            progress: message.progress,
            message: `OCR page ${currentPage} — ${Math.round(message.progress * 100)}%`,
          });
        },
      });
      try {
        for (const pageNumber of needsOcr.slice(0, MAX_OCR_PAGES)) {
          throwIfAborted(signal);
          currentPage = pageNumber;
          const canvas = await renderPageForOcr(pdf, pageNumber);
          const result = await worker.recognize(canvas);
          const index = pages.findIndex((page) => page.page === pageNumber);
          pages[index] = {
            page: pageNumber,
            text: result.data.text
              .split(/\r?\n/)
              .map((line) => line.replace(/[ \t]+/g, " ").trim())
              .filter(Boolean)
              .join("\n"),
            method: "ocr",
            confidenceBps: Math.max(0, Math.min(10_000, Math.round(result.data.confidence * 100))),
          };
          canvas.width = 1;
          canvas.height = 1;
        }
      } finally {
        await worker.terminate();
      }
    }
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }

  const orderedPages = [...pages].sort((left, right) => left.page - right.page);
  const methods = new Set(orderedPages.filter((page) => page.text).map((page) => page.method));
  const method = methods.size > 1 ? "hybrid" : methods.has("ocr") ? "ocr" : "text_layer";
  const rawText = orderedPages
    .map((page) => `--- Page ${page.page} ---\n${page.text}`)
    .join("\n\n");
  if (rawText.replace(/--- Page \d+ ---/g, "").trim().length < MIN_USABLE_TEXT) {
    warnings.push("Very little text was detected. Enter and confirm all required fields manually.");
  }

  onProgress?.({ stage: "complete", progress: 1, message: "Extraction ready for human review" });
  return { rawText, pages: orderedPages, pageCount: pdf.numPages, method, warnings };
}
