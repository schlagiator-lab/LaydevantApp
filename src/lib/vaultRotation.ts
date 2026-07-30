// Coffre de données sensibles — rotation de clé d'un dossier (tranche 6).
// Aucune crypto ici : la préparation (déballage, déchiffrement, nouvelle
// DEK, re-chiffrement, ré-emballage) vit dans src/lib/vault.js et dans
// VaultRotationSheet ; ce module ne fait que les lectures nécessaires à
// cette préparation et l'appel à la fonction Postgres qui écrit tout en une
// seule transaction (supabase/migrations/20260730_090000_vault_rotate_secret.sql).
import { supabase } from './supabase';

export interface DossierAccessRecipient {
  user_id: string;
  wrapped_dek: string;
  dek_version: number;
}

/**
 * Toutes les lignes vault_dossier_access d'UN dossier, tous utilisateurs
 * confondus (lecture réservée à l'admin par la policy RLS, comme
 * `getAllVaultDossiers` dans vaultAdmin.ts). Le jeu de user_id retourné EST
 * la liste des destinataires actuels du coffre pour la rotation.
 */
export async function getDossierAccessRows(dossierId: string): Promise<DossierAccessRecipient[]> {
  const { data, error } = await supabase
    .from('vault_dossier_access')
    .select('user_id, wrapped_dek, dek_version')
    .eq('dossier_id', dossierId);
  if (error) throw error;
  return (data ?? []) as DossierAccessRecipient[];
}

export interface RecipientKeyInfo {
  user_id: string;
  public_key: string;
  is_recovery_admin: boolean;
}

/**
 * Clé publique + statut récupérateur des user_id donnés. Lu directement sur
 * vault_user_keys (pas la vue vault_public_keys, filtrée sur
 * access_enabled=true) : on veut la clé d'un destinataire actuel même si son
 * état access_enabled est incohérent, et le flag récupérateur dans la même
 * requête pour le garde-fou de la rotation.
 */
export async function getVaultUserKeyInfo(userIds: string[]): Promise<RecipientKeyInfo[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await supabase
    .from('vault_user_keys')
    .select('user_id, public_key, is_recovery_admin')
    .in('user_id', userIds);
  if (error) throw error;
  return (data ?? []) as RecipientKeyInfo[];
}

export interface RotateVaultSecretParams {
  dossierId: string;
  ciphertext: string;
  contentIv: string;
  expectedDekVersion: number;
  newDekVersion: number;
  accessRows: { user_id: string; wrapped_dek: string }[];
}

/**
 * Appelle rotate_vault_secret (RPC, SECURITY DEFINER) : remplace les lignes
 * vault_dossier_access du dossier ET met à jour vault_secrets dans une seule
 * transaction Postgres. Si un seul destinataire manque, si le nombre de
 * lignes réellement mises à jour ne correspond pas, ou si dek_version a déjà
 * changé (rotation concurrente), la fonction lève une exception et annule
 * TOUT — jamais d'état à moitié écrit, par construction côté serveur.
 */
export async function rotateVaultSecretRpc(params: RotateVaultSecretParams): Promise<void> {
  const { error } = await supabase.rpc('rotate_vault_secret', {
    p_dossier_id: params.dossierId,
    p_ciphertext: params.ciphertext,
    p_content_iv: params.contentIv,
    p_expected_dek_version: params.expectedDekVersion,
    p_new_dek_version: params.newDekVersion,
    p_access_rows: params.accessRows,
  });
  if (error) throw error;
}
