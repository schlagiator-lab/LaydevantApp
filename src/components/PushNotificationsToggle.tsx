import { useEffect, useState } from 'react';
import { isIosDevice } from '../lib/pdfMeasure';
import { getPushSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from '../lib/push';
import { useToast } from '../lib/useToast';
import { colors, fonts, radius, textA } from '../styles/tokens';

function isStandaloneDisplay(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

const helperTextStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: textA(0.55),
  fontFamily: fonts.sans,
  margin: 0,
};

const buttonStyle = (active: boolean): React.CSSProperties => ({
  flex: 'none',
  height: 30,
  borderRadius: radius.md,
  border: active ? `1px solid ${textA(0.2)}` : 'none',
  background: active ? 'transparent' : colors.accent,
  color: active ? textA(0.7) : '#132146',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
});

/**
 * Bouton "Activer/Désactiver les notifications" (brique 3b) — en tête de
 * CommunicationsScreen, seul écran qui en a besoin pour l'instant (pas
 * d'écran Réglages/Profil dans l'app). Garde iOS : le push n'existe que pour
 * une PWA installée sur l'écran d'accueil (mode standalone) — sur Safari/
 * iOS hors standalone, aucune API push n'est de toute façon exposée, mais on
 * préfère un message explicite à un bouton qui échouerait silencieusement.
 */
export function PushNotificationsToggle() {
  const { showToast } = useToast();
  const supported = isPushSupported();
  // null = état pas encore connu (non supporté connu synchrone -> pas besoin
  // d'un aller-retour async pour ce cas).
  const [subscribed, setSubscribed] = useState<boolean | null>(supported ? null : false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      try {
        const sub = await getPushSubscription();
        if (!cancelled) setSubscribed(sub !== null && Notification.permission === 'granted');
      } catch {
        if (!cancelled) setSubscribed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  if (isIosDevice() && !isStandaloneDisplay()) {
    return <p style={helperTextStyle}>Ajoutez l'app à l'écran d'accueil pour activer les notifications.</p>;
  }

  if (!supported) {
    return <p style={helperTextStyle}>Notifications non prises en charge sur cet appareil.</p>;
  }

  // Le clic EST le geste utilisateur synchrone requis par iOS pour
  // Notification.requestPermission() — aucun await avant l'appel à
  // subscribeToPush() (qui l'appelle en tout premier).
  const handleClick = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        if (subscribed) {
          const sub = await getPushSubscription();
          if (sub) await unsubscribeFromPush(sub);
          setSubscribed(false);
        } else {
          await subscribeToPush();
          setSubscribed(true);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Échec de la notification.');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <button type="button" onClick={handleClick} disabled={busy || subscribed === null} style={buttonStyle(!!subscribed)}>
      {subscribed ? 'Désactiver les notifications' : 'Activer les notifications'}
    </button>
  );
}
