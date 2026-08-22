// Coffre de données sensibles — lectures/écritures Supabase pour le panneau
// admin (tranche 5). Aucune crypto ici : voir src/lib/vault.js pour
// l'emballage/déballage de DEK, ce module ne fait que lire/poser des lignes
// déjà chiffrées, autorisé par les policies RLS pour is_vault_admin().
import { supabase, supabaseUrl } from './supabase';
import type { Profile, EquipmentRequest, EquipmentRequestStatus } from '../types/database';

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

/**
 * Révoque l'accès au coffre d'un compte (onglet "Accès", tranche 5). Aucune
 * crypto ici : (a) retire toutes ses lignes `vault_dossier_access` (accès aux
 * coffres existants), (b) désactive `access_enabled` (bloque les futurs
 * partages). Le trigger `vault_user_keys_guard` autorise (b) car l'appelant
 * est admin connecté — même garde-fou que `setVaultAccessEnabled`.
 *
 * (b) n'est volontairement PAS fondu dans le même throw que (a) : si (a)
 * réussit puis (b) échoue, l'appelant doit pouvoir distinguer cet état
 * partiel (coffres déjà retirés, compte pas encore désactivé) d'un échec
 * complet, pour ne jamais le signaler en silence.
 */
export async function revokeVaultAccess(userId: string): Promise<{ removedCount: number; disableError: string | null }> {
  const { error: delError, count } = await supabase
    .from('vault_dossier_access')
    .delete({ count: 'exact' })
    .eq('user_id', userId);
  if (delError) throw delError;

  const { error: updError } = await supabase.from('vault_user_keys').update({ access_enabled: false }).eq('user_id', userId);

  return { removedCount: count ?? 0, disableError: updError ? updError.message : null };
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

/**
 * Tous les profils applicatifs, pas seulement ceux enrôlés au coffre
 * (contrairement à `getAllVaultUserKeys`) — nécessaire pour retrouver un
 * monteur qui n'a jamais touché au coffre et reste malgré tout un candidat
 * légitime à la suppression de compte (onglet "Comptes").
 */
export async function listAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from('profiles').select('id, full_name, role, is_comms_publisher');
  if (error) throw error;
  return (data ?? []) as Profile[];
}

/** Geste admin (item 4, communications) : active/désactive le droit de
 * publier des communications pour un compte. La RPC (SECURITY DEFINER) est
 * le vrai verrou côté base ; erreur remontée telle quelle. */
export async function setCommsPublisher(userId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_comms_publisher', { p_user_id: userId, p_enabled: enabled });
  if (error) throw error;
}

export interface DossierDeletionRequestSummary {
  id: string;
  dossier_id: string;
  /** Nom du dossier client — même embed par FK que `getAllVaultDossiers`. */
  nom_client: string;
  requested_by: string;
  /** Best-effort, comme `full_name` dans `getAllVaultUserKeys` — même absence
   * de FK directe entre `dossier_deletion_requests.requested_by` et
   * `profiles` (les deux référencent `auth.users` séparément). */
  requested_by_nom: string | null;
  reason: string;
  created_at: string;
}

/**
 * Demandes de suppression en attente (onglet "Demandes"), plus ancienne
 * d'abord. RLS : réservé aux admins (`is_vault_admin`), même garde-fou que
 * le reste de ce module — cette requête échoue silencieusement (zéro ligne)
 * pour un non-admin plutôt que de fuiter les demandes des autres.
 */
export async function listDeletionRequests(): Promise<DossierDeletionRequestSummary[]> {
  const { data, error } = await supabase
    .from('dossier_deletion_requests')
    .select('id, dossier_id, requested_by, reason, created_at, dossiers(nom_client)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;

  type Row = {
    id: string;
    dossier_id: string;
    requested_by: string;
    reason: string;
    created_at: string;
    dossiers: { nom_client: string } | { nom_client: string }[] | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return [];

  const namesByUserId = new Map<string, string | null>();
  try {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in(
        'id',
        rows.map((r) => r.requested_by),
      );
    if (profilesError) throw profilesError;
    for (const p of (profiles ?? []) as { id: string; full_name: string | null }[]) {
      namesByUserId.set(p.id, p.full_name);
    }
  } catch {
    // Best-effort — voir le commentaire de la fonction.
  }

  return rows.map((r) => {
    const rel = Array.isArray(r.dossiers) ? r.dossiers[0] : r.dossiers;
    return {
      id: r.id,
      dossier_id: r.dossier_id,
      nom_client: rel?.nom_client ?? r.dossier_id,
      requested_by: r.requested_by,
      requested_by_nom: namesByUserId.get(r.requested_by) ?? null,
      reason: r.reason,
      created_at: r.created_at,
    };
  });
}

/**
 * Nombre de demandes de suppression de dossier en attente — même filtre que
 * `listDeletionRequests`, juste le compte (flag "Coffre (admin)" de
 * l'accueil). `head: true` + pas de `select('*')` : seul le compte est
 * nécessaire. RLS admin-only sur cette table : zéro pour un non-admin.
 */
export async function countPendingDeletionRequests(): Promise<number> {
  const { count, error } = await supabase
    .from('dossier_deletion_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw error;
  return count ?? 0;
}

/**
 * Approuve ou rejette une demande via la RPC `resolve_dossier_deletion_request`
 * — jamais de soft delete direct depuis cet écran : la fonction vérifie
 * l'admin et fait le soft delete + la résolution de façon atomique. Une
 * demande déjà traitée par un autre admin entre-temps remonte telle quelle
 * (le message d'erreur de la RPC est déjà lisible, pas de reformulation ici).
 */
export async function resolveDeletionRequest(requestId: string, approve: boolean): Promise<void> {
  const { error } = await supabase.rpc('resolve_dossier_deletion_request', {
    p_request_id: requestId,
    p_approve: approve,
  });
  if (error) throw error;
}

/**
 * Demandes d'équipement manuel absent de la base (item 1, onglet "Demandes"),
 * plus ancienne d'abord — même RLS/garde-fou que `listDeletionRequests` :
 * réservé aux admins, échoue silencieusement (zéro ligne) pour un non-admin
 * plutôt que de fuiter les demandes des autres. Le nom du dossier vient d'un
 * embed direct (FK réelle `dossier_id → dossiers`) ; le nom du demandeur
 * vient d'une requête best-effort séparée sur `profiles`, exactement comme
 * `listDeletionRequests` (pas de FK directe `requested_by → profiles`).
 */
export async function listPendingEquipmentRequests(): Promise<EquipmentRequest[]> {
  const { data, error } = await supabase
    .from('dossier_equipment_requests')
    .select(
      'id, dossier_id, requested_by, marque, modele, commentaire, specialty_id, status, created_at, resolved_by, resolved_at, resolved_product_id, dossiers(nom_client)'
    )
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;

  type Row = {
    id: string;
    dossier_id: string;
    requested_by: string | null;
    marque: string;
    modele: string | null;
    commentaire: string | null;
    specialty_id: string | null;
    status: EquipmentRequestStatus;
    created_at: string;
    resolved_by: string | null;
    resolved_at: string | null;
    resolved_product_id: string | null;
    dossiers: { nom_client: string } | { nom_client: string }[] | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return [];

  const namesByUserId = new Map<string, string | null>();
  try {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in(
        'id',
        rows.map((r) => r.requested_by).filter((id): id is string => id !== null),
      );
    if (profilesError) throw profilesError;
    for (const p of (profiles ?? []) as { id: string; full_name: string | null }[]) {
      namesByUserId.set(p.id, p.full_name);
    }
  } catch {
    // Best-effort — voir le commentaire de listDeletionRequests.
  }

  return rows.map((r) => {
    const rel = Array.isArray(r.dossiers) ? r.dossiers[0] : r.dossiers;
    return {
      id: r.id,
      dossier_id: r.dossier_id,
      requested_by: r.requested_by,
      marque: r.marque,
      modele: r.modele,
      commentaire: r.commentaire,
      specialty_id: r.specialty_id,
      status: r.status,
      created_at: r.created_at,
      resolved_by: r.resolved_by,
      resolved_at: r.resolved_at,
      resolved_product_id: r.resolved_product_id,
      nom_client: rel?.nom_client ?? r.dossier_id,
      requested_by_nom: r.requested_by ? namesByUserId.get(r.requested_by) ?? null : null,
    };
  });
}

/**
 * Nombre de demandes d'équipement manuel en attente — même filtre que
 * `listPendingEquipmentRequests`, juste le compte (flag "Coffre (admin)" de
 * l'accueil). RLS `dossier_equipment_requests` laisse `select` à tout
 * utilisateur authentifié (CLAUDE.md §3) : cette fonction n'est donc un
 * signal admin fiable que si l'appelant a déjà vérifié `isVaultAdmin()`.
 */
export async function countPendingEquipmentRequests(): Promise<number> {
  const { count, error } = await supabase
    .from('dossier_equipment_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw error;
  return count ?? 0;
}

/**
 * Approuve ou rejette une demande via la RPC
 * `resolve_dossier_equipment_request` — crée ou réutilise le produit et le
 * rattache au dossier si approuvé, atomiquement côté base (réservé aux
 * admins, `is_vault_admin`). Message d'erreur de la RPC remonté tel quel
 * (l'UI l'affichera), pas de reformulation ici.
 */
export async function resolveEquipmentRequest(
  requestId: string,
  opts: { approve: boolean; specialtyId?: string }
): Promise<void> {
  const { error } = await supabase.rpc('resolve_dossier_equipment_request', {
    p_request_id: requestId,
    p_specialty_id: opts.specialtyId ?? null,
    p_approve: opts.approve,
  });
  if (error) throw error;
}

/**
 * Supprime le compte applicatif d'un monteur via l'Edge Function
 * `delete-account` (service_role — la clé anon ne peut jamais supprimer un
 * compte Auth). verify_jwt reste actif sur cette fonction (contrairement à
 * `enroll`) : l'appelant doit déjà être connecté. Tous les garde-fous
 * (appelant admin, cible non-admin, accès coffre déjà révoqué) sont
 * revérifiés côté serveur — ceux de l'UI ne sont qu'un affichage cohérent,
 * jamais la seule protection réelle.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Session expirée — reconnecte-toi.');

  const res = await fetch(`${supabaseUrl}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    let message = `Suppression échouée (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* garde le message par défaut */
    }
    throw new Error(message);
  }
}

export interface DeletionActivityRow {
  user_id: string;
  auteur: string;
  role: string;
  last_15min: number;
  last_24h: number;
  last_7d: number;
  derniere_suppression: string;
  /** Compte par table sur 24h, ex. `{ dossier_photos: 12, dossier_notes: 3 }`. */
  tables_24h: Record<string, number>;
}

/**
 * Alerte admin de suppression massive : une ligne par utilisateur ayant
 * supprimé quelque chose sur les 7 derniers jours (RPC `get_deletion_activity`,
 * `SECURITY DEFINER`, déjà en place côté base). `insufficient_privilege`
 * (42501, non-admin) est traité comme "rien à montrer", même convention que
 * `listDeletionRequests`/`listPendingEquipmentRequests` plus haut — pas un
 * plantage. En pratique inatteignable depuis l'onglet admin (déjà gaté par
 * `isVaultAdmin()`), mais utile pour `countActiveDeletionAlerts` ci-dessous,
 * appelée sans ce pré-check côté accueil.
 */
export async function getDeletionActivity(): Promise<DeletionActivityRow[]> {
  const { data, error } = await supabase.rpc('get_deletion_activity');
  if (error) {
    if (error.code === '42501') return [];
    throw error;
  }
  return (data ?? []) as DeletionActivityRow[];
}

/**
 * Seuils d'alerte de suppression massive — volontairement côté front,
 * jamais en base : ajustables sans migration. Provisoires, calibrés sur des
 * données de préprod non représentatives ; à recalibrer une fois un vrai
 * volume de suppressions observé en prod.
 */
export const SEUIL_RAFALE = 8; // last_15min : rafale en cours, urgent
export const SEUIL_CUMUL = 25; // last_24h : cumul à vérifier

export type DeletionAlertLevel = 'rafale' | 'cumul';

/**
 * Niveau d'alerte d'une ligne, ou `null` si sous les deux seuils. "rafale"
 * prioritaire sur "cumul" quand les deux sont dépassés à la fois — c'est le
 * signal le plus urgent (activité en cours vs activité déjà passée).
 */
export function deletionAlertLevel(row: DeletionActivityRow): DeletionAlertLevel | null {
  if (row.last_15min >= SEUIL_RAFALE) return 'rafale';
  if (row.last_24h >= SEUIL_CUMUL) return 'cumul';
  return null;
}

const DELETION_ALERT_ACK_KEY = 'laydevant.deletionAlertsAck';

/** Clé composite user_id + valeur de compteur : se périme automatiquement
 * dès que `last_24h` bouge, donc dès que de nouvelles suppressions arrivent. */
function deletionAlertAckId(row: DeletionActivityRow): string {
  return `${row.user_id}:${row.last_24h}`;
}

function readDeletionAlertAcks(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETION_ALERT_ACK_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeDeletionAlertAcks(acks: Set<string>): void {
  try {
    localStorage.setItem(DELETION_ALERT_ACK_KEY, JSON.stringify([...acks]));
  } catch {
    // best-effort — stockage plein/indisponible, pas bloquant
  }
}

/** Acquittement purement local (pas de table, pas de sync entre appareils) :
 * l'admin a déjà vu ce niveau de suppression pour cet utilisateur. */
export function isDeletionAlertAcknowledged(row: DeletionActivityRow): boolean {
  return readDeletionAlertAcks().has(deletionAlertAckId(row));
}

export function acknowledgeDeletionAlert(row: DeletionActivityRow): void {
  const acks = readDeletionAlertAcks();
  acks.add(deletionAlertAckId(row));
  writeDeletionAlertAcks(acks);
}

/**
 * Nombre d'alertes actives non acquittées — alimente le flag "Coffre (admin)"
 * de l'accueil, même chemin que les trois autres compteurs (HomeScreen.tsx) :
 * sommée avec eux, best-effort, jamais bloquante pour l'accueil.
 */
export async function countActiveDeletionAlerts(): Promise<number> {
  const rows = await getDeletionActivity();
  return rows.filter((r) => deletionAlertLevel(r) !== null && !isDeletionAlertAcknowledged(r)).length;
}
