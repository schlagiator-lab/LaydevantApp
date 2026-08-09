import { supabase } from './supabase';
import type { GameLeaderboardEntry } from '../types/database';

/**
 * Enregistre le score de fin de partie du mini-jeu PdfTetris (table
 * `game_scores`, RLS : chacun n'écrit que sa propre ligne). Ne garde que le
 * MEILLEUR score connu — même logique que le SQL validé
 * (`best_score = greatest(game_scores.best_score, excluded.best_score)`),
 * reproduite ici côté client car l'upsert PostgREST ne sait pas exécuter une
 * expression dépendant de la ligne existante dans sa clause de conflit.
 * `best_lines` suit toujours la partie qui vient de se terminer, sans
 * greatest — comportement identique au SQL validé.
 *
 * Renvoie le meilleur score connu après écriture (pour affichage immédiat).
 */
export async function submitScore(score: number, lines: number): Promise<number> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  if (!userId) throw new Error('Session absente — impossible d\'enregistrer le score.');

  const { data: existing, error: fetchError } = await supabase
    .from('game_scores')
    .select('best_score')
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const bestScore = Math.max(score, existing?.best_score ?? 0);
  const { error } = await supabase.from('game_scores').upsert(
    { user_id: userId, best_score: bestScore, best_lines: lines, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) throw error;

  return bestScore;
}

/** Classement d'équipe, déjà trié par la vue `game_leaderboard`. */
export async function getLeaderboard(limit = 10): Promise<GameLeaderboardEntry[]> {
  const { data, error } = await supabase.from('game_leaderboard').select('*').limit(limit);
  if (error) throw error;
  return (data ?? []) as GameLeaderboardEntry[];
}
