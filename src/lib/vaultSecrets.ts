// Coffre de données sensibles — lectures/écritures Supabase pour l'écran
// d'ouverture/édition (tranche 4, "Feature coffre données sensibles.md" §8-9).
// Aucune crypto ici : voir src/lib/vault.js pour le chiffrement/déchiffrement
// et l'emballage de DEK, ce module ne fait que lire/poser des lignes déjà
// chiffrées.
import { supabase } from './supabase';
import type { UserKeyRecord, EncryptedContent } from './vault.js';

export interface VaultUserKeyRow extends UserKeyRecord {
  user_id: string;
}

export interface VaultSecretRow {
  dossier_id: string;
  ciphertext: string;
  content_iv: string;
  dek_version: number;
}

export interface VaultDossierAccessRow {
  dossier_id: string;
  user_id: string;
  wrapped_dek: string;
  dek_version: number;
}

export interface VaultPublicKey {
  user_id: string;
  public_key: string;
}

/** La ligne de clés de l'utilisateur courant — nécessaire à unlockWithPassword. */
export async function getOwnVaultKeyRecord(userId: string): Promise<VaultUserKeyRow | null> {
  const { data, error } = await supabase
    .from('vault_user_keys')
    .select(
      'user_id, public_key, wrapped_private_key_pw, wrapped_private_key_recovery, pw_salt, recovery_salt, pw_iv, recovery_iv, kdf_iterations',
    )
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data as VaultUserKeyRow | null;
}

/** has_vault_access() (SECURITY DEFINER) — distingue un vrai coffre vide d'un
 * accès refusé par la RLS, qui renverrait sinon silencieusement zéro ligne. */
export async function hasVaultAccess(): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_vault_access');
  if (error) throw error;
  return Boolean(data);
}

/** dossier_vault_has_content() (SECURITY DEFINER) — existence seule, jamais de
 * déchiffrement. Sert uniquement à afficher un indicateur vide/non-vide sur
 * le badge "Chiffré" ; à n'appeler qu'après avoir confirmé hasVaultAccess(),
 * sinon rien à en tirer côté affichage. */
export async function dossierVaultHasContent(dossierId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('dossier_vault_has_content', { p_dossier_id: dossierId });
  if (error) throw error;
  return Boolean(data);
}

export async function getVaultSecret(dossierId: string): Promise<VaultSecretRow | null> {
  const { data, error } = await supabase
    .from('vault_secrets')
    .select('dossier_id, ciphertext, content_iv, dek_version')
    .eq('dossier_id', dossierId)
    .maybeSingle();
  if (error) throw error;
  return data as VaultSecretRow | null;
}

export async function getOwnDossierAccess(dossierId: string, userId: string): Promise<VaultDossierAccessRow | null> {
  const { data, error } = await supabase
    .from('vault_dossier_access')
    .select('dossier_id, user_id, wrapped_dek, dek_version')
    .eq('dossier_id', dossierId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data as VaultDossierAccessRow | null;
}

/** Tous les destinataires autorisés (access_enabled = true, admins-récupérateurs
 * inclus) — vers qui emballer la DEK à la création d'un coffre. */
export async function getVaultPublicKeys(): Promise<VaultPublicKey[]> {
  const { data, error } = await supabase.from('vault_public_keys').select('user_id, public_key');
  if (error) throw error;
  return (data ?? []) as VaultPublicKey[];
}

export async function insertVaultSecret(dossierId: string, content: EncryptedContent): Promise<void> {
  const { error } = await supabase.from('vault_secrets').insert({
    dossier_id: dossierId,
    ciphertext: content.ciphertext,
    content_iv: content.content_iv,
    dek_version: 1,
  });
  if (error) throw error;
}

export async function updateVaultSecret(dossierId: string, content: EncryptedContent): Promise<void> {
  const { error } = await supabase
    .from('vault_secrets')
    .update({ ciphertext: content.ciphertext, content_iv: content.content_iv })
    .eq('dossier_id', dossierId);
  if (error) throw error;
}

/**
 * destroy_dossier_vault(p_dossier_id) (SECURITY DEFINER, admin-only côté
 * fonction — vérifie is_vault_admin en interne, lève "NON_AUTORISE: ..."
 * sinon). Supprime vault_dossier_access + vault_secrets du dossier en une
 * transaction. Irréversible : permet de repasser un dossier "vide" au sens
 * de delete_dossier_if_empty même après avoir vidé toutes ses notes (le
 * ciphertext d'un tableau vide reste une ligne vault_secrets non vide).
 */
export async function destroyDossierVault(dossierId: string): Promise<void> {
  const { error } = await supabase.rpc('destroy_dossier_vault', { p_dossier_id: dossierId });
  if (error) throw error;
}

export async function insertDossierAccessRows(rows: VaultDossierAccessRow[]): Promise<void> {
  const { error } = await supabase.from('vault_dossier_access').insert(rows);
  if (error) throw error;
}

/**
 * Pose ou remplace une ligne d'accès (partage/réparation, onglet "Accès" du
 * panneau admin, tranche 5). Upsert plutôt qu'insert : idempotent si le
 * compte a déjà une ligne pour ce dossier — pas de conflit de clé primaire,
 * pas de doublon. Le conflit se résout sur la clé primaire de la table
 * (dossier_id, user_id), par défaut côté PostgREST.
 */
export async function upsertDossierAccessRow(row: VaultDossierAccessRow): Promise<void> {
  const { error } = await supabase.from('vault_dossier_access').upsert(row);
  if (error) throw error;
}
