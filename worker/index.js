async function getUser(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  return res.ok ? await res.json() : null;
}

// Rejoue le Bearer de l'appelant sur la RPC is_vault_admin() (SECURITY
// DEFINER, teste profiles.role = 'admin' — même rôle admin que le reste de
// l'app, pas une notion propre au coffre) plutôt que de lire profiles
// directement : indépendant de la RLS de `profiles`, aucun secret
// service_role nécessaire côté Worker.
async function checkIsAdmin(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_vault_admin`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  return res.ok && (await res.json()) === true;
}

// Même patron que checkIsAdmin, pour les objets vault/{dossierId}/... :
// rejoue le Bearer de l'appelant sur has_dossier_vault_access(p_dossier_id)
// (SECURITY DEFINER — a-t-il une ligne vault_dossier_access pour CE dossier)
// plutôt que de faire confiance à un query param, qui pourrait mentir sur le
// dossier. Même policy DELETE que vault_files côté Postgres : accès nominatif
// OU admin, jamais un secret service_role côté Worker.
async function checkHasDossierVaultAccess(request, env, dossierId) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/has_dossier_vault_access`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_dossier_id: dossierId }),
  });
  return res.ok && (await res.json()) === true;
}

// Préfixes liés à une entité (hors dossier) autorisés pour ?prefix= :
// allowlist stricte tête + slug, aucun `..`, aucun `/` supplémentaire, aucun
// espace. "plans" réutilise ce même mécanisme (slug = dossier_id, qui matche
// déjà [a-z0-9-]+ en tant qu'UUID) plutôt que le paramètre dédié ?dossier=,
// lequel reste figé sur le préfixe `dossiers/` pour ne rien changer aux
// photos. Ne PAS rendre le /slug optionnel ici : ça autoriserait galerie ou
// plans nus, sans entité associée — les préfixes globaux (ci-dessous) sont
// une liste séparée, volontairement disjointe de ce regex.
const GENERIC_PREFIX_RE = /^(galerie|plans|vault)\/[a-z0-9-]+$/;

// Préfixes globaux — espaces partagés par toute l'app, sans slug d'entité
// (rien à faire suivre la tête : pas de dossier, pas de produit). Égalité
// stricte sur une allowlist fermée, jamais un regex à trou : un préfixe
// global n'a structurellement aucun segment à valider après la tête. Ajouter
// un futur préfixe global = ajouter son nom ici, rien d'autre.
const GLOBAL_PREFIXES = ["communications", "equipment-requests"];

// Nom de fichier optionnel (?name=) : accolé tel quel après l'UUID généré,
// pour que la clé porte la vraie extension (pdf/dwg/...) plutôt que le
// .jpg/.png deviné depuis le Content-Type. Charset restreint : pas de `/`,
// donc aucun risque de sortir du préfixe.
const NAME_RE = /^[a-zA-Z0-9._-]{1,120}$/;

async function handlePhotos(request, env) {
  const url = new URL(request.url);

  const user = await getUser(request, env);
  if (!user) return new Response("Unauthorized", { status: 401 });

  if (request.method === "POST") {
    const dossierId = url.searchParams.get("dossier");
    const prefix = url.searchParams.get("prefix");
    let keyPrefix;
    if (dossierId) {
      keyPrefix = `dossiers/${dossierId}`;
    } else if (prefix && GENERIC_PREFIX_RE.test(prefix)) {
      keyPrefix = prefix;
    } else if (prefix && GLOBAL_PREFIXES.includes(prefix)) {
      keyPrefix = prefix;
    } else {
      return new Response("dossier ou prefix manquant/invalide", { status: 400 });
    }
    const contentType = request.headers.get("Content-Type") || "image/jpeg";

    const rawName = url.searchParams.get("name");
    let filename;
    if (rawName !== null) {
      if (!NAME_RE.test(rawName)) return new Response("name invalide", { status: 400 });
      filename = `${crypto.randomUUID()}-${rawName}`;
    } else {
      const ext = contentType.includes("png") ? "png" : "jpg";
      filename = `${crypto.randomUUID()}.${ext}`;
    }
    const key = `${keyPrefix}/${filename}`;
    const bytes = await request.arrayBuffer();
    await env.PHOTOS_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    return Response.json({ key, contentType });
  }

  if (request.method === "GET") {
    const key = decodeURIComponent(url.pathname.replace("/api/photos/", ""));
    const obj = await env.PHOTOS_BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  if (request.method === "DELETE") {
    // Admin-only par défaut : le POST/GET restent ouverts à tout authentifié,
    // mais une suppression R2 est irréversible et la lecture (GET) est
    // préfixe-agnostique (documents/ inclus, §13 CLAUDE.md). is_vault_admin()
    // teste `profiles.role = 'admin'` en SECURITY DEFINER (même rôle admin
    // que le reste de l'app, pas une notion propre au coffre) — appelée en
    // HTTP brut avec le Bearer de l'appelant, sans introduire de secret
    // service_role dans le Worker.
    const key = decodeURIComponent(url.pathname.replace("/api/photos/", ""));

    if (key.startsWith("vault/")) {
      // Fichiers chiffrés du coffre : la clé elle-même (pas un query param,
      // qui pourrait mentir) porte le dossier_id (vault/{dossierId}/...).
      // Même policy DELETE que vault_files côté Postgres : accès nominatif
      // OU admin. Teste d'abord l'accès (cas nominal), ne rejoue
      // is_vault_admin que s'il est faux — évite un appel inutile.
      const dossierId = key.split("/")[1];
      const hasAccess = dossierId ? await checkHasDossierVaultAccess(request, env, dossierId) : false;
      if (!hasAccess) {
        const isAdmin = await checkIsAdmin(request, env);
        if (!isAdmin) return new Response("Forbidden", { status: 403 });
      }
    } else {
      // Tout autre préfixe (documents/, plans/, galerie/, communications/…) :
      // comportement inchangé, admin-only strict.
      const isAdmin = await checkIsAdmin(request, env);
      if (!isAdmin) return new Response("Forbidden", { status: 403 });
    }

    await env.PHOTOS_BUCKET.delete(key);
    return new Response(null, { status: 204 });
  }

  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/photos")) {
      return handlePhotos(request, env);
    }
    // tout le reste -> les assets statiques (la PWA)
    return env.ASSETS.fetch(request);
  },
};