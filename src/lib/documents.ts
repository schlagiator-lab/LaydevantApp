import { supabase } from './supabase';
import { getAccessToken } from './dossiers';
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
 * No GROUP BY available without touching the schema, so one exact head-count
 * request per specialty (in parallel) rather than fetching rows and tallying
 * them client-side — that approach silently capped at PostgREST's default
 * 1000-row limit once a department passed 1000 documents.
 */
export async function countDocumentsBySpecialty(
  specialtyIds: string[],
): Promise<Record<string, number>> {
  if (specialtyIds.length === 0) return {};
  const entries = await Promise.all(
    specialtyIds.map(async (specialtyId) => {
      const { count, error } = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('specialty_id', specialtyId);
      if (error) throw error;
      return [specialtyId, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries);
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
 * trusting the storage response's Content-Type. Objects uploaded through the
 * n8n workflow can carry the wrong (or no) Content-Type; pdf.js and
 * window.open()'d blob URLs both need a correct `application/pdf` type to be
 * recognized. Mirrors what pdfCache.putPdf does for the pinned/offline path.
 */
export async function fetchPdfBlob(filePath: string, mimeType: string | null): Promise<Blob> {
  const signedUrl = await getSignedDocumentUrl(filePath);
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error(`Téléchargement du PDF impossible (${response.status}).`);
  const blob = await response.blob();
  return new Blob([blob], { type: mimeType || 'application/pdf' });
}

/**
 * Pendant R2 de fetchPdfBlob, pour les documents migrés (storage_provider
 * 'r2'). Même contrat de sortie (Blob re-typé) que le chemin Supabase, pour
 * que DocumentScreen n'ait rien d'autre à distinguer en aval. Passe par le
 * Worker /api/photos (§2 CLAUDE.md), authentifié par JWT plutôt que par URL
 * signée — la lecture y est préfixe-agnostique, `documents/` inclus.
 */
export async function fetchPdfBlobR2(filePath: string, mimeType: string | null): Promise<Blob> {
  const token = await getAccessToken();
  const response = await fetch(`/api/photos/documents/${filePath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Téléchargement du PDF impossible (${response.status}).`);
  const blob = await response.blob();
  return new Blob([blob], { type: mimeType || 'application/pdf' });
}
