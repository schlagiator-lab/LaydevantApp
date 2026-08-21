// Edge Function "promote-equipment-notice".
//
// Frontière admin qui promeut une notice PDF jointe en staging à une demande
// d'équipement (dossier_equipment_request_files, R2 sous
// equipment-requests/{requestId}/...) vers la bibliothèque `documents`. Le
// travail lourd (téléchargement R2, extraction de texte, upload vers
// documents/, insert products/documents) est délégué à un workflow n8n déjà
// en place, appelé par webhook protégé en Header Auth (même famille que le
// webhook ingest-from-url, CLAUDE.md §9) — cette fonction assemble le
// payload, vérifie les préconditions et écrit l'ancre d'idempotence après
// succès. Aucune écriture directe dans `documents`/`products` ici (même
// règle que le reste de l'app, CLAUDE.md §3/§16).
//
// Auth : verify_jwt reste ACTIVÉ au déploiement (comme web-search-notices et
// delete-account) — seul un utilisateur déjà authentifié atteint ce code. La
// garde admin rejoue le JWT de l'appelant sur un client Supabase classique
// (jamais service_role pour cette vérification) et appelle la RPC
// is_vault_admin() (SECURITY DEFINER, même rôle admin que le reste de
// l'app — pas une notion propre au coffre). Les LECTURES D'AUTORITÉ
// (fichier/demande, avant relais n8n) et l'ÉCRITURE de l'ancre
// d'idempotence utilisent ensuite service_role, uniquement via le SDK
// Supabase (jamais de fetch manuel vers PostgREST — l'en-tête `apikey` d'un
// fetch manuel serait refusé côté Postgres).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Secrets de fonction — URL/nom d'en-tête/secret du webhook n8n de
// promotion. Jamais commités, jamais dans le front (contrairement à
// VITE_N8N_INGEST_SECRET, ce n'est PAS un garde-fou faible : ce secret ne
// quitte jamais le serveur, CLAUDE.md §13).
const N8N_PROMOTE_URL = Deno.env.get('N8N_PROMOTE_URL');
const N8N_HEADER_AUTH_NAME = Deno.env.get('N8N_HEADER_AUTH_NAME');
const N8N_HEADER_AUTH_SECRET = Deno.env.get('N8N_HEADER_AUTH_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Sous-ensemble complet de documents.doc_type (CLAUDE.md §3) — contrairement
// au formulaire de déclaration d'équipement (front, sous-ensemble à 4
// valeurs), la promotion vers la bibliothèque accepte tout le check DB.
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
    console.error('promote-equipment-notice: secrets n8n manquants (N8N_PROMOTE_URL/N8N_HEADER_AUTH_NAME/N8N_HEADER_AUTH_SECRET)');
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }

  // 1) Garde admin — rejoue le JWT de l'appelant sur son propre client
  // (jamais service_role pour cette vérification), même motif que
  // web-search-notices.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Réservé aux administrateurs.' }, 403);

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isAdmin, error: adminErr } = await caller.rpc('is_vault_admin');
  if (adminErr || isAdmin !== true) {
    return json({ ok: false, error: 'Réservé aux administrateurs.' }, 403);
  }

  // 2) Entrée
  let body: { file_id?: string; title?: string; doc_type?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Requête invalide' }, 400);
  }

  const fileId = (body.file_id ?? '').trim();
  const title = (body.title ?? '').trim();
  const docType = body.doc_type ?? '';

  if (!fileId) return json({ ok: false, error: 'file_id manquant' }, 400);
  if (!DOC_TYPES.has(docType)) return json({ ok: false, error: 'doc_type invalide' }, 400);

  // 3) Lecture d'autorité — service_role, SDK Supabase uniquement.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: file, error: fileErr } = await admin
    .from('dossier_equipment_request_files')
    .select('id, request_id, storage_key, mime, taille, promoted_document_id')
    .eq('id', fileId)
    .maybeSingle();
  if (fileErr) {
    console.error('promote-equipment-notice: lecture fichier échouée', fileErr);
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }
  if (!file) return json({ ok: false, error: 'Notice introuvable.' }, 404);

  if (file.promoted_document_id) {
    return json(
      { ok: false, error: 'Cette notice est déjà dans la bibliothèque.', document_id: file.promoted_document_id },
      409,
    );
  }

  const { data: request, error: requestErr } = await admin
    .from('dossier_equipment_requests')
    .select('id, status, marque, specialty_id, resolved_product_id, specialties(slug)')
    .eq('id', file.request_id)
    .maybeSingle();
  if (requestErr) {
    console.error('promote-equipment-notice: lecture demande échouée', requestErr);
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }
  if (!request) return json({ ok: false, error: 'Demande introuvable.' }, 404);

  if (request.status !== 'approved' || !request.resolved_product_id) {
    return json({ ok: false, error: "La demande doit d'abord être approuvée." }, 409);
  }

  const specialtySlug = (request as { specialties?: { slug?: string } | null }).specialties?.slug ?? null;

  // 4) Relais n8n — Header Auth (nom + secret configurables sans toucher au
  // code, même convention que web-search-notices pour ANTHROPIC_MODEL etc.).
  let n8nResponse: Response;
  try {
    n8nResponse = await fetch(N8N_PROMOTE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [N8N_HEADER_AUTH_NAME]: N8N_HEADER_AUTH_SECRET,
      },
      body: JSON.stringify({
        storage_key: file.storage_key,
        product_id: request.resolved_product_id,
        specialty_id: request.specialty_id,
        specialty_slug: specialtySlug,
        brand: request.marque,
        doc_type: docType,
        title,
        mime: file.mime,
        file_size: file.taille,
      }),
    });
  } catch (err) {
    console.error('promote-equipment-notice: appel n8n échoué', err);
    return json({ ok: false, error: "Échec de l'ingestion.", detail: 'Appel réseau échoué' }, 502);
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
    console.error('promote-equipment-notice: n8n a refusé la promotion', n8nResponse.status, detail);
    // Le fichier de staging reste inchangé (aucune ancre écrite) : l'admin
    // peut réessayer la promotion sans perdre la notice.
    return json({ ok: false, error: "Échec de l'ingestion.", detail }, 502);
  }

  // 5) Ancre d'idempotence — le WHERE ... IS NULL rend l'UPDATE atomique
  // face à une promotion concurrente (deux admins, double-clic) : au plus
  // une des deux écrit réellement l'ancre.
  const { data: updated, error: updateErr } = await admin
    .from('dossier_equipment_request_files')
    .update({ promoted_document_id: documentId })
    .eq('id', fileId)
    .is('promoted_document_id', null)
    .select('id');

  let warning: string | undefined;
  if (updateErr) {
    // Le document existe déjà dans la bibliothèque à ce stade (n8n a
    // réussi) — échec honnête plutôt que de faire échouer toute la requête
    // pour un problème d'écriture de suivi seul (CLAUDE.md §7, précédent
    // delete-account).
    console.error('promote-equipment-notice: écriture ancre échouée', updateErr);
    warning = "Document créé, mais l'ancre de suivi n'a pas pu être enregistrée.";
  } else if ((updated?.length ?? 0) === 0) {
    warning = 'Promotion concurrente détectée.';
  }

  return json(
    {
      ok: true,
      document_id: documentId,
      file_path: n8nBody?.document?.file_path ?? null,
      title,
      ...(warning ? { warning } : {}),
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
