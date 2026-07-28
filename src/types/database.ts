// Hand-written types for the fixed Supabase schema documented in CLAUDE.md §3.
// The schema is not owned by this app (managed by the n8n ingestion workflow)
// and must never be altered from here.

export type DocType =
  | 'notice_installation'
  | 'manuel_programmation'
  | 'fiche_technique'
  | 'schema'
  | 'fiche_perso'
  | 'autre';

export type ProfileRole = 'monteur' | 'admin';

export interface Department {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  sort_order: number;
}

export interface Specialty {
  id: string;
  department_id: string;
  name: string;
  slug: string;
  sort_order: number;
}

export interface Product {
  id: string;
  specialty_id: string;
  brand: string | null;
  model: string | null;
  name: string;
}

export interface DocumentRow {
  id: string;
  specialty_id: string;
  product_id: string | null;
  title: string;
  doc_type: DocType;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  content: string | null;
  source_url: string | null;
  retrieved_at: string | null;
  version_label: string | null;
  tags: string[] | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  full_name: string | null;
  role: ProfileRole;
}

export interface PinnedDocument {
  user_id: string;
  document_id: string;
  pinned_at: string;
}

/** Row shape returned by the `search_documents` RPC (CLAUDE.md §3). */
export interface SearchDocumentsResult {
  id: string;
  title: string;
  doc_type: DocType;
  file_path: string;
  specialty_name: string;
  department_name: string;
  product_label: string | null;
  /** Raw HTML from ts_headline — unescaped, contains <b> tags. Never inject
   * directly into the DOM; sanitize per CLAUDE.md §6 before rendering. */
  extrait: string;
  rank: number;
}

/** Shape for the browse-mode query in CLAUDE.md §4 (no RPC, direct select). */
export interface BrowseDocumentRow {
  id: string;
  title: string;
  doc_type: DocType;
  file_path: string;
  specialties: { name: string; departments: { name: string } | null } | null;
  products: { brand: string | null; model: string | null } | null;
}

// Dossiers clients — étape A (sans données sensibles). Schéma déjà en place
// côté Supabase, non modifiable depuis cette app (cf. brief dossiers clients).

export interface Dossier {
  id: string;
  nom_client: string;
  adresse: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export interface DossierProduit {
  dossier_id: string;
  product_id: string;
  note: string | null;
}

export interface DossierDocumentLink {
  dossier_id: string;
  document_id: string;
}

/** Row shape returned by the `search_dossiers` RPC. */
export interface SearchDossiersResult {
  id: string;
  nom_client: string;
  adresse: string | null;
  nb_produits: number;
  nb_documents: number;
}

export type DossierDocumentOrigine = 'equipement' | 'direct';

/**
 * Row shape returned by `dossier_documents_complets` — same naming
 * convention as `search_documents` (CLAUDE.md §3) since it comes from the
 * same schema. `origine` distinguishes notices pulled in via an attached
 * `product_id` from ones rattachées directement to the dossier.
 */
export interface DossierDocumentComplet {
  id: string;
  title: string;
  doc_type: DocType;
  file_path: string;
  specialty_name: string;
  product_label: string | null;
  origine: DossierDocumentOrigine;
}
