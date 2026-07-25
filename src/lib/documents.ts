import { supabase } from './supabase';
import type { BrowseDocumentRow, SearchDocumentsResult } from '../types/database';

/** Online search across the full corpus (CLAUDE.md §3). Requires a query. */
export async function searchDocuments(params: {
  q: string;
  departmentSlug?: string | null;
  specialtySlug?: string | null;
  limit?: number;
}): Promise<SearchDocumentsResult[]> {
  const { data, error } = await supabase.rpc('search_documents', {
    q: params.q,
    p_department_slug: params.departmentSlug ?? null,
    p_specialty_slug: params.specialtySlug ?? null,
    p_limit: params.limit ?? 30,
  });
  if (error) throw error;
  return (data ?? []) as SearchDocumentsResult[];
}

/**
 * Browse-mode listing — no query, so search_documents doesn't apply
 * (CLAUDE.md §4). `specialtyIds` narrows to one specialty (leaf drill-down),
 * several (a department's specialties), or is omitted for the full catalog.
 */
export async function listDocuments(specialtyIds?: string[]): Promise<BrowseDocumentRow[]> {
  let query = supabase
    .from('documents')
    .select('id, title, doc_type, file_path, specialties(name, departments(name)), products(brand, model)')
    .order('title');
  if (specialtyIds) query = query.in('specialty_id', specialtyIds);
  const { data, error } = await query.returns<BrowseDocumentRow[]>();
  if (error) throw error;
  return data ?? [];
}

/**
 * Document counts per specialty, for the Department screen (CLAUDE.md §5.2).
 * No GROUP BY available without touching the schema, so this fetches the
 * (small) id/specialty_id pairs and tallies them client-side.
 */
export async function countDocumentsBySpecialty(
  specialtyIds: string[],
): Promise<Record<string, number>> {
  if (specialtyIds.length === 0) return {};
  const { data, error } = await supabase
    .from('documents')
    .select('specialty_id')
    .in('specialty_id', specialtyIds)
    .returns<{ specialty_id: string }[]>();
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.specialty_id] = (counts[row.specialty_id] ?? 0) + 1;
  }
  return counts;
}

/** Signed URL for a document's PDF — expires in 1h, must be regenerated on demand (§8), never stored. */
export async function getSignedDocumentUrl(filePath: string, expiresInSeconds = 3600) {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(filePath, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Fetches the PDF and re-wraps it with an explicit MIME type instead of
 * pointing the viewer straight at the signed URL. Storage objects uploaded
 * through the n8n workflow can carry the wrong (or no) Content-Type; an
 * `<iframe>` given that URL directly then falls back to Chrome's
 * undisplayable-content placeholder (a plain filename + "Ouvrir" link)
 * instead of rendering the PDF inline. Forcing the type here mirrors what
 * pdfCache.putPdf does for the pinned/offline path, so both paths behave
 * the same way.
 */
export async function fetchPdfBlob(filePath: string, mimeType: string | null): Promise<Blob> {
  const signedUrl = await getSignedDocumentUrl(filePath);
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error(`Téléchargement du PDF impossible (${response.status}).`);
  const blob = await response.blob();
  return new Blob([blob], { type: mimeType || 'application/pdf' });
}
