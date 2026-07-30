import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { useVaultSession } from '../lib/useVaultSession';
import {
  getVaultSecret,
  getOwnDossierAccess,
  getVaultPublicKeys,
  insertVaultSecret,
  updateVaultSecret,
  insertDossierAccessRows,
  hasVaultAccess,
  type VaultDossierAccessRow,
} from '../lib/vaultSecrets';
import { unwrapDek, decryptContent, generateDek, encryptContent, wrapDekForUser } from '../lib/vault.js';
import { colors, fonts, textA } from '../styles/tokens';

export interface VaultSheetProps {
  dossierId: string;
  onClose: () => void;
}

type ContentPhase =
  | { kind: 'loading' }
  | { kind: 'blocked' }
  | { kind: 'empty' }
  | { kind: 'ready'; dek: CryptoKey }
  | { kind: 'error'; message: string };

/**
 * Ouverture/édition du coffre de données sensibles d'un dossier (Feature
 * coffre données sensibles.md, tranche 4). UI seule : toute la crypto vit
 * dans src/lib/vault.js (testé, 19/19), ce composant l'appelle sans y
 * toucher. Le déverrouillage (clé privée) est partagé entre dossiers via
 * VaultSessionProvider (src/lib/vaultSession.tsx) ; la DEK et la note en
 * clair, elles, sont strictement locales à ce composant et à ce dossier.
 */
export function VaultSheet({ dossierId, onClose }: VaultSheetProps) {
  const { session, isOnline } = useAuth();
  const userId = session?.user.id ?? null;
  const {
    privateKey,
    unlocked,
    unlocking,
    error: unlockError,
    unlock,
    unlockWithRecoveryKey,
    lock,
    touch,
  } = useVaultSession();

  const [unlockMode, setUnlockMode] = useState<'password' | 'recovery'>('password');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [content, setContent] = useState<ContentPhase>({ kind: 'loading' });
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!unlocked || !userId) return;
    let cancelled = false;
    void (async () => {
      setContent({ kind: 'loading' });
      try {
        const allowed = await hasVaultAccess();
        if (cancelled) return;
        if (!allowed) {
          setContent({ kind: 'blocked' });
          return;
        }

        const secret = await getVaultSecret(dossierId);
        if (cancelled) return;
        if (!secret) {
          setNote('');
          setContent({ kind: 'empty' });
          return;
        }

        const access = await getOwnDossierAccess(dossierId, userId);
        if (cancelled) return;
        if (!access) {
          setContent({
            kind: 'error',
            message: "Coffre existant mais aucun accès ne t'a été emballé — contacte un administrateur.",
          });
          return;
        }

        if (!privateKey) throw new Error('Clé privée indisponible.');
        const dek = await unwrapDek(access.wrapped_dek, privateKey);
        const plaintext = await decryptContent(dek, secret.ciphertext, secret.content_iv);
        if (cancelled) return;
        setNote(plaintext);
        setContent({ kind: 'ready', dek });
      } catch (err) {
        if (!cancelled) {
          setContent({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    // Cleanup, pas le corps de l'effet : se déclenche au verrouillage (bouton,
    // inactivité, sortie de la zone dossier — unlocked passe à false) et au
    // démontage du composant (fermeture de la feuille, changement de
    // dossier). La DEK et la note en clair ne doivent jamais survivre à la
    // clé privée qui les a produites.
    return () => {
      cancelled = true;
      setContent({ kind: 'loading' });
      setNote('');
      setSaveError(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, dossierId, userId]);

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (unlocking) return;
    if (unlockMode === 'password') {
      if (!password) return;
      await unlock(password);
      setPassword('');
    } else {
      if (!recoveryKey) return;
      await unlockWithRecoveryKey(recoveryKey);
      setRecoveryKey('');
    }
  }

  function toggleUnlockMode() {
    setUnlockMode((m) => (m === 'password' ? 'recovery' : 'password'));
    setPassword('');
    setRecoveryKey('');
  }

  async function handleSave() {
    if (!userId || saving || (content.kind !== 'ready' && content.kind !== 'empty')) return;
    setSaving(true);
    setSaveError(null);
    touch();
    try {
      if (content.kind === 'ready') {
        const encrypted = await encryptContent(content.dek, note);
        await updateVaultSecret(dossierId, encrypted);
      } else {
        const dek = await generateDek();
        const encrypted = await encryptContent(dek, note);
        await insertVaultSecret(dossierId, encrypted);

        const recipients = await getVaultPublicKeys();
        const rows: VaultDossierAccessRow[] = await Promise.all(
          recipients.map(async (r) => ({
            dossier_id: dossierId,
            user_id: r.user_id,
            wrapped_dek: await wrapDekForUser(dek, r.public_key),
            dek_version: 1,
          })),
        );
        try {
          await insertDossierAccessRows(rows);
        } catch (accessErr) {
          throw new Error(
            `Le contenu a été enregistré mais l'octroi des accès a échoué (${
              accessErr instanceof Error ? accessErr.message : String(accessErr)
            }). Contacte un administrateur pour réparer les accès de ce dossier.`,
            { cause: accessErr },
          );
        }
        setContent({ kind: 'ready', dek });
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          touch();
        }}
        className="no-scrollbar"
        style={sheetStyle}
      >
        <div style={grabberStyle} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Données sensibles</span>
          {unlocked && (
            <button type="button" onClick={lock} style={lockButtonStyle}>
              Verrouiller
            </button>
          )}
        </div>

        {!isOnline && (
          <div style={{ ...offlineBannerStyle, marginTop: 12 }}>
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
              Connexion réseau requise pour ouvrir le coffre.
            </span>
          </div>
        )}

        {isOnline && !unlocked && (
          <form onSubmit={(e) => void handleUnlockSubmit(e)} style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
              {unlockMode === 'password'
                ? 'Mot de passe de coffre — distinct de ton mot de passe de connexion.'
                : 'Clé de récupération remise à la création du coffre.'}
            </p>
            {unlockMode === 'password' ? (
              <input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mot de passe du coffre"
                style={inputStyle}
                autoFocus
              />
            ) : (
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                style={inputStyle}
                autoFocus
              />
            )}
            {unlockError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{unlockError}</span>}
            <button
              type="submit"
              disabled={unlocking || (unlockMode === 'password' ? !password : !recoveryKey)}
              style={{
                ...primaryButtonStyle,
                opacity: unlocking || (unlockMode === 'password' ? !password : !recoveryKey) ? 0.5 : 1,
              }}
            >
              {unlocking ? 'Déverrouillage…' : 'Déverrouiller'}
            </button>
            <button type="button" onClick={toggleUnlockMode} style={switchModeLinkStyle}>
              {unlockMode === 'password'
                ? 'Mot de passe oublié ? Utiliser ma clé de récupération'
                : 'Utiliser mon mot de passe'}
            </button>
          </form>
        )}

        {isOnline && unlocked && content.kind === 'loading' && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>Chargement…</p>
        )}

        {isOnline && unlocked && content.kind === 'blocked' && (
          <p style={{ fontSize: 13.5, color: textA(0.6), lineHeight: 1.5, marginTop: 16 }}>
            Tu n'as pas accès au coffre de données sensibles. Contacte un administrateur pour l'activer.
          </p>
        )}

        {isOnline && unlocked && content.kind === 'error' && (
          <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5, marginTop: 16 }}>{content.message}</p>
        )}

        {isOnline && unlocked && (content.kind === 'empty' || content.kind === 'ready') && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {content.kind === 'empty' && (
              <p style={{ fontSize: 13, color: textA(0.55), margin: 0 }}>
                Coffre vide — mastercodes, WiFi, codes d'accès du site.
              </p>
            )}
            <textarea
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                touch();
              }}
              rows={6}
              placeholder="Mastercodes, mot de passe WiFi, codes d'accès…"
              style={textareaStyle}
            />
            {saveError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{saveError}</span>}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ ...primaryButtonStyle, opacity: saving ? 0.6 : 1 }}
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'flex-end',
  zIndex: 1200,
};

const sheetStyle: CSSProperties = {
  width: '100%',
  maxHeight: '85vh',
  overflowY: 'auto',
  background: colors.bg,
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
  padding: '18px 16px 24px',
  boxSizing: 'border-box',
  fontFamily: fonts.sans,
  color: colors.text,
};

const grabberStyle: CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 2,
  background: textA(0.25),
  margin: '0 auto 16px',
};

const lockButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${textA(0.3)}`,
  borderRadius: 10,
  color: colors.text,
  fontSize: 12.5,
  fontWeight: 700,
  padding: '6px 12px',
  cursor: 'pointer',
};

const offlineBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '9px 12px',
};

const inputStyle: CSSProperties = {
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

const textareaStyle: CSSProperties = {
  width: '100%',
  background: textA(0.08),
  border: 'none',
  borderRadius: 12,
  padding: '12px 14px',
  color: colors.text,
  fontSize: 14.5,
  fontFamily: fonts.sans,
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
  lineHeight: 1.5,
};

const switchModeLinkStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: textA(0.55),
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: 'underline',
  textAlign: 'left',
  alignSelf: 'flex-start',
  cursor: 'pointer',
};

const primaryButtonStyle: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};
