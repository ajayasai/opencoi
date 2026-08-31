import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus } from "lucide-react";
import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "./ui";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function PdfPreview({ file, initialPage = 1 }: { file: File; initialPage?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let documentProxy: PDFDocumentProxy | null = null;
    setLoading(true);
    setError("");
    const loadingTaskPromise = file
      .arrayBuffer()
      .then((buffer) =>
        getDocument({ data: new Uint8Array(buffer), useWorkerFetch: true, stopAtErrors: true }),
      );
    loadingTaskPromise
      .then((task) => task.promise)
      .then((loaded) => {
        documentProxy = loaded;
        if (active) {
          setPdf(loaded);
          setPage(Math.min(Math.max(initialPage, 1), loaded.numPages));
        }
      })
      .catch(
        () => active && setError("Preview could not be rendered. You can still review the fields."),
      )
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
      documentProxy?.cleanup();
      void loadingTaskPromise.then((task) => task.destroy());
    };
  }, [file, initialPage]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    setLoading(true);
    pdf
      .getPage(page)
      .then(async (pdfPage) => {
        if (cancelled || !canvasRef.current) return;
        const viewport = pdfPage.getViewport({ scale: 1.25 * zoom });
        const canvas = canvasRef.current;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable");
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        await pdfPage.render({
          canvas: null,
          canvasContext: context,
          viewport,
          annotationMode: AnnotationMode.DISABLE,
        }).promise;
      })
      .catch(() => !cancelled && setError("This page could not be rendered."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [pdf, page, zoom]);

  return (
    <div className="pdf-preview">
      <div className="pdf-preview__toolbar">
        <div className="pdf-preview__pager">
          <IconButton
            label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <span>
            Page <strong>{page}</strong> of {pdf?.numPages ?? "—"}
          </span>
          <IconButton
            label="Next page"
            disabled={!pdf || page >= pdf.numPages}
            onClick={() => setPage((value) => Math.min(pdf?.numPages ?? value, value + 1))}
          >
            <ChevronRight size={18} />
          </IconButton>
        </div>
        <div className="pdf-preview__zoom">
          <IconButton
            label="Zoom out"
            disabled={zoom <= 0.7}
            onClick={() => setZoom((value) => Math.max(0.7, value - 0.15))}
          >
            <Minus size={16} />
          </IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton
            label="Zoom in"
            disabled={zoom >= 1.6}
            onClick={() => setZoom((value) => Math.min(1.6, value + 0.15))}
          >
            <Plus size={16} />
          </IconButton>
        </div>
      </div>
      <div className="pdf-preview__viewport">
        {loading && (
          <div className="pdf-preview__loading">
            <LoaderCircle className="spin" size={23} />
          </div>
        )}
        {error ? (
          <div className="pdf-preview__error">
            <p>{error}</p>
            <Button variant="secondary" size="sm" onClick={() => setError("")}>
              Try again
            </Button>
          </div>
        ) : (
          <canvas ref={canvasRef} aria-label={`Rendered PDF page ${page}`} />
        )}
      </div>
    </div>
  );
}
