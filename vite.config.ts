import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // SW custom (src/sw.ts) requis pour les handlers push à venir (brique 3
      // notifications) — generateSW ne permet pas d'ajouter du code SW
      // arbitraire. Le comportement de précache/cache runtime ci-dessous est
      // répliqué à l'identique dans src/sw.ts (cf. commentaires du fichier).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icons/favicon-48x48.png', 'icons/apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Laydevant SA — Documentation technique',
        short_name: 'Laydevant Docs',
        description:
          "Documentation technique de terrain pour les monteurs Laydevant SA (électricité, télécom, portes automatiques).",
        theme_color: '#1E3A6B',
        background_color: '#1E2256',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // Document PDFs are handled by our own Cache API logic (§4 of CLAUDE.md),
        // not by workbox — this only precaches the app shell.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,mjs,jpg,jpeg,webp,avif,gif,mp3}'],
        // tetris_audio.mp3 (~6.9 Mo) exceeds the 2 Mo default precache limit —
        // excluded from precache (would otherwise be forced onto every install)
        // and served instead via the runtime CacheFirst route in src/sw.ts
        // (cached on first online playback, then available offline).
        globIgnores: ['**/tetris_audio.mp3'],
      },
    }),
  ],
});
