// Coffre de données sensibles — lectures/écriture Supabase pour l'écran
// d'enrôlement (tranche 4). Aucune crypto ici : voir src/lib/vault.js pour
// la génération de clés / l'emballage, ce module ne fait que lire l'état
// et poser la ligne déjà chiffrée dans vault_user_keys.
import { supabase } from './supabase';
import type { UserKeyRecord } from './vault.js';

export type VaultEnrollFlow = 'strict' | 'light';

export type VaultEnrollState =
  | { status: 'already-enrolled' }
  | { status: 'blocked-no-recovery-admin' }
  | { status: 'ready'; flow: VaultEnrollFlow };

/**
 * Détermine l'état d'enrôlement de l'utilisateur courant :
 *  - déjà enrôlé (ligne vault_user_keys existante) → pas de ré-enrôlement ici ;
 *  - sinon, admin (is_vault_admin, SECURITY DEFINER — évite de dépendre d'une
 *    RLS de `profiles` non documentée dans ce dépôt) → flux strict ;
 *  - sinon (monteur) → flux léger, à condition qu'au moins un admin-récupérateur
 *    existe déjà (vault_recovery_admins), sinon bloqué.
 */
export async function getVaultEnrollState(userId: string): Promise<VaultEnrollState> {
  const { data: existing, error: existingError } = await supabase
    .from('vault_user_keys')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { status: 'already-enrolled' };

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_vault_admin');
  if (adminError) throw adminError;

  if (isAdmin) return { status: 'ready', flow: 'strict' };

  const { count, error: countError } = await supabase
    .from('vault_recovery_admins')
    .select('*', { count: 'exact', head: true });
  if (countError) throw countError;
  if (!count) return { status: 'blocked-no-recovery-admin' };

  return { status: 'ready', flow: 'light' };
}

/**
 * Pose la ligne d'enrôlement. access_enabled et is_recovery_admin ne sont
 * jamais fournis : ils restent au défaut (false) posé par la base, seul un
 * admin les active séparément.
 */
export async function submitVaultEnrollment(userId: string, record: UserKeyRecord): Promise<void> {
  const { error } = await supabase.from('vault_user_keys').insert({ user_id: userId, ...record });
  if (error) throw error;
}
