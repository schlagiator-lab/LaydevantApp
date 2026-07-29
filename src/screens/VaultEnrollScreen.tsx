import { useEffect, useState, type CSSProperties } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { getVaultEnrollState, submitVaultEnrollment, type VaultEnrollFlow } from '../lib/vaultEnroll';
import { generateRecoveryKey, createUserKeys } from '../lib/vault.js';
import { StatusPill } from '../components/StatusPill';
import { colors, fonts, textA } from '../styles/tokens';

type Phase =
  | { kind: 'loading' }
  | { kind: 'checkError'; message: string }
  | { kind: 'alreadyEnrolled' }
  | { kind: 'blocked' }
  | { kind: 'form'; flow: VaultEnrollFlow }
  | { kind: 'submitting'; flow: VaultEnrollFlow }
  | { kind: 'submitError'; flow: VaultEnrollFlow; message: string }
  | { kind: 'done' };

const MIN_LENGTH: Record<VaultEnrollFlow, number> = { strict: 16, light: 12 };

/**
 * Enrôlement au coffre de données sensibles (étape B, tranche 4 de
 * "Feature coffre données sensibles.md"). Pure UI : toute la crypto vit dans
 * src/lib/vault.js (testé, 19/19), ce module se contente de l'appeler.
 */
export function VaultEnrollScreen() {
  const { session, isOnline } = useAuth();
  const nav = useNavigation();
  const userId = session?.user.id ?? null;

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [printed, setPrinted] = useState(false);
  // Affichée une seule fois, uniquement pour le flux strict (admin). Le flux
  // léger (monteur) génère aussi une clé de récupération — createUserKeys
  // l'exige — mais ne la met JAMAIS ici : elle vit et meurt dans le scope de
  // handleSubmit. Voir le commentaire à cet endroit.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !isOnline) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await getVaultEnrollState(userId);
        if (cancelled) return;
        if (state.status === 'already-enrolled') {
          setPhase({ kind: 'alreadyEnrolled' });
        } else if (state.status === 'blocked-no-recovery-admin') {
          setPhase({ kind: 'blocked' });
        } else {
          if (state.flow === 'strict') setRecoveryKey(generateRecoveryKey());
          setPhase({ kind: 'form', flow: state.flow });
        }
      } catch (err) {
        if (!cancelled) {
          setPhase({ kind: 'checkError', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // isOnline volontairement dans les deps : si le réseau revient après un
    // premier rendu hors ligne, on relance la vérification.
  }, [userId, isOnline]);

  const flow = phase.kind === 'form' || phase.kind === 'submitting' || phase.kind === 'submitError' ? phase.flow : null;
  const minLength = flow ? MIN_LENGTH[flow] : 0;
  const lengthOk = password.length >= minLength;
  const matchOk = password.length > 0 && password === confirmPassword;
  const strictGateOk = flow !== 'strict' || printed;
  const canSubmit = flow !== null && lengthOk && matchOk && strictGateOk && phase.kind !== 'submitting';

  async function handleSubmit() {
    if (!userId || !flow || !canSubmit) return;
    setPhase({ kind: 'submitting', flow });
    try {
      // Flux léger : récupération d'un monteur = ré-enrôlement assisté par un
      // admin, pas de clé papier individuelle — createUserKeys exige quand
      // même une clé de récupération en entrée, donc on la génère ici, on
      // l'utilise, et on ne la stocke nulle part (ni state, ni ailleurs).
      const recKeyForSubmit = flow === 'strict' ? recoveryKey : generateRecoveryKey();
      if (!recKeyForSubmit) throw new Error('Clé de récupération manquante.');
      const record = await createUserKeys(password, recKeyForSubmit);
      await submitVaultEnrollment(userId, record);
      setPassword('');
      setConfirmPassword('');
      setRecoveryKey(null);
      setPhase({ kind: 'done' });
    } catch (err) {
      setPhase({ kind: 'submitError', flow, message: err instanceof Error ? err.message : String(err) });
    }
  }

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
            <span style={eyebrowStyle}>Coffre — Enrôlement</span>
          </div>
          <StatusPill online={isOnline} />
        </div>
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '18px 16px 32px', boxSizing: 'border-box' }}
      >
        {!isOnline && (
          <BlockingMessage text="Connexion réseau requise pour configurer le coffre de données sensibles." />
        )}

        {isOnline && phase.kind === 'loading' && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 40 }}>Vérification…</p>
        )}

        {isOnline && phase.kind === 'checkError' && (
          <BlockingMessage text={`Erreur : ${phase.message}`} isError />
        )}

        {isOnline && phase.kind === 'alreadyEnrolled' && (
          <div style={{ textAlign: 'center', padding: '60px 20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Coffre déjà configuré</div>
            <div style={{ fontSize: 14, color: textA(0.6), lineHeight: 1.5 }}>
              Ce compte a déjà une clé de coffre. Le ré-enrôlement n'est pas géré par cet écran.
            </div>
          </div>
        )}

        {isOnline && phase.kind === 'blocked' && (
          <div style={{ textAlign: 'center', padding: '60px 20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Récupération pas encore configurée</div>
            <div style={{ fontSize: 14, color: textA(0.6), lineHeight: 1.5 }}>
              La récupération n'est pas encore configurée, contacte l'administrateur.
            </div>
          </div>
        )}

        {isOnline && flow && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 6 }}>
                {flow === 'strict' ? 'Configurer le coffre (administrateur)' : 'Configurer le coffre'}
              </div>
              <p style={{ fontSize: 13.5, color: textA(0.65), lineHeight: 1.5, margin: 0 }}>
                Ce mot de passe protège les données sensibles des dossiers clients (mastercodes, WiFi…). Il n'est
                connu que de toi : personne, pas même un administrateur, ne peut le récupérer.
              </p>
            </div>

            <div style={warningBannerStyle}>
              <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent, marginTop: 5 }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
                Choisis un mot de passe DIFFÉRENT de ton mot de passe de connexion. C'est un rappel — l'application
                ne peut pas vérifier cette différence techniquement.
              </span>
            </div>

            {flow === 'strict' && recoveryKey && (
              <div style={recoveryBoxStyle}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Clé de récupération</div>
                <p style={{ fontSize: 12.5, color: textA(0.65), lineHeight: 1.5, margin: '0 0 12px' }}>
                  Seul moyen de récupérer ce compte si le mot de passe est perdu. Affichée une seule fois, jamais
                  stockée : imprime-la et range-la en lieu sûr avant de continuer.
                </p>
                <div className="vault-recovery-print">
                  <div style={recoveryKeyTextStyle}>{recoveryKey}</div>
                </div>
                <button type="button" onClick={() => window.print()} style={printButtonStyle}>
                  Imprimer
                </button>
                <label style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={printed}
                    onChange={(e) => setPrinted(e.target.checked)}
                    style={{ width: 18, height: 18, flex: 'none' }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    J'ai imprimé cette clé et je l'ai rangée en lieu sûr.
                  </span>
                </label>
              </div>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Mot de passe du coffre</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, color: lengthOk ? textA(0.45) : colors.accent }}>
                Minimum {minLength} caractères.
              </span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Confirmer le mot de passe</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={inputStyle}
              />
              {confirmPassword.length > 0 && !matchOk && (
                <span style={{ fontSize: 12, color: colors.accent }}>Les mots de passe ne correspondent pas.</span>
              )}
            </label>

            {phase.kind === 'submitError' && (
              <div style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>Erreur : {phase.message}</div>
            )}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              style={{
                height: 52,
                borderRadius: 14,
                border: 'none',
                background: !canSubmit ? textA(0.2) : colors.accent,
                color: '#132146',
                fontSize: 16,
                fontWeight: 700,
                cursor: !canSubmit ? 'default' : 'pointer',
              }}
            >
              {phase.kind === 'submitting' ? 'Configuration…' : 'Configurer le coffre'}
            </button>
          </div>
        )}

        {isOnline && phase.kind === 'done' && (
          <div style={{ textAlign: 'center', padding: '60px 20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Coffre configuré</div>
            <div style={{ fontSize: 14, color: textA(0.6), lineHeight: 1.5, marginBottom: 20 }}>
              Le reste du coffre (ouverture, édition) arrive dans une prochaine étape.
            </div>
            <button type="button" onClick={nav.goHome} style={backHomeButtonStyle}>
              Retour à l'accueil
            </button>
          </div>
        )}
      </div>
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

const warningBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '10px 12px',
};

const recoveryBoxStyle: CSSProperties = {
  background: colors.card,
  borderRadius: 14,
  padding: '14px 16px',
};

const recoveryKeyTextStyle: CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textAlign: 'center',
  padding: '14px 8px',
  background: textA(0.08),
  borderRadius: 10,
  wordBreak: 'break-all',
  marginBottom: 12,
};

const printButtonStyle: CSSProperties = {
  width: '100%',
  height: 40,
  borderRadius: 10,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: 'pointer',
  marginBottom: 12,
};

const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  width: '100%',
  background: textA(0.08),
  border: 'none',
  borderRadius: 14,
  padding: '0 14px',
  height: 52,
  color: colors.text,
  fontSize: 16,
  fontFamily: fonts.sans,
  outline: 'none',
  boxSizing: 'border-box',
};

const backHomeButtonStyle: CSSProperties = {
  height: 44,
  padding: '0 20px',
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
};
