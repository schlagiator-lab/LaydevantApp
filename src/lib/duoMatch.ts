import { supabase } from './supabase';

/**
 * Couche data du mode duo du mini-jeu PdfTetris (brique 4 — lobby +
 * lancement). Wrappers minces autour des RPC `duo_match` (SECURITY DEFINER,
 * créées hors dépôt dans le SQL Editor — voir la conversation, pas de
 * migration à ajouter ici). Aucune logique métier : juste l'appel + le
 * typage, la logique d'attaque/sync réseau reste pour la brique 5.
 */

export type DuoMatchStatus = 'waiting' | 'playing' | 'finished';

/**
 * Ligne complète de `duo_matches` (+ `server_now`, ajouté par la RPC
 * `sync_duo_match`). Colonnes hors périmètre brique 4
 * (`*_attack_total`, `*_died_at`, `*_last_seen`, `server_now`) typées dès
 * maintenant pour que la brique 5 les lise sans re-typage — non consommées
 * ici, où seuls `id`, `code`, `seed`, `status`, `guest` servent.
 */
export interface DuoMatchRow {
  id: string;
  code: string;
  seed: number;
  host: string;
  guest: string | null;
  status: DuoMatchStatus;
  host_attack_total: number;
  guest_attack_total: number;
  host_died_at: string | null;
  guest_died_at: string | null;
  host_last_seen: string;
  guest_last_seen: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  server_now: string;
}

export interface CreatedDuoMatch {
  id: string;
  code: string;
  seed: number;
  status: DuoMatchStatus;
}

export interface JoinedDuoMatch {
  id: string;
  code: string;
  seed: number;
  status: DuoMatchStatus;
  host: string;
}

export interface WaitingDuoMatch {
  id: string;
  code: string;
  host_name: string;
  created_at: string;
}

export async function createDuoMatch(): Promise<CreatedDuoMatch> {
  const { data, error } = await supabase.rpc('create_duo_match');
  if (error) throw error;
  return data as CreatedDuoMatch;
}

/** Lève l'exception 'MATCH_INDISPONIBLE' telle quelle (inexistant / déjà pris
 * / le sien) — à l'appelant de la reconnaître et de l'afficher. */
export async function joinDuoMatch(code: string): Promise<JoinedDuoMatch> {
  const { data, error } = await supabase.rpc('join_duo_match', { p_code: code });
  if (error) throw error;
  return data as JoinedDuoMatch;
}

/** Sert aussi de heartbeat (rafraîchit host_last_seen/guest_last_seen côté
 * serveur à chaque appel) — utilisé en brique 4 pour le poll du lobby côté
 * host ; la sync de jeu (attaques) reste pour la brique 5. */
export async function syncDuoMatch(matchId: string, attackTotal: number, died: boolean): Promise<DuoMatchRow> {
  const { data, error } = await supabase.rpc('sync_duo_match', {
    p_match_id: matchId,
    p_attack_total: attackTotal,
    p_died: died,
  });
  if (error) throw error;
  return data as DuoMatchRow;
}

export async function listWaitingDuoMatches(): Promise<WaitingDuoMatch[]> {
  const { data, error } = await supabase.rpc('list_waiting_duo_matches');
  if (error) throw error;
  return (data ?? []) as WaitingDuoMatch[];
}

/** No-op côté serveur si l'appelant n'est pas host ou si le match n'est plus
 * 'waiting' — jamais d'erreur à gérer pour ce cas côté appelant. */
export async function cancelDuoMatch(matchId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_duo_match', { p_match_id: matchId });
  if (error) throw error;
}
