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

// L'Edge Function a un timeout serveur ~150s (504 IDLE_TIMEOUT) sur les
// recherches longues. On coupe côté client avant ça pour ne pas laisser
// l'utilisateur attendre jusqu'au bout sans retour.
const CLIENT_TIMEOUT_MS = 90_000;

/** Distingue un abandon côté client (délai dépassé) d'un échec réseau/serveur ordinaire. */
export class WebSearchTimeoutError extends Error {
  constructor() {
    super('La recherche a pris trop de temps.');
    this.name = 'WebSearchTimeoutError';
  }
}

/** Recherche web de notices (Feature recherche web notices.md, §3-4). En ligne uniquement. */
export async function searchWebNotices(params: WebSearchNoticesParams): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CLIENT_TIMEOUT_MS);

  let data: { results: WebSearchResult[]; error?: string } | null;
  let error: unknown;
  try {
    ({ data, error } = await supabase.functions.invoke<{ results: WebSearchResult[]; error?: string }>(
      'web-search-notices',
      {
        body: {
          brand: params.brand,
          model: params.model,
          department_name: params.departmentName ?? null,
          specialty_name: params.specialtyName ?? null,
          equipment_type: params.equipmentType?.trim() || null,
        },
        signal: controller.signal,
      },
    ));
  } finally {
    clearTimeout(timer);
  }

  if (error) {
    if (timedOut) throw new WebSearchTimeoutError();
    // supabase-js n'expose pas directement le code HTTP sur toutes les
    // versions du client — le contexte de la réponse le porte quand présent.
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 429) throw new Error('Limite de recherches web atteinte pour aujourd’hui.');
    throw new Error('La recherche web a échoué.');
  }

  return data?.results ?? [];
}
