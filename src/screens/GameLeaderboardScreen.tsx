import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { getLeaderboard } from '../lib/gameScores';
import { Leaderboard } from '../components/Leaderboard';
import type { GameLeaderboardEntry } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

/**
 * Classement du mini-jeu PdfTetris, accessible depuis le menu du jeu
 * (`GameScreen`) ou depuis son écran de fin de partie. Cran de navigation
 * séparé (`gameLeaderboard`) pour que le retour Android revienne au menu du
 * jeu plutôt qu'à l'accueil — voir `src/lib/NavigationProvider.tsx`.
 */
export function GameLeaderboardScreen() {
  const nav = useNavigation();
  const { session } = useAuth();
  const [entries, setEntries] = useState<GameLeaderboardEntry[] | null | undefined>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await getLeaderboard();
        if (!cancelled) setEntries(rows);
      } catch {
        if (!cancelled) setEntries(undefined); // hors ligne/erreur — bonus non bloquant
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        padding: 16,
        gap: 16,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={nav.goBack}
          aria-label="Retour"
          style={{
            flex: 'none',
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: textA(0.1),
            border: 'none',
            color: colors.text,
            fontSize: 17,
            cursor: 'pointer',
          }}
        >
          ‹
        </button>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Classement</span>
      </div>

      <Leaderboard entries={entries} currentUserId={session?.user.id} />
    </div>
  );
}
