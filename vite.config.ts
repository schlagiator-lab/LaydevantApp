import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon-64.png'],
      manifest: {
        name: 'Laydevant SA — Documentation technique',
        short_name: 'Laydevant Docs',
        description:
          "Documentation technique de terrain pour les monteurs Laydevant SA (électricité, télécom, portes automatiques).",
        theme_color: '#1E3A6B',
        background_color: '#1E3A6B',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Document PDFs are handled by our own Cache API logic (§4 of CLAUDE.md),
        // not by workbox — this only precaches the app shell.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,mjs}'],
      },
    }),
  ],
});
