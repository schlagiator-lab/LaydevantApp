import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { enroll } from '../lib/onboarding';
import { colors, fonts, textA } from '../styles/tokens';

export interface EnrollScreenProps {
  onLogin: () => void;
}

/**
 * Auto-enrôlement (CLAUDE.md §7) : la personne doit être sur la liste blanche
 * (onboarding_invitations, email non consommé) pour que enroll() réussisse —
 * l'Edge Function fait tout le contrôle, cet écran ne fait qu'appeler.
 * Connexion automatique après succès, comme LoginScreen.
 */
export function EnrollScreen({ onLogin }: EnrollScreenProps) {
  const { signInWithPassword, isOnline } = useAuth();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isOnline || submitting) return;
    setError(null);

    if (password.length < 12) {
      setError('Mot de passe : 12 caractères minimum.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }

    setSubmitting(true);
    try {
      await enroll({ email, password, fullName });
      const { error: signInError } = await signInWithPassword(email, password);
      if (signInError) setError(signInError);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
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

  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        padding: 24,
      }}
    >
      <img
        src="/branding/logo-laydevant.jpg"
        alt="Laydevant SA — Électricité, Télécom, Automatisation de portes et portails"
        style={{ width: '100%', maxWidth: 320, borderRadius: 6 }}
      />

      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Email</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Nom complet</span>
          <input
            type="text"
            autoComplete="name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Mot de passe</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Confirmer le mot de passe</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        {error && (
          <div style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{error}</div>
        )}

        {!isOnline && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(222, 122, 34, 0.15)',
              border: '1px solid rgba(222, 122, 34, 0.4)',
              borderRadius: 10,
              padding: '9px 12px',
            }}
          >
            <span
              style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }}
            />
            <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
              Hors ligne — l'enrôlement nécessite une connexion réseau.
            </span>
          </div>
        )}

        <button
          type="submit"
          disabled={!isOnline || submitting}
          style={{
            height: 52,
            borderRadius: 14,
            border: 'none',
            background: !isOnline || submitting ? textA(0.2) : colors.accent,
            color: '#132146',
            fontSize: 16,
            fontWeight: 700,
            cursor: !isOnline || submitting ? 'default' : 'pointer',
            marginTop: 4,
          }}
        >
          {submitting ? 'Enrôlement…' : "S'enrôler"}
        </button>

        <button type="button" onClick={onLogin} style={linkButtonStyle}>
          J'ai déjà un compte
        </button>
      </form>
    </div>
  );
}

const linkButtonStyle: React.CSSProperties = {
  alignSelf: 'center',
  background: 'none',
  border: 'none',
  padding: 0,
  marginTop: 4,
  color: textA(0.55),
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'underline',
  cursor: 'pointer',
};
