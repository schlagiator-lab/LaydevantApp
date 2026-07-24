# Laydevant SA — Documentation technique (PWA)

PWA de consultation de documentation technique de terrain pour les monteurs
Laydevant SA. Voir [`CLAUDE.md`](./CLAUDE.md) pour la spécification complète
(architecture hors ligne, schéma Supabase, écrans, contraintes de sécurité).

## Stack

React + Vite + TypeScript, vite-plugin-pwa, @supabase/supabase-js, MiniSearch, idb.

## Démarrage

```bash
cp .env.example .env   # renseigner VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

## Scripts

- `npm run dev` — serveur de développement
- `npm run build` — build de production (type-check + build Vite, génère le service worker)
- `npm run preview` — sert le build de production en local
- `npm run lint` — ESLint
- `npm run format` — Prettier (écrit les fichiers)
- `npm run deploy` — build puis `wrangler deploy` (Cloudflare Workers, static assets)

## Déploiement

Cloudflare Workers avec Static Assets (pas Cloudflare Pages) — configuré dans
[`wrangler.jsonc`](./wrangler.jsonc), assets servis depuis `dist/`. `VITE_SUPABASE_URL`
et `VITE_SUPABASE_ANON_KEY` sont lues par Vite au moment du build (`.env` local),
pas à l'exécution — rien à configurer côté Worker.

```bash
npm run deploy   # nécessite d'être authentifié : npx wrangler login
```
