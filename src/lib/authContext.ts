import { createContext } from 'react';
import type { Session } from '@supabase/supabase-js';

export interface AuthContextValue {
  /** Structurally-valid stored session, possibly expired — see needsLogin. */
  session: Session | null;
  /** True once the client has finished reading the persisted session at boot. */
  isReady: boolean;
  isOnline: boolean;
  /**
   * True only when there is no session at all (never logged in, or the SDK
   * confirmed — over the network — that the refresh token is dead and cleared
   * it). An expired-but-present session while offline does NOT set this: the
   * whole point of CLAUDE.md §7 is that a technician mid-cave keeps access to
   * whatever is already cached instead of being bounced to a login screen.
   */
  needsLogin: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
