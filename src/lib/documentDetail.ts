import { supabase } from './supabase';
import type { DocumentRow } from '../types/database';

export interface DocumentDetail {
  doc: DocumentRow;
  specialtyName: string;
  departmentName: string;
  productLabel: string | null;
}

interface DetailRow extends DocumentRow {
  specialties: { name: string; departments: { name: string } | null } | null;
  products: { brand: string | null; model: string | null } | null;
}

/** Full document fetch by id — online only, used when the doc isn't pinned on this device. */
export async function getDocumentDetail(documentId: string): Promise<DocumentDetail> {
  const { data, error } = await supabase
    .from('documents')
    .select(
      'id, specialty_id, product_id, title, doc_type, storage_provider, file_path, file_size, mime_type, content, source_url, retrieved_at, version_label, tags, created_by, created_at, updated_at, specialties(name, departments(name)), products(brand, model)',
    )
    .eq('id', documentId)
    .single()
    .returns<DetailRow>();
  if (error) throw error;

  const { specialties, products, ...doc } = data;
  return {
    doc,
    specialtyName: specialties?.name ?? '',
    departmentName: specialties?.departments?.name ?? '',
    productLabel: [products?.brand, products?.model].filter(Boolean).join(' ') || null,
  };
}
