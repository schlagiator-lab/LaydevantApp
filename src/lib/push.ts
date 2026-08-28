// Notifications push (brique 3b) — souscription/désinscription client
// uniquement. AUCUN envoi de push ici : c'est le rôle d'une brique serveur à
// part (n8n/Edge Function côté back), pas de ce module. Table/RPC déjà en
// place côté Supabase (push_subscriptions, upsert_push_subscription,
// delete_push_subscription — RPC-only, RLS verrouillée).
import { supabase } from './supabase';

/** Convertit la clé publique VAPID (base64url) au format Uint8Array attendu
 * par PushManager.subscribe. Implémentation standard (cf. doc MDN). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** null si non supporté OU aucun abonnement actif. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Doit être appelée directement dans le handler de clic (geste utilisateur
 * synchrone), sans await avant le premier appel — iOS Safari/WebKit exige
 * que requestPermission() parte du même tick que le geste, sinon la demande
 * est silencieusement ignorée.
 */
export async function subscribeToPush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Permission de notification refusée.');
  }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY),
  });

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Abonnement push incomplet.');
  }

  const { error } = await supabase.rpc('upsert_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: navigator.userAgent,
  });
  if (error) throw error;

  return sub;
}

export async function unsubscribeFromPush(sub: PushSubscription): Promise<void> {
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  const { error } = await supabase.rpc('delete_push_subscription', { p_endpoint: endpoint });
  if (error) throw error;
}
