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
  /** Pic de suppressions sur une fenêtre de 15 min, sur toute la période de
   * 90 jours renvoyée par la RPC (v3) — remplace `max_burst_24h` : une
   * rafale ancienne ne doit pas se perdre dans une fenêtre glissante courte. */
  max_burst: number;
  /** Horodatage du pic ci-dessus — sert à afficher "rafale le [date]" pour
   * une rafale passée (§ affichage, DeletionActivityRowCard). */
  burst_at: string;
  last_24h: number;
  last_7d: number;
  /** Total sur les 90 jours de la fenêtre RPC — profondeur de l'activité,
   * affiché tel quel, n'entre dans aucun seuil d'alerte. */
  total_90j: number;
  derniere_suppression: string;
  /** Compte par table sur 90 jours, ex. `{ dossier_photos: 12, dossier_notes: 3 }`.
   * Remplace `tables_24h` (RPC v3). */
  tables_90j: Record<string, number>;
}

/**
 * Alerte admin de suppression massive : une ligne par utilisateur ayant
 * supprimé quelque chose sur les 90 derniers jours (RPC `get_deletion_activity`
 * v3, `SECURITY DEFINER`, déjà en place côté base). `insufficient_privilege`
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
export const SEUIL_RAFALE = 8; // max_burst : rafale (en cours ou passée, peu importe quand)
export const SEUIL_CUMUL = 25; // last_24h : cumul à vérifier

export type DeletionAlertLevel = 'rafale' | 'cumul';

/**
 * Niveau d'alerte d'une ligne, ou `null` si sous les deux seuils. "rafale"
 * prioritaire sur "cumul" quand les deux sont dépassés à la fois — c'est le
 * signal le plus urgent. Basé sur `max_burst` (pic sur toute la période de
 * 90 jours), PAS `last_15min` : une fenêtre courte redescend toujours à zéro
 * avec le temps, ce qui masquerait une rafale passée non acquittée — voir le
 * principe de péremption au niveau du module (une alerte ne s'éteint que par
 * acquittement, jamais par ancienneté). `last_15min` reste utile pour
 * l'affichage (distinguer rafale en cours / passée, DeletionActivityRowCard),
 * simplement plus pour la classification.
 */
export function deletionAlertLevel(row: DeletionActivityRow): DeletionAlertLevel | null {
  if (row.max_burst >= SEUIL_RAFALE) return 'rafale';
  if (row.last_24h >= SEUIL_CUMUL) return 'cumul';
  return null;
}

export interface DeletionAlertSnapshot {
  max_burst: number;
  last_24h: number;
  last_7d: number;
  total_90j: number;
}

export interface DeletionAlertHistoryRow {
  id: string;
  target_user: string;
  /** Best-effort côté RPC (jointure `profiles` en service_role) ; null si indisponible. */
  target_nom: string | null;
  level: DeletionAlertLevel;
  snapshot: DeletionAlertSnapshot;
  acknowledged_by: string;
  ack_nom: string | null;
  acknowledged_at: string;
  note: string | null;
}

/**
 * Historique des acquittements d'alerte de suppression (RPC
 * `get_deletion_alert_history`, `SECURITY DEFINER`, admin-only). Même
 * convention `insufficient_privilege` que `getDeletionActivity` : tableau
 * vide pour un non-admin plutôt qu'un plantage.
 */
export async function getDeletionAlertHistory(limit = 100): Promise<DeletionAlertHistoryRow[]> {
  const { data, error } = await supabase.rpc('get_deletion_alert_history', { p_limit: limit });
  if (error) {
    if (error.code === '42501') return [];
    throw error;
  }
  return (data ?? []) as DeletionAlertHistoryRow[];
}

/**
 * Acquitte l'alerte de suppression d'un utilisateur (RPC
 * `acknowledge_deletion_alert`, `SECURITY DEFINER`, admin-only). Un admin
 * acquitte l'activité d'un AUTRE utilisateur (`p_target_user`) — c'est le cas
 * normal, pas la sienne. `p_snapshot` fige les compteurs courants de la ligne
 * (max_burst/last_24h/last_7d/total_90j) : c'est cet ÉTAT, pas une alerte
 * abstraite, qui est acquitté (voir `isAlertCoveredByAck` ci-dessous) — une
 * nouvelle suppression qui fait dépasser ce snapshot rallume l'alerte même
 * déjà acquittée. `p_note` est facultative.
 */
export async function acknowledgeDeletionAlert(
  row: DeletionActivityRow,
  level: DeletionAlertLevel,
  note?: string
): Promise<void> {
  const snapshot: DeletionAlertSnapshot = {
    max_burst: row.max_burst,
    last_24h: row.last_24h,
    last_7d: row.last_7d,
    total_90j: row.total_90j,
  };
  const trimmedNote = note?.trim();
  const { error } = await supabase.rpc('acknowledge_deletion_alert', {
    p_target_user: row.user_id,
    p_level: level,
    p_snapshot: snapshot,
    p_note: trimmedNote ? trimmedNote : null,
  });
  if (error) throw error;
}

/**
 * Un acquittement "couvre" la ligne live courante si aucun de ses compteurs
 * n'a progressé depuis le snapshot figé à l'acquittement — reproduit la
 * propriété de péremption de l'ancien acquittement local (clé
 * user_id + valeur de compteur, désormais remplacée par cette table) : une
 * nouvelle suppression fait remonter l'alerte même si un acquittement plus
 * ancien existe pour cet utilisateur.
 */
function isAlertCoveredByAck(row: DeletionActivityRow, ack: DeletionAlertHistoryRow): boolean {
  return (
    row.max_burst <= ack.snapshot.max_burst &&
    row.last_24h <= ack.snapshot.last_24h &&
    row.last_7d <= ack.snapshot.last_7d &&
    row.total_90j <= ack.snapshot.total_90j
  );
}

export interface DeletionAlertState {
  row: DeletionActivityRow;
  level: DeletionAlertLevel;
  acknowledged: boolean;
  /** Dernier acquittement connu pour cet utilisateur, couvrant ou non la ligne live. */
  lastAck: DeletionAlertHistoryRow | null;
}

/**
 * Combine l'activité live (`getDeletionActivity`, fenêtre 90 jours, v3) avec
 * l'historique des acquittements (`getDeletionAlertHistory`) pour déterminer,
 * pour chaque ligne en alerte, si le dernier acquittement de cet utilisateur
 * couvre encore l'état courant.
 */
export function reconcileDeletionAlerts(
  liveRows: DeletionActivityRow[],
  history: DeletionAlertHistoryRow[]
): DeletionAlertState[] {
  const latestAckByUser = new Map<string, DeletionAlertHistoryRow>();
  for (const entry of history) {
    const current = latestAckByUser.get(entry.target_user);
    if (!current || entry.acknowledged_at > current.acknowledged_at) {
      latestAckByUser.set(entry.target_user, entry);
    }
  }

  const alerts: DeletionAlertState[] = [];
  for (const row of liveRows) {
    const level = deletionAlertLevel(row);
    if (level === null) continue;
    const lastAck = latestAckByUser.get(row.user_id) ?? null;
    const acknowledged = lastAck !== null && isAlertCoveredByAck(row, lastAck);
    alerts.push({ row, level, acknowledged, lastAck });
  }
  return alerts;
}

/**
 * Nombre d'alertes actives non acquittées — alimente le flag "Coffre (admin)"
 * de l'accueil, même chemin que les trois autres compteurs (HomeScreen.tsx) :
 * sommée avec eux, best-effort, jamais bloquante pour l'accueil.
 */
export async function countActiveDeletionAlerts(): Promise<number> {
  const [rows, history] = await Promise.all([getDeletionActivity(), getDeletionAlertHistory()]);
  return reconcileDeletionAlerts(rows, history).filter((a) => !a.acknowledged).length;
}
