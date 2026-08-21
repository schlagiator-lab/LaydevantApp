import { useEffect, useState } from 'react';
import PdfTetris from '../components/PdfTetris';
import { useNavigation } from '../lib/useNavigation';
import {
  cancelDuoMatch,
  createDuoMatch,
  joinDuoMatch,
  listWaitingDuoMatches,
  syncDuoMatch,
  type CreatedDuoMatch,
  type WaitingDuoMatch,
} from '../lib/duoMatch';
import { primeMusicAudio } from '../lib/tetrisMusic';
import { colors, fonts, textA } from '../styles/tokens';

/** Lancement transmis à PdfTetris (brique 4) — voir PdfTetrisProps.duoMatch. */
interface DuoLaunch {
  matchId: string;
  code: string;
  seed: number;
  role: 'host' | 'guest';
}

const POLL_HOSTING_MS = 1500;
const POLL_LIST_MS = 3000;

/**
 * Lobby du mode duo (brique 4) — matchmaking par code, sans routeur (poussé
 * via NavigationProvider, `nav.goGameDuoLobby`). Deux actions : créer un
 * match (attente d'un joueur, affichage du code) ou en rejoindre un (liste
 * des matchs en attente + saisie manuelle du code). Une fois les deux
 * joueurs réunis, lance PdfTetris en mode duo — sans brancher d'attaques ni
 * de sync réseau (brique 5).
 *
 * État local uniquement (pas de cran de navigation par sous-état), même
 * convention que GameScreen ('menu'/'play') : seul le lobby lui-même a un
 * cran dédié, pour que le retour Android y ramène plutôt qu'à l'accueil.
 */
export function GameDuoLobbyScreen() {
  const nav = useNavigation();
  const [view, setView] = useState<'choice' | 'hosting' | 'play'>('choice');
  const [launch, setLaunch] = useState<DuoLaunch | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- créer ----
  const [creating, setCreating] = useState(false);
  const [hostedMatch, setHostedMatch] = useState<CreatedDuoMatch | null>(null);
  // Amorcé SYNCHRONEMENT dans le tap "Créer", avant tout await — iOS bloque
  // sinon le .play() de la musique lancée plus tard par le poll (hors
  // geste, voir tetrisMusic.ts). Réutilisé tel quel par PdfTetris, jamais
  // recréé. N'affecte pas le chemin guest (jeu lancé dans le geste
  // "Rejoindre" lui-même, pas besoin d'amorçage). State plutôt que ref :
  // primedMusicAudio est lu au rendu (JSX ci-dessous), et lire un ref
  // pendant le rendu n'est pas fiable (react-hooks/refs) — l'amorçage lui-
  // même reste synchrone dans le handler, seul le stockage change.
  const [primedMusicAudio, setPrimedMusicAudio] = useState<HTMLAudioElement | null>(null);

  const handleCreate = async () => {
    if (creating || joining) return;
    setPrimedMusicAudio(primeMusicAudio());
    setCreating(true);
    setError(null);
    try {
      const m = await createDuoMatch();
      setHostedMatch(m);
      setView('hosting');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  // Poll pendant l'attente — sert aussi de heartbeat (host_last_seen). Dès
  // que le match passe 'playing' avec un guest, on lance le jeu en duo côté
  // host et on arrête le poll (cleanup de l'effet).
  useEffect(() => {
    if (view !== 'hosting' || !hostedMatch) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const row = await syncDuoMatch(hostedMatch.id, 0, false);
        if (cancelled) return;
        if (row.status === 'playing' && row.guest) {
          setLaunch({ matchId: hostedMatch.id, code: hostedMatch.code, seed: hostedMatch.seed, role: 'host' });
          setView('play');
        }
      } catch {
        // best-effort : on retente au prochain tick, pas d'affichage d'erreur
        // pour un simple accroc réseau pendant l'attente
      }
    };
    const id = window.setInterval(tick, POLL_HOSTING_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [view, hostedMatch]);

  const handleCancel = async () => {
    if (hostedMatch) {
      try {
        await cancelDuoMatch(hostedMatch.id);
      } catch {
        // best-effort : on quitte quand même le lobby
      }
    }
    setHostedMatch(null);
    setView('choice');
    nav.goBack();
  };

  // ---- rejoindre ----
  const [waiting, setWaiting] = useState<WaitingDuoMatch[] | null | undefined>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  // Incrémenté après un MATCH_INDISPONIBLE pour forcer un rafraîchissement
  // immédiat de la liste, sans dépendre d'une fonction partagée entre l'effet
  // de poll et le handler de join (même convention d'effet auto-suffisant
  // que GameLeaderboardScreen/VaultAdminScreen : fetch inline, pas de
  // useCallback exposé à l'extérieur).
  const [listRefreshNonce, setListRefreshNonce] = useState(0);

  useEffect(() => {
    if (view !== 'choice') return;
    let cancelled = false;
    const tick = () => {
      void (async () => {
        try {
          const rows = await listWaitingDuoMatches();
          if (!cancelled) setWaiting(rows);
        } catch {
          if (!cancelled) setWaiting(undefined);
        }
      })();
    };
    tick();
    const id = window.setInterval(tick, POLL_LIST_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [view, listRefreshNonce]);

  const handleJoin = async (code: string) => {
    const normalized = code.trim().toUpperCase();
    if (!normalized || creating || joining) return;
    setJoining(true);
    setError(null);
    try {
      const m = await joinDuoMatch(normalized);
      setLaunch({ matchId: m.id, code: m.code, seed: m.seed, role: 'guest' });
      setView('play');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('MATCH_INDISPONIBLE')) {
        setError('Match indisponible : inexistant, déjà pris, ou le tien.');
        setListRefreshNonce((n) => n + 1);
      } else {
        setError(message);
      }
    } finally {
      setJoining(false);
    }
  };

  // Pas de vrai rematch (aucune RPC pour ré-inviter spécifiquement le même
  // adversaire) : chaque joueur retourne indépendamment au menu de création/
  // rejoindre, plutôt que de relancer localement l'ancien match `launch`
  // (déjà 'finished' côté serveur).
  const handleExitDuoMatch = () => {
    setLaunch(null);
    setView('choice');
  };

  if (view === 'play' && launch) {
    return (
      <PdfTetris
        standalone
        duoMatch={launch}
        onExitDuoMatch={handleExitDuoMatch}
        primedMusicAudio={primedMusicAudio ?? undefined}
      />
    );
  }

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
        <span style={{ fontSize: 18, fontWeight: 700 }}>Match Duo</span>
      </div>

      {view === 'hosting' && hostedMatch ? (
        <div style={{ maxWidth: 384, margin: '40px auto 0', textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: textA(0.55), marginBottom: 6 }}>Code du match</p>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 40,
              fontWeight: 800,
              letterSpacing: '0.12em',
              marginBottom: 16,
            }}
          >
            {hostedMatch.code}
          </div>
          <p style={{ fontSize: 14, color: textA(0.65), marginBottom: 24 }}>En attente d'un joueur…</p>
          <button type="button" onClick={() => void handleCancel()} style={secondaryButtonStyle}>
            Annuler
          </button>
        </div>
      ) : (
        <div style={{ maxWidth: 384, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {error && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: colors.accent,
                background: 'rgba(222, 122, 34, 0.15)',
                border: '1px solid rgba(222, 122, 34, 0.4)',
                borderRadius: 10,
                padding: '9px 12px',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || joining}
            style={{ ...primaryButtonStyle, opacity: creating || joining ? 0.6 : 1 }}
          >
            {creating ? 'Création…' : 'Créer un match'}
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Rejoindre par code</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="CODE"
                style={{
                  flex: 1,
                  background: textA(0.08),
                  border: 'none',
                  borderRadius: 14,
                  padding: '0 14px',
                  height: 48,
                  color: colors.text,
                  fontSize: 16,
                  fontFamily: fonts.mono,
                  letterSpacing: '0.08em',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={() => void handleJoin(joinCode)}
                disabled={!joinCode.trim() || creating || joining}
                style={{
                  ...primaryButtonStyle,
                  opacity: !joinCode.trim() || creating || joining ? 0.6 : 1,
                }}
              >
                Rejoindre
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: textA(0.6) }}>Matchs en attente</span>
            {waiting === null && (
              <p style={{ fontSize: 13, color: textA(0.55) }}>Chargement…</p>
            )}
            {waiting === undefined && (
              <p style={{ fontSize: 13, color: textA(0.55) }}>Liste indisponible hors ligne.</p>
            )}
            {waiting && waiting.length === 0 && (
              <p style={{ fontSize: 13, color: textA(0.55) }}>Aucun match en attente pour l'instant.</p>
            )}
            {waiting && waiting.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {waiting.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => void handleJoin(m.code)}
                    disabled={creating || joining}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: 12,
                      border: `1px solid ${textA(0.15)}`,
                      background: textA(0.05),
                      color: colors.text,
                      fontFamily: fonts.sans,
                      cursor: creating || joining ? 'default' : 'pointer',
                      opacity: creating || joining ? 0.6 : 1,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{m.host_name}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 14, letterSpacing: '0.06em' }}>{m.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
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
  height: 48,
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
