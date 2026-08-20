// Coffre de données sensibles — lectures/écritures Supabase pour l'écran
// d'ouverture/édition (tranche 4, "Feature coffre données sensibles.md" §8-9).
// Aucune crypto ici : voir src/lib/vault.js pour le chiffrement/déchiffrement
// et l'emballage de DEK, ce module ne fait que lire/poser des lignes déjà
// chiffrées.
import { supabase } from './supabase';
import { generateDek, encryptContent, wrapDekForUser } from './vault.js';
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

/**
 * Sonde d'existence d'un coffre, indépendante de l'accès (RPC SECURITY
 * DEFINER `dossier_has_vault`) — ne révèle aucun contenu, juste un booléen.
 * Nécessaire car `getVaultSecret` ne peut PAS servir de sonde : sa RLS
 * masque le ciphertext sans accès, donc un coffre existant-mais-inaccessible
 * (ex. ré-enrôlé dont vault_dossier_access vient d'être purgée) renverrait
 * `null` comme un coffre réellement absent — deux situations que VaultSheet
 * doit distinguer avant de proposer d'écrire (bootstrapDossierVault).
 */
export async function dossierHasVault(dossierId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('dossier_has_vault', { p_dossier_id: dossierId });
  if (error) throw error;
  return Boolean(data);
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

/**
 * Amorce un coffre encore vide (aucune ligne `vault_secrets` pour ce
 * dossier) : nouvelle DEK, chiffre `initialPlaintext` sous cette DEK, écrit
 * `vault_secrets`, puis emballe la DEK vers tous les destinataires actuels
 * (`getVaultPublicKeys`) et écrit `vault_dossier_access`. Extrait tel quel de
 * la branche bootstrap de `VaultSheet.persistNotes` (notes) — seule source de
 * cette séquence, aussi appelée par `uploadVaultFile` (fichiers) quand le
 * premier fichier d'un dossier est déposé avant toute note. `initialPlaintext`
 * laisse l'appelant choisir le contenu initial du blob notes (`'[]'` pour un
 * bootstrap déclenché par un fichier, le JSON des notes en cours pour un
 * bootstrap déclenché par la sauvegarde d'une note).
 * @returns la DEK créée (extractable), pour que l'appelant l'utilise
 *   immédiatement sans la redéballer.
 */
export async function bootstrapDossierVault(dossierId: string, initialPlaintext: string): Promise<CryptoKey> {
  const dek = await generateDek();
  const encrypted = await encryptContent(dek, initialPlaintext);
  await insertVaultSecret(dossierId, encrypted);

  const recipients = await getVaultPublicKeys();
  const rows: VaultDossierAccessRow[] = await Promise.all(
    recipients.map(async (r) => ({
      dossier_id: dossierId,
      user_id: r.user_id,
      wrapped_dek: await wrapDekForUser(dek, r.public_key),
      dek_version: 1,
    })),
  );
  try {
    await insertDossierAccessRows(rows);
  } catch (accessErr) {
    throw new Error(
      `Le contenu a été enregistré mais l'octroi des accès a échoué (${
        accessErr instanceof Error ? accessErr.message : String(accessErr)
      }). Contacte un administrateur pour réparer les accès de ce dossier.`,
      { cause: accessErr },
    );
  }
  return dek;
}
