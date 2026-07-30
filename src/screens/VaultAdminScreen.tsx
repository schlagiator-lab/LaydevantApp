import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useVaultSession } from '../lib/useVaultSession';
import {
  isVaultAdmin,
  getAllVaultUserKeys,
  setVaultAccessEnabled,
  getAllVaultDossiers,
  getDossierAccessRowsForUser,
  type VaultUserKeySummary,
  type VaultDossierSummary,
} from '../lib/vaultAdmin';
import { upsertDossierAccessRow } from '../lib/vaultSecrets';
import { unwrapDek, wrapDekForUser } from '../lib/vault.js';
import { StatusPill } from '../components/StatusPill';
import { colors, fonts, textA, successA } from '../styles/tokens';

type Phase = { kind: 'loading' } | { kind: 'checkError'; message: string } | { kind: 'forbidden' } | { kind: 'ready' };

type Tab = 'comptes' | 'acces' | 'rotation';

type AccountsPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; rows: VaultUserKeySummary[] };

/**
 * Panneau admin du coffre de données sensibles (tranche 5). Réservé aux
 * admins : garde-fou fait par l'écran lui-même (is_vault_admin, RPC), pas
 * par le lien d'entrée ni par la navigation — même convention que
 * VaultEnrollScreen. Cette première étape est lecture seule : seul l'onglet
 * "Comptes" est implémenté, "Accès" et "Rotation" sont des placeholders.
 */
export function VaultAdminScreen() {
  const { isOnline } = useAuth();
  const nav = useNavigation();

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('comptes');
  const [accounts, setAccounts] = useState<AccountsPhase>({ kind: 'loading' });

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

  useEffect(() => {
    if (phase.kind !== 'ready') return;
    void (async () => {
      await loadAccounts();
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
            </div>

            {tab === 'comptes' && <AccountsTab accounts={accounts} />}
            {tab === 'acces' && <AccessTab accounts={accounts} onActivated={loadAccounts} />}
            {tab === 'rotation' && <ComingSoon />}
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

function ComingSoon() {
  return <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>À venir.</p>;
}

function AccountsTab({ accounts }: { accounts: AccountsPhase }) {
  if (accounts.kind === 'loading') {
    return <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>Chargement…</p>;
  }
  if (accounts.kind === 'error') {
    return <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5 }}>Erreur : {accounts.message}</p>;
  }
  if (accounts.rows.length === 0) {
    return <p style={{ fontSize: 13, color: textA(0.55) }}>Aucun compte enrôlé.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {accounts.rows.map((r) => (
        <div key={r.user_id} style={accountRowStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, wordBreak: 'break-all' }}>
            {r.full_name ?? r.user_id}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge label="Enrôlé" active={r.public_key !== null} />
            <Badge label="Accès coffre" active={r.access_enabled} />
            <Badge label="Récupérateur" active={r.is_recovery_admin} />
          </div>
        </div>
      ))}
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

/**
 * Onglet "Accès" (tranche 5) : active un compte enrôlé — lui donne accès à
 * tous les coffres existants. Exige la clé privée déballée (session de
 * coffre partagée via VaultSessionProvider, comme VaultSheet) : sans elle,
 * impossible de déballer les DEK existantes pour les remballer vers le
 * nouveau compte.
 */
function AccessTab({ accounts, onActivated }: { accounts: AccountsPhase; onActivated: () => void }) {
  const { session } = useAuth();
  const ownUserId = session?.user.id ?? null;
  const { privateKey, unlocked, unlocking, error: unlockError, unlock } = useVaultSession();

  const [password, setPassword] = useState('');
  const [pendingActivation, setPendingActivation] = useState<VaultUserKeySummary | null>(null);
  const [activation, setActivation] = useState<ActivationState>({ kind: 'idle' });

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
      onActivated();
    } catch (err) {
      setActivation({ kind: 'error', account, message: err instanceof Error ? err.message : String(err) });
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

      {rows.map((r) => {
        const isRunning = activation.kind === 'running' && activation.account.user_id === r.user_id;
        return (
          <div key={r.user_id} style={accountRowStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, wordBreak: 'break-all' }}>
              {r.full_name ?? r.user_id}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Badge label="Accès coffre" active={r.access_enabled} />
              <button
                type="button"
                onClick={() => openConfirm(r)}
                disabled={isRunning}
                style={{ ...activateButtonStyle, opacity: isRunning ? 0.6 : 1 }}
              >
                {isRunning ? 'Activation…' : r.access_enabled ? "Réparer l'accès" : 'Activer'}
              </button>
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
    </div>
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
