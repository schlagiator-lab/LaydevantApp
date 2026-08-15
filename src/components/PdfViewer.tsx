import '../lib/pdfjsPolyfills';

import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
// Vite-specific `?url` import: bundles the worker script and gives back its
// final URL, which pdf.js needs to run parsing/rendering off the main thread.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { colors, fonts, textA } from '../styles/tokens';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/**
 * Renders PDF pages to a <canvas>, independently of the browser's own PDF
 * support. Added because Chrome for Android doesn't render PDFs inline in an
 * <iframe> at all (confirmed on-device — see DocumentScreen's
 * handleOpenPdf comment); this sidesteps that entirely by drawing pixels
 * ourselves, so it behaves the same on desktop, Android, online, and offline.
 */
export function PdfViewer({ blob }: { blob: Blob }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);

  const [pageCount, setPageCount] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      setPageNum(1);
      setPageCount(0);
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        loadingTaskRef.current = loadingTask;
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      void loadingTaskRef.current?.destroy();
      loadingTaskRef.current = null;
      docRef.current = null;
    };
  }, [blob]);

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const containerWidth = containerRef.current?.clientWidth ?? 320;
        const unscaledWidth = page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale: containerWidth / unscaledWidth });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
      } catch (err) {
        if (!cancelled && err instanceof Error && err.name !== 'RenderingCancelledException') {
          setError(err.message);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageNum, loading]);

  if (error) {
    return (
      <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55), lineHeight: 1.6 }}>
        Aperçu impossible : {error}
      </span>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 10, background: colors.bgDark }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55) }}>Chargement de l'aperçu…</span>
          </div>
        ) : (
          <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }} />
        )}
      </div>
      {pageCount > 1 && (
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <button
            type="button"
            onClick={() => setPageNum((n) => Math.max(1, n - 1))}
            disabled={pageNum <= 1}
            style={{
              background: textA(0.1),
              border: 'none',
              borderRadius: 8,
              color: colors.text,
              width: 32,
              height: 32,
              fontSize: 16,
              cursor: pageNum <= 1 ? 'default' : 'pointer',
              opacity: pageNum <= 1 ? 0.4 : 1,
            }}
            aria-label="Page précédente"
          >
            ‹
          </button>
          <span style={{ fontFamily: fonts.mono, fontSize: 12.5, color: textA(0.6) }}>
            Page {pageNum} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPageNum((n) => Math.min(pageCount, n + 1))}
            disabled={pageNum >= pageCount}
            style={{
              background: textA(0.1),
              border: 'none',
              borderRadius: 8,
              color: colors.text,
              width: 32,
              height: 32,
              fontSize: 16,
              cursor: pageNum >= pageCount ? 'default' : 'pointer',
              opacity: pageNum >= pageCount ? 0.4 : 1,
            }}
            aria-label="Page suivante"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
