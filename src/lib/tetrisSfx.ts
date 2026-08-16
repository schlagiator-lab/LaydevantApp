/**
 * Bruitages de PdfTetris — préchargés une seule fois au montage du jeu,
 * rejoués à la demande. Même convention de chemin que la musique de fond
 * (`/tetris_audio.mp3`) : fichiers servis tels quels depuis `public/`.
 *
 * Volume constant, sous la musique de fond (0.35) pour rester secondaire.
 * Pas de toggle mute : aucun état son n'existe ailleurs dans l'app (§ jeu,
 * CLAUDE.md) — hors scope d'en créer un ici.
 */

export const SFX_VOLUME = 0.5;

export type SfxName =
  | 'rotate'
  | 'lock'
  | 'clearSingle'
  | 'clearDouble'
  | 'clearTriple'
  | 'tetris'
  | 'gameOver';

const SFX_FILES: Record<SfxName, string> = {
  rotate: '/SFX_PieceRotateLR.mp3',
  lock: '/SFX_SpecialLineBEndFallTouch.mp3',
  clearSingle: '/SFX_SpecialLineClearSingle.mp3',
  clearDouble: '/SFX_SpecialLineClearDouble.mp3',
  clearTriple: '/SFX_SpecialLineClearTriple.mp3',
  tetris: '/SFX_SpecialTetris.mp3',
  gameOver: '/SFX_GameOver.mp3',
};

// Sons déclenchés en rafale rapprochée (deux rotations en quelques dizaines
// de ms, ou plusieurs locks successifs — hard drop compris, qui déclenche
// aussi 'lock' via lockAndClear) : on joue un clone pour ne pas couper le
// son précédent. Les sons ponctuels (clear, game over) n'ont pas ce
// problème — un simple reset de currentTime suffit.
const CLONE_ON_PLAY = new Set<SfxName>(['rotate', 'lock']);

export type TetrisSfx = {
  play: (name: SfxName) => void;
  dispose: () => void;
};

export function createTetrisSfx(): TetrisSfx {
  const pool = new Map<SfxName, HTMLAudioElement>();
  for (const [name, src] of Object.entries(SFX_FILES) as [SfxName, string][]) {
    const audio = new Audio(src);
    audio.volume = SFX_VOLUME;
    audio.preload = 'auto';
    pool.set(name, audio);
  }

  const play = (name: SfxName) => {
    const base = pool.get(name);
    if (!base) return;
    if (CLONE_ON_PLAY.has(name)) {
      const clone = base.cloneNode(true) as HTMLAudioElement;
      clone.volume = SFX_VOLUME;
      void clone.play().catch(() => {});
    } else {
      base.currentTime = 0;
      void base.play().catch(() => {});
    }
  };

  const dispose = () => {
    for (const audio of pool.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
    pool.clear();
  };

  return { play, dispose };
}
