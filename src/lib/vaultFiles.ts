// Coffre de données sensibles — fichiers chiffrés (tranche 4, modèle
// enveloppe FEK). Couche data pure, aucune UI ici (elle vient en tranche 5).
//
// Zero-knowledge : rien en clair (octets, nom, type) ne quitte jamais le
// client. Le Worker /api/photos ne voit que le préfixe vault/{dossierId}/...
// et des octets déjà chiffrés — la clé de dossier (préfixe R2) est le seul
// signal non chiffré, comme pour toute autre ressource de ce dossier.
//
// Modèle : une FEK (AES-256-GCM) par fichier ; la FEK est "emballée" en la
// CHIFFRANT (symétrique, vault.encryptBytes) sous la DEK du dossier — jamais
// wrapKey/RSA, la DEK n'a que ['encrypt','decrypt']. Les octets ET les
// métadonnées (nom, type) du fichier sont chiffrés sous la FEK, jamais
// directement sous la DEK. Voir src/lib/vault.js pour le cœur crypto (testé,
// 30/30, test-vault.mjs) — aucune fonction crypto n'est réécrite ici.
import { supabase } from './supabase';
import { getAccessToken, uploadPhotoBytes } from './dossiers';
import { getVaultSecret, bootstrapDossierVault } from './vaultSecrets';
import {
  generateFek,
  encryptBytes,
  decryptBytes,
  wrapFekForDek,
  unwrapFekWithDek,
  encryptContent,
  decryptContent,
} from './vault.js';

/** Ligne brute de `vault_files` — tout est chiffré à l'exception de `taille`
 * (taille du fichier en clair, pas un secret) et des identifiants/timestamps. */
export interface VaultFileRow {
  id: string;
  dossier_id: string;
  storage_key: string;
  file_iv: string;
  wrapped_fek: string;
  fek_wrap_iv: string;
  meta_ciphertext: string;
  meta_iv: string;
  dek_version: number;
  taille: number;
  created_at: string;
}

/** Métadonnées déchiffrées EN MÉMOIRE côté client — jamais persistées ainsi. */
interface DecryptedFileMeta {
  name: string;
  mime: string;
}

/** Élément de liste : la ligne brute (nécessaire à `openVaultFile`, qui a
 * besoin de `storage_key`/`wrapped_fek`/`fek_wrap_iv`/`file_iv` pour rouvrir
 * le fichier sans re-décrypter les métadonnées une seconde fois) enrichie du
 * nom et du type déjà déchiffrés pour l'affichage. */
export interface VaultFileListItem extends VaultFileRow, DecryptedFileMeta {}

const VAULT_FILE_COLUMNS =
  'id, dossier_id, storage_key, file_iv, wrapped_fek, fek_wrap_iv, meta_ciphertext, meta_iv, dek_version, taille, created_at';

/**
 * Chiffre et dépose un fichier dans le coffre du dossier. Si le coffre n'a
 * encore aucune ligne `vault_secrets` (aucune note jamais créée), amorce
 * d'abord le coffre via `bootstrapDossierVault` (même séquence que la
 * création via une note — extraite de VaultSheet, seule source, jamais
 * dupliquée ici) et utilise la DEK ainsi créée ; sinon `dek` DOIT être fourni
 * par l'appelant (déjà déballée en session, jamais recherchée ici).
 */
export async function uploadVaultFile(dossierId: string, dek: CryptoKey | null, file: File): Promise<void> {
  const secret = await getVaultSecret(dossierId);
  let activeDek: CryptoKey;
  let dekVersion: number;
  if (!secret) {
    activeDek = await bootstrapDossierVault(dossierId, JSON.stringify([]));
    dekVersion = 1;
  } else {
    if (!dek) {
      throw new Error('Coffre déjà initialisé mais clé indisponible — déverrouille le coffre avant d’ajouter un fichier.');
    }
    activeDek = dek;
    dekVersion = secret.dek_version;
  }

  const fek = await generateFek();
  const fileBytes = await file.arrayBuffer();
  const { ciphertext, iv: fileIv } = await encryptBytes(fek, fileBytes);
  const metaEncrypted = await encryptContent(fek, JSON.stringify({ name: file.name, mime: file.type }));
  const { wrapped_fek: wrappedFek, wrap_iv: wrapIv } = await wrapFekForDek(fek, activeDek);

  // Nom volontairement opaque (pas le nom réel, déjà chiffré dans
  // meta_ciphertext) : rien côté clé/nom d'objet R2 ne doit laisser deviner
  // le type ou le nom du fichier.
  // Cast : Uint8Array<ArrayBufferLike> (retour de encryptBytes) vs BlobPart
  // qui exige Uint8Array<ArrayBuffer> — friction de typage TS 5.7+ sans
  // portée runtime (Blob accepte n'importe quelle vue de tableau typé).
  const { key } = await uploadPhotoBytes(
    new Blob([ciphertext as BlobPart]),
    `prefix=vault/${dossierId}&name=payload.bin`,
    'application/octet-stream',
  );

  const { error } = await supabase.from('vault_files').insert({
    dossier_id: dossierId,
    storage_key: key,
    file_iv: fileIv,
    wrapped_fek: wrappedFek,
    fek_wrap_iv: wrapIv,
    meta_ciphertext: metaEncrypted.ciphertext,
    meta_iv: metaEncrypted.content_iv,
    dek_version: dekVersion,
    taille: file.size,
  });
  if (error) throw error;
}

/**
 * Liste les fichiers du dossier, métadonnées (nom, type) déchiffrées EN
 * MÉMOIRE via la FEK de chaque ligne. Ne touche jamais aux octets du fichier
 * lui-même (pas de GET R2 ici) — seulement la liste et un aperçu textuel.
 */
export async function listVaultFiles(dossierId: string, dek: CryptoKey): Promise<VaultFileListItem[]> {
  const { data, error } = await supabase
    .from('vault_files')
    .select(VAULT_FILE_COLUMNS)
    .eq('dossier_id', dossierId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as VaultFileRow[];

  return Promise.all(
    rows.map(async (row) => {
      const fek = await unwrapFekWithDek(row.wrapped_fek, row.fek_wrap_iv, dek);
      const metaPlain = await decryptContent(fek, row.meta_ciphertext, row.meta_iv);
      const meta = JSON.parse(metaPlain) as DecryptedFileMeta;
      return { ...row, name: meta.name, mime: meta.mime };
    }),
  );
}

/**
 * Récupère les octets chiffrés depuis R2 (même fetch authentifié que
 * `getDossierPlanBlob`), déballe la FEK de la ligne et déchiffre. Le Blob
 * clair renvoyé n'est destiné qu'à un usage éphémère en mémoire (aperçu,
 * partage) — l'appelant révoque l'object URL qu'il en tire, rien n'est
 * persisté ici.
 */
export async function openVaultFile(row: VaultFileRow, dek: CryptoKey): Promise<Blob> {
  const token = await getAccessToken();
  const res = await fetch(`/api/photos/${row.storage_key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Téléchargement du fichier échoué (HTTP ${res.status})`);
  const encryptedBytes = await res.arrayBuffer();

  const fek = await unwrapFekWithDek(row.wrapped_fek, row.fek_wrap_iv, dek);
  const metaPlain = await decryptContent(fek, row.meta_ciphertext, row.meta_iv);
  const meta = JSON.parse(metaPlain) as DecryptedFileMeta;
  const plainBytes = await decryptBytes(fek, encryptedBytes, row.file_iv);
  return new Blob([plainBytes], { type: meta.mime || 'application/octet-stream' });
}

/**
 * Renomme un fichier : déballe sa FEK, ré-chiffre `{name, mime}` sous CETTE
 * MÊME FEK et écrase `meta_ciphertext`/`meta_iv`. Ne touche ni aux octets R2
 * (`storage_key`), ni à `file_iv`, ni à l'emballage de la FEK
 * (`wrapped_fek`/`fek_wrap_iv`), ni à `taille` — seul le JSON métadonnées
 * change. `mime` est repris tel quel de l'appelant (déjà déchiffré via
 * `listVaultFiles`) plutôt que re-déchiffré ici, un aller-retour crypto inutile.
 */
export async function renameVaultFile(row: VaultFileRow, dek: CryptoKey, newName: string, mime: string): Promise<void> {
  const fek = await unwrapFekWithDek(row.wrapped_fek, row.fek_wrap_iv, dek);
  const metaEncrypted = await encryptContent(fek, JSON.stringify({ name: newName, mime }));
  const { error } = await supabase
    .from('vault_files')
    .update({ meta_ciphertext: metaEncrypted.ciphertext, meta_iv: metaEncrypted.content_iv })
    .eq('id', row.id);
  if (error) throw error;
}

/**
 * Supprime la ligne `vault_files` (SDK, RLS `has_dossier_vault_access OR
 * is_vault_admin`) PUIS l'octet R2 en best-effort. Hard delete — pas de
 * `deleted_at` sur cette table (décidé en amont) : un orphelin R2 après un
 * échec du DELETE Worker est silencieux et sans gravité, l'objet reste du
 * chiffré illisible sans la FEK, elle-même déjà supprimée avec la ligne.
 */
export async function deleteVaultFile(row: { id: string; storage_key: string }): Promise<void> {
  const { error } = await supabase.from('vault_files').delete().eq('id', row.id);
  if (error) throw error;

  try {
    const token = await getAccessToken();
    await fetch(`/api/photos/${row.storage_key}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best-effort : voir le commentaire de fonction ci-dessus.
  }
}
