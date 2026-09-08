import { supabase } from './supabase';
import type { PrixArticle } from '../types/database';

/** Articles d'une spécialité en mode liste_prix (CLAUDE.md §4), triés alphabétiquement. */
export async function fetchPrixArticles(specialtyId: string): Promise<PrixArticle[]> {
  const { data, error } = await supabase
    .from('prix_articles')
    .select('id, specialty_id, nom, remarque, prix_vente_ht, created_by, created_at, updated_at')
    .eq('specialty_id', specialtyId)
    .is('deleted_at', null)
    .order('nom')
    .returns<PrixArticle[]>();
  if (error) throw error;
  return data ?? [];
}

export interface CreatePrixArticleInput {
  specialty_id: string;
  nom: string;
  remarque: string | null;
  prix_vente_ht: number | null;
}

/** `created_by`/`created_at`/`updated_at` ont des défauts en base — ne jamais les envoyer. */
export async function createPrixArticle(input: CreatePrixArticleInput): Promise<void> {
  const { error } = await supabase.from('prix_articles').insert(input);
  if (error) throw error;
}

export interface UpdatePrixArticleInput {
  nom: string;
  remarque: string | null;
  prix_vente_ht: number | null;
}

export async function updatePrixArticle(id: string, input: UpdatePrixArticleInput): Promise<void> {
  const { error } = await supabase.from('prix_articles').update(input).eq('id', id);
  if (error) throw error;
}
