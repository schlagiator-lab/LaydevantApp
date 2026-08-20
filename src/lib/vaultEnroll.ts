// Coffre de données sensibles — lectures/écriture Supabase pour l'écran
// d'enrôlement (tranche 4). Aucune crypto ici : voir src/lib/vault.js pour
// la génération de clés / l'emballage, ce module ne fait que lire l'état
// et poser la ligne déjà chiffrée dans vault_user_keys.
import { supabase } from './supabase';
import { createUserKeys, generateRecoveryKey } from './vault.js';
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

/**
 * Génère une paire de clés "légère" (flux monteur) : une clé de récupération
 * est requise par `createUserKeys` mais jamais affichée ni conservée — elle
 * n'existe que le temps de cet appel. Seule source de cette séquence,
 * partagée par l'enrôlement initial léger (VaultEnrollScreen) et le
 * ré-enrôlement (reenrollVaultUser ci-dessous) : ne jamais la réinliner
 * ailleurs.
 */
export async function generateLightUserKeyRecord(password: string): Promise<UserKeyRecord> {
  const recoveryKey = generateRecoveryKey();
  return createUserKeys(password, recoveryKey);
}

/**
 * Statut récupérateur de l'utilisateur COURANT (pas un autre compte, à la
 * différence d'AccountsTab/VaultAdminScreen qui lit ce champ pour tous les
 * comptes en tant qu'admin) — sert à cacher le point d'entrée du
 * ré-enrôlement (VaultSheet) : leur voie de secours est le break-glass
 * mutuel entre admins-récupérateurs, jamais ce flux. RLS
 * vault_user_keys_select autorise déjà `user_id = auth.uid()`, donc cette
 * lecture n'exige pas d'être admin. Pas de ligne (jamais enrôlé) → false,
 * cohérent puisque ce cas ne montre de toute façon pas le formulaire de
 * déverrouillage qui héberge ce lien.
 */
export async function isOwnRecoveryAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('vault_user_keys')
    .select('is_recovery_admin')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.is_recovery_admin === true;
}

/**
 * Ré-enrôlement d'un déjà-enrôlé qui a perdu mot de passe ET clé de
 * récupération — jamais un reset de mot de passe (cryptographiquement
 * impossible sans l'un des deux), mais une nouvelle paire complète. La
 * donnée n'est jamais perdue : chaque DEK de dossier reste emballée pour les
 * admins-récupérateurs, qui "réparent l'accès" ensuite (geste existant,
 * inchangé).
 *
 * Persistance UNIQUEMENT via la RPC SECURITY DEFINER `reenroll_vault_user` —
 * jamais `submitVaultEnrollment` (INSERT → conflit de clé primaire, la ligne
 * existe déjà). La RPC remplace la paire dans `vault_user_keys` (sans
 * toucher `access_enabled`) et purge les lignes `vault_dossier_access` de
 * l'appelant côté base ; elle refuse déjà un `is_recovery_admin` — le
 * masquage du point d'entrée (isOwnRecoveryAdmin) n'est donc qu'une
 * première ceinture, pas l'unique garde.
 *
 * Ne passe volontairement PAS par `getVaultEnrollState` : intention
 * distincte de l'enrôlement initial (pas de court-circuit
 * "already-enrolled" ici, c'est justement le cas qu'on traite).
 */
export async function reenrollVaultUser(newPassword: string): Promise<void> {
  const record = await generateLightUserKeyRecord(newPassword);
  const { error } = await supabase.rpc('reenroll_vault_user', {
    p_public_key: record.public_key,
    p_wrapped_private_key_pw: record.wrapped_private_key_pw,
    p_wrapped_private_key_recovery: record.wrapped_private_key_recovery,
    p_pw_salt: record.pw_salt,
    p_recovery_salt: record.recovery_salt,
    p_pw_iv: record.pw_iv,
    p_recovery_iv: record.recovery_iv,
    p_kdf_iterations: record.kdf_iterations,
  });
  if (error) throw error;
}
