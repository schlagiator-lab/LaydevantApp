// Coffre de données sensibles — lectures Supabase pour le panneau admin
// (tranche 5, onglet "Comptes"). Aucune écriture ni crypto ici : lecture
// seule sur vault_user_keys, autorisée par sa policy RLS pour is_vault_admin().
import { supabase } from './supabase';

export async function isVaultAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_vault_admin');
  if (error) throw error;
  return Boolean(data);
}

export interface VaultUserKeySummary {
  user_id: string;
  /** Non nul = l'utilisateur a posé sa ligne vault_user_keys ("enrôlé"). */
  public_key: string | null;
  access_enabled: boolean;
  is_recovery_admin: boolean;
  /** Vient d'une requête séparée sur `profiles` (voir plus bas) ; null si
   * indisponible — l'écran retombe alors sur l'affichage du user_id brut. */
  full_name: string | null;
}

/**
 * Liste tous les comptes du coffre pour le panneau admin (lecture seule).
 * Le nom lisible est récupéré par une requête séparée sur `profiles` : il
 * n'existe pas de clé étrangère directe entre vault_user_keys et profiles
 * (les deux référencent auth.users indépendamment), donc PostgREST ne peut
 * pas les embarquer en une seule requête. Cette seconde requête est
 * best-effort — si elle échoue, on retombe sur le user_id brut plutôt que
 * de bloquer tout l'écran (CLAUDE.md : profiles reste géré hors de ce dépôt).
 */
export async function getAllVaultUserKeys(): Promise<VaultUserKeySummary[]> {
  const { data, error } = await supabase
    .from('vault_user_keys')
    .select('user_id, public_key, access_enabled, is_recovery_admin');
  if (error) throw error;
  const rows = (data ?? []) as Omit<VaultUserKeySummary, 'full_name'>[];
  if (rows.length === 0) return [];

  const namesByUserId = new Map<string, string | null>();
  try {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in(
        'id',
        rows.map((r) => r.user_id),
      );
    if (profilesError) throw profilesError;
    for (const p of (profiles ?? []) as { id: string; full_name: string | null }[]) {
      namesByUserId.set(p.id, p.full_name);
    }
  } catch {
    // Best-effort — voir le commentaire de la fonction.
  }

  return rows.map((r) => ({ ...r, full_name: namesByUserId.get(r.user_id) ?? null }));
}
