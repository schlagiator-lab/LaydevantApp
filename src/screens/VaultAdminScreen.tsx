import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useVaultSession } from '../lib/useVaultSession';
import {
  isVaultAdmin,
  getAllVaultUserKeys,
  setVaultAccessEnabled,
  getAllVaultDossiers,
  getDossierAccessRowsForUser,
  revokeVaultAccess,
  listAllProfiles,
  setCommsPublisher,
  deleteAccount,
  listDeletionRequests,
  resolveDeletionRequest,
  listPendingEquipmentRequests,
  resolveEquipmentRequest,
  getDeletionActivity,
  deletionAlertLevel,
  isDeletionAlertAcknowledged,
  acknowledgeDeletionAlert,
  type VaultUserKeySummary,
  type VaultDossierSummary,
  type DossierDeletionRequestSummary,
  type DeletionActivityRow,
  type DeletionAlertLevel,
} from '../lib/vaultAdmin';
import { upsertDossierAccessRow } from '../lib/vaultSecrets';
import { unwrapDek, wrapDekForUser } from '../lib/vault.js';
import { listInvitations, addInvitation, removeInvitation } from '../lib/onboarding';
import { getLocalDepartments, getLocalSpecialties } from '../lib/db';
import { listAllDemandes, updateDemandeStatut, deleteDemande, demandeTypeLabel, demandeStatutLabel } from '../lib/demandes';
import type {
  OnboardingInvitation,
  ProfileRole,
  Profile,
  Department,
  Specialty,
  EquipmentRequest,
  Demande,
  DemandeType,
  DemandeStatut,
} from '../types/database';
import { StatusPill } from '../components/StatusPill';
import { VaultRotationSheet } from '../components/VaultRotationSheet';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { colors, fonts, textA, successA, accentA } from '../styles/tokens';

type Phase = { kind: 'loading' } | { kind: 'checkError'; message: string } | { kind: 'forbidden' } | { kind: 'ready' };

type Tab = 'comptes' | 'acces' | 'rotation' | 'onboarding' | 'demandes';

/** Rouge d'alerte "rafale" — même constante que HomeScreen.DANGER (flag
 * "Coffre (admin)"), dupliquée ici plutôt que partagée : pas de module de
 * tokens communs pour cette couleur, seul `colors.accent` (orange) l'est. */
const DANGER = '#D14343';

type AccountsPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: VaultUserKeySummary[] };

type ProfilesPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: Profile[] };

/**
 * Panneau admin du coffre de données sensibles (tranches 5-6). Réservé aux
 * admins : garde-fou fait par l'écran lui-même (is_vault_admin, RPC), pas
 * par le lien d'entrée ni par la navigation — même convention que
 * VaultEnrollScreen. Trois onglets : "Comptes" (lecture), "Accès"
 * (activation/révocation), "Rotation" (rotation de clé par dossier — point
 * d'entrée unique de VaultRotationSheet, déplacé ici depuis la fiche
 * dossier).
 */
export function VaultAdminScreen() {
  const { isOnline } = useAuth();
  const nav = useNavigation();

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('comptes');
  const [accounts, setAccounts] = useState<AccountsPhase>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<ProfilesPhase>({ kind: 'loading' });

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    void (async () => {
      try {
        const allowed = await isVaultAdmin();
        if (cancelled) return;
        setPhase(allowed ? { kind: 'ready' } : { kind: 'forbidden' });
      } catch (err) {
        if (!cancelled) {
          setPhase({ kind: 'checkError', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  // Partagée par les onglets "Comptes" et "Accès" — même liste, un seul
  // fetch. `loadAccounts` est aussi repassée à l'onglet "Accès" pour
  // rafraîchir les badges après une activation.
  const loadAccounts = useCallback(async () => {
    setAccounts({ kind: 'loading' });
    try {
      const rows = await getAllVaultUserKeys();
      setAccounts({ kind: 'loaded', rows });
    } catch (err) {
      setAccounts({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // Tous les profils (pas seulement les enrôlés au coffre) — nécessaire pour
  // l'onglet "Comptes", qui doit pouvoir proposer la suppression d'un
  // monteur qui n'a jamais touché au coffre.
  const loadProfiles = useCallback(async () => {
    setProfiles({ kind: 'loading' });
    try {
      const rows = await listAllProfiles();
      setProfiles({ kind: 'loaded', rows });
    } catch (err) {
      setProfiles({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (phase.kind !== 'ready') return;
    void (async () => {
      await Promise.all([loadAccounts(), loadProfiles()]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
      }}
    >
      <div style={{ flex: 'none', padding: '14px 16px 12px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={nav.goHome} aria-label="Retour" style={backButtonStyle}>
              ‹
            </button>
            <span style={eyebrowStyle}>Coffre — Administration</span>
          </div>
          <StatusPill online={isOnline} />
        </div>
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '18px 16px 32px', boxSizing: 'border-box' }}
      >
        {!isOnline && <BlockingMessage text="Connexion réseau requise pour administrer le coffre." />}

        {isOnline && phase.kind === 'loading' && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 40 }}>Vérification…</p>
        )}

        {isOnline && phase.kind === 'checkError' && <BlockingMessage text={`Erreur : ${phase.message}`} isError />}

        {isOnline && phase.kind === 'forbidden' && (
          <div style={{ textAlign: 'center', padding: '60px 20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Réservé à l'administrateur</div>
            <div style={{ fontSize: 14, color: textA(0.6), lineHeight: 1.5 }}>
              Cet écran n'est accessible qu'aux comptes administrateur.
            </div>
          </div>
        )}

        {isOnline && phase.kind === 'ready' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <TabButton label="Comptes" active={tab === 'comptes'} onClick={() => setTab('comptes')} />
              <TabButton label="Accès" active={tab === 'acces'} onClick={() => setTab('acces')} />
              <TabButton label="Rotation" active={tab === 'rotation'} onClick={() => setTab('rotation')} />
              <TabButton label="Onboarding" active={tab === 'onboarding'} onClick={() => setTab('onboarding')} />
              <TabButton label="Notifications" active={tab === 'demandes'} onClick={() => setTab('demandes')} />
            </div>

            {tab === 'comptes' && (
              <AccountsTab
                accounts={accounts}
                profiles={profiles}
                onAccountsChanged={loadAccounts}
                onProfilesChanged={loadProfiles}
              />
            )}
            {tab === 'acces' && <AccessTab accounts={accounts} onAccountsChanged={loadAccounts} />}
            {tab === 'rotation' && <RotationTab />}
            {tab === 'onboarding' && <OnboardingTab />}
            {tab === 'demandes' && <DemandesTab />}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...tabButtonStyle, ...(active ? tabButtonActiveStyle : null) }}>
      {label}
    </button>
  );
}

/**
 * Onglet "Comptes" : liste TOUS les profils applicatifs (pas seulement ceux
 * enrôlés au coffre — `listAllProfiles`, croisée avec `accounts`, la liste
 * `vault_user_keys` déjà chargée par le panneau pour l'onglet "Accès). Un
 * monteur qui n'a jamais touché au coffre apparaît donc ici aussi, avec un
 * badge neutre "Coffre : non enrôlé" — c'est justement ce qui permet de le
 * supprimer sans détour par l'onglet "Accès".
 *
 * Suppression (bouton "Supprimer le compte") : jamais pour un admin, et
 * jamais tant que l'accès coffre de la cible est actif ou qu'elle est
 * récupérateur — l'Edge Function `delete-account` revérifie ces mêmes
 * conditions côté serveur, ce gate côté UI n'est qu'un raccourci cohérent.
 */
function AccountsTab({
  accounts,
  profiles,
  onAccountsChanged,
  onProfilesChanged,
}: {
  accounts: AccountsPhase;
  profiles: ProfilesPhase;
  onAccountsChanged: () => void;
  onProfilesChanged: () => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [publisherId, setPublisherId] = useState<string | null>(null);
  const [publisherError, setPublisherError] = useState<string | null>(null);

  async function handleConfirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    setDeletingId(target.id);
    setDeleteError(null);
    try {
      await deleteAccount(target.id);
      onProfilesChanged();
      onAccountsChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleTogglePublisher(target: Profile) {
    setPublisherId(target.id);
    setPublisherError(null);
    try {
      await setCommsPublisher(target.id, !target.is_comms_publisher);
      onProfilesChanged();
    } catch (err) {
      setPublisherError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublisherId(null);
    }
  }

  if (profiles.kind === 'loading' || accounts.kind === 'loading') {
    return <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>Chargement…</p>;
  }
  if (profiles.kind === 'error') {
    return <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {profiles.message}</p>;
  }
  if (accounts.kind === 'error') {
    return <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {accounts.message}</p>;
  }
  if (profiles.rows.length === 0) {
    return <p style={{ fontSize: 13, color: textA(0.55) }}>Aucun compte.</p>;
  }

  const vaultByUserId = new Map(accounts.rows.map((r) => [r.user_id, r]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {deleteError && <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {deleteError}</p>}
      {publisherError && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {publisherError}</p>
      )}

      {profiles.rows.map((p) => {
        const vault = vaultByUserId.get(p.id) ?? null;
        const vaultAccessOn = vault?.access_enabled === true;
        const isRecoveryAdmin = vault?.is_recovery_admin === true;
        const canDelete = p.role === 'monteur' && !vaultAccessOn && !isRecoveryAdmin;
        const isDeleting = deletingId === p.id;
        const isTogglingPublisher = publisherId === p.id;
        return (
          <div key={p.id} style={accountRowStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, wordBreak: 'break-all' }}>
              {p.full_name ?? p.id}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Badge label={p.role === 'admin' ? 'Admin' : 'Monteur'} active={p.role === 'admin'} />
              {vault ? (
                <>
                  <Badge label="Enrôlé" active={vault.public_key !== null} />
                  <Badge label="Accès coffre" active={vault.access_enabled} />
                  <Badge label="Récupérateur" active={vault.is_recovery_admin} />
                </>
              ) : (
                <Badge label="Coffre : non enrôlé" active={false} />
              )}
              {/* Sans effet sur un admin (canPublishCommunications = admin OU
                  publisher) : badge et bouton réservés aux monteurs pour ne
                  jamais afficher un geste qui ne changerait rien. */}
              {p.role === 'monteur' && <Badge label="Publie" active={p.is_comms_publisher} />}
            </div>

            {p.role === 'monteur' && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {vaultAccessOn && (
                  <span style={{ fontSize: 12, color: textA(0.55), lineHeight: 1.4 }}>
                    Révoque l'accès au coffre (onglet Accès) avant de pouvoir supprimer ce compte.
                  </span>
                )}
                {isRecoveryAdmin && (
                  <span style={{ fontSize: 12, color: textA(0.55), lineHeight: 1.4 }}>
                    Compte récupérateur — suppression impossible depuis cet écran.
                  </span>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => void handleTogglePublisher(p)}
                    disabled={isTogglingPublisher}
                    style={{
                      ...(p.is_comms_publisher ? revokeButtonStyle : activateButtonStyle),
                      opacity: isTogglingPublisher ? 0.5 : 1,
                    }}
                  >
                    {isTogglingPublisher
                      ? 'Mise à jour…'
                      : p.is_comms_publisher
                        ? 'Retirer la publication'
                        : 'Autoriser à publier'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(p)}
                    disabled={!canDelete || isDeleting}
                    style={{ ...revokeButtonStyle, opacity: !canDelete || isDeleting ? 0.5 : 1 }}
                  >
                    {isDeleting ? 'Suppression…' : 'Supprimer le compte'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {pendingDelete && (
        <ConfirmSheet
          title="Supprimer ce compte ?"
          message={`« ${pendingDelete.full_name ?? pendingDelete.id} » perdra définitivement l'accès à l'application. Cette action est irréversible.`}
          confirmLabel="Supprimer"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </div>
  );
}

function Badge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 100,
        background: active ? successA(0.18) : textA(0.08),
        color: active ? colors.success : textA(0.45),
        fontSize: 11.5,
        fontWeight: 700,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? colors.success : textA(0.3) }} />
      {label}
    </span>
  );
}

interface FailedDossier {
  dossier: VaultDossierSummary;
  message: string;
}

type ActivationState =
  | { kind: 'idle' }
  | { kind: 'running'; account: VaultUserKeySummary }
  | {
      kind: 'done';
      account: VaultUserKeySummary;
      newlyShared: number;
      alreadyUpToDate: number;
      /** Vraiment aucune ligne vault_dossier_access pour toi sur ce coffre. */
      skipped: VaultDossierSummary[];
      /** Ta ligne existe (donc pas "pas d'accès admin"), mais le déballage/
       * remballage/upsert a échoué pour une autre raison — jamais confondu
       * avec `skipped`, qui mentait sinon sur la cause réelle. */
      failed: FailedDossier[];
    }
  | { kind: 'error'; account: VaultUserKeySummary; message: string };

type RevokeState =
  | { kind: 'idle' }
  | { kind: 'refused'; account: VaultUserKeySummary; message: string }
  | { kind: 'running'; account: VaultUserKeySummary }
  | { kind: 'done'; account: VaultUserKeySummary; removedCount: number }
  /** (a) a réussi, (b) a échoué : ne jamais fondre avec `done` ni `error`, le
   * compte est dans un état à moitié fait qu'il faut signaler tel quel. */
  | { kind: 'partial'; account: VaultUserKeySummary; removedCount: number; message: string }
  | { kind: 'error'; account: VaultUserKeySummary; message: string };

/**
 * Onglet "Accès" (tranche 5) : active un compte enrôlé — lui donne accès à
 * tous les coffres existants. Exige la clé privée déballée (session de
 * coffre partagée via VaultSessionProvider, comme VaultSheet) : sans elle,
 * impossible de déballer les DEK existantes pour les remballer vers le
 * nouveau compte. Le geste inverse (Révoquer) ne fait, lui, aucune crypto —
 * il n'a donc pas besoin de la clé privée, mais reste derrière le même écran
 * de déverrouillage puisqu'il partage la liste de comptes de l'onglet.
 */
function AccessTab({ accounts, onAccountsChanged }: { accounts: AccountsPhase; onAccountsChanged: () => void }) {
  const { session } = useAuth();
  const ownUserId = session?.user.id ?? null;
  const { privateKey, unlocked, unlocking, error: unlockError, unlock } = useVaultSession();

  const [password, setPassword] = useState('');
  const [pendingActivation, setPendingActivation] = useState<VaultUserKeySummary | null>(null);
  const [activation, setActivation] = useState<ActivationState>({ kind: 'idle' });
  const [pendingRevoke, setPendingRevoke] = useState<VaultUserKeySummary | null>(null);
  const [revoke, setRevoke] = useState<RevokeState>({ kind: 'idle' });

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (unlocking || !password) return;
    await unlock(password);
    setPassword('');
  }

  function openConfirm(account: VaultUserKeySummary) {
    setActivation({ kind: 'idle' });
    setPendingActivation(account);
  }

  async function handleConfirmActivate() {
    const account = pendingActivation;
    if (!account || !privateKey || !ownUserId) return;
    setPendingActivation(null);
    setActivation({ kind: 'running', account });
    try {
      await setVaultAccessEnabled(account.user_id);
      const targetPublicKey = account.public_key;
      if (!targetPublicKey) throw new Error('Clé publique introuvable pour ce compte.');

      const [dossiers, ownRows, targetRows] = await Promise.all([
        getAllVaultDossiers(),
        getDossierAccessRowsForUser(ownUserId),
        getDossierAccessRowsForUser(account.user_id),
      ]);
      const ownByDossier = new Map(ownRows.map((r) => [r.dossier_id, r]));
      const targetDossierIds = new Set(targetRows.map((r) => r.dossier_id));

      let newlyShared = 0;
      let alreadyUpToDate = 0;
      // "Vraiment pas d'accès" (aucune ligne trouvée) et "accès trouvé mais
      // échec ensuite" sont deux causes différentes — ne jamais les fondre
      // dans le même compteur/libellé, sous peine d'accuser à tort l'admin
      // de ne pas avoir accès alors que sa ligne existe bel et bien.
      const skipped: VaultDossierSummary[] = [];
      const failed: FailedDossier[] = [];

      for (const dossier of dossiers) {
        const ownRow = ownByDossier.get(dossier.dossier_id);
        if (!ownRow) {
          skipped.push(dossier);
          continue;
        }
        try {
          const dek = await unwrapDek(ownRow.wrapped_dek, privateKey, true);
          const wrappedDek = await wrapDekForUser(dek, targetPublicKey);
          await upsertDossierAccessRow({
            dossier_id: dossier.dossier_id,
            user_id: account.user_id,
            wrapped_dek: wrappedDek,
            dek_version: ownRow.dek_version,
          });
          if (targetDossierIds.has(dossier.dossier_id)) alreadyUpToDate++;
          else newlyShared++;
        } catch (err) {
          // Ne plante pas tout le lot pour un coffre en particulier — mais
          // ta ligne EXISTE ici (sinon on serait sorti au `if (!ownRow)`
          // ci-dessus) : ce n'est donc PAS un défaut d'accès admin, c'est un
          // échec du déballage/remballage/upsert. Message réel conservé.
          failed.push({ dossier, message: err instanceof Error ? err.message : String(err) });
        }
      }

      setActivation({ kind: 'done', account, newlyShared, alreadyUpToDate, skipped, failed });
      onAccountsChanged();
    } catch (err) {
      setActivation({ kind: 'error', account, message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleRevokeClick(account: VaultUserKeySummary) {
    setRevoke({ kind: 'idle' });
    // Son propre compte peut être À LA FOIS soi-même ET récupérateur — tester
    // "soi-même" en premier pour donner le motif le plus pertinent pour
    // l'utilisateur (on ne peut de toute façon rien y faire dans les deux cas,
    // mais le message doit rester correct).
    if (account.user_id === ownUserId) {
      setRevoke({ kind: 'refused', account, message: 'Impossible de révoquer son propre accès.' });
      return;
    }
    if (account.is_recovery_admin) {
      setRevoke({
        kind: 'refused',
        account,
        message:
          "Impossible de révoquer un récupérateur. Le retrait du rôle récupérateur se fait en base pour l'instant.",
      });
      return;
    }
    setPendingRevoke(account);
  }

  async function handleConfirmRevoke() {
    const account = pendingRevoke;
    if (!account) return;
    setPendingRevoke(null);
    setRevoke({ kind: 'running', account });
    try {
      const { removedCount, disableError } = await revokeVaultAccess(account.user_id);
      if (disableError) {
        setRevoke({ kind: 'partial', account, removedCount, message: disableError });
        return;
      }
      setRevoke({ kind: 'done', account, removedCount });
      onAccountsChanged();
    } catch (err) {
      setRevoke({ kind: 'error', account, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!unlocked) {
    return (
      <form onSubmit={(e) => void handleUnlockSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ fontSize: 13, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
          Déverrouille ton coffre pour activer l'accès d'un compte — il faut ta clé privée pour repartager les
          coffres existants.
        </p>
        <input
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mot de passe du coffre"
          style={tabInputStyle}
          autoFocus
        />
        {unlockError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{unlockError}</span>}
        <button
          type="submit"
          disabled={unlocking || !password}
          style={{ ...tabPrimaryButtonStyle, opacity: unlocking || !password ? 0.5 : 1 }}
        >
          {unlocking ? 'Déverrouillage…' : 'Déverrouiller'}
        </button>
      </form>
    );
  }

  const rows = accounts.kind === 'loaded' ? accounts.rows.filter((r) => r.public_key !== null) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {accounts.kind === 'loading' && (
        <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>
      )}
      {accounts.kind === 'error' && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {accounts.message}</p>
      )}
      {accounts.kind === 'loaded' && rows.length === 0 && (
        <p style={{ fontSize: 13, color: textA(0.55) }}>Aucun compte enrôlé.</p>
      )}

      {(activation.kind === 'done' || activation.kind === 'error') && (
        <div
          style={
            activation.kind === 'error' || activation.skipped.length > 0 || activation.failed.length > 0
              ? reportBoxErrorStyle
              : reportBoxStyle
          }
        >
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: activation.kind === 'done' ? 4 : 0 }}>
            {activation.account.full_name ?? activation.account.user_id}
          </div>
          {activation.kind === 'done' ? (
            <>
              <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                {activation.newlyShared} coffre{activation.newlyShared > 1 ? 's' : ''} nouvellement partagé
                {activation.newlyShared > 1 ? 's' : ''}, {activation.alreadyUpToDate} déjà à jour, {activation.skipped.length}{' '}
                ignoré{activation.skipped.length > 1 ? 's' : ''} (pas d'accès admin)
                {activation.failed.length > 0 &&
                  `, ${activation.failed.length} échoué${activation.failed.length > 1 ? 's' : ''} malgré un accès`}
                .
              </p>
              {activation.skipped.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: textA(0.65), lineHeight: 1.6 }}>
                  {activation.skipped.map((d) => (
                    <li key={d.dossier_id}>{d.nom_client}</li>
                  ))}
                </ul>
              )}
              {activation.failed.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: colors.accent, lineHeight: 1.6 }}>
                  {activation.failed.map(({ dossier, message }) => (
                    <li key={dossier.dossier_id}>
                      {dossier.nom_client} — {message}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0, color: colors.accent }}>Erreur : {activation.message}</p>
          )}
          <button type="button" onClick={() => setActivation({ kind: 'idle' })} style={dismissLinkStyle}>
            Fermer
          </button>
        </div>
      )}

      {revoke.kind !== 'idle' && revoke.kind !== 'running' && (
        <div style={revoke.kind === 'done' ? reportBoxStyle : reportBoxErrorStyle}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>
            {revoke.account.full_name ?? revoke.account.user_id}
          </div>
          {revoke.kind === 'done' && (
            <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              Accès révoqué pour {revoke.account.full_name ?? revoke.account.user_id} : {revoke.removedCount} coffre
              {revoke.removedCount > 1 ? 's' : ''} retiré{revoke.removedCount > 1 ? 's' : ''}.
            </p>
          )}
          {revoke.kind === 'partial' && (
            <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0, color: colors.accent }}>
              {revoke.removedCount} coffre{revoke.removedCount > 1 ? 's' : ''} retiré{revoke.removedCount > 1 ? 's' : ''},
              mais la désactivation du compte a échoué : {revoke.message}. État partiel — relancez la révocation.
            </p>
          )}
          {(revoke.kind === 'refused' || revoke.kind === 'error') && (
            <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0, color: colors.accent }}>{revoke.message}</p>
          )}
          <button type="button" onClick={() => setRevoke({ kind: 'idle' })} style={dismissLinkStyle}>
            Fermer
          </button>
        </div>
      )}

      {rows.map((r) => {
        const isRunning = activation.kind === 'running' && activation.account.user_id === r.user_id;
        const isRevoking = revoke.kind === 'running' && revoke.account.user_id === r.user_id;
        return (
          <div key={r.user_id} style={accountRowStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, wordBreak: 'break-all' }}>
              {r.full_name ?? r.user_id}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Badge label="Accès coffre" active={r.access_enabled} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => openConfirm(r)}
                  disabled={isRunning}
                  style={{ ...activateButtonStyle, opacity: isRunning ? 0.6 : 1 }}
                >
                  {isRunning ? 'Activation…' : r.access_enabled ? "Réparer l'accès" : 'Activer'}
                </button>
                {r.access_enabled && (
                  <button
                    type="button"
                    onClick={() => handleRevokeClick(r)}
                    disabled={isRevoking}
                    style={{ ...revokeButtonStyle, opacity: isRevoking ? 0.6 : 1 }}
                  >
                    {isRevoking ? 'Révocation…' : 'Révoquer'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {pendingActivation && (
        <div onClick={() => setPendingActivation(null)} style={confirmOverlayStyle}>
          <div onClick={(e) => e.stopPropagation()} style={confirmBoxStyle}>
            <p style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px' }}>
              {pendingActivation.full_name ?? pendingActivation.user_id}
            </p>
            <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '0 0 16px', color: colors.accent, fontWeight: 600 }}>
              Ce compte aura accès à TOUS les secrets de TOUS les coffres.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setPendingActivation(null)} style={{ ...tabSecondaryButtonStyle, flex: 1 }}>
                Annuler
              </button>
              <button type="button" onClick={() => void handleConfirmActivate()} style={{ ...tabPrimaryButtonStyle, flex: 1 }}>
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRevoke && (
        <div onClick={() => setPendingRevoke(null)} style={confirmOverlayStyle}>
          <div onClick={(e) => e.stopPropagation()} style={confirmBoxStyle}>
            <p style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px' }}>
              {pendingRevoke.full_name ?? pendingRevoke.user_id}
            </p>
            <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '0 0 16px', color: colors.accent, fontWeight: 600 }}>
              Ce compte perdra l'accès à tous les coffres. Attention : cela coupe l'accès futur, mais n'efface pas ce
              que la personne a déjà pu consulter. Pour une coupure dure, utilisez la rotation.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setPendingRevoke(null)} style={{ ...tabSecondaryButtonStyle, flex: 1 }}>
                Annuler
              </button>
              <button type="button" onClick={() => void handleConfirmRevoke()} style={{ ...tabPrimaryButtonStyle, flex: 1 }}>
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type DossiersPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: VaultDossierSummary[] };

/**
 * Onglet "Rotation" (tranche 6) : liste tous les dossiers ayant un coffre
 * (même lecture que `getAllVaultDossiers` déjà utilisée par l'onglet
 * "Accès" — vault_secrets joint à dossiers.nom_client) et ouvre
 * VaultRotationSheet pour le dossier choisi. Point d'entrée unique de la
 * rotation : le bouton correspondant a été retiré de la fiche dossier.
 * Le rafraîchissement de la liste après fermeture de la feuille est
 * inconditionnel (pas seulement après succès) : une rotation ne change
 * jamais QUELS dossiers ont un coffre ni leur nom, donc rafraîchir à chaque
 * fermeture est strictement équivalent en résultat visible à ne rafraîchir
 * qu'après succès, sans avoir à faire remonter un signal de succès distinct
 * depuis la feuille.
 */
function RotationTab() {
  const [dossiers, setDossiers] = useState<DossiersPhase>({ kind: 'loading' });
  const [rotationTarget, setRotationTarget] = useState<VaultDossierSummary | null>(null);

  const loadDossiers = useCallback(async () => {
    setDossiers({ kind: 'loading' });
    try {
      const rows = await getAllVaultDossiers();
      setDossiers({ kind: 'loaded', rows });
    } catch (err) {
      setDossiers({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadDossiers();
    })();
  }, [loadDossiers]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {dossiers.kind === 'loading' && (
        <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>
      )}
      {dossiers.kind === 'error' && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {dossiers.message}</p>
      )}
      {dossiers.kind === 'loaded' && dossiers.rows.length === 0 && (
        <p style={{ fontSize: 13, color: textA(0.55) }}>Aucun coffre créé.</p>
      )}
      {dossiers.kind === 'loaded' &&
        dossiers.rows.map((d) => (
          <div key={d.dossier_id} style={accountRowStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>{d.nom_client}</div>
              <button type="button" onClick={() => setRotationTarget(d)} style={rotateButtonStyle}>
                Faire tourner la clé
              </button>
            </div>
          </div>
        ))}

      {rotationTarget && (
        <VaultRotationSheet
          dossierId={rotationTarget.dossier_id}
          dossierName={rotationTarget.nom_client}
          onClose={() => {
            setRotationTarget(null);
            void loadDossiers();
          }}
        />
      )}
    </div>
  );
}

type InvitationsPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: OnboardingInvitation[] };

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** Même formule que CarnetSection.formatDateTime — date + heure, nécessaire
 * pour `derniere_suppression` (§ alerte suppression massive), contrairement à
 * `formatDate` ci-dessus qui suffit pour les autres onglets de cet écran. */
function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Onglet "Onboarding" (CLAUDE.md §7) : gère la liste blanche d'emails
 * autorisés à s'auto-enrôler. Pas de vérification `role === 'admin'` propre
 * à cet onglet : `is_vault_admin()` (qui gate déjà tout VaultAdminScreen via
 * `phase.kind === 'ready'`) teste exactement la même condition côté base
 * (`profiles.role = 'admin'`, cf. migration vault_user_keys) que la RLS de
 * `onboarding_invitations` — le gate d'écran est donc déjà en place, pas
 * besoin d'un second aller-retour réseau pour la même réponse.
 */
function OnboardingTab() {
  const [invitations, setInvitations] = useState<InvitationsPhase>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProfileRole>('monteur');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<OnboardingInvitation | null>(null);
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const loadInvitations = useCallback(async () => {
    setInvitations({ kind: 'loading' });
    try {
      const rows = await listInvitations();
      setInvitations({ kind: 'loaded', rows });
    } catch (err) {
      setInvitations({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadInvitations();
    })();
  }, [loadInvitations]);

  const trimmedEmail = email.trim();
  const emailValid = trimmedEmail.includes('@');

  async function handleAddSubmit(e: FormEvent) {
    e.preventDefault();
    if (!emailValid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await addInvitation({ email: trimmedEmail, role, note: note.trim() || null });
      setEmail('');
      setRole('monteur');
      setNote('');
      await loadInvitations();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmRemove() {
    const invite = pendingRemove;
    if (!invite) return;
    setPendingRemove(null);
    setRemovingEmail(invite.email);
    setRemoveError(null);
    try {
      await removeInvitation(invite.email);
      await loadInvitations();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingEmail(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <form onSubmit={(e) => void handleAddSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="email"
          placeholder="Email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={tabInputStyle}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as ProfileRole)} style={tabInputStyle}>
          <option value="monteur">Monteur</option>
          <option value="admin">Admin</option>
        </select>
        <input
          type="text"
          placeholder="Note (optionnel)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={tabInputStyle}
        />
        {formError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{formError}</span>}
        <button
          type="submit"
          disabled={!emailValid || submitting}
          style={{ ...tabPrimaryButtonStyle, opacity: !emailValid || submitting ? 0.5 : 1 }}
        >
          {submitting ? 'Invitation…' : 'Inviter'}
        </button>
      </form>

      {removeError && <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {removeError}</p>}

      {invitations.kind === 'loading' && (
        <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>
      )}
      {invitations.kind === 'error' && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {invitations.message}</p>
      )}
      {invitations.kind === 'loaded' && invitations.rows.length === 0 && (
        <p style={{ fontSize: 13, color: textA(0.55) }}>Aucune invitation.</p>
      )}

      {invitations.kind === 'loaded' &&
        invitations.rows.map((inv) => (
          <div key={inv.email} style={accountRowStyle}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-all' }}>{inv.email}</div>
                {inv.note && (
                  <div style={{ fontSize: 12.5, color: textA(0.6), marginTop: 2 }}>{inv.note}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPendingRemove(inv)}
                disabled={removingEmail === inv.email}
                style={{ ...revokeButtonStyle, opacity: removingEmail === inv.email ? 0.6 : 1 }}
              >
                {removingEmail === inv.email ? '…' : 'Retirer'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <Badge label={inv.role === 'admin' ? 'Admin' : 'Monteur'} active={inv.role === 'admin'} />
              {inv.consumed_at ? (
                <StatusChip label={`Enrôlé le ${formatDate(inv.consumed_at)}`} kind="success" />
              ) : (
                <StatusChip label="En attente" kind="pending" />
              )}
            </div>
          </div>
        ))}

      {pendingRemove && (
        <ConfirmSheet
          title="Retirer cette invitation ?"
          message={`« ${pendingRemove.email} » ne pourra plus s'enrôler avec ce lien tant qu'elle n'est pas réinvitée.`}
          confirmLabel="Retirer"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => void handleConfirmRemove()}
        />
      )}
    </div>
  );
}

type DeletionRequestsPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: DossierDeletionRequestSummary[] };

type EquipmentRequestsPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: EquipmentRequest[] };

/**
 * Onglet "Notifications" (ex-"Demandes", renommé pour couvrir aussi
 * l'activité de suppression ci-dessous) : deux flux nettement séparés
 * visuellement.
 *
 * "À traiter" — trois sous-blocs autonomes, chacun avec son propre
 * chargement/état d'erreur/liste — pas d'état partagé, comme
 * AccountsTab/AccessTab sont déjà deux composants séparés. Suppression de
 * dossier (inchangé) d'abord, puis équipement manquant (item 1, morceau 3),
 * puis remontées terrain (canal de remontée général — proposition/bug/autre,
 * table `demandes`, sans rapport avec les deux premiers blocs qui portent
 * sur `dossier_deletion_requests`/`dossier_equipment_requests`). Flux
 * d'ACTION : chaque ligne se résout (approuver/rejeter/traiter).
 *
 * "Activité de suppression" — `DeletionActivityTab`, repris tel quel
 * (anciennement son propre onglet "Suppressions", devenu impossible à
 * repérer une fois la barre à six onglets sur écran de téléphone). Flux
 * d'INFORMATION, lecture seule : rien à approuver, seulement à acquitter.
 */
function DemandesTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <p style={{ fontSize: 17, fontWeight: 700, color: colors.text }}>À traiter</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={eyebrowStyle}>Suppression de dossier</p>
          <DeletionRequestsSection />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={eyebrowStyle}>Équipement manquant</p>
          <EquipmentRequestsSection />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={eyebrowStyle}>Remontées terrain</p>
          <RemonteesTerrainSection />
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingTop: 20,
          borderTop: `1px solid ${textA(0.12)}`,
        }}
      >
        <p style={{ fontSize: 17, fontWeight: 700, color: colors.text }}>Activité de suppression</p>
        <p style={{ fontSize: 12.5, color: textA(0.55), lineHeight: 1.4 }}>
          Information en lecture seule — à surveiller, pas à traiter.
        </p>
        <DeletionActivityTab />
      </div>
    </div>
  );
}

/**
 * Demandes de suppression en attente (dossier à coffre configuré, refusées
 * directement à un non-admin par le trigger côté base — voir
 * DossierFormSheet.handleDelete). Approuver/rejeter passe exclusivement par
 * `resolveDeletionRequest`, jamais par un soft delete direct ici : c'est la
 * RPC `resolve_dossier_deletion_request` qui vérifie l'admin et fait le soft
 * delete + la résolution de façon atomique.
 */
function DeletionRequestsSection() {
  const [requests, setRequests] = useState<DeletionRequestsPhase>({ kind: 'loading' });
  const [pendingApprove, setPendingApprove] = useState<DossierDeletionRequestSummary | null>(null);
  const [pendingReject, setPendingReject] = useState<DossierDeletionRequestSummary | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setRequests({ kind: 'loading' });
    try {
      const rows = await listDeletionRequests();
      setRequests({ kind: 'loaded', rows });
    } catch (err) {
      setRequests({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    // Chargement au montage via callback mémoïsée ; setState après await,
    // pattern voulu.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRequests();
  }, [loadRequests]);

  async function handleResolve(request: DossierDeletionRequestSummary, approve: boolean) {
    setPendingApprove(null);
    setPendingReject(null);
    setResolvingId(request.id);
    setResolveError(null);
    try {
      await resolveDeletionRequest(request.id, approve);
      await loadRequests();
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {resolveError && <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {resolveError}</p>}

      {requests.kind === 'loading' && (
        <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>
      )}
      {requests.kind === 'error' && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {requests.message}</p>
      )}
      {requests.kind === 'loaded' && requests.rows.length === 0 && (
        <p style={{ fontSize: 13, color: textA(0.55) }}>Aucune demande en attente.</p>
      )}

      {requests.kind === 'loaded' &&
        requests.rows.map((r) => {
          const isResolving = resolvingId === r.id;
          return (
            <div key={r.id} style={accountRowStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>{r.nom_client}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {r.reason === 'vault_content' && <Badge label="Données sensibles" active />}
                <span style={{ fontSize: 12, color: textA(0.55) }}>
                  Demandé{r.requested_by_nom ? ` par ${r.requested_by_nom}` : ''} le {formatDate(r.created_at)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => setPendingReject(r)}
                  disabled={isResolving}
                  style={{ ...revokeButtonStyle, opacity: isResolving ? 0.6 : 1 }}
                >
                  Rejeter
                </button>
                <button
                  type="button"
                  onClick={() => setPendingApprove(r)}
                  disabled={isResolving}
                  style={{ ...activateButtonStyle, opacity: isResolving ? 0.6 : 1 }}
                >
                  {isResolving ? '…' : 'Approuver la suppression'}
                </button>
              </div>
            </div>
          );
        })}

      {pendingApprove && (
        <ConfirmSheet
          title="Approuver la suppression ?"
          message={`« ${pendingApprove.nom_client} » sera définitivement supprimé — ses données sensibles ont été vérifiées.`}
          confirmLabel="Supprimer"
          danger
          onCancel={() => setPendingApprove(null)}
          onConfirm={() => void handleResolve(pendingApprove, true)}
        />
      )}

      {pendingReject && (
        <ConfirmSheet
          title="Rejeter cette demande ?"
          message={`« ${pendingReject.nom_client} » sera conservé ; la demande sera classée comme rejetée.`}
          confirmLabel="Rejeter"
          onCancel={() => setPendingReject(null)}
          onConfirm={() => void handleResolve(pendingReject, false)}
        />
      )}
    </div>
  );
}

/**
 * Demandes d'équipement absent de la base (item 1, morceau 3). Approuver
 * exige une spécialité (la RPC `resolve_dossier_equipment_request` la refuse
 * sinon) — le bouton reste désactivé tant qu'aucune n'est choisie pour la
 * ligne. Référentiel spécialités réutilisé tel quel (getLocalDepartments/
 * getLocalSpecialties, IndexedDB déjà synchronisé — CLAUDE.md §4), pas de
 * nouvelle requête.
 */
function EquipmentRequestsSection() {
  const [requests, setRequests] = useState<EquipmentRequestsPhase>({ kind: 'loading' });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [selectedSpecialtyByRequest, setSelectedSpecialtyByRequest] = useState<Record<string, string>>({});
  const [pendingApprove, setPendingApprove] = useState<EquipmentRequest | null>(null);
  const [pendingReject, setPendingReject] = useState<EquipmentRequest | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setRequests({ kind: 'loading' });
    try {
      const rows = await listPendingEquipmentRequests();
      setRequests({ kind: 'loaded', rows });
    } catch (err) {
      setRequests({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    // Chargement au montage via callback mémoïsée ; setState après await,
    // pattern voulu.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [depts, specs] = await Promise.all([getLocalDepartments(), getLocalSpecialties()]);
      if (cancelled) return;
      setDepartments(depts);
      setSpecialties(specs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const specialtiesByDepartment = useMemo(() => {
    const map = new Map<string, Specialty[]>();
    for (const s of specialties) {
      const list = map.get(s.department_id) ?? [];
      list.push(s);
      map.set(s.department_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [specialties]);

  async function handleResolve(request: EquipmentRequest, approve: boolean) {
    setPendingApprove(null);
    setPendingReject(null);
    setResolvingId(request.id);
    setResolveError(null);
    try {
      await resolveEquipmentRequest(request.id, {
        approve,
        specialtyId: approve ? selectedSpecialtyByRequest[request.id] : undefined,
      });
      await loadRequests();
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingId(null);
    }
  }

  const approveSpecialtyName = pendingApprove
    ? (specialties.find((s) => s.id === selectedSpecialtyByRequest[pendingApprove.id])?.name ?? '')
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {resolveError && <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {resolveError}</p>}

      {requests.kind === 'loading' && (
        <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>
      )}
      {requests.kind === 'error' && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {requests.message}</p>
      )}
      {requests.kind === 'loaded' && requests.rows.length === 0 && (
        <p style={{ fontSize: 13, color: textA(0.55) }}>Aucune demande d'équipement en attente.</p>
      )}

      {requests.kind === 'loaded' &&
        requests.rows.map((r) => {
          const isResolving = resolvingId === r.id;
          const selectedSpecialtyId = selectedSpecialtyByRequest[r.id] ?? '';
          const canApprove = selectedSpecialtyId !== '' && !isResolving;
          return (
            <div key={r.id} style={accountRowStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>
                {r.marque}
                {r.modele ? ` ${r.modele}` : ''}
              </div>
              {r.commentaire && (
                <div style={{ fontSize: 12.5, color: textA(0.6), marginTop: 4, lineHeight: 1.4 }}>{r.commentaire}</div>
              )}
              <div style={{ fontSize: 12, color: textA(0.55), marginTop: 8 }}>
                Dossier : {r.nom_client ?? r.dossier_id}
              </div>
              <div style={{ fontSize: 12, color: textA(0.55), marginTop: 2 }}>
                Demandé{r.requested_by_nom ? ` par ${r.requested_by_nom}` : ''} le {formatDate(r.created_at)}
              </div>

              <select
                value={selectedSpecialtyId}
                onChange={(e) =>
                  setSelectedSpecialtyByRequest((prev) => ({ ...prev, [r.id]: e.target.value }))
                }
                disabled={isResolving}
                style={{ ...tabInputStyle, height: 40, marginTop: 10 }}
              >
                <option value="">Choisir une spécialité…</option>
                {departments.map((dept) => {
                  const deptSpecialties = specialtiesByDepartment.get(dept.id) ?? [];
                  if (deptSpecialties.length === 0) return null;
                  return (
                    <optgroup key={dept.id} label={dept.name}>
                      {deptSpecialties.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => setPendingReject(r)}
                  disabled={isResolving}
                  style={{ ...revokeButtonStyle, opacity: isResolving ? 0.6 : 1 }}
                >
                  Refuser
                </button>
                <button
                  type="button"
                  onClick={() => setPendingApprove(r)}
                  disabled={!canApprove}
                  style={{ ...activateButtonStyle, opacity: canApprove ? 1 : 0.5 }}
                >
                  {isResolving ? '…' : 'Approuver'}
                </button>
              </div>
            </div>
          );
        })}

      {pendingApprove && (
        <ConfirmSheet
          title="Approuver la demande ?"
          message={`Créer le produit « ${pendingApprove.marque}${pendingApprove.modele ? ' ' + pendingApprove.modele : ''} » dans la spécialité « ${approveSpecialtyName} » et le rattacher au dossier « ${pendingApprove.nom_client ?? pendingApprove.dossier_id} » ?`}
          confirmLabel="Approuver"
          onCancel={() => setPendingApprove(null)}
          onConfirm={() => void handleResolve(pendingApprove, true)}
        />
      )}

      {pendingReject && (
        <ConfirmSheet
          title="Refuser cette demande ?"
          message={`La demande pour « ${pendingReject.marque}${pendingReject.modele ? ' ' + pendingReject.modele : ''} » sera classée comme refusée.`}
          confirmLabel="Refuser"
          onCancel={() => setPendingReject(null)}
          onConfirm={() => void handleResolve(pendingReject, false)}
        />
      )}
    </div>
  );
}

const DEMANDE_TYPE_FILTERS: (DemandeType | 'all')[] = ['all', 'amelioration', 'bug', 'autre'];
const DEMANDE_STATUT_FILTERS: (DemandeStatut | 'all')[] = ['all', 'nouvelle', 'en_cours', 'traitee'];

function demandeTypeFilterLabel(value: DemandeType | 'all'): string {
  return value === 'all' ? 'Tous' : demandeTypeLabel(value);
}

function demandeStatutFilterLabel(value: DemandeStatut | 'all'): string {
  return value === 'all' ? 'Tous' : demandeStatutLabel(value);
}

type RemonteesPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: Demande[] };

/**
 * Canal de remontée terrain (amélioration/bug/autre, table `demandes`) — vue
 * admin : tout voir, filtrer, faire avancer le statut, répondre. Filtré par
 * défaut sur statut 'nouvelle' (les demandes à traiter en premier), pas de
 * filtre par type. `reponseByDemande` porte les brouillons de réponse en
 * cours d'édition (un textarea par carte), même pattern que
 * `selectedSpecialtyByRequest` dans EquipmentRequestsSection. Suppression
 * définitive réservée aux demandes 'traitee' (bouton visible seulement sur
 * ce statut) — une demande encore ouverte ne doit disparaître qu'en passant
 * par le cycle de statut normal, jamais par suppression directe.
 */
function RemonteesTerrainSection() {
  const [typeFilter, setTypeFilter] = useState<DemandeType | 'all'>('all');
  const [statutFilter, setStatutFilter] = useState<DemandeStatut | 'all'>('nouvelle');
  const [phase, setPhase] = useState<RemonteesPhase>({ kind: 'loading' });
  const [reponseByDemande, setReponseByDemande] = useState<Record<string, string>>({});
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingReopen, setPendingReopen] = useState<Demande | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Demande | null>(null);

  const loadDemandes = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const rows = await listAllDemandes({
        type: typeFilter === 'all' ? undefined : typeFilter,
        statut: statutFilter === 'all' ? undefined : statutFilter,
      });
      setPhase({ kind: 'loaded', rows });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [typeFilter, statutFilter]);

  useEffect(() => {
    // Chargement au montage et à chaque changement de filtre, via callback
    // mémoïsée ; setState après await, pattern voulu dans ce fichier.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDemandes();
  }, [loadDemandes]);

  async function handleStatutChange(demande: Demande, statut: DemandeStatut) {
    setPendingReopen(null);
    setUpdatingId(demande.id);
    setActionError(null);
    try {
      await updateDemandeStatut(demande.id, { statut });
      await loadDemandes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleSaveReponse(demande: Demande) {
    const reponse = (reponseByDemande[demande.id] ?? demande.reponse_admin ?? '').trim();
    setUpdatingId(demande.id);
    setActionError(null);
    try {
      await updateDemandeStatut(demande.id, { reponse_admin: reponse || null });
      await loadDemandes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleDelete(demande: Demande) {
    setPendingDelete(null);
    setUpdatingId(demande.id);
    setActionError(null);
    try {
      await deleteDemande(demande.id);
      await loadDemandes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
        {DEMANDE_TYPE_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTypeFilter(value)}
            style={demandeFilterChipStyle(typeFilter === value)}
          >
            {demandeTypeFilterLabel(value)}
          </button>
        ))}
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
        {DEMANDE_STATUT_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatutFilter(value)}
            style={demandeFilterChipStyle(statutFilter === value)}
          >
            {demandeStatutFilterLabel(value)}
          </button>
        ))}
      </div>

      {actionError && <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {actionError}</p>}

      {phase.kind === 'loading' && (
        <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>
      )}
      {phase.kind === 'error' && (
        <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {phase.message}</p>
      )}
      {phase.kind === 'loaded' && phase.rows.length === 0 && (
        <p style={{ fontSize: 13, color: textA(0.55) }}>Aucune demande.</p>
      )}

      {phase.kind === 'loaded' &&
        phase.rows.map((d) => {
          const isUpdating = updatingId === d.id;
          const reponseValue = reponseByDemande[d.id] ?? d.reponse_admin ?? '';
          const contexte = d.contexte as { platform?: string; appVersion?: string } | null;
          const label = d.titre ?? d.message.slice(0, 60) + (d.message.length > 60 ? '…' : '');
          return (
            <div key={d.id} style={accountRowStyle}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, wordBreak: 'break-word' }}>{label}</div>
                  <div style={{ fontSize: 12, color: textA(0.55), marginTop: 4 }}>
                    {demandeTypeLabel(d.type)} · {d.auteur_nom ?? 'inconnu'} · {formatDate(d.created_at)}
                  </div>
                </div>
                <DemandeStatutBadge statut={d.statut} />
              </div>

              <p style={{ fontSize: 13.5, color: textA(0.8), lineHeight: 1.5, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {d.message}
              </p>

              {contexte?.platform && (
                <div style={{ fontSize: 11, fontFamily: fonts.mono, color: textA(0.4), marginTop: 6 }}>
                  {contexte.platform}
                  {contexte.appVersion ? ` · v${contexte.appVersion}` : ''}
                </div>
              )}

              {d.resolved_by_nom && d.resolved_at && (
                <div style={{ fontSize: 12, color: textA(0.5), marginTop: 6 }}>
                  Traitée par {d.resolved_by_nom} le {formatDate(d.resolved_at)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {d.statut === 'nouvelle' && (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void handleStatutChange(d, 'en_cours')}
                    style={{ ...activateButtonStyle, opacity: isUpdating ? 0.6 : 1 }}
                  >
                    Prendre en charge
                  </button>
                )}
                {d.statut === 'en_cours' && (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void handleStatutChange(d, 'traitee')}
                    style={{ ...activateButtonStyle, opacity: isUpdating ? 0.6 : 1 }}
                  >
                    Marquer traitée
                  </button>
                )}
                {d.statut === 'traitee' && (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => setPendingReopen(d)}
                    style={{ ...revokeButtonStyle, opacity: isUpdating ? 0.6 : 1 }}
                  >
                    Rouvrir
                  </button>
                )}
                {d.statut === 'traitee' && (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => setPendingDelete(d)}
                    style={{ ...revokeButtonStyle, opacity: isUpdating ? 0.6 : 1 }}
                  >
                    Supprimer
                  </button>
                )}
              </div>

              <textarea
                value={reponseValue}
                onChange={(e) => setReponseByDemande((prev) => ({ ...prev, [d.id]: e.target.value }))}
                placeholder="Réponse (optionnel)"
                rows={2}
                disabled={isUpdating}
                style={{ ...tabInputStyle, height: 'auto', marginTop: 10, paddingTop: 10, paddingBottom: 10, resize: 'vertical' }}
              />
              <button
                type="button"
                disabled={isUpdating}
                onClick={() => void handleSaveReponse(d)}
                style={{ ...activateButtonStyle, marginTop: 8, opacity: isUpdating ? 0.6 : 1 }}
              >
                Enregistrer la réponse
              </button>
            </div>
          );
        })}

      {pendingReopen && (
        <ConfirmSheet
          title="Rouvrir cette demande ?"
          message="Elle repassera au statut « En cours »."
          confirmLabel="Rouvrir"
          onCancel={() => setPendingReopen(null)}
          onConfirm={() => void handleStatutChange(pendingReopen, 'en_cours')}
        />
      )}

      {pendingDelete && (
        <ConfirmSheet
          title="Supprimer cette demande ?"
          message="Elle sera définitivement supprimée — action irréversible."
          confirmLabel="Supprimer"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleDelete(pendingDelete)}
        />
      )}
    </div>
  );
}

function demandeFilterChipStyle(active: boolean): CSSProperties {
  return {
    flex: 'none',
    whiteSpace: 'nowrap',
    height: 32,
    padding: '0 12px',
    borderRadius: 100,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    border: `1px solid ${active ? colors.accent : textA(0.25)}`,
    background: active ? colors.accent : 'transparent',
    color: active ? '#132146' : colors.text,
  };
}

type DeletionActivityPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: DeletionActivityRow[] };

/**
 * Section "Activité de suppression" de l'onglet "Notifications" (alerte
 * admin de suppression massive) : une ligne par utilisateur ayant supprimé
 * quelque chose sur 7 jours (`getDeletionActivity`, lecture seule — aucune
 * écriture possible depuis cette section). Les lignes en alerte (seuils
 * `SEUIL_RAFALE`/`SEUIL_CUMUL`, `deletionAlertLevel`, vaultAdmin.ts)
 * remontent en premier, puis le reste de l'activité 7j triée par la RPC.
 * `insufficient_privilege` (non-admin) est déjà réduit à un tableau vide par
 * `getDeletionActivity` — inatteignable en pratique ici puisque l'écran
 * entier est déjà gaté par `isVaultAdmin()`, mais ça revient bien à "ne rien
 * montrer" plutôt qu'à planter.
 */
function DeletionActivityTab() {
  const [phase, setPhase] = useState<DeletionActivityPhase>({ kind: 'loading' });
  // Incrémenté après un acquittement pour forcer un nouveau rendu : l'état
  // acquitté vit en localStorage (vaultAdmin.ts), pas en state React.
  const [ackVersion, setAckVersion] = useState(0);

  const loadActivity = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const rows = await getDeletionActivity();
      setPhase({ kind: 'loaded', rows });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    // Chargement au montage via callback mémoïsée ; setState après await,
    // pattern voulu dans ce fichier.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadActivity();
  }, [loadActivity]);

  function handleAcknowledge(row: DeletionActivityRow) {
    acknowledgeDeletionAlert(row);
    setAckVersion((v) => v + 1);
  }

  if (phase.kind === 'loading') {
    return <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 12 }}>Chargement…</p>;
  }
  if (phase.kind === 'error') {
    return <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {phase.message}</p>;
  }
  if (phase.rows.length === 0) {
    return <p style={{ fontSize: 13, color: textA(0.55) }}>Aucune suppression sur les 7 derniers jours.</p>;
  }

  const withLevel = phase.rows.map((row) => ({ row, level: deletionAlertLevel(row) }));
  const alerting = withLevel.filter((r) => r.level !== null);
  const normal = withLevel.filter((r) => r.level === null);

  return (
    <div key={ackVersion} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {alerting.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={eyebrowStyle}>En alerte</p>
          {alerting.map(({ row, level }) => (
            <DeletionActivityRowCard key={row.user_id} row={row} level={level} onAcknowledge={handleAcknowledge} />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={eyebrowStyle}>Activité 7 jours</p>
        {normal.length === 0 ? (
          <p style={{ fontSize: 13, color: textA(0.55) }}>Rien en dehors des alertes ci-dessus.</p>
        ) : (
          normal.map(({ row }) => (
            <DeletionActivityRowCard key={row.user_id} row={row} level={null} onAcknowledge={handleAcknowledge} />
          ))
        )}
      </div>
    </div>
  );
}

function DeletionActivityRowCard({
  row,
  level,
  onAcknowledge,
}: {
  row: DeletionActivityRow;
  level: DeletionAlertLevel | null;
  onAcknowledge: (row: DeletionActivityRow) => void;
}) {
  const acknowledged = level !== null && isDeletionAlertAcknowledged(row);
  const tableEntries = Object.entries(row.tables_24h ?? {});

  return (
    <div style={accountRowStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, wordBreak: 'break-word' }}>{row.auteur}</div>
          <div style={{ fontSize: 12, color: textA(0.55), marginTop: 4 }}>
            {row.role} · dernière suppression le {formatDateTime(row.derniere_suppression)}
          </div>
        </div>
        {level && <DeletionAlertBadge level={level} acknowledged={acknowledged} />}
      </div>

      {level && (
        <p style={{ fontSize: 12.5, color: level === 'rafale' ? DANGER : colors.accent, marginTop: 6, lineHeight: 1.4 }}>
          {level === 'rafale' ? 'Rafale : activité en cours, urgent.' : 'Cumul : à vérifier.'}
        </p>
      )}

      <div style={{ fontSize: 12.5, color: textA(0.7), marginTop: 8 }}>
        {row.last_15min} sur 15 min · {row.last_24h} sur 24 h · {row.last_7d} sur 7 j
      </div>

      {tableEntries.length > 0 && (
        <div style={{ fontSize: 12, color: textA(0.55), marginTop: 6, lineHeight: 1.5 }}>
          {tableEntries.map(([table, count]) => `${table} (${count})`).join(' · ')}
        </div>
      )}

      {level && !acknowledged && (
        <button type="button" onClick={() => onAcknowledge(row)} style={{ ...activateButtonStyle, marginTop: 10 }}>
          Marquer comme vue
        </button>
      )}
    </div>
  );
}

/** Même formule visuelle que `DemandeStatutBadge` (dot + pill) — pas de
 * composant partagé, seule la palette est commune, cf. commentaire de
 * `DemandeStatutBadge` plus bas. */
function DeletionAlertBadge({ level, acknowledged }: { level: DeletionAlertLevel; acknowledged: boolean }) {
  if (acknowledged) {
    return <StatusChip label={level === 'rafale' ? 'Rafale · vue' : 'Cumul · vue'} kind="success" />;
  }
  const color = level === 'rafale' ? DANGER : colors.accent;
  const background = level === 'rafale' ? 'rgba(209, 67, 67, 0.18)' : accentA(0.18);
  return (
    <span
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 100,
        background,
        color,
        fontSize: 11.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {level === 'rafale' ? 'Rafale' : 'Cumul'}
    </span>
  );
}

/** Même formule 3 états que le badge de statut côté monteur (DemandesScreen) —
 * pas de composant partagé, seule la palette (accent/text/success) est
 * commune, réutilisée ici sans dépendance croisée entre écrans monteur/admin. */
function DemandeStatutBadge({ statut }: { statut: DemandeStatut }) {
  const color = statut === 'traitee' ? colors.success : statut === 'en_cours' ? colors.text : colors.accent;
  const background = statut === 'traitee' ? successA(0.18) : statut === 'en_cours' ? textA(0.1) : accentA(0.18);
  return (
    <span
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 100,
        background,
        color,
        fontSize: 11.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {demandeStatutLabel(statut)}
    </span>
  );
}

function StatusChip({ label, kind }: { label: string; kind: 'success' | 'pending' }) {
  const color = kind === 'success' ? colors.success : colors.accent;
  const background = kind === 'success' ? successA(0.18) : accentA(0.18);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 100,
        background,
        color,
        fontSize: 11.5,
        fontWeight: 700,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  );
}

function BlockingMessage({ text, isError = false }: { text: string; isError?: boolean }) {
  return (
    <div style={offlineBannerStyle}>
      <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
      <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4, color: isError ? colors.accent : colors.text }}>
        {text}
      </span>
    </div>
  );
}

const backButtonStyle: CSSProperties = {
  flex: 'none',
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: textA(0.1),
  border: 'none',
  color: colors.text,
  fontSize: 17,
  cursor: 'pointer',
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: textA(0.55),
};

const offlineBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 10,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '9px 12px',
};

const tabButtonStyle: CSSProperties = {
  flex: 1,
  height: 38,
  borderRadius: 10,
  border: 'none',
  background: textA(0.08),
  color: colors.text,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

const tabButtonActiveStyle: CSSProperties = {
  background: colors.accent,
  color: '#132146',
};

const accountRowStyle: CSSProperties = {
  background: colors.card,
  borderRadius: 14,
  padding: '12px 14px',
};

const tabInputStyle: CSSProperties = {
  width: '100%',
  height: 48,
  background: textA(0.08),
  border: 'none',
  borderRadius: 12,
  padding: '0 14px',
  color: colors.text,
  fontSize: 15,
  fontFamily: fonts.sans,
  outline: 'none',
  boxSizing: 'border-box',
};

const tabPrimaryButtonStyle: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

const tabSecondaryButtonStyle: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: `1px solid ${textA(0.25)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

const activateButtonStyle: CSSProperties = {
  flex: 'none',
  height: 34,
  borderRadius: 10,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const revokeButtonStyle: CSSProperties = {
  flex: 'none',
  height: 34,
  borderRadius: 10,
  border: `1px solid ${colors.accent}`,
  background: 'transparent',
  color: colors.accent,
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const rotateButtonStyle: CSSProperties = {
  flex: 'none',
  height: 34,
  borderRadius: 10,
  border: `1px solid ${colors.accent}`,
  background: 'transparent',
  color: colors.accent,
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const confirmOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  boxSizing: 'border-box',
  zIndex: 1200,
};

const confirmBoxStyle: CSSProperties = {
  width: '100%',
  maxWidth: 360,
  background: colors.bg,
  border: `1px solid ${textA(0.15)}`,
  borderRadius: 14,
  padding: 18,
  boxSizing: 'border-box',
  fontFamily: fonts.sans,
  color: colors.text,
};

const reportBoxStyle: CSSProperties = {
  background: successA(0.12),
  border: `1px solid ${successA(0.3)}`,
  borderRadius: 12,
  padding: '12px 14px',
};

const reportBoxErrorStyle: CSSProperties = {
  background: 'rgba(222, 122, 34, 0.12)',
  border: '1px solid rgba(222, 122, 34, 0.35)',
  borderRadius: 12,
  padding: '12px 14px',
};

const dismissLinkStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  marginTop: 8,
  color: textA(0.55),
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: 'underline',
  cursor: 'pointer',
};
