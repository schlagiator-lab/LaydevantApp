import { supabase } from './supabase';
import { sanitizeFilename, uploadPhotoBytes } from './dossiers';
import type { DocType } from '../types/database';

export interface AddCatalogNoticeResult {
  product_id?: string;
  failed?: boolean;
  message?: string;
}

/**
 * Ajout d'une notice à la bibliothèque SANS dossier client (AddCatalogNoticeScreen,
 * onglet Outils) — sœur de addDossierEquipmentWithNotice (dossiers.ts), même
 * transport (upload en staging R2 sous `equipment-requests/{uuid}`, MÊME
 * `uploadPhotoBytes`) et même Edge Function jumelle
 * (`add-catalog-notice`, gate authentifié, pas admin), mais sans dossier_id
 * ni request_id : le produit n'est rattaché à rien d'autre qu'à sa
 * spécialité.
 *
 * Même normalisation de résultat que addDossierEquipmentWithNotice : sur un
 * non-2xx, l'erreur de functions.invoke est relue via error.context (Response
 * non parsée par supabase-js) pour un message propre plutôt que l'erreur
 * générique.
 */
export async function addCatalogNotice(params: {
  specialtyId: string;
  specialtySlug: string | null;
  brand: string;
  model?: string | null;
  docType: DocType;
  title: string;
  file: File;
}): Promise<AddCatalogNoticeResult> {
  const name = sanitizeFilename(params.file.name);
  const mime = params.file.type || 'application/pdf';
  const stagingId = crypto.randomUUID();
  const { key } = await uploadPhotoBytes(
    params.file,
    `prefix=equipment-requests/${stagingId}&name=${encodeURIComponent(name)}`,
    mime
  );

  const { data, error } = await supabase.functions.invoke('add-catalog-notice', {
    body: {
      specialty_id: params.specialtyId,
      specialty_slug: params.specialtySlug,
      brand: params.brand,
      model: params.model ?? null,
      doc_type: params.docType,
      title: params.title,
      storage_key: key,
      mime,
      file_size: params.file.size,
    },
  });

  if (!error) {
    const payload = data as { product_id?: string } | null;
    return { product_id: payload?.product_id };
  }

  let payload: { error?: string } | null = null;
  const context = (error as { context?: Response }).context;
  if (context) {
    try {
      payload = await context.json();
    } catch {
      payload = null;
    }
  }
  return { failed: true, message: payload?.error ?? error.message };
}
