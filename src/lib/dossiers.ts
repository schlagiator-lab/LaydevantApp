import { supabase } from './supabase';
import type { Dossier, SearchDossiersResult, DossierDocumentComplet } from '../types/database';

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
