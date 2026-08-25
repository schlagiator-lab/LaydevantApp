// Edge Function "add-catalog-notice".
//
// Sœur de add-dossier-equipment-notice, sans aucun dossier client : ajoute
// une notice à la bibliothèque quand un monteur a déjà en main marque +
// modèle + un PDF, sans vouloir passer par un dossier. Même gate
// authentifié (pas admin), même produit créé via une RPC SECURITY DEFINER
// scopée utilisateur, même relais vers le workflow n8n de promotion que
// add-dossier-equipment-notice/promote-equipment-notice.
//
// Auth : verify_jwt reste ACTIVÉ au déploiement (comme les fonctions
// sœurs) — seul un utilisateur déjà authentifié atteint ce code. Le gate
// est AUTHENTIFIÉ, PAS ADMIN. Le produit est créé via la RPC SECURITY
// DEFINER `upsert_product_standalone`, rejouée sur un client Supabase
// SCOPÉ UTILISATEUR (jamais service_role) car son gate interne lit
// auth.uid() côté base.
//
// Contrairement à add-dossier-equipment-notice : pas de dossier_id, pas de
// request_id, pas de client service_role, pas de fermeture de demande —
// cette fonction ne connaît que le produit et la notice.
//
// NE PAS modifier promote-equipment-notice, add-dossier-equipment-notice,
// ni le workflow n8n — cette fonction n'ajoute qu'un troisième point
// d'entrée vers le même relais n8n, avec ses propres préconditions.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Secrets de fonction — mêmes noms, même webhook n8n que
// promote-equipment-notice/add-dossier-equipment-notice : un seul workflow
// de promotion, plusieurs portes d'entrée avec des préconditions différentes.
const N8N_PROMOTE_URL = Deno.env.get('N8N_PROMOTE_URL');
const N8N_HEADER_AUTH_NAME = Deno.env.get('N8N_HEADER_AUTH_NAME');
const N8N_HEADER_AUTH_SECRET = Deno.env.get('N8N_HEADER_AUTH_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Sous-ensemble complet de documents.doc_type (CLAUDE.md §3) — même check
// que promote-equipment-notice/add-dossier-equipment-notice.
const DOC_TYPES = new Set([
  'notice_installation',
  'manuel_programmation',
  'fiche_technique',
  'schema',
  'fiche_perso',
  'autre',
]);

interface N8nPromoteResponse {
  ok?: boolean;
  document?: { id?: string; file_path?: string };
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Méthode non autorisée' }, 405);
  }

  if (!N8N_PROMOTE_URL || !N8N_HEADER_AUTH_NAME || !N8N_HEADER_AUTH_SECRET) {
    console.error('add-catalog-notice: secrets n8n manquants (N8N_PROMOTE_URL/N8N_HEADER_AUTH_NAME/N8N_HEADER_AUTH_SECRET)');
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }

  // 1) Garde — AUTHENTIFIÉ, pas admin. Le client scopé utilisateur sert
  // aussi bien à cette vérification qu'à la RPC ci-dessous (étape 3) : même
  // client, même JWT, jamais is_vault_admin() ici.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Authentification requise.' }, 401);

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ ok: false, error: 'Authentification requise.' }, 401);
  }

  // 2) Entrée
  let body: {
    specialty_id?: string;
    specialty_slug?: string;
    brand?: string;
    model?: string;
    doc_type?: string;
    title?: string;
    storage_key?: string;
    mime?: string;
    file_size?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Requête invalide' }, 400);
  }

  const specialtyId = (body.specialty_id ?? '').trim();
  const specialtySlug = body.specialty_slug ?? null;
  const brand = (body.brand ?? '').trim();
  const model = (body.model ?? '').trim() || null;
  const docType = body.doc_type ?? '';
  const title = (body.title ?? '').trim();
  const storageKey = (body.storage_key ?? '').trim();
  const mime = body.mime ?? '';
  const fileSize = body.file_size;

  if (!DOC_TYPES.has(docType)) return json({ ok: false, error: 'doc_type invalide' }, 400);
  if (!brand) return json({ ok: false, error: 'brand manquant' }, 400);
  if (!specialtyId) return json({ ok: false, error: 'specialty_id manquant' }, 400);
  if (!storageKey) return json({ ok: false, error: 'Un fichier PDF est requis.' }, 400);
  // Garde-fou : on ne promeut que du staging (notice jointe à une
  // déclaration d'équipement), jamais une clé R2 arbitraire.
  if (!storageKey.startsWith('equipment-requests/')) {
    return json({ ok: false, error: 'storage_key invalide — doit provenir du staging.' }, 400);
  }

  // 3) Produit — RPC SECURITY DEFINER, client SCOPÉ UTILISATEUR (son gate
  // interne lit auth.uid(), qui doit être celui de l'appelant).
  const { data: productId, error: productErr } = await caller.rpc('upsert_product_standalone', {
    p_specialty_id: specialtyId,
    p_brand: brand,
    p_model: model,
  });
  if (productErr || !productId) {
    console.error('add-catalog-notice: upsert_product_standalone échoué', productErr);
    return json({ ok: false, error: "Échec de la création du produit." }, 502);
  }

  // 4) Relais n8n — même Header Auth, même payload que
  // add-dossier-equipment-notice/promote-equipment-notice.
  let n8nResponse: Response;
  try {
    n8nResponse = await fetch(N8N_PROMOTE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [N8N_HEADER_AUTH_NAME]: N8N_HEADER_AUTH_SECRET,
      },
      body: JSON.stringify({
        storage_key: storageKey,
        product_id: productId,
        specialty_id: specialtyId,
        specialty_slug: specialtySlug,
        brand,
        doc_type: docType,
        title,
        mime,
        file_size: fileSize,
      }),
    });
  } catch (err) {
    console.error('add-catalog-notice: appel n8n échoué', err);
    return json({ ok: false, error: "Échec de l'ajout en base.", detail: 'Appel réseau échoué' }, 502);
  }

  const n8nText = await n8nResponse.text().catch(() => '');
  let n8nBody: N8nPromoteResponse | null;
  try {
    n8nBody = n8nText ? JSON.parse(n8nText) : null;
  } catch {
    n8nBody = null;
  }

  const documentId = n8nBody?.document?.id;
  if (!n8nResponse.ok || n8nBody?.ok === false || !documentId) {
    const detail = (n8nBody?.error ?? n8nText ?? '').slice(0, 300);
    console.error('add-catalog-notice: n8n a refusé l\'ajout', n8nResponse.status, detail);
    // Le produit créé par l'étape 3 reste en base — sans gravité, il sera
    // réutilisé au prochain essai grâce à l'anti-doublon de
    // upsert_product_standalone (recherche insensible à la casse marque/modèle).
    return json({ ok: false, error: "Échec de l'ajout en base.", detail }, 502);
  }

  // 5) Succès — l'ingestion du document est asynchrone via n8n, exactement
  // comme la sœur : on ne fait pas confiance à document_id/file_path pour
  // le contrat de retour attendu par la tâche, mais product_id suffit ici.
  return json({ ok: true, product_id: productId }, 200);
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
