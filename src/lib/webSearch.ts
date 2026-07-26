import { supabase } from './supabase';
import type { WebSearchResult } from '../types/webSearch';

export interface WebSearchNoticesParams {
  brand: string;
  model: string;
  /** Contexte de filtre actif au moment de la saisie, pour affiner la requête (§3). */
  departmentName?: string | null;
  specialtyName?: string | null;
  /** Contexte libre et facultatif saisi par l'utilisateur (ex. "disjoncteur"). */
  equipmentType?: string | null;
}

/** Recherche web de notices (Feature recherche web notices.md, §3-4). En ligne uniquement. */
export async function searchWebNotices(params: WebSearchNoticesParams): Promise<WebSearchResult[]> {
  const { data, error } = await supabase.functions.invoke<{ results: WebSearchResult[]; error?: string }>(
    'web-search-notices',
    {
      body: {
        brand: params.brand,
        model: params.model,
        department_name: params.departmentName ?? null,
        specialty_name: params.specialtyName ?? null,
        equipment_type: params.equipmentType?.trim() || null,
      },
    },
  );

  if (error) {
    // supabase-js n'expose pas directement le code HTTP sur toutes les
    // versions du client — le contexte de la réponse le porte quand présent.
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 429) throw new Error('Limite de recherches web atteinte pour aujourd’hui.');
    throw new Error('La recherche web a échoué.');
  }

  return data?.results ?? [];
}
