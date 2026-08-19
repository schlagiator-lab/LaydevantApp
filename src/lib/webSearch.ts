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

interface WebSearchJobRow {
  id: string;
  status_final: string | null;
  final_results: WebSearchResult[] | null;
}

const JOB_COLUMNS = 'id, status_final, final_results';

// Pipeline back-end unique (n8n + juge LLM) : un trigger Postgres démarre le
// job à l'insert (status_final part sur 'pending' par défaut côté serveur),
// puis passe par 'processing' avant 'done'. On laisse le pipeline démarrer
// avant le premier poll, puis on interroge à intervalle régulier.
const INITIAL_POLL_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;
// Pas de balai serveur côté n8n/Postgres : passé HARD_LIMIT_MS sans que le
// job soit terminé ('done', ou 'error' en défensif), le client abandonne et
// signale une recherche interrompue plutôt que d'attendre indéfiniment.
const HARD_LIMIT_MS = 300_000;

/** Le job est resté pending/processing au-delà du timeout client. */
export class WebSearchTimeoutError extends Error {
  constructor() {
    super('Recherche interrompue, réessaie.');
    this.name = 'WebSearchTimeoutError';
  }
}

/** Le job est passé en statut 'error' côté serveur. */
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
 * pipeline n8n, juge LLM inclus) puis poll `status_final` jusqu'à 'done' ou
 * timeout client. `final_results` arrive déjà trié/dédupliqué par le juge
 * back-end : aucun tri/fusion côté client. `options.signal` permet à
 * l'appelant d'arrêter le polling en cours (ex. démontage du composant) sans
 * lever d'erreur applicative.
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
    .select(JOB_COLUMNS)
    .single();

  if (insertError || !data) {
    console.warn('WEBSEARCH_POLL: échec de création du job —', insertError?.message);
    throw insertError ?? new Error('La recherche web a échoué.');
  }
  const job = data as WebSearchJobRow;

  console.warn('WEBSEARCH_POLL: job créé, id =', job.id, '| status_final =', job.status_final);
  let lastStatus = job.status_final;

  await sleep(INITIAL_POLL_DELAY_MS, signal);

  for (;;) {
    const elapsed = Date.now() - startedAt;

    const { data: rowData, error: pollError } = await supabase
      .from('web_search_jobs')
      .select(JOB_COLUMNS)
      .eq('id', job.id)
      .single();

    if (pollError) {
      console.warn('WEBSEARCH_POLL: échec de lecture, job =', job.id, '—', pollError.message);
      throw pollError;
    }
    const row = rowData as WebSearchJobRow;

    if (row.status_final !== lastStatus) {
      console.warn(
        'WEBSEARCH_POLL: status_final',
        lastStatus,
        '→',
        row.status_final,
        '| job =',
        job.id,
        '| écoulé ≈',
        `${Math.round(elapsed / 1000)}s`,
      );
      lastStatus = row.status_final;
    }

    if (row.status_final === 'done') {
      const results = row.final_results ?? [];
      console.warn('WEBSEARCH_POLL: terminé, job =', job.id, '| résultats =', results.length);
      return results;
    }

    if (row.status_final === 'error') {
      console.warn('WEBSEARCH_POLL: statut error, job =', job.id);
      return [];
    }

    if (elapsed >= HARD_LIMIT_MS) {
      console.warn(
        'WEBSEARCH_POLL: timeout client (limite dure atteinte), job =',
        job.id,
        '| dernier statut =',
        row.status_final,
      );
      throw new WebSearchTimeoutError();
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }
}
