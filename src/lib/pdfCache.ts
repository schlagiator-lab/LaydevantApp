// Cache API storage for pinned PDFs (CLAUDE.md §4) — IndexedDB is a poor fit
// for large binaries, Cache API is built for exactly this.
import { safeMimeForOpen, withSafeMime } from './safeOpen';

const CACHE_NAME = 'laydevant-offline-pdfs';

function keyFor(documentId: string): string {
  return `/offline-pdf/${documentId}`;
}

/**
 * `mimeType` is forced explicitly rather than trusting `blob.type` (which
 * mirrors whatever Content-Type the storage response carried) — PDFs
 * uploaded through the n8n workflow can land in Supabase Storage without a
 * correct `application/pdf` Content-Type, and a blob/object URL with the
 * wrong type never renders inline, it falls back to an undisplayable-content
 * placeholder in the viewer.
 */
export async function putPdf(documentId: string, blob: Blob, mimeType: string): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(keyFor(documentId), new Response(blob, { headers: { 'Content-Type': safeMimeForOpen(mimeType) } }));
}

export async function getPdf(documentId: string): Promise<Blob | undefined> {
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(keyFor(documentId));
  if (!response) return undefined;
  // Re-typé aussi à la lecture : couvre les entrées mises en cache avant le
  // filtrage de putPdf (SECURITY_AUDIT.md E1).
  const blob = await response.blob();
  return withSafeMime(blob, blob.type);
}

export async function hasPdf(documentId: string): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(keyFor(documentId))) !== undefined;
}

export async function deletePdf(documentId: string): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(keyFor(documentId));
}
