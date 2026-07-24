import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useOnlineStatus } from './network';
import { AuthContext, type AuthContextValue } from './authContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isReady, setIsReady] = useState(false);
  const isOnline = useOnlineStatus();
  // Mirrors isOnline into the refresh ticker without re-subscribing to
  // onAuthStateChange on every connectivity flip.
  const wasOnline = useRef(false);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setIsReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      cancelled = true;
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
