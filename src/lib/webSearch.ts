import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
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
const CLIENT_TIMEOUT_MS = 135_000;

/** Distingue un abandon côté client (délai dépassé) d'un échec réseau/serveur ordinaire. */
export class WebSearchTimeoutError extends Error {
  constructor() {
    super('La recherche a pris trop de temps.');
    this.name = 'WebSearchTimeoutError';
  }
}

/** Absence de réseau détectée avant l'appel ou pendant celui-ci — distincte d'un vrai timeout serveur. */
export class WebSearchOfflineError extends Error {
  constructor() {
    super('Pas de connexion — réessaie une fois en ligne.');
    this.name = 'WebSearchOfflineError';
  }
}

/**
 * Diagnostic uniquement, jamais affiché à l'utilisateur : `invoke()` réduit
 * toute défaillance à `{ error }` sans jamais rejeter (FunctionsClient.js),
 * donc c'est ici qu'on explicite la cause réelle avant de la réduire au
 * message générique affiché à l'écran — préfixe grep-able en console Chrome
 * distante pour diagnostiquer sur le terrain.
 */
function logClientDiagnostic(cause: string, startedAt: number): void {
  console.warn('WEBSEARCH_CLIENT: cause =', cause, '| écoulé_ms =', Date.now() - startedAt);
}

/** Recherche web de notices (Feature recherche web notices.md, §3-4). En ligne uniquement. */
export async function searchWebNotices(params: WebSearchNoticesParams): Promise<WebSearchResult[]> {
  const startedAt = Date.now();

  if (!navigator.onLine) {
    logClientDiagnostic('offline', startedAt);
    throw new WebSearchOfflineError();
  }

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
    if (timedOut) {
      logClientDiagnostic('timeout', startedAt);
      throw new WebSearchTimeoutError();
    }
    if (!navigator.onLine) {
      logClientDiagnostic('offline', startedAt);
      throw new WebSearchOfflineError();
    }
    // supabase-js n'expose pas directement le code HTTP sur toutes les
    // versions du client — le contexte de la réponse le porte quand présent.
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 429) {
      logClientDiagnostic('http 429', startedAt);
      throw new Error('Limite de recherches web atteinte pour aujourd’hui.');
    }
    if (error instanceof FunctionsHttpError) {
      logClientDiagnostic(`http ${status ?? '?'}`, startedAt);
      throw new Error('La recherche web a échoué.');
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
      logClientDiagnostic('network', startedAt);
      throw new Error('La recherche web a échoué.');
    }
    logClientDiagnostic('app', startedAt);
    throw new Error('La recherche web a échoué.');
  }

  return data?.results ?? [];
}
