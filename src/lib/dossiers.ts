import { supabase } from './supabase';
import type {
  Dossier,
  SearchDossiersResult,
  DossierDocumentComplet,
  DossierNoteView,
  DossierPhotoView,
} from '../types/database';

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
  const { error } = await supabase.from('dossier_produits').insert({ dossier_id: dossierId, product_id: productId });
  if (error) throw error;
}

export async function removeDossierEquipment(dossierId: string, productId: string): Promise<void> {
  const { error } = await supabase
    .from('dossier_produits')
    .delete()
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
    .limit(30);
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
  const { error } = await supabase.from('dossier_notes').delete().eq('id', noteId);
  if (error) throw error;
}

// --- Carnet public : photos (octets sur Cloudflare R2 via /api/photos) ------

async function getAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Session absente — reconnecte-toi pour gérer les photos.');
  return token;
}

/** Redimensionne + recompresse côté client avant l'upload (respecte l'EXIF). */
async function compressImage(file: File, maxDim = 1600, quality = 0.75): Promise<Blob> {
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
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DossierPhotoView[];
}

export async function uploadDossierPhoto(
  dossierId: string,
  file: File,
  auteur: string
): Promise<void> {
  const blob = await compressImage(file);
  const token = await getAccessToken();
  const res = await fetch(`/api/photos?dossier=${dossierId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload photo échoué (HTTP ${res.status})`);
  const { key } = (await res.json()) as { key: string };
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

export async function deleteDossierPhoto(photo: {
  id: string;
  storage_key: string;
}): Promise<void> {
  // La ligne DB est la source de vérité pour l'UI : on l'enlève d'abord.
  const { error } = await supabase.from('dossier_photos').delete().eq('id', photo.id);
  if (error) throw error;
  // Nettoyage R2 best-effort : un objet orphelin est silencieux et sans gravité.
  try {
    const token = await getAccessToken();
    await fetch(`/api/photos/${photo.storage_key}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* orphelin toléré */
  }
}