import { useEffect, useState } from 'react';

/**
 * `navigator.onLine` only reflects link-layer connectivity (e.g. still true
 * on a Wi-Fi network with no internet), but it's the signal CLAUDE.md's
 * offline-auth requirement (§7) is built around: react to the browser's own
 * online/offline events, don't attempt to ping a server to verify reachability.
 *
 * Field testing on Android showed the `online`/`offline` window events don't
 * reliably fire at all on some devices (confirmed via the Diagnostic screen's
 * event log staying empty through a real airplane-mode toggle). The event
 * listeners alone left `isOnline` stuck at its value from mount. To cover
 * that, this also re-reads `navigator.onLine` directly on an interval and on
 * visibility/focus regains — still no network request, just polling the
 * property instead of trusting the change event to tell us when it moved.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    const recheck = () => setIsOnline(navigator.onLine);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    const intervalId = window.setInterval(recheck, 3000);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      window.clearInterval(intervalId);
    };
  }, []);

  return isOnline;
}
