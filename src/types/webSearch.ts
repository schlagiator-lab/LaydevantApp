// Types pour la fonctionnalité "Recherche web de notices" (Feature recherche
// web notices.md, §3). Distincts de types/database.ts : ces formes ne
// viennent pas du schéma Supabase mais du contrat de l'Edge Function
// web-search-notices et du webhook n8n ingest-from-url.

import type { DocType } from './database';

/** Sous-ensemble de DocType effectivement produit par l'Edge Function. */
export type WebSearchResultType = Extract<
  DocType,
  'notice_installation' | 'manuel_programmation' | 'fiche_technique' | 'autre'
>;

export type WebSearchConfidence = 'haute' | 'moyenne' | 'faible';

export interface WebSearchResult {
  type: WebSearchResultType;
  title: string;
  url: string;
  /** Détermine si "Ajouter à la bibliothèque" est proposé, ou seulement "Ouvrir" (§5). */
  is_pdf: boolean;
  source: string;
  confidence: WebSearchConfidence;
}
