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

export interface SearchWebNoticesOptions {
  /** Permet à l'appelant de couper le polling proprement (composant démonté). */
  signal?: AbortSignal;
}

type WebSearchJobStatus = 'pending' | 'processing' | 'done' | 'failed';

interface WebSearchJobRow {
  id: string;
  status: WebSearchJobStatus;
  results: WebSearchResult[] | null;
  error: string | null;
}

// La recherche est maintenant asynchrone : un trigger Postgres déclenche un
// workflow n8n à l'insertion du job, qui peut prendre plusieurs dizaines de
// secondes (recherche web réelle). On laisse n8n démarrer avant le premier
// poll, puis on interroge à intervalle régulier.
const INITIAL_POLL_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;
// Pas de balai serveur côté n8n/Postgres : si ce délai est dépassé sans
// done/failed, c'est l'appli elle-même qui marque son propre job en 'failed'
// (RLS : l'utilisateur met à jour ses propres jobs) avant d'abandonner, pour
// ne pas laisser un job orphelin en 'pending'/'processing' indéfiniment.
const CLIENT_TIMEOUT_MS = 180_000;

/** Le job est resté pending/processing au-delà du timeout client — distinct d'un échec serveur. */
export class WebSearchTimeoutError extends Error {
  constructor() {
    super('La recherche a pris trop de temps.');
    this.name = 'WebSearchTimeoutError';
  }
}

/** Le job est passé en statut 'failed' côté n8n/serveur — message porté par job.error. */
export class WebSearchFailedError extends Error {
  constructor(message: string) {
    super(message || 'La recherche web a échoué.');
    this.name = 'WebSearchFailedError';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Recherche annulée.', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Recherche annulée.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Recherche web de notices (Feature recherche web notices.md, §3-4). En ligne
 * uniquement. Crée un job dans `web_search_jobs` (un trigger Postgres lance le
 * workflow n8n) puis poll son statut jusqu'à 'done'/'failed' ou timeout
 * client. `options.signal` permet à l'appelant d'arrêter le polling en cours
 * (ex. démontage du composant) sans lever d'erreur applicative.
 */
export async function searchWebNotices(
  params: WebSearchNoticesParams,
  options: SearchWebNoticesOptions = {},
): Promise<WebSearchResult[]> {
  const { signal } = options;
  const startedAt = Date.now();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  if (!userId) throw new Error('Session absente — impossible de lancer la recherche.');

  const { data, error: insertError } = await supabase
    .from('web_search_jobs')
    .insert({
      user_id: userId,
      brand: params.brand,
      model: params.model,
      equipment_type: params.equipmentType?.trim() || null,
      department_name: params.departmentName ?? null,
      specialty_name: params.specialtyName ?? null,
    })
    .select('id, status, results, error')
    .single();

  if (insertError || !data) {
    console.warn('WEBSEARCH_POLL: échec de création du job —', insertError?.message);
    throw insertError ?? new Error('La recherche web a échoué.');
  }
  const job = data as WebSearchJobRow;

  console.warn('WEBSEARCH_POLL: job créé, id =', job.id);
  let lastStatus: WebSearchJobStatus = job.status;

  await sleep(INITIAL_POLL_DELAY_MS, signal);

  for (;;) {
    if (Date.now() - startedAt > CLIENT_TIMEOUT_MS) {
      console.warn('WEBSEARCH_POLL: timeout client, job =', job.id);
      // Best-effort : même si ce marquage échoue (réseau tombé pile à ce
      // moment-là), on abandonne quand même côté client — l'utilisateur ne
      // doit jamais rester bloqué en attente à cause d'un échec ici.
      const { error: markFailedError } = await supabase
        .from('web_search_jobs')
        .update({ status: 'failed', error: 'Timeout client' })
        .eq('id', job.id);
      if (markFailedError) {
        console.warn(
          'WEBSEARCH_POLL: échec du marquage failed après timeout, job =',
          job.id,
          '—',
          markFailedError.message,
        );
      }
      throw new WebSearchTimeoutError();
    }

    const { data: rowData, error: pollError } = await supabase
      .from('web_search_jobs')
      .select('id, status, results, error')
      .eq('id', job.id)
      .single();

    if (pollError) {
      console.warn('WEBSEARCH_POLL: échec de lecture, job =', job.id, '—', pollError.message);
      throw pollError;
    }
    const row = rowData as WebSearchJobRow;

    if (row.status !== lastStatus) {
      console.warn('WEBSEARCH_POLL: transition', lastStatus, '→', row.status, '| job =', job.id);
      lastStatus = row.status;
    }

    if (row.status === 'done') {
      const results = row.results ?? [];
      console.warn('WEBSEARCH_POLL: terminé, job =', job.id, '| résultats =', results.length);
      return results;
    }

    if (row.status === 'failed') {
      const message = row.error ?? 'La recherche web a échoué.';
      console.warn('WEBSEARCH_POLL: échoué, job =', job.id, '—', message);
      throw new WebSearchFailedError(message);
    }

    // pending / processing : on continue de poller.
    await sleep(POLL_INTERVAL_MS, signal);
  }
}
