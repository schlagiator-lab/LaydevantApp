import { useEffect, useState } from 'react';
import { supabaseUrl } from './supabase';

/**
 * `navigator.onLine` and the `online`/`offline` window events were the first
 * approach (CLAUDE.md §7 only requires detecting network absence, not a
 * specific mechanism). Field testing on Android disproved both signals on
 * real hardware: toggling airplane mode alone never fired an event AND never
 * changed the `navigator.onLine` value itself — confirmed via the Diagnostic
 * screen's raw event log staying empty through a real toggle, while a
 * genuine radio power-cycle (screen off/on) did produce one event. Polling
 * the property alone can't help when the property itself doesn't move.
 *
 * So this now uses an active reachability probe as the authoritative signal:
 * a no-cors fetch against the Supabase project URL with a short timeout.
 * `no-cors` still requires the network stack to actually attempt the
 * request — it fails/throws when truly offline — without needing the
 * response to carry CORS headers we don't otherwise need here. The window
 * events are kept only as a fast optimistic path (immediate negative signal,
 * or trigger an early re-probe) on browsers where they do work; the next
 * interval tick always corrects a wrong guess.
 */
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 4000;

// Cible de la sonde : la racine du projet ("/") n'est mappée nulle part côté
// gateway Supabase et répond 404 à chaque tick — inoffensif pour la logique
// (on ne lit que succès/échec de la requête réseau, jamais le code HTTP),
// mais bruyant dans l'onglet Network en debug. `/rest/v1/departments` répond
// 200 de façon fiable avec la clé anon existante, passée en query string —
// en mode `no-cors` un en-tête custom comme `apikey` serait silencieusement
// ignoré par le navigateur, d'où le query param plutôt qu'un header. Table
// choisie pour sa stabilité (§3/§4 CLAUDE.md), `select=id&limit=1` pour
// rester la requête la plus légère possible côté base (tick toutes les 5 s,
// en continu).
const probeUrl = `${supabaseUrl}/rest/v1/departments?select=id&limit=1&apikey=${import.meta.env.VITE_SUPABASE_ANON_KEY}`;

async function isReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(probeUrl, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    let cancelled = false;
    let probeToken = 0;

    const probe = async () => {
      const token = ++probeToken;
      const reachable = await isReachable();
      if (!cancelled && token === probeToken) setIsOnline(reachable);
    };

    const goOffline = () => {
      setIsOnline(false);
      void probe();
    };
    const recheck = () => void probe();

    window.addEventListener('online', recheck);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);

    void probe();
    const intervalId = window.setInterval(recheck, PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener('online', recheck);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      window.clearInterval(intervalId);
    };
  }, []);

  return isOnline;
}
