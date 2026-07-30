import { useEffect, useState, type CSSProperties } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { isVaultAdmin, getAllVaultUserKeys, type VaultUserKeySummary } from '../lib/vaultAdmin';
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

  useEffect(() => {
    if (phase.kind !== 'ready' || tab !== 'comptes') return;
    let cancelled = false;
    void (async () => {
      setAccounts({ kind: 'loading' });
      try {
        const rows = await getAllVaultUserKeys();
        if (!cancelled) setAccounts({ kind: 'loaded', rows });
      } catch (err) {
        if (!cancelled) {
          setAccounts({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase.kind, tab]);

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
            {tab === 'acces' && <ComingSoon />}
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
