import { colors, textA, fonts } from '../styles/tokens';
import type { GameLeaderboardEntry } from '../types/database';

interface LeaderboardProps {
  /** null = chargement en cours, undefined = échec/hors ligne, [] = aucun score. */
  entries: GameLeaderboardEntry[] | null | undefined;
  currentUserId: string | undefined;
  title?: string;
}

/**
 * Classement d'équipe du mini-jeu PdfTetris (`game_leaderboard`, voir
 * `src/lib/gameScores.ts`) — extrait pour être partagé entre l'écran de fin
 * de partie (PdfTetris) et le sous-écran "Classement" du menu d'attente de
 * la recherche web (WebSearchScreen).
 */
export function Leaderboard({ entries, currentUserId, title = "Classement d'équipe" }: LeaderboardProps) {
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={titleStyle}>{title}</span>
      {entries === null && <p style={emptyStyle}>Chargement du classement…</p>}
      {entries === undefined && <p style={emptyStyle}>Classement indisponible hors ligne.</p>}
      {entries && entries.length === 0 && <p style={emptyStyle}>Aucun score enregistré pour l'instant.</p>}
      {entries && entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map((entry, i) => {
            const mine = entry.user_id === currentUserId;
            return (
              <div key={entry.user_id} style={rowStyle(mine)}>
                <span style={nameStyle(mine)}>
                  {i + 1}. {entry.joueur ?? 'Anonyme'}
                </span>
                <span style={scoreStyle(mine)}>{entry.best_score}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const titleStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: textA(0.55),
  textAlign: 'center',
  fontFamily: fonts.sans,
};

const emptyStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: textA(0.55),
  margin: 0,
  textAlign: 'center',
  fontFamily: fonts.sans,
};

function rowStyle(mine: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '4px 8px',
    borderRadius: 8,
    background: mine ? 'rgba(131,163,60,0.18)' : 'transparent',
  };
}

function nameStyle(mine: boolean): React.CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: mine ? 700 : 600,
    color: mine ? colors.success : colors.text,
    fontFamily: fonts.sans,
  };
}

function scoreStyle(mine: boolean): React.CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: 700,
    color: mine ? colors.success : textA(0.55),
    fontFamily: fonts.mono,
  };
}
