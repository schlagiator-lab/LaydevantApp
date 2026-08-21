import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useOnlineStatus } from './network';
import { AuthContext, type AuthContextValue } from './authContext';

// Filet de sécurité si getSession() ni ne résout ni ne rejette (storage local
// bloqué) : force le rendu plutôt que de laisser l'app en écran blanc.
const SESSION_READY_TIMEOUT_MS = 5000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isReady, setIsReady] = useState(false);
  const isOnline = useOnlineStatus();
  // Mirrors isOnline into the refresh ticker without re-subscribing to
  // onAuthStateChange on every connectivity flip.
  const wasOnline = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const markReady = (nextSession: Session | null) => {
      if (cancelled) return;
      setSession(nextSession);
      setIsReady(true);
    };

    // isReady doit passer à true dans TOUS les cas — sinon App.tsx (isReady
    // gate le rendu) laisse l'app en écran blanc indéfiniment, y compris hors
    // ligne avec des documents déjà épinglés (CLAUDE.md §6).
    const timeoutId = setTimeout(() => markReady(null), SESSION_READY_TIMEOUT_MS);

    supabase.auth
      .getSession()
      .then(({ data }) => {
        clearTimeout(timeoutId);
        markReady(data.session);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        console.error('auth: getSession() a échoué, session considérée absente', err);
        markReady(null);
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      subscription.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isOnline === wasOnline.current) return;
    wasOnline.current = isOnline;
    if (isOnline) {
      // Coming back online is the only moment we allow supabase-js to try to
      // refresh a stale session (CLAUDE.md §7: "ne redemander l'authentification
      // qu'au retour du réseau"). If the refresh token really is dead, this is
      // what eventually fires SIGNED_OUT and flips needsLogin to true.
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  }, [isOnline]);

  const signInWithPassword: AuthContextValue['signInWithPassword'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const value: AuthContextValue = {
    session,
    isReady,
    isOnline,
    needsLogin: isReady && session === null,
    signInWithPassword,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
