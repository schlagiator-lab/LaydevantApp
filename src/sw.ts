/// <reference lib="webworker" />
// Service worker custom (stratégie injectManifest de vite-plugin-pwa) — requis
// pour ajouter des handlers SW arbitraires (push, à venir), impossible avec
// generateSW. Réplique À L'IDENTIQUE le comportement actuel obtenu par
// generateSW + registerType:'autoUpdate' (défauts silencieux du plugin :
// cleanupOutdatedCaches/skipWaiting/clientsClaim/navigateFallback ne sont
// visibles nulle part dans vite.config.ts sous generateSW, ici ils doivent
// être écrits à la main). Voir CLAUDE.md §2 pour le contexte PWA/precache.
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { RangeRequestsPlugin } from 'workbox-range-requests';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// Équivalent écrit à la main de registerType:'autoUpdate' (le plugin
// positionnait skipWaiting/clientsClaim à true en generateSW, sans que ce
// soit visible dans vite.config.ts).
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA : sert index.html pour toute navigation non précachée — équivalent du
// navigateFallback:'index.html' que le plugin appliquait par défaut en
// generateSW (jamais explicite côté vite.config.ts).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// tetris_audio.mp3 (~6.9 Mo) exclu du précache (injectManifest.globIgnores,
// vite.config.ts) — mis en cache au premier lancement en ligne puis servi
// hors ligne. Équivalent code de l'ancien runtimeCaching déclaratif.
//
// Lu via <audio> (new Audio(), HTMLAudioElement) : le navigateur émet des
// requêtes Range sur ce fichier volumineux, réponses 206 Partial Content.
// Sans CacheableResponsePlugin, CacheFirst n'écrit en cache que les status
// 200 — un 206 était donc silencieusement jamais persisté (la musique ne
// survivait pas à un refresh en mode avion, bug préexistant à la migration
// injectManifest). RangeRequestsPlugin sert ensuite les 206 depuis la
// réponse complète mise en cache — placé en dernier pour ne découper la
// réponse qu'après la vérification de fraîcheur d'ExpirationPlugin.
registerRoute(
  ({ url }) => /\/tetris_audio\.mp3$/.test(url.href),
  new CacheFirst({
    cacheName: 'tetris-music',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 206] }),
      new ExpirationPlugin({ maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 30 }),
      new RangeRequestsPlugin(),
    ],
  })
);
