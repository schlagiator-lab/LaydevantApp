import { supabase } from './supabase';
import { compressImage, uploadPhotoBytes } from './dossiers';
import type { GalerieItem } from '../types/database';

/** Insensible à la casse et aux accents ("télécommande" ~ "telecommande"). */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Items d'une spécialité en mode galerie (CLAUDE.md §4), lus depuis `galerie_items_view`. */
export async function listGalerieItems(specialtyId: string): Promise<GalerieItem[]> {
  const { data, error } = await supabase
    .from('galerie_items_view')
    .select('id, specialty_id, name, brand, notes, created_at, updated_at, nb_photos, photos')
    .eq('specialty_id', specialtyId)
    .order('name')
    .returns<GalerieItem[]>();
  if (error) throw error;
  return data ?? [];
}

// --- Ajout d'un produit (formulaire ouvert à tout monteur, pas d'admin) ----

export interface CreateGalerieItemInput {
  specialtyId: string;
  name: string;
  brand: string | null;
  notes: string | null;
  createdBy: string;
}

/** Crée l'item ; remonte une erreur lisible si le nom existe déjà dans la spécialité (23505). */
export async function createGalerieItem(input: CreateGalerieItemInput): Promise<string> {
  const { data, error } = await supabase
    .from('galerie_items')
    .insert({
      specialty_id: input.specialtyId,
      name: input.name,
      brand: input.brand,
      notes: input.notes,
      created_by: input.createdBy,
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new Error('Un produit porte déjà ce nom dans cette spécialité.');
    }
    throw error;
  }
  return (data as { id: string }).id;
}

export interface UploadGaleriePhotoResult {
  storage_key: string;
  mime: string;
  largeur: number;
  hauteur: number;
  taille: number;
}

/** Dimensions du blob compressé — compressImage ne les expose pas, on redécode. */
async function readImageDimensions(blob: Blob): Promise<{ largeur: number; hauteur: number }> {
  const bitmap = await createImageBitmap(blob);
  const dims = { largeur: bitmap.width, hauteur: bitmap.height };
  bitmap.close();
  return dims;
}

/** Compresse (pipeline carnet) puis envoie sous galerie/<slug spécialité>/ via le Worker. */
export async function uploadGaleriePhoto(file: File, specialtySlug: string): Promise<UploadGaleriePhotoResult> {
  const blob = await compressImage(file);
  const [{ key, contentType }, { largeur, hauteur }] = await Promise.all([
    uploadPhotoBytes(blob, `prefix=galerie/${specialtySlug}`),
    readImageDimensions(blob),
  ]);
  return { storage_key: key, mime: contentType, largeur, hauteur, taille: blob.size };
}

export interface AddGaleriePhotoRowInput {
  storage_key: string;
  mime: string;
  libelle: string | null;
  largeur: number;
  hauteur: number;
  taille: number;
  sort_order: number;
}

export async function addGaleriePhotoRow(itemId: string, input: AddGaleriePhotoRowInput): Promise<void> {
  const { error } = await supabase.from('galerie_photos').insert({
    item_id: itemId,
    storage_provider: 'r2',
    storage_key: input.storage_key,
    mime: input.mime,
    libelle: input.libelle,
    largeur: input.largeur,
    hauteur: input.hauteur,
    taille: input.taille,
    sort_order: input.sort_order,
  });
  if (error) throw error;
}
