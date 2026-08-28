// Edge Function "send-push" — brique 4 des notifications push.
//
// Envoie une notification Web Push à TOUS les abonnés de push_subscriptions.
// Déclenchée en brique 5 par un Database Webhook sur INSERT dans
// `communications` (payload imposé { record, ... }, record.titre mappé vers
// le corps de la notif) ; accepte aussi { title, body } libre pour les tests
// manuels (curl/Postman).
//
// Auth : verify_jwt DOIT être désactivé au déploiement (comme enroll,
// `supabase functions deploy send-push --no-verify-jwt`) — l'appelant est un
// Database Webhook, pas un utilisateur authentifié, donc pas de JWT. Le
// verrou est le header `x-push-secret` (PUSH_HOOK_SECRET), vérifié en tout
// premier ci-dessous, avant tout accès à la base.
//
// service_role UNIQUEMENT ici : push_subscriptions a sa RLS verrouillée
// (accès direct interdit), cette fonction la contourne par design pour lire
// tous les abonnés. Le secret ne quitte jamais cette fonction serveur.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-push-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PUSH_HOOK_SECRET = Deno.env.get('PUSH_HOOK_SECRET');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT');
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Nettoie `communications.titre` (nom de fichier brut déposé à l'upload,
// CLAUDE.md §17 — pas une phrase soignée) pour l'affichage dans le corps de
// la notif : retire l'extension finale, remplace '_'/'-' par des espaces,
// collapse les espaces multiples, trim, puis tronque à ~120 caractères.
function cleanTitreForNotif(titre: string | null | undefined): string {
  const fallback = 'Une nouvelle communication est disponible';
  if (!titre) return fallback;
  const cleaned = titre
    .replace(/\.[a-zA-Z0-9]{1,10}$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Méthode non autorisée' }, 405);
  }

  // 1) Garde d'entrée — secret partagé avec le futur Database Webhook
  // (brique 5), jamais un JWT utilisateur : cette fonction n'est pas
  // appelée par le front. Fail-closed si PUSH_HOOK_SECRET n'est pas
  // configuré côté fonction (comparaison à `undefined` ne matche jamais).
  if (!PUSH_HOOK_SECRET || req.headers.get('x-push-secret') !== PUSH_HOOK_SECRET) {
    return json({ ok: false, error: 'Non autorisé' }, 401);
  }

  if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('send-push: secrets VAPID manquants (VAPID_SUBJECT/VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)');
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }

  // 2) Payload — deux formats acceptés :
  // - { record, ... } : format imposé par le Database Webhook Supabase
  //   (brique 5, INSERT sur communications) — `record` est la ligne insérée.
  // - { title, body } : format libre pour les tests manuels (curl/Postman),
  //   comportement inchangé.
  // test_user_id : réservé aux tests manuels, absent en production, valide
  // dans les deux formats.
  let body: {
    title?: string;
    body?: string;
    test_user_id?: string;
    record?: { titre?: string | null; deleted_at?: string | null };
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const testUserId = (body.test_user_id ?? '').trim() || null;

  let title: string;
  let notifBody: string;
  if (body.record) {
    // Sécurité : ne jamais notifier une ligne déjà soft-deletée (deleted_at
    // posé entre l'INSERT et l'appel webhook, ou webhook rejoué).
    if (body.record.deleted_at) {
      return json({ sent: 0 }, 200);
    }
    title = 'Nouvelle communication';
    notifBody = cleanTitreForNotif(body.record.titre);
  } else {
    title = body.title || "Communication d'entreprise";
    notifBody = body.body || 'Nouvelle communication disponible';
  }

  // 3) Abonnés — service_role : push_subscriptions a sa RLS verrouillée,
  // aucun accès direct possible depuis le front (contournement par design).
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // test_user_id présent -> restreint l'envoi à ce seul utilisateur (test
  // manuel) ; absent -> tous les abonnés (comportement production, ce que
  // déclenchera le Database Webhook de la brique 5).
  let subsQuery = admin.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  if (testUserId) {
    subsQuery = subsQuery.eq('user_id', testUserId);
  }
  const { data: subs, error: subsErr } = await subsQuery;

  if (subsErr) {
    console.error('send-push: lecture push_subscriptions échouée', subsErr);
    return json({ ok: false, error: 'Erreur serveur' }, 500);
  }

  if (!subs || subs.length === 0) {
    return json({ sent: 0 }, 200);
  }

  const rows = subs as SubscriptionRow[];

  // 4) VAPID
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({ title, body: notifBody });

  // 5) Envoi en parallèle — un échec individuel ne doit jamais bloquer les
  // autres abonnés. Promise.allSettled préserve l'ordre : results[i]
  // correspond à rows[i].
  const results = await Promise.allSettled(
    rows.map((sub) =>
      webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
    )
  );

  let sent = 0;
  let failed = 0;
  const deadIds: string[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      sent++;
      return;
    }
    failed++;
    const err = result.reason as { statusCode?: number; message?: string } | undefined;
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      // Endpoint mort (désinstallation navigateur, expiration) — collecté
      // pour purge, jamais loggué comme une vraie erreur.
      deadIds.push(rows[i].id);
    } else {
      console.error('send-push: envoi échoué', rows[i].id, err?.statusCode, err?.message ?? err);
    }
  });

  // 6) Purge des endpoints morts.
  let pruned = 0;
  if (deadIds.length > 0) {
    const { error: deleteErr, count } = await admin
      .from('push_subscriptions')
      .delete({ count: 'exact' })
      .in('id', deadIds);
    if (deleteErr) {
      console.error('send-push: purge des abonnés morts échouée', deleteErr);
    } else {
      pruned = count ?? deadIds.length;
    }
  }

  return json({ sent, failed, pruned }, 200);
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
