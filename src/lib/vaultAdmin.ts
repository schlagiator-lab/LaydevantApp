// Coffre de données sensibles — lectures/écritures Supabase pour le panneau
// admin (tranche 5). Aucune crypto ici : voir src/lib/vault.js pour
// l'emballage/déballage de DEK, ce module ne fait que lire/poser des lignes
// déjà chiffrées, autorisé par les policies RLS pour is_vault_admin().
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

/**
 * Active l'accès au coffre pour un compte déjà enrôlé (onglet "Accès",
 * tranche 5). Le trigger `vault_user_keys_guard` n'autorise cette écriture
 * que si l'appelant est admin — pas de RPC spécial, pas de désactivation du
 * trigger. Fait entrer le compte dans `vault_public_keys` pour les FUTURS
 * coffres ; les coffres existants doivent être partagés séparément (voir
 * `getAllVaultDossiers` / `getDossierAccessRowsForUser` ci-dessous).
 */
export async function setVaultAccessEnabled(userId: string): Promise<void> {
  const { error } = await supabase.from('vault_user_keys').update({ access_enabled: true }).eq('user_id', userId);
  if (error) throw error;
}

export interface VaultDossierSummary {
  dossier_id: string;
  /** Nom du dossier client — pour lister nommément les coffres ignorés
   * faute d'accès admin (compte-rendu de l'onglet "Accès"). */
  nom_client: string;
}

/**
 * Tous les coffres existants (une ligne `vault_secrets` = un dossier avec un
 * coffre créé). Lecture réservée à l'admin par la policy RLS de
 * `vault_secrets` (is_vault_admin()) ; le join sur `dossiers` passe par la
 * même requête plutôt qu'un aller-retour séparé, PostgREST embarque via la
 * clé étrangère vault_secrets.dossier_id -> dossiers.id.
 */
export async function getAllVaultDossiers(): Promise<VaultDossierSummary[]> {
  const { data, error } = await supabase.from('vault_secrets').select('dossier_id, dossiers(nom_client)');
  if (error) throw error;
  type Row = { dossier_id: string; dossiers: { nom_client: string } | { nom_client: string }[] | null };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const rel = Array.isArray(r.dossiers) ? r.dossiers[0] : r.dossiers;
    return { dossier_id: r.dossier_id, nom_client: rel?.nom_client ?? r.dossier_id };
  });
}

export interface DossierAccessKeyRow {
  dossier_id: string;
  wrapped_dek: string;
  dek_version: number;
}

/**
 * Toutes les lignes `vault_dossier_access` d'un utilisateur donné, tous
 * dossiers confondus. Sert deux usages dans l'onglet "Accès" : appelée avec
 * TON user_id, elle donne les DEK à déballer pour les repartager ; appelée
 * avec le user_id de la cible, elle dit pour quels dossiers elle avait déjà
 * une ligne (idempotence : "déjà à jour" vs "nouvellement partagé").
 */
export async function getDossierAccessRowsForUser(userId: string): Promise<DossierAccessKeyRow[]> {
  const { data, error } = await supabase
    .from('vault_dossier_access')
    .select('dossier_id, wrapped_dek, dek_version')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []) as DossierAccessKeyRow[];
}
