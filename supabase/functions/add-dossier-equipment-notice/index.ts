// Edge Function "add-dossier-equipment-notice".
//
// Sœur de promote-equipment-notice, avec un gate différent : "chemin
// direct" — quand un monteur déclare un équipement
// absent ET joint déjà sa notice ET choisit une spécialité, l'ajout en base
// est immédiat, sans validation admin. Alignée sur le flux web (n8n écrit
// products/documents via sa connexion Postgres privilégiée) plutôt que sur
// le flux de demande classique (dossier_equipment_requests, résolu par un
// admin). Le travail lourd (téléchargement R2, extraction, upload vers
// documents/, insert products/documents) est délégué au MÊME workflow n8n
// que promote-equipment-notice, appelé par le même webhook Header Auth.
//
// Auth : verify_jwt reste ACTIVÉ au déploiement (comme les fonctions
// sœurs) — seul un utilisateur déjà authentifié atteint ce code. Le gate
// est AUTHENTIFIÉ, PAS ADMIN : contrairement à promote-equipment-notice, on
// n'appelle jamais is_vault_admin() ici. Le produit est créé via la RPC
// SECURITY DEFINER `upsert_dossier_product`, rejouée sur un client Supabase
// SCOPÉ UTILISATEUR (jamais service_role pour cet appel) car son gate
// interne lit auth.uid() côté base — il doit voir l'utilisateur appelant,
// pas le rôle de service. `service_role` n'intervient qu'à l'étape 5
// (fermeture d'une demande existante, UPDATE admin-only sur
// dossier_equipment_requests), jamais de fetch manuel vers PostgREST — SDK
// Supabase uniquement, dans les deux cas.
//
// NE PAS modifier promote-equipment-notice, resolve_dossier_equipment_request,
// ni le workflow n8n — cette fonction n'ajoute qu'un second point d'entrée
// vers le même relais n8n, avec ses propres préconditions.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Secrets de fonction — mêmes noms, même webhook n8n que
// promote-equipment-notice (2d) : un seul workflow de promotion, deux
// portes d'entrée avec des préconditions différentes.
const N8N_PROMOTE_URL = Deno.env.get('N8N_PROMOTE_URL');
const N8N_HEADER_AUTH_NAME = Deno.env.get('N8N_HEADER_AUTH_NAME');
const N8N_HEADER_AUTH_SECRET = Deno.env.get('N8N_HEADER_AUTH_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Sous-ensemble complet de documents.doc_type (CLAUDE.md §3) — même check
// que promote-equipment-notice, plus large que les 4 valeurs offertes par
// le formulaire front (EquipmentRequestSheet, NOTICE_DOC_TYPES).
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
    console.error('add-dossier-equipment-notice: secrets n8n manquants (N8N_PROMOTE_URL/N8N_HEADER_AUTH_NAME/N8N_HEADER_AUTH_SECRET)');
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }

  // 1) Garde — AUTHENTIFIÉ, pas admin. Le client scopé utilisateur sert
  // aussi bien à cette vérification qu'à la RPC ci-dessous (étape 4) : même
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
  const userId = userData.user.id;

  // 2) Entrée
  let body: {
    dossier_id?: string;
    specialty_id?: string;
    specialty_slug?: string;
    brand?: string;
    model?: string;
    doc_type?: string;
    title?: string;
    storage_key?: string;
    mime?: string;
    file_size?: number;
    request_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Requête invalide' }, 400);
  }

  const dossierId = (body.dossier_id ?? '').trim();
  const specialtyId = (body.specialty_id ?? '').trim();
  const specialtySlug = body.specialty_slug ?? null;
  const brand = (body.brand ?? '').trim();
  const model = (body.model ?? '').trim() || null;
  const docType = body.doc_type ?? '';
  const title = (body.title ?? '').trim();
  const storageKey = (body.storage_key ?? '').trim();
  const mime = body.mime ?? '';
  const fileSize = body.file_size;
  const requestId = (body.request_id ?? '').trim() || null;

  if (!DOC_TYPES.has(docType)) return json({ ok: false, error: 'doc_type invalide' }, 400);
  if (!brand) return json({ ok: false, error: 'brand manquant' }, 400);
  if (!dossierId) return json({ ok: false, error: 'dossier_id manquant' }, 400);
  if (!specialtyId) return json({ ok: false, error: 'specialty_id manquant' }, 400);
  if (!storageKey) return json({ ok: false, error: 'storage_key manquant' }, 400);
  // Garde-fou : on ne promeut que du staging (notice jointe à une
  // déclaration d'équipement), jamais une clé R2 arbitraire.
  if (!storageKey.startsWith('equipment-requests/')) {
    return json({ ok: false, error: 'storage_key invalide — doit provenir du staging.' }, 400);
  }

  // 3) Produit — RPC SECURITY DEFINER, client SCOPÉ UTILISATEUR (son gate
  // interne lit auth.uid(), qui doit être celui de l'appelant).
  const { data: productId, error: productErr } = await caller.rpc('upsert_dossier_product', {
    p_dossier_id: dossierId,
    p_specialty_id: specialtyId,
    p_brand: brand,
    p_model: model,
  });
  if (productErr || !productId) {
    console.error('add-dossier-equipment-notice: upsert_dossier_product échoué', productErr);
    return json({ ok: false, error: "Échec de la création du produit." }, 502);
  }

  // 4) Relais n8n — même Header Auth que promote-equipment-notice.
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
    console.error('add-dossier-equipment-notice: appel n8n échoué', err);
    return json({ ok: false, error: "Échec de l'ajout en base.", detail: 'Appel réseau échoué' }, 502);
  }

  const n8nText = await n8nResponse.text().catch(() => '');
  let n8nBody: N8nPromoteResponse | null = null;
  try {
    n8nBody = n8nText ? JSON.parse(n8nText) : null;
  } catch {
    n8nBody = null;
  }

  const documentId = n8nBody?.document?.id;
  if (!n8nResponse.ok || n8nBody?.ok === false || !documentId) {
    const detail = (n8nBody?.error ?? n8nText ?? '').slice(0, 300);
    console.error('add-dossier-equipment-notice: n8n a refusé l\'ajout', n8nResponse.status, detail);
    // Le produit créé par l'étape 3 reste en base — sans gravité, il sera
    // réutilisé au prochain essai grâce à l'anti-doublon de
    // upsert_dossier_product (recherche insensible à la casse marque/modèle).
    return json({ ok: false, error: "Échec de l'ajout en base.", detail }, 502);
  }

  // 5) Fermeture de la demande d'origine, si le doc a été joint à une
  // demande existante ('pending') plutôt qu'à une déclaration neuve.
  // service_role : c'est un UPDATE admin-only sur dossier_equipment_requests
  // (RLS §3 — résolution réservée à resolve_dossier_equipment_request en
  // temps normal), et le client scopé utilisateur n'y a pas ce droit.
  // 0 ligne touchée (déjà résolue entre-temps) : idempotent, pas une erreur
  // — le document est de toute façon déjà créé à ce stade. Aucune ligne de
  // suivi de fichier créée ici (contrairement au flux de staging classique).
  //
  // Garde d'appartenance AVANT toute écriture : request_id vient du body,
  // non fiable tel quel — sans ce contrôle, un appelant peut fournir l'id
  // de la demande pending d'un AUTRE dossier et se la faire clôturer
  // (approved + resolved_product_id) avec le produit qu'il vient de créer
  // ici, contournant resolve_dossier_equipment_request (admin-only). On
  // relit donc la demande avec le même client service_role et on compare
  // son dossier_id à celui de la requête courante avant d'écrire quoi que
  // ce soit.
  if (requestId) {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: requestRow, error: requestErr } = await admin
      .from('dossier_equipment_requests')
      .select('dossier_id')
      .eq('id', requestId)
      .maybeSingle();

    if (requestErr) {
      // Échec honnête côté logs uniquement, même précédent que ci-dessous :
      // le document existe déjà, pas de raison de faire échouer toute la
      // requête pour un problème de suivi seul.
      console.error('add-dossier-equipment-notice: lecture de la demande échouée', requestErr);
    } else if (!requestRow || requestRow.dossier_id !== dossierId) {
      return json({ ok: false, error: "La demande référencée n'appartient pas à ce dossier." }, 403);
    } else {
      const { error: closeErr } = await admin
        .from('dossier_equipment_requests')
        .update({
          status: 'approved',
          resolved_by: userId,
          resolved_at: new Date().toISOString(),
          resolved_product_id: productId,
          specialty_id: specialtyId,
        })
        .eq('id', requestId)
        .eq('status', 'pending');
      if (closeErr) {
        // Échec honnête côté logs uniquement : le document existe déjà (n8n a
        // réussi juste avant) — pas de raison de faire échouer toute la
        // requête pour un problème de suivi seul (même précédent que
        // promote-equipment-notice/delete-account, CLAUDE.md §7).
        console.error('add-dossier-equipment-notice: fermeture de la demande échouée', closeErr);
      }
    }
  }

  // 6) Succès
  return json(
    {
      ok: true,
      product_id: productId,
      document_id: documentId,
      file_path: n8nBody?.document?.file_path ?? null,
    },
    200,
  );
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
