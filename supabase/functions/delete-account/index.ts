// Edge Function "delete-account" — CLAUDE.md §7, pendant symétrique de
// `enroll` côté suppression de compte.
//
// Auth : verify_jwt reste ACTIVÉ (contrairement à enroll) — seul un
// utilisateur déjà authentifié atteint ce code. Le JWT est décodé (pas
// revérifié : Supabase l'a déjà fait au niveau de la passerelle avant
// d'invoquer la fonction, même convention que web-search-notices) pour
// identifier l'appelant.
//
// Toutes les lectures de contrôle (rôle de l'appelant, rôle et statut coffre
// de la cible) passent par service_role plutôt que par un client "rejoue le
// JWT" : il n'y a ici aucune écriture à faire respecter par la RLS comme
// dans web-search-notices (journalisation) — seulement des décisions
// d'autorisation qui aboutissent de toute façon à un geste réservé à
// service_role (auth.admin.deleteUser). Les garde-fous métier (appelant
// admin, cible non-admin, accès coffre déjà révoqué) sont donc appliqués
// explicitement ici, jamais délégués à la RLS.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function userIdFromAuthHeader(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice('Bearer '.length);
    const payloadSegment = token.split('.')[1];
    const json = atob(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = JSON.parse(json).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return json({ error: 'Méthode non autorisée' }, 405);
  }

  const callerId = userIdFromAuthHeader(req.headers.get('Authorization'));
  if (!callerId) return json({ error: 'Non authentifié' }, 401);

  let body: { userId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Requête invalide' }, 400);
  }

  const targetId = (body.userId ?? '').trim();
  if (!targetId) return json({ error: 'Compte cible manquant' }, 400);
  if (targetId === callerId) return json({ error: 'Impossible de supprimer son propre compte.' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // 1) L'appelant est-il admin ?
  const { data: callerProfile, error: callerErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', callerId)
    .maybeSingle();
  if (callerErr) return json({ error: 'Erreur serveur' }, 500);
  if (callerProfile?.role !== 'admin') return json({ error: 'Réservé aux administrateurs.' }, 403);

  // 2) La cible existe-t-elle, et n'est-elle PAS admin ?
  const { data: targetProfile, error: targetErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', targetId)
    .maybeSingle();
  if (targetErr) return json({ error: 'Erreur serveur' }, 500);
  if (!targetProfile) return json({ error: 'Compte introuvable.' }, 404);
  if (targetProfile.role === 'admin') {
    return json({ error: 'Impossible de supprimer un compte administrateur depuis cet écran.' }, 403);
  }

  // 3) Si la cible a une ligne coffre, son accès doit déjà être révoqué, et
  // ce ne doit pas être un récupérateur.
  const { data: vaultRow, error: vaultErr } = await admin
    .from('vault_user_keys')
    .select('access_enabled, is_recovery_admin')
    .eq('user_id', targetId)
    .maybeSingle();
  if (vaultErr) return json({ error: 'Erreur serveur' }, 500);
  if (vaultRow?.access_enabled) {
    return json({ error: "L'accès au coffre doit d'abord être révoqué (onglet Accès)." }, 409);
  }
  if (vaultRow?.is_recovery_admin) {
    return json({ error: 'Impossible de supprimer un compte récupérateur du coffre.' }, 409);
  }

  // 4) Suppression du compte Auth — le cœur du geste, irréversible.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
  if (deleteErr) {
    // Honnête plutôt que masqué : un monteur avec de l'historique (dossiers
    // créés, documents épinglés, notes de carnet...) peut heurter une
    // contrainte de clé étrangère non-cascade sur une table hors de ce
    // dépôt (dossiers.created_by, dossier_notes.auteur, etc.) — l'erreur
    // réelle remonte telle quelle plutôt qu'un message générique trompeur.
    return json({ error: `Suppression échouée : ${deleteErr.message}` }, 500);
  }

  // Best-effort : si profiles n'est pas en ON DELETE CASCADE sur auth.users
  // (schéma géré hors de ce dépôt), on nettoie explicitement pour ne pas
  // laisser un profil orphelin. Le compte Auth est déjà supprimé à ce
  // stade — ne jamais faire échouer la requête pour ce nettoyage.
  await admin.from('profiles').delete().eq('id', targetId);

  return json({ ok: true }, 200);
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
