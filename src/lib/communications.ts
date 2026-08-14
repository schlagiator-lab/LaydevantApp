// Communications d'entreprise (item 4) — espace global, sans dossier_id.
// Octets sur Cloudflare R2 via le Worker /api/photos, préfixe communications/
// (cf. CLAUDE.md §2/§3). Même pattern que les plans de dossier (dossiers.ts),
// sans compression : ce sont toujours des PDF, jamais des images.
import { supabase, supabaseUrl } from './supabase';
import { getAccessToken, getPhotoObjectUrl, sanitizeFilename, uploadPhotoBytes } from './dossiers';
import type { Communication, ProfileRole } from '../types/database';

export async function listCommunications(): Promise<Communication[]> {
  const { data, error } = await supabase
    .from('communications_view')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Communication[];
}

export interface UploadCommunicationInput {
  file: File;
  titre?: string | null;
}

/**
 * Aucune compression (PDF, pas une image) : le fichier est envoyé tel quel,
 * avec son mime d'origine. La RLS communications_insert_publisher est le
 * vrai verrou (auteur = auth.uid() ET admin/publisher) — l'erreur, si elle
 * survient, remonte telle quelle ; l'UI ne doit proposer l'upload qu'aux
 * ayants droit (canPublishCommunications), pas s'appuyer dessus comme verrou.
 *
 * Pas de second aller-retour pour joindre auteur_nom : l'appelant est
 * l'auteur, il connaît déjà son propre nom. `auteur_nom` vaut donc `null` sur
 * la ligne renvoyée ; l'écran rechargera via listCommunications (qui, lui,
 * passe par la vue) pour l'obtenir joint.
 */
export async function uploadCommunication({ file, titre }: UploadCommunicationInput): Promise<Communication> {
  const { data: userData } = await supabase.auth.getUser();
  const auteur = userData.user?.id;
  if (!auteur) throw new Error('Session absente — reconnecte-toi.');

  const name = sanitizeFilename(file.name);
  const { key } = await uploadPhotoBytes(file, `prefix=communications&name=${encodeURIComponent(name)}`, file.type);

  const { data: inserted, error: insertError } = await supabase
    .from('communications')
    .insert({
      titre: titre ?? null,
      storage_provider: 'r2',
      storage_key: key,
      mime: file.type,
      taille: file.size,
      auteur,
    })
    .select('id, titre, storage_provider, storage_key, mime, taille, auteur, created_at')
    .single();
  if (insertError) throw insertError;

  return { ...inserted, auteur_nom: null } as Communication;
}

/** Même fetch authentifié que les photos/plans — storage_key porte déjà le
 * préfixe communications/, aucune logique propre nécessaire ici. */
export const getCommunicationObjectUrl = getPhotoObjectUrl;

/**
 * Même fetch authentifié que getPhotoObjectUrl, mais renvoie le Blob brut
 * (re-typé application/pdf, comme fetchPdfBlobR2) plutôt qu'une object URL —
 * nécessaire pour PdfViewer, qui prend un Blob en prop, pas une URL.
 */
export async function getCommunicationBlob(storageKey: string): Promise<Blob> {
  const token = await getAccessToken();
  const res = await fetch(`/api/photos/${storageKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Chargement du PDF échoué (HTTP ${res.status})`);
  const blob = await res.blob();
  return new Blob([blob], { type: 'application/pdf' });
}

/**
 * Soft delete uniquement — l'octet R2 reste récupérable, jamais de
 * suppression d'objet ici (même logique que deleteDossierPlan/Photo).
 *
 * PATCH fetch direct (au lieu du SDK) : la policy SELECT de `communications`
 * est `deleted_at IS NULL`, donc la revalidation de la ligne que PostgREST
 * fait pour la réponse échoue en 42501 dès que `.update()` vient de poser
 * `deleted_at`. `Prefer: return=minimal` supprime cette revalidation — le SDK
 * 2.110.8 n'expose pas ce Prefer par requête, d'où le fetch ciblé ici, sans
 * toucher au client global ni aux autres écritures qui, elles, dépendent de
 * `return=representation` via `.select()`.
 */
export async function softDeleteCommunication(id: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const token = await getAccessToken();
  const res = await fetch(`${supabaseUrl}/rest/v1/communications?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      deleted_at: new Date().toISOString(),
      deleted_by: userData.user?.id ?? null,
    }),
  });
  // return=minimal : succès = 204 No Content, y compris si aucune ligne ne
  // matchait l'id — PostgREST ne distingue pas les deux cas dans ce mode,
  // sans conséquence pour un soft-delete (pas de compteur à en tirer).
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), body);
  }
}

/**
 * is_comms_publisher() côté base ne teste QUE profiles.is_comms_publisher —
 * le cas admin est ajouté ici, pas dans la RPC. Le profil courant n'étant
 * chargé nulle part en mémoire (AuthContext ne porte que la Session Supabase),
 * un select ciblé unique sur profiles suffit — plus simple que deux RPC.
 */
export async function canPublishCommunications(): Promise<boolean> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return false;

  const { data, error } = await supabase
    .from('profiles')
    .select('role, is_comms_publisher')
    .eq('id', userId)
    .single();
  if (error) throw error;

  const row = data as { role: ProfileRole; is_comms_publisher: boolean };
  return row.role === 'admin' || row.is_comms_publisher === true;
}
