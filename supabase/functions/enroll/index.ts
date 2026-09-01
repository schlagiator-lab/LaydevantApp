// Edge Function "enroll" — CLAUDE.md §7 (onboarding par liste blanche).
//
// Auth : verify_jwt DOIT être désactivé au déploiement (`supabase functions
// deploy enroll --no-verify-jwt`, ou réglage équivalent côté dashboard) —
// contrairement à web-search-notices (§9), l'appelant n'a par définition pas
// encore de compte donc pas de JWT. C'est cette fonction elle-même, avec
// service_role, qui fait tout le contrôle d'accès (email pending et non
// consommé dans onboarding_invitations) : le verrou est donc bien côté
// serveur, jamais dans l'absence d'auth Supabase standard.
//
// Séquencement de déploiement (§7) : ne couper les inscriptions publiques
// Supabase (Authentication → Settings) qu'après avoir déployé et testé cette
// fonction — sinon fenêtre où plus aucun compte ne peut être créé.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return json({ error: 'Méthode non autorisée' }, 405);
  }

  // service_role : cette fonction crée des comptes et lit la liste pending,
  // deux choses interdites au client anon. Le secret ne quitte jamais le serveur.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  let body: { email?: string; password?: string; fullName?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Requête invalide' }, 400);
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.fullName ?? '').trim();

  // Validations d'entrée — messages volontairement génériques (voir plus bas).
  if (!email || !email.includes('@')) return json({ error: 'Email invalide' }, 400);
  if (password.length < 12) return json({ error: 'Mot de passe : 12 caractères minimum' }, 400);
  if (!fullName) return json({ error: 'Nom requis' }, 400);

  // 1) L'email est-il invité ET non déjà consommé ?
  const { data: invite, error: inviteErr } = await admin
    .from('onboarding_invitations')
    .select('email, role, consumed_at')
    .eq('email', email)
    .maybeSingle();

  if (inviteErr) return json({ error: 'Erreur serveur' }, 500);

  // Message identique "invité ou pas" pour ne pas révéler qui est sur la liste
  // (un attaquant ne doit pas pouvoir sonder les emails invités de tes collègues).
  if (!invite || invite.consumed_at) {
    return json({ error: "Cet email n'est pas autorisé à s'enregistrer." }, 403);
  }

  // 2) Créer le compte. email_confirm: true => pas d'email de confirmation,
  // connexion immédiate. Le rôle vient de l'INVITATION, jamais du client.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createErr || !created.user) {
    // Cas courant : l'email a déjà un compte Auth (double-clic, reprise).
    return json({ error: 'Impossible de créer le compte (email déjà utilisé ?)' }, 409);
  }

  const userId = created.user.id;

  // 3) Profil (nom + rôle de l'invitation). upsert : si un trigger crée déjà
  // une ligne profiles à la création du user, on la complète au lieu de casser.
  const { error: profileErr } = await admin
    .from('profiles')
    .upsert({ id: userId, full_name: fullName, role: invite.role });

  if (profileErr) {
    // Compte créé mais profil KO : on annule le compte pour ne pas laisser un
    // user orphelin sans profil (état incohérent). Reprise propre possible.
    await admin.auth.admin.deleteUser(userId);
    return json({ error: 'Erreur serveur (profil)' }, 500);
  }

  // 4) Marquer l'invitation consommée (usage unique).
  await admin
    .from('onboarding_invitations')
    .update({ consumed_at: new Date().toISOString(), consumed_by: userId })
    .eq('email', email);

  return json({ ok: true }, 200);
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
