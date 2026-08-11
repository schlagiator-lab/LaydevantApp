import { supabase } from './supabase';
import type { GalerieItem } from '../types/database';

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
