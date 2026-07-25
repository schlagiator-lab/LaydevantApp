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
