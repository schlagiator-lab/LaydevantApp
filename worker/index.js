async function getUser(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  return res.ok ? await res.json() : null;
}

async function handlePhotos(request, env) {
  const url = new URL(request.url);

  const user = await getUser(request, env);
  if (!user) return new Response("Unauthorized", { status: 401 });

  if (request.method === "POST") {
    const dossierId = url.searchParams.get("dossier");
    if (!dossierId) return new Response("dossier manquant", { status: 400 });
    const contentType = request.headers.get("Content-Type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";
    const key = `dossiers/${dossierId}/${crypto.randomUUID()}.${ext}`;
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