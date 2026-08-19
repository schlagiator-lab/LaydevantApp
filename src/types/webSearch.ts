// Types pour la fonctionnalité "Recherche web de notices" (Feature recherche
// web notices.md, §3). Distincts de types/database.ts : ces formes ne
// viennent pas du schéma Supabase mais du contrat du pipeline back-end
// (juge LLM, `web_search_jobs.final_results`) et du webhook n8n ingest-from-url.

/** 'video' n'existe pas côté DocType : jamais capturable vers la bibliothèque (CaptureSheet). */
export type WebSearchResultType =
  | 'notice_installation'
  | 'manuel_programmation'
  | 'fiche_technique'
  | 'video'
  | 'autre';

export type WebSearchConfidence = 'haute' | 'moyenne' | 'faible';

export interface WebSearchResult {
  type: WebSearchResultType;
  title: string;
  url: string;
  /** Détermine si "Ajouter à la bibliothèque" est proposé, ou seulement "Ouvrir" (§5). */
  is_pdf: boolean;
  source: string;
  confidence: WebSearchConfidence;
  /** Validation HTTP par le back-end. false = NON VÉRIFIÉ (pas "lien mort") ; absent/null = pas de validation. */
  link_ok?: boolean | null;
  http_status?: number | null;
  content_type?: string | null;
}
