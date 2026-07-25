import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in the environment.');
}

// Only the `anon` key belongs here — RLS is what protects the data (CLAUDE.md §8).
//
// autoRefreshToken is off by default: supabase-js would otherwise try to
// refresh the token on its own timer/visibility-change logic, which fails
// loudly when offline. src/lib/auth.tsx drives startAutoRefresh()/
// stopAutoRefresh() explicitly from real network state instead (CLAUDE.md §7).
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
