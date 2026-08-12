async function getUser(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  return res.ok ? await res.json() : null;
}

// Préfixes génériques (hors dossier) autorisés pour ?prefix= : allowlist
// stricte tête + slug, aucun `..`, aucun `/` supplémentaire, aucun espace.
// "plans" réutilise ce même mécanisme (slug = dossier_id, qui matche déjà
// [a-z0-9-]+ en tant qu'UUID) plutôt que le paramètre dédié ?dossier=, lequel
// reste figé sur le préfixe `dossiers/` pour ne rien changer aux photos.
const GENERIC_PREFIX_RE = /^(galerie|plans)\/[a-z0-9-]+$/;

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