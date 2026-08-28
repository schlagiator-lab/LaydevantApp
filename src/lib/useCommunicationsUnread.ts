import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import { getLastCommunicationAt, COMM_LAST_SEEN_KEY } from './communications';

/**
 * Pastille "non-lu" sur l'entrée "Communication d'entreprise" de l'accueil —
 * pur front (localStorage), aucune infra serveur. Recalculé au montage (donc
 * à chaque retour à l'accueil : le routeur démonte/remonte les écrans, cf.
 * useToolsFlag.ts) et à la reprise de premier plan (visibilitychange), pour
 * capter une communication publiée pendant que l'app était en arrière-plan
 * sans navigation. En ligne uniquement, best-effort (échec silencieux, garde
 * le dernier état connu — pas de pastille affichée à tort).
 */
export function useCommunicationsUnread(): boolean {
  const { isOnline } = useAuth();
  const [hasUnread, setHasUnread] = useState(false);

  const refresh = useCallback(() => {
    if (!isOnline) return;
    void (async () => {
      try {
        const lastCreatedAt = await getLastCommunicationAt();
        if (!lastCreatedAt) {
          setHasUnread(false);
          return;
        }
        const lastSeenAt = localStorage.getItem(COMM_LAST_SEEN_KEY);
        setHasUnread(!lastSeenAt || lastCreatedAt > lastSeenAt);
      } catch {
        // Best-effort — cf. commentaire ci-dessus.
      }
    })();
  }, [isOnline]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refresh]);

  return hasUnread;
}
