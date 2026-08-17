import { useState } from 'react';
import PdfTetris from '../components/PdfTetris';
import { useNavigation } from '../lib/useNavigation';
import { colors, fonts, textA } from '../styles/tokens';

/**
 * Mini-jeu PdfTetris lancé en autonome depuis l'accueil, sans recherche web
 * derrière. Ouvre d'abord un menu Jouer/Classement (état local, pas de cran
 * de navigation dédié : sortir du menu OU de la partie ramène à l'accueil,
 * comme avant l'ajout du menu). Le Classement, lui, est un cran séparé
 * (`nav.goGameLeaderboard`, voir `GameLeaderboardScreen`) pour que le retour
 * Android y revienne à ce menu plutôt qu'à l'accueil.
 */
export function GameScreen() {
  const nav = useNavigation();
  const [view, setView] = useState<'menu' | 'play'>('menu');

  return (
    <div
      className="no-scrollbar"
      style={{
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        padding: '16px 16px 24px',
      }}
    >
      {view === 'play' ? (
        <PdfTetris standalone onShowLeaderboard={nav.goGameLeaderboard} />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              maxWidth: 384,
              margin: '0 auto',
              padding: '0 4px 14px',
              boxSizing: 'border-box',
            }}
          >
            <button type="button" onClick={nav.goBack} aria-label="Retour" style={backButtonStyle}>
              ‹
            </button>
            <span style={{ fontSize: 18, fontWeight: 700 }}>Range la bibliothèque</span>
          </div>

          <div style={{ maxWidth: 384, margin: '40px auto 0', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: textA(0.55), marginBottom: 16 }}>
              Le mini-jeu de la bibliothèque, pour patienter ou juste s'amuser.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button type="button" onClick={() => setView('play')} style={primaryButtonStyle}>
                Jouer
              </button>
              <button type="button" onClick={nav.goGameLeaderboard} style={secondaryButtonStyle}>
                Classement
              </button>
            </div>
            <div style={{ marginTop: 10 }}>
              <button type="button" onClick={nav.goGameDuoLobby} style={secondaryButtonStyle}>
                Match Duo
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const backButtonStyle: React.CSSProperties = {
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

const primaryButtonStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 14,
  fontWeight: 700,
  padding: '0 20px',
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 12,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 14,
  fontWeight: 700,
  padding: '0 20px',
  cursor: 'pointer',
};
