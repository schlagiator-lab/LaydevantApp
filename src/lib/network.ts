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

async function isReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(supabaseUrl, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: controller.signal });
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
