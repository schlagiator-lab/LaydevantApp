import type { WebSearchResultType } from '../types/webSearch';

export interface IngestFromUrlPayload {
  pdf_url: string;
  brand: string;
  model: string;
  specialty_slug: string;
  doc_type: WebSearchResultType;
  title: string;
  source_url: string;
}

/**
 * Capture vers la bibliothèque (Feature recherche web notices.md, §5-6) : le
 * front ne touche jamais Storage ni la table documents directement — tout
 * passe par le webhook n8n ingest-from-url, qui réutilise le pipeline
 * d'ingestion existant (extraction texte, upload, upsert produit/document).
 */
export async function submitIngestFromUrl(payload: IngestFromUrlPayload): Promise<void> {
  const webhookUrl = import.meta.env.VITE_N8N_INGEST_URL;
  if (!webhookUrl) throw new Error("Webhook d'ingestion non configuré.");

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // Limite honnête du §6 : certaines sources fabricant bloquent le
    // téléchargement automatique (403, portail, JS) — ne pas masquer
    // l'échec, le laisser remonter tel quel jusqu'à l'appelant.
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Échec de l'ajout à la bibliothèque (${response.status}).`);
  }
}
