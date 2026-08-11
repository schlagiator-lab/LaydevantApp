import { supabase } from './supabase';
import type { WebSearchConfidence, WebSearchResult } from '../types/webSearch';

export interface WebSearchNoticesParams {
  brand: string;
  model: string;
  /** Contexte de filtre actif au moment de la saisie, pour affiner la requête (§3). */
  departmentName?: string | null;
  specialtyName?: string | null;
  /** Contexte libre et facultatif saisi par l'utilisateur (ex. "disjoncteur"). */
  equipmentType?: string | null;
}

/** État progressif transmis par `onUpdate` une fois la révélation atteinte (§2 étape 2). */
export interface WebSearchProgressUpdate {
  results: WebSearchResult[];
  /** Vrai tant qu'au moins un moteur n'est pas terminé — faux à la terminaison complète. */
  stillSearching: boolean;
}

export interface SearchWebNoticesOptions {
  /** Permet à l'appelant de couper le polling proprement (composant démonté). */
  signal?: AbortSignal;
  /**
   * Appelé à chaque changement d'état affichable après la révélation
   * (REVEAL_DELAY_MS, ou immédiatement si les deux moteurs finissent avant) :
   * à la révélation elle-même, puis à chaque terminaison de moteur
   * supplémentaire, puis une dernière fois à la terminaison complète.
   */
  onUpdate?: (update: WebSearchProgressUpdate) => void;
}

type WebSearchJobStatus = 'pending' | 'processing' | 'done' | 'failed';
type WebSearchEngine = 'anthropic' | 'perplexity';

interface WebSearchJobRow {
  id: string;
  status_anthropic: WebSearchJobStatus;
  results_anthropic: WebSearchResult[] | null;
  error_anthropic: string | null;
  done_at_anthropic: string | null;
  status_perplexity: WebSearchJobStatus;
  results_perplexity: WebSearchResult[] | null;
  error_perplexity: string | null;
  done_at_perplexity: string | null;
}

const JOB_COLUMNS =
  'id, status_anthropic, results_anthropic, error_anthropic, done_at_anthropic, status_perplexity, results_perplexity, error_perplexity, done_at_perplexity';

// La recherche est maintenant asynchrone à deux moteurs : deux workflows n8n
// indépendants écrivent chacun leur colonne (status_anthropic/status_perplexity)
// à l'insertion du job. On laisse n8n démarrer avant le premier poll, puis on
// interroge à intervalle régulier.
const INITIAL_POLL_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;
// Valeurs de validation, ajustables. Règle de révélation : Perplexity répond
// vite (~20s) mais ramène souvent des documents médiocres ; Anthropic est
// lent (~2-5 min) mais trouve les vraies notices. On n'affiche donc rien
// avant REVEAL_DELAY_MS (le mini-jeu occupe l'utilisateur, cf.
// WebSearchScreen), sauf si les deux moteurs finissent avant — dans ce cas
// le résultat est déjà complet, pas de raison d'attendre. Passé la
// révélation, chaque terminaison de moteur supplémentaire refait remonter
// les vraies notices en tête (comparateur type+confidence, cf.
// compareResults plus bas).
//
// Pas de balai serveur côté n8n/Postgres : passé HARD_LIMIT_MS sans que les
// deux moteurs soient terminés, c'est l'appli elle-même qui marque le(s)
// moteur(s) restant(s) en 'failed' sur leur propre colonne (RLS :
// l'utilisateur met à jour ses propres jobs) avant d'abandonner, pour ne pas
// laisser un job orphelin en 'pending'/'processing' indéfiniment.
const REVEAL_DELAY_MS = 90_000;
const HARD_LIMIT_MS = 300_000;

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

function confidenceRank(confidence: WebSearchConfidence): number {
  switch (confidence) {
    case 'haute':
      return 3;
    case 'moyenne':
      return 2;
    case 'faible':
      return 1;
  }
}

/** Rang de TYPE, meilleur = 1. Priorité au vrai document d'installation/programmation sur les fiches techniques. */
const TYPE_PRIORITY: Record<string, number> = {
  notice_installation: 1,
  manuel_programmation: 1,
  autre: 2,
  fiche_technique: 3,
};
const UNKNOWN_TYPE_RANK = 4;

function typeRank(type: string): number {
  return TYPE_PRIORITY[type] ?? UNKNOWN_TYPE_RANK;
}

/** Ordonne deux résultats : type d'abord (meilleur en premier), puis confidence à type égal. */
function compareResults(a: WebSearchResult, b: WebSearchResult): number {
  const typeDelta = typeRank(a.type) - typeRank(b.type);
  if (typeDelta !== 0) return typeDelta;
  return confidenceRank(b.confidence) - confidenceRank(a.confidence);
}

/** trim + casse du domaine ignorée ; repli sur une comparaison texte si l'URL est malformée. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Fusionne les résultats des deux moteurs, dédupliqués par URL (meilleur selon type puis confidence gagne), triés pareil. */
function mergeAndDedupe(
  anthropicResults: WebSearchResult[],
  perplexityResults: WebSearchResult[],
): WebSearchResult[] {
  const byUrl = new Map<string, WebSearchResult>();
  for (const result of [...anthropicResults, ...perplexityResults]) {
    const key = normalizeUrl(result.url);
    const existing = byUrl.get(key);
    if (!existing || compareResults(result, existing) < 0) {
      byUrl.set(key, result);
    }
  }
  return Array.from(byUrl.values()).sort(compareResults);
}

/** Best-effort : un moteur encore pending/processing à la terminaison est marqué failed sur sa propre colonne. */
async function markEngineFailed(jobId: string, engine: WebSearchEngine, reason: string): Promise<void> {
  const update =
    engine === 'anthropic'
      ? { status_anthropic: 'failed' as const, error_anthropic: reason }
      : { status_perplexity: 'failed' as const, error_perplexity: reason };
  const { error } = await supabase.from('web_search_jobs').update(update).eq('id', jobId);
  if (error) {
    console.warn(
      'WEBSEARCH_POLL: échec du marquage failed —',
      engine,
      '| job =',
      jobId,
      '—',
      error.message,
    );
  }
}

/**
 * Recherche web de notices (Feature recherche web notices.md, §3-4). En ligne
 * uniquement. Crée un job dans `web_search_jobs` (un trigger Postgres lance le
 * workflow n8n) puis poll son statut jusqu'à 'done'/'failed' ou timeout
 * client. `options.signal` permet à l'appelant d'arrêter le polling en cours
 * (ex. démontage du composant) sans lever d'erreur applicative. `options.onUpdate`
 * permet un affichage progressif (révélation à REVEAL_DELAY_MS, mise à jour à
 * chaque moteur qui termine) ; la promesse résolue reste le résultat final
 * complet, pour compatibilité avec un appelant qui ignorerait `onUpdate`.
 */
export async function searchWebNotices(
  params: WebSearchNoticesParams,
  options: SearchWebNoticesOptions = {},
): Promise<WebSearchResult[]> {
  const { signal, onUpdate } = options;
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

  console.warn(
    'WEBSEARCH_POLL: job créé, id =',
    job.id,
    '| anthropic =',
    job.status_anthropic,
    '| perplexity =',
    job.status_perplexity,
  );
  let lastAnthropicStatus: WebSearchJobStatus = job.status_anthropic;
  let lastPerplexityStatus: WebSearchJobStatus = job.status_perplexity;
  let revealed = false;

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
    const statusChangedThisTick =
      row.status_anthropic !== lastAnthropicStatus || row.status_perplexity !== lastPerplexityStatus;

    if (row.status_anthropic !== lastAnthropicStatus) {
      const isTerminal = row.status_anthropic === 'done' || row.status_anthropic === 'failed';
      console.warn(
        'WEBSEARCH_POLL: anthropic',
        lastAnthropicStatus,
        '→',
        row.status_anthropic,
        '| job =',
        job.id,
        ...(isTerminal
          ? [
              '| durée ≈',
              `${Math.round((Date.now() - startedAt) / 1000)}s`,
              '| done_at_anthropic =',
              row.done_at_anthropic,
            ]
          : []),
      );
      lastAnthropicStatus = row.status_anthropic;
    }
    if (row.status_perplexity !== lastPerplexityStatus) {
      const isTerminal = row.status_perplexity === 'done' || row.status_perplexity === 'failed';
      console.warn(
        'WEBSEARCH_POLL: perplexity',
        lastPerplexityStatus,
        '→',
        row.status_perplexity,
        '| job =',
        job.id,
        ...(isTerminal
          ? [
              '| durée ≈',
              `${Math.round((Date.now() - startedAt) / 1000)}s`,
              '| done_at_perplexity =',
              row.done_at_perplexity,
            ]
          : []),
      );
      lastPerplexityStatus = row.status_perplexity;
    }

    const anthropicTerminal = row.status_anthropic === 'done' || row.status_anthropic === 'failed';
    const perplexityTerminal = row.status_perplexity === 'done' || row.status_perplexity === 'failed';
    const anthropicDone = row.status_anthropic === 'done';
    const perplexityDone = row.status_perplexity === 'done';

    let shouldTerminate = false;
    let reason = '';

    if (anthropicTerminal && perplexityTerminal) {
      shouldTerminate = true;
      reason = 'les deux moteurs terminés';
    } else if (elapsed >= HARD_LIMIT_MS) {
      shouldTerminate = true;
      reason = 'limite dure (300s) atteinte, moteur(s) restant(s) non fini(s)';
    }

    if (!shouldTerminate) {
      // Au moins un moteur encore pending/processing, sous la limite dure.
      // Avant REVEAL_DELAY_MS, on n'affiche rien (mini-jeu). Une fois
      // atteint, on révèle l'état courant puis on met à jour à chaque
      // terminaison de moteur supplémentaire (statusChangedThisTick), pas à
      // chaque tick — évite de re-notifier l'appelant pour rien.
      if (elapsed >= REVEAL_DELAY_MS) {
        const justRevealed = !revealed;
        revealed = true;
        if (justRevealed || statusChangedThisTick) {
          const merged = mergeAndDedupe(
            anthropicDone ? row.results_anthropic ?? [] : [],
            perplexityDone ? row.results_perplexity ?? [] : [],
          );
          console.warn(
            'WEBSEARCH_POLL: révélation progressive, job =',
            job.id,
            '| résultats fusionnés =',
            merged.length,
          );
          onUpdate?.({ results: merged, stillSearching: true });
        }
      }
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }

    console.warn('WEBSEARCH_POLL: décision de terminaison —', reason, '| job =', job.id);

    // Best-effort : même si ce marquage échoue (réseau tombé pile à ce
    // moment-là), on termine quand même côté client — l'utilisateur ne doit
    // jamais rester bloqué en attente à cause d'un échec ici. On se base sur
    // l'état lu avant marquage pour distinguer un vrai échec serveur d'un
    // abandon décidé côté client (cf. distinction plus bas).
    if (!anthropicTerminal) {
      await markEngineFailed(job.id, 'anthropic', reason);
    }
    if (!perplexityTerminal) {
      await markEngineFailed(job.id, 'perplexity', reason);
    }

    if (anthropicDone || perplexityDone) {
      const merged = mergeAndDedupe(
        anthropicDone ? row.results_anthropic ?? [] : [],
        perplexityDone ? row.results_perplexity ?? [] : [],
      );
      console.warn('WEBSEARCH_POLL: terminé, job =', job.id, '| résultats fusionnés =', merged.length);
      onUpdate?.({ results: merged, stillSearching: false });
      return merged;
    }

    if (row.status_anthropic === 'failed' && row.status_perplexity === 'failed') {
      const message =
        [row.error_anthropic, row.error_perplexity].filter(Boolean).join(' / ') ||
        'La recherche web a échoué.';
      console.warn('WEBSEARCH_POLL: échoué (les deux moteurs), job =', job.id, '—', message);
      throw new WebSearchFailedError(message);
    }

    console.warn('WEBSEARCH_POLL: timeout, aucun moteur done, job =', job.id);
    throw new WebSearchTimeoutError();
  }
}
