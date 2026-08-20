import { supabase } from './supabase';
import type {
  Dossier,
  SearchDossiersResult,
  DossierDocumentComplet,
  DossierNoteView,
  DossierPhotoView,
  DossierPlanView,
  DocType,
  EquipmentRequest,
  EquipmentRequestFile,
  EquipmentRequestStatus,
} from '../types/database';
import type { PhotoAnnotations } from './photoAnnotations';

/**
 * Dossier list/filter (brief dossiers clients, "LISTE DES DOSSIERS"). An
 * empty `q` returns every dossier — used both for the initial listing and
 * for search-as-you-type filtering by nom_client or adresse.
 */
export async function searchDossiers(q: string): Promise<SearchDossiersResult[]> {
  const { data, error } = await supabase.rpc('search_dossiers', { q });
  if (error) throw error;
  return (data ?? []) as SearchDossiersResult[];
}

export async function getDossier(id: string): Promise<Dossier> {
  const { data, error } = await supabase.from('dossiers').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Dossier;
}

export async function createDossier(input: {
  nomClient: string;
  adresse: string | null;
  notes: string | null;
  createdBy: string;
}): Promise<Dossier> {
  const { data, error } = await supabase
    .from('dossiers')
    .insert({
      nom_client: input.nomClient,
      adresse: input.adresse,
      notes: input.notes,
      created_by: input.createdBy,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as Dossier;
}

export async function updateDossier(
  id: string,
  input: { nomClient: string; adresse: string | null; notes: string | null },
): Promise<Dossier> {
  const { data, error } = await supabase
    .from('dossiers')
    .update({ nom_client: input.nomClient, adresse: input.adresse, notes: input.notes })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Dossier;
}

/** Supprime le dossier seulement s'il est vide (RPC `delete_dossier_if_empty`) —
 * sinon lève une erreur dont le message commence par "DOSSIER_NON_VIDE:". */
export async function deleteDossierIfEmpty(dossierId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_dossier_if_empty', { p_dossier_id: dossierId });
  if (error) throw error;
}

/** RPC `dossier_has_configured_vault` — booléen seul, aucun contenu sensible.
 * Contrairement à `dossierVaultHasContent` (vaultSecrets.ts), appelable par
 * n'importe quel authentifié même sans accès personnel au coffre : sert de
 * pré-check avant suppression pour savoir si un non-admin doit passer par
 * une demande plutôt qu'un soft delete direct. */
export async function dossierHasConfiguredVault(dossierId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('dossier_has_configured_vault', { p_dossier_id: dossierId });
  if (error) throw error;
  return Boolean(data);
}

export type RequestDossierDeletionResult = 'created' | 'already_pending';

/** Crée une demande de suppression (`dossier_deletion_requests`) pour un
 * dossier qu'un non-admin ne peut pas supprimer directement (coffre
 * configuré, trigger côté base). L'index unique partiel sur les demandes
 * `pending` est géré ici : une violation (23505) redevient un état distinct
 * plutôt qu'une exception, pour que l'appelant affiche le bon message. */
export async function requestDossierDeletion(dossierId: string): Promise<RequestDossierDeletionResult> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('dossier_deletion_requests').insert({
    dossier_id: dossierId,
    requested_by: userData.user?.id ?? null,
    reason: 'vault_content',
  });
  if (error) {
    if (error.code === '23505') return 'already_pending';
    throw error;
  }
  return 'created';
}

// --- Demandes d'équipement manuel absent de la base (item 1) --------------

/** Crée une demande d'équipement (`dossier_equipment_requests`) pour un
 * produit absent de la base — résolue plus tard par un admin (voir
 * `resolveEquipmentRequest` dans vaultAdmin.ts). `marque` obligatoire côté
 * appelant ; `modele`/`commentaire` optionnels. */
export async function createEquipmentRequest(input: {
  dossierId: string;
  marque: string;
  modele?: string | null;
  commentaire?: string | null;
}): Promise<EquipmentRequest> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('dossier_equipment_requests')
    .insert({
      dossier_id: input.dossierId,
      requested_by: userData.user?.id ?? null,
      marque: input.marque,
      modele: input.modele ?? null,
      commentaire: input.commentaire ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as EquipmentRequest;
}

/** Demandes d'équipement d'un dossier, plus ancienne d'abord — seulement
 * `pending` par défaut (affichage provisoire dans la fiche dossier) ;
 * `opts.status` pour cibler un autre statut (ex. 'approved', pour le bloc
 * "Demandes approuvées" et la promotion de notices vers la bibliothèque),
 * ou 'all' pour tout récupérer (historique éventuel). `notices` est la
 * ressource imbriquée PostgREST des PDF joints (staging, §11). */
export async function listDossierEquipmentRequests(
  dossierId: string,
  opts?: { status?: EquipmentRequestStatus | 'all' }
): Promise<EquipmentRequest[]> {
  let query = supabase
    .from('dossier_equipment_requests')
    .select('*, notices:dossier_equipment_request_files(*)')
    .eq('dossier_id', dossierId)
    .order('created_at', { ascending: true });
  const status = opts?.status ?? 'pending';
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as EquipmentRequest[];
}

/**
 * Joint une notice PDF à une demande d'équipement (staging, aucune
 * validation admin requise). Octets bruts du fichier, SANS compression —
 * ce n'est jamais une image, contrairement à uploadDossierPhoto. Même
 * mécanisme que uploadDossierPlan : `prefix=equipment-requests/{requestId}`
 * (GENERIC_PREFIX_RE côté Worker, slug = request_id) + `name=` pour
 * préserver la vraie extension du fichier.
 */
export async function attachEquipmentRequestNotice(
  requestId: string,
  file: File,
  docTypeSuggere?: DocType | null
): Promise<EquipmentRequestFile> {
  const name = sanitizeFilename(file.name);
  const mime = file.type || 'application/pdf';
  const { key } = await uploadPhotoBytes(file, `prefix=equipment-requests/${requestId}&name=${encodeURIComponent(name)}`, mime);

  const { data, error } = await supabase
    .from('dossier_equipment_request_files')
    .insert({
      request_id: requestId,
      storage_provider: 'r2',
      storage_key: key,
      nom_fichier: file.name,
      mime,
      taille: file.size,
      doc_type_suggere: docTypeSuggere ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as EquipmentRequestFile;
}

/** Même fetch authentifié que getDossierPlanBlob (Blob re-typé
 * application/pdf pour PdfViewer) — dupliqué plutôt que partagé, la clé
 * `/api/photos/{storageKey}` est déjà complète et indépendante du préfixe
 * appelant. */
export async function getEquipmentRequestNoticeBlob(storageKey: string): Promise<Blob> {
  const token = await getAccessToken();
  const res = await fetch(`/api/photos/${storageKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Chargement de la notice échoué (HTTP ${res.status})`);
  const blob = await res.blob();
  return new Blob([blob], { type: 'application/pdf' });
}

/**
 * Hard delete — pas de `deleted_at` sur cette table (staging). Ligne DB
 * d'abord (source de vérité UI), octet R2 en best-effort ensuite, même
 * convention que deleteVaultFile (vaultFiles.ts) : un DELETE Worker refusé
 * (non-admin) ou en échec réseau laisse un orphelin R2 toléré plutôt que de
 * bloquer la suppression côté utilisateur. Aucune logique de permission
 * côté client — la RLS (auteur OU is_vault_admin) et le Worker tranchent.
 */
export async function deleteEquipmentRequestNotice(fileId: string, storageKey: string): Promise<void> {
  const { error } = await supabase.from('dossier_equipment_request_files').delete().eq('id', fileId);
  if (error) throw error;

  try {
    const token = await getAccessToken();
    await fetch(`/api/photos/${storageKey}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best-effort : voir le commentaire de fonction ci-dessus.
  }
}

/**
 * Supprime une demande d'équipement entière (`delete_dossier_equipment_request`,
 * SECURITY DEFINER — admin toujours, auteur uniquement si encore 'pending' ;
 * pas de policy DELETE côté RLS sur cette table). Les lignes
 * `dossier_equipment_request_files` disparaissent via l'ON DELETE CASCADE
 * de la RPC ; les octets R2 des notices jointes sont nettoyés en best-effort
 * AVANT l'appel RPC (storage_key doit encore être connu côté client à ce
 * moment-là), même tolérance à l'orphelin que deleteEquipmentRequestNotice.
 */
export async function deleteEquipmentRequest(request: EquipmentRequest): Promise<void> {
  const token = await getAccessToken();
  for (const notice of request.notices ?? []) {
    try {
      await fetch(`/api/photos/${notice.storage_key}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Best-effort : voir le commentaire de fonction ci-dessus.
    }
  }

  const { error } = await supabase.rpc('delete_dossier_equipment_request', { p_request_id: request.id });
  if (error) throw error;
}

export interface PromoteEquipmentNoticeResult {
  document_id?: string;
  alreadyPromoted?: boolean;
  failed?: boolean;
  message?: string;
}

/**
 * Promeut une notice de staging vers la bibliothèque via l'Edge Function
 * `promote-equipment-notice` (admin-only, gate côté serveur). Résultat
 * normalisé plutôt que l'erreur brute de `functions.invoke` : sur un
 * non-2xx, supabase-js expose la réponse via `error.context` (un `Response`
 * qu'il faut lire nous-mêmes, PostgREST ne l'a pas déjà parsé) — c'est ce
 * qui distingue le 409 "déjà promue" (payload avec `document_id`) du reste
 * (400/403/404/409 "pas approuvée"/500/502, tous traités comme un échec
 * générique par l'appelant).
 */
export async function promoteEquipmentNotice(
  fileId: string,
  title: string,
  docType: string
): Promise<PromoteEquipmentNoticeResult> {
  const { data, error } = await supabase.functions.invoke('promote-equipment-notice', {
    body: { file_id: fileId, title, doc_type: docType },
  });

  if (!error) {
    return { document_id: (data as { document_id?: string } | null)?.document_id };
  }

  let payload: { error?: string; document_id?: string } | null = null;
  const context = (error as { context?: Response }).context;
  if (context) {
    try {
      payload = await context.json();
    } catch {
      payload = null;
    }
  }

  if (payload?.document_id) {
    return { alreadyPromoted: true, document_id: payload.document_id };
  }
  return { failed: true, message: payload?.error ?? error.message };
}

/** Toutes les notices du dossier (équipements + rattachements directs), dédupliquées. */
export async function getDossierDocumentsComplets(dossierId: string): Promise<DossierDocumentComplet[]> {
  const { data, error } = await supabase.rpc('dossier_documents_complets', { p_dossier_id: dossierId });
  if (error) throw error;
  return (data ?? []) as DossierDocumentComplet[];
}

export interface DossierEquipment {
  productId: string;
  note: string | null;
  productLabel: string;
  specialtyName: string;
}

interface DossierProduitRow {
  product_id: string;
  note: string | null;
  products: {
    brand: string | null;
    model: string | null;
    name: string;
    specialties: { name: string } | null;
  } | null;
}

export async function listDossierEquipments(dossierId: string): Promise<DossierEquipment[]> {
  const { data, error } = await supabase
    .from('dossier_produits')
    .select('product_id, note, products(brand, model, name, specialties(name))')
    .eq('dossier_id', dossierId)
    .is('deleted_at', null)
    .returns<DossierProduitRow[]>();
  if (error) throw error;
  return (data ?? []).map((row) => ({
    productId: row.product_id,
    note: row.note,
    productLabel: [row.products?.brand, row.products?.model].filter(Boolean).join(' ') || row.products?.name || '',
    specialtyName: row.products?.specialties?.name ?? '',
  }));
}

export async function addDossierEquipment(dossierId: string, productId: string): Promise<void> {
  const { error } = await supabase
    .from('dossier_produits')
    .upsert(
      { dossier_id: dossierId, product_id: productId, deleted_at: null, deleted_by: null },
      { onConflict: 'dossier_id,product_id' }
    );
  if (error) throw error;
}

export async function removeDossierEquipment(dossierId: string, productId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('dossier_produits')
    .update({ deleted_at: new Date().toISOString(), deleted_by: userData.user?.id ?? null })
    .eq('dossier_id', dossierId)
    .eq('product_id', productId);
  if (error) throw error;
}

export async function addDossierDocument(dossierId: string, documentId: string): Promise<void> {
  const { error } = await supabase
    .from('dossier_documents')
    .insert({ dossier_id: dossierId, document_id: documentId });
  if (error) throw error;
}

export async function removeDossierDocument(dossierId: string, documentId: string): Promise<void> {
  const { error } = await supabase
    .from('dossier_documents')
    .delete()
    .eq('dossier_id', dossierId)
    .eq('document_id', documentId);
  if (error) throw error;
}

export interface ProductSearchResult {
  id: string;
  productLabel: string;
  specialtyName: string;
}

interface ProductSearchRow {
  id: string;
  brand: string | null;
  model: string | null;
  name: string;
  specialties: { name: string } | null;
}

/** Product picker backing "Ajouter un équipement" — matches brand, model or name. */
export async function searchProducts(q: string): Promise<ProductSearchResult[]> {
  let query = supabase
    .from('products')
    .select('id, brand, model, name, specialties(name)')
    .order('name')
    .limit(100);
  const trimmed = q.trim();
  if (trimmed) {
    query = query.or(`brand.ilike.%${trimmed}%,model.ilike.%${trimmed}%,name.ilike.%${trimmed}%`);
  }
  const { data, error } = await query.returns<ProductSearchRow[]>();
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    productLabel: [row.brand, row.model].filter(Boolean).join(' ') || row.name,
    specialtyName: row.specialties?.name ?? '',
  }));
}
// --- Carnet public : notes -------------------------------------------------

export async function listDossierNotes(dossierId: string): Promise<DossierNoteView[]> {
  const { data, error } = await supabase
    .from('dossier_notes_view')
    .select('*')
    .eq('dossier_id', dossierId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DossierNoteView[];
}

export async function createDossierNote(input: {
  dossierId: string;
  titre: string | null;
  texte: string;
  auteur: string;
}): Promise<void> {
  const { error } = await supabase.from('dossier_notes').insert({
    dossier_id: input.dossierId,
    titre: input.titre,
    texte: input.texte,
    auteur: input.auteur,
  });
  if (error) throw error;
}

export async function updateDossierNote(
  noteId: string,
  input: { titre: string | null; texte: string }
): Promise<void> {
  const { error } = await supabase
    .from('dossier_notes')
    .update({ titre: input.titre, texte: input.texte })
    .eq('id', noteId);
  if (error) throw error;
}

export async function deleteDossierNote(noteId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('dossier_notes')
    .update({ deleted_at: new Date().toISOString(), deleted_by: userData.user?.id ?? null })
    .eq('id', noteId);
  if (error) throw error;
}

// --- Carnet public : photos (octets sur Cloudflare R2 via /api/photos) ------

export async function getAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Session absente — reconnecte-toi pour gérer les photos.');
  return token;
}

/** Redimensionne + recompresse côté client avant l'upload (respecte l'EXIF). */
export async function compressImage(file: File, maxDim = 1600, quality = 0.75): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponible');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Compression échouée'))),
      'image/jpeg',
      quality
    );
  });
}

export async function listDossierPhotos(dossierId: string): Promise<DossierPhotoView[]> {
  const { data, error } = await supabase
    .from('dossier_photos_view')
    .select('*')
    .eq('dossier_id', dossierId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DossierPhotoView[];
}

/** Envoi authentifié des octets vers le Worker /api/photos (§2/§10 CLAUDE.md).
 * `contentType` par défaut à 'image/jpeg' pour ne rien changer à l'appelant
 * historique (uploadDossierPhoto) ; les plans (PDF/DWG/...) passent leur
 * propre mime dérivé par extension (derivePlanType). */
export async function uploadPhotoBytes(
  blob: Blob,
  query: string,
  contentType = 'image/jpeg'
): Promise<{ key: string; contentType: string }> {
  const token = await getAccessToken();
  const res = await fetch(`/api/photos?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload photo échoué (HTTP ${res.status})`);
  return res.json() as Promise<{ key: string; contentType: string }>;
}

export async function uploadDossierPhoto(
  dossierId: string,
  file: File,
  auteur: string
): Promise<void> {
  const blob = await compressImage(file);
  const { key } = await uploadPhotoBytes(blob, `dossier=${dossierId}`);
  const { error } = await supabase.from('dossier_photos').insert({
    dossier_id: dossierId,
    storage_provider: 'r2',
    storage_key: key,
    mime: 'image/jpeg',
    taille: blob.size,
    auteur,
  });
  if (error) throw error;
}

/** Récupère les octets (JWT requis) et renvoie un object URL à révoquer après usage. */
export async function getPhotoObjectUrl(storageKey: string): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch(`/api/photos/${storageKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Chargement photo échoué (HTTP ${res.status})`);
  return URL.createObjectURL(await res.blob());
}

export async function updateDossierPhotoTitre(photoId: string, titre: string | null): Promise<void> {
  const { error } = await supabase.from('dossier_photos').update({ titre }).eq('id', photoId);
  if (error) throw error;
}

export async function updateDossierPhotoAnnotations(
  photoId: string,
  annotations: PhotoAnnotations | null
): Promise<void> {
  const { error } = await supabase.from('dossier_photos').update({ annotations }).eq('id', photoId);
  if (error) throw error;
}

export async function deleteDossierPhoto(photo: {
  id: string;
  storage_key: string;
}): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('dossier_photos')
    .update({ deleted_at: new Date().toISOString(), deleted_by: userData.user?.id ?? null })
    .eq('id', photo.id);
  if (error) throw error;
}

// --- Plans du dossier (octets sur Cloudflare R2 via /api/photos, préfixe plans/) --

export type DossierPlanKind = 'pdf' | 'dwg' | 'image' | 'file';

const PLAN_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function fileBaseName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? filename : filename.slice(0, dot);
}

/**
 * Le navigateur ne renseigne pas fiablement le mime d'un .dwg (souvent
 * application/octet-stream ou vide) — le type se dérive donc par extension du
 * nom de fichier, pas par File.type. 'kind' pilote l'affichage (PlansSection),
 * 'mime' est ce qu'on stocke en base et qu'on envoie au Worker comme
 * Content-Type réel de l'objet R2.
 */
export function derivePlanType(file: File): { kind: DossierPlanKind; mime: string } {
  const ext = fileExtension(file.name);
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (ext === 'dwg') return { kind: 'dwg', mime: 'application/acad' };
  if (PLAN_IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', mime: file.type };
  return { kind: 'file', mime: file.type || 'application/octet-stream' };
}

/** Charset restreint au NAME_RE du Worker ([a-zA-Z0-9._-]) : diacritiques
 * retirées, tout le reste remplacé par "_", jamais vide. Exportée pour être
 * réutilisée par communications.ts (même contrainte de nommage côté Worker). */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return (cleaned || 'fichier').slice(0, 120);
}

/**
 * Même fetch authentifié que getPhotoObjectUrl, mais renvoie le Blob brut
 * (re-typé application/pdf, comme getCommunicationBlob côté communications)
 * plutôt qu'une object URL — nécessaire pour PdfViewer, qui prend un Blob en
 * prop, pas une URL. window.open('blob:…') sur iOS échoue quand il suit un
 * await (Safari bloque tout window.open hors du geste synchrone) — d'où le
 * viewer PdfViewer in-app dans PlansSection plutôt que window.open.
 */
export async function getDossierPlanBlob(storageKey: string): Promise<Blob> {
  const token = await getAccessToken();
  const res = await fetch(`/api/photos/${storageKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Chargement du PDF échoué (HTTP ${res.status})`);
  const blob = await res.blob();
  return new Blob([blob], { type: 'application/pdf' });
}

export async function listDossierPlans(dossierId: string): Promise<DossierPlanView[]> {
  const { data, error } = await supabase
    .from('dossier_plans_view')
    .select('*')
    .eq('dossier_id', dossierId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DossierPlanView[];
}

/**
 * Compresse si image (comme les photos du carnet), envoie tel quel sinon
 * (PDF/DWG/autre — jamais de recompression). Le nom envoyé au Worker porte
 * toujours la VRAIE extension du contenu effectivement stocké : .jpg pour une
 * image (compressImage réencode systématiquement en JPEG), l'extension
 * d'origine pour le reste — jamais celle, potentiellement trompeuse, du
 * fichier original de l'utilisateur pour une image (ex. .heic).
 */
export async function uploadDossierPlan(dossierId: string, file: File, auteur: string): Promise<void> {
  const { kind, mime } = derivePlanType(file);

  let bytes: Blob = file;
  let largeur: number | null = null;
  let hauteur: number | null = null;
  let name = sanitizeFilename(file.name);

  if (kind === 'image') {
    bytes = await compressImage(file);
    name = sanitizeFilename(`${fileBaseName(file.name)}.jpg`);
    try {
      const bitmap = await createImageBitmap(bytes);
      largeur = bitmap.width;
      hauteur = bitmap.height;
      bitmap.close();
    } catch {
      // Dimensions best-effort seulement — l'upload continue sans elles.
    }
  }

  const { key } = await uploadPhotoBytes(bytes, `prefix=plans/${dossierId}&name=${encodeURIComponent(name)}`, mime);

  const { error } = await supabase.from('dossier_plans').insert({
    dossier_id: dossierId,
    storage_provider: 'r2',
    storage_key: key,
    mime,
    taille: bytes.size,
    largeur,
    hauteur,
    auteur,
  });
  if (error) throw error;
}

export async function updateDossierPlanTitre(planId: string, titre: string | null): Promise<void> {
  const { error } = await supabase.from('dossier_plans').update({ titre }).eq('id', planId);
  if (error) throw error;
}

/** Soft delete uniquement — le fichier R2 doit rester récupérable, jamais de
 * suppression d'objet ici (même logique que deleteDossierPhoto). */
export async function deleteDossierPlan(planId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('dossier_plans')
    .update({ deleted_at: new Date().toISOString(), deleted_by: userData.user?.id ?? null })
    .eq('id', planId);
  if (error) throw error;
}
