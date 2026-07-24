import { useEffect, useState } from 'react';

/**
 * `navigator.onLine` only reflects link-layer connectivity (e.g. still true
 * on a Wi-Fi network with no internet), but it's the signal CLAUDE.md's
 * offline-auth requirement (§7) is built around: react to the browser's own
 * online/offline events, don't attempt to ping a server to verify reachability.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
}
