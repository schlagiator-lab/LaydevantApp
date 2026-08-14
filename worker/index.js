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

// Préfixes génériques (hors dossier) autorisés pour ?prefix= : allowlist
// stricte tête + slug, aucun `..`, aucun `/` supplémentaire, aucun espace.
// "plans" réutilise ce même mécanisme (slug = dossier_id, qui matche déjà
// [a-z0-9-]+ en tant qu'UUID) plutôt que le paramètre dédié ?dossier=, lequel
// reste figé sur le préfixe `dossiers/` pour ne rien changer aux photos.
const GENERIC_PREFIX_RE = /^(galerie|plans|communications)\/[a-z0-9-]+$/;

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
    // Admin-only : le POST/GET restent ouverts à tout authentifié, mais une
    // suppression R2 est irréversible et la lecture (GET) est
    // préfixe-agnostique (documents/ inclus, §13 CLAUDE.md). is_vault_admin()
    // teste `profiles.role = 'admin'` en SECURITY DEFINER (même rôle admin
    // que le reste de l'app, pas une notion propre au coffre) — appelée en
    // HTTP brut avec le Bearer de l'appelant, sans introduire de secret
    // service_role dans le Worker.
    const isAdmin = await checkIsAdmin(request, env);
    if (!isAdmin) return new Response("Forbidden", { status: 403 });

    const key = decodeURIComponent(url.pathname.replace("/api/photos/", ""));
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