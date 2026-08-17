import { useRef, useEffect, useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigation } from '../lib/useNavigation';
import { useAuth } from '../lib/useAuth';
import { submitScore, getLeaderboard } from '../lib/gameScores';
import { syncDuoMatch } from '../lib/duoMatch';
import { Leaderboard } from './Leaderboard';
import { createTetrisSfx, type SfxName, type TetrisSfx } from '../lib/tetrisSfx';
import type { GameLeaderboardEntry } from '../types/database';

/**
 * PDF Tetris — « Range la bibliothèque »
 * Mini-jeu affiché pendant l'attente de la recherche web (Laydevant).
 *
 * Thème : des dossiers/PDF tombent, tu les empiles ; une LIGNE complète = une
 * étagère rangée qui s'illumine et disparaît. La vitesse monte par paliers →
 * la difficulté croît toute seule.
 *
 * Contrôles GESTUELS (une main, mobile) :
 *   - glisser ← / →  : déplace la pièce d'une colonne
 *   - tap            : rotation
 *   - glisser ↓ doux : descente rapide (soft drop)
 *   - swipe ↓ franc  : chute instantanée (hard drop)
 *   (clavier fléché + espace dispo pour tester au desktop)
 *
 * Monté uniquement pendant le chargement de la recherche web (voir
 * WebSearchScreen) — le bandeau de recherche vit au-dessus, pas ici.
 * Réglages regroupés dans CFG.
 */

const C = {
  bg: '#16325a',
  bgDeep: '#0f2444',
  panel: '#1b3a5e',
  grid: 'rgba(255,255,255,0.05)',
  gridLine: 'rgba(255,255,255,0.08)',
  green: '#a4c639',
  orange: '#e8823c',
  text: '#cbd8ec',
  textDim: '#7f93b4',
  shelf: '#ffd23f',
};

// Couche de capture plein écran — mode standalone (GameScreen) uniquement.
// Fige l'écran entier pendant la partie (overscroll iOS compris) et reçoit
// les gestes de jeu partout, bande morte du bas incluse — jamais utilisée
// pour l'usage embarqué (WebSearchScreen), qui garde son scroll normal.
const gameCaptureLayerStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  touchAction: 'none',
  overscrollBehavior: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  background: C.bgDeep,
  display: 'flex',
  flexDirection: 'column',
  padding: 16,
  boxSizing: 'border-box',
  zIndex: 1400,
};

// Couleurs des 7 pièces (palette "dossiers" chaleureuse + froide, lisible sur marine)
const PIECE_COLORS = {
  I: '#4bc0d9', // cyan
  O: '#f2c14e', // jaune dossier
  T: '#b072d9', // violet
  S: '#a4c639', // vert appli
  Z: '#e8823c', // orange PDF
  J: '#5a8fd9', // bleu
  L: '#e06b8b', // rose
} as const;

type PieceKey = keyof typeof PIECE_COLORS;
type Shape = number[][];

const SHAPES: Record<PieceKey, Shape> = {
  I: [[1, 1, 1, 1]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1]],
  S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]],
};
const KEYS = Object.keys(SHAPES) as PieceKey[];

// Une extension "métier" par forme (le label affiché au centre de la pièce)
const PIECE_EXT: Record<PieceKey, string> = {
  I: '.pdf',
  O: '.zip',
  T: '.docx',
  S: '.dwg',
  Z: '.jpg',
  J: '.xlsx',
  L: '.csv',
};
const EXT_LIST = Object.values(PIECE_EXT);

const CFG = {
  cols: 10,
  rows: 18,
  startDropMs: 850, // vitesse de chute initiale
  minDropMs: 140, // vitesse max (palier le plus rapide)
  speedupEvery: 8, // toutes les N lignes, on accélère
  speedupFactor: 0.8, // facteur d'accélération par palier (plus bas = paliers plus francs)
  softDropMs: 55, // chute pendant un glisser bas
  spawnDelayMs: 250, // petit répit avant que la nouvelle pièce commence à tomber
  swipeThreshold: 90, // px verticaux pour déclencher un hard drop (peu sensible)
  softDropArm: 40, // px verticaux avant d'armer le soft drop
  colStep: 22, // px horizontaux par colonne déplacée
  bonusPoints: 5, // points bonus si la ligne complétée contient l'extension cible
};

// barème Tetris classique : récompense les multi-lignes en un seul coup,
// multiplié par le niveau courant au moment de l'effacement
const LINE_POINTS: Record<number, number> = { 1: 100, 2: 300, 3: 500, 4: 800 };

// DEV brique 5 - mode duo : barème d'ATTAQUE (distinct du barème de score
// LINE_POINTS ci-dessus). Single ne pousse rien.
const ATTACK_LINES: Record<number, number> = { 2: 1, 3: 2, 4: 4 };

const DUO_SYNC_MS = 1000; // cadence de la boucle de sync réseau (attaques + résolution)
const DUO_DISCONNECT_MS = 10000; // au-delà, adversaire silencieux => déconnecté (temps serveur)

type DuoOutcome = 'won' | 'lost' | 'draw' | 'opponentDisconnected';

const DUO_OUTCOME_LABEL: Record<DuoOutcome, string> = {
  won: 'Gagné',
  lost: 'Perdu',
  draw: 'Match nul',
  opponentDisconnected: 'Adversaire déconnecté — Gagné',
};

type Piece = { key: PieceKey; shape: Shape; color: string; ext: string; x: number; y: number };
type GridCell = { color: string; ext: string } | null;
type GameState = {
  grid: GridCell[][];
  piece: Piece;
  next: Piece;
  dropMs: number;
  acc: number;
  lines: number;
  score: number;
  over: boolean;
  flash: number[];
  flashUntil: number;
  soft: boolean;
  softConsumed: boolean;
  spawnLockUntil: number;
};

function rotate(mat: Shape): Shape {
  const R = mat.length, Cc = mat[0].length;
  const out: Shape = Array.from({ length: Cc }, () => Array(R).fill(0));
  for (let r = 0; r < R; r++)
    for (let c = 0; c < Cc; c++) out[c][R - 1 - r] = mat[r][c];
  return out;
}

function emptyGrid(): GridCell[][] {
  return Array.from({ length: CFG.rows }, () => Array<GridCell>(CFG.cols).fill(null));
}

// vrai tant que la pièce vient d'apparaître (répit spawnLockUntil) — pendant
// cette fenêtre, aucune descente rapide (soft/hard drop) n'est autorisée,
// mais déplacement et rotation restent permis
function inSpawnWindow(st: GameState): boolean {
  return performance.now() < st.spawnLockUntil;
}

// DEV brique 3 - mode duo (à venir) : source d'aléa seedable pour la séquence
// de pièces uniquement. mulberry32, suffisant pour un PRNG déterministe côté
// client (pas d'usage crypto). `pieceRng` est le SEUL état ; randomPiece est
// stateless (pas de sac 7-bag), donc rien d'autre à réinitialiser ici.
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let pieceRng: (() => number) | null = null; // null => solo (Math.random)

// seed: entier (0..2^31-1) pour rejouer une séquence déterministe, ou null
// pour revenir au mode solo (Math.random). Un même seed appelé deux fois
// produit exactement la même suite à partir de là.
export function seedPieces(seed: number | null): void {
  pieceRng = seed == null ? null : mulberry32(seed >>> 0);
}

function pieceRandom(): number {
  return pieceRng ? pieceRng() : Math.random();
}

function randomPiece(): Piece {
  const k = KEYS[(pieceRandom() * KEYS.length) | 0];
  return { key: k, shape: SHAPES[k], color: PIECE_COLORS[k], ext: PIECE_EXT[k], x: (CFG.cols >> 1) - 1, y: 0 };
}

// DEV brique 3 - auto-test du déterminisme, appelé depuis le bouton "Test
// seed" ; à retirer en brique 4. Tire 14 pièces via le MÊME chemin que le
// jeu (randomPiece), donc via pieceRandom()/pieceRng ci-dessus.
function runSeedTest(): void {
  const draw14 = (): string[] => Array.from({ length: 14 }, () => randomPiece().key);
  seedPieces(12345);
  const s1 = draw14();
  seedPieces(12345);
  const s2 = draw14();
  seedPieces(99999);
  const s3 = draw14();
  seedPieces(null); // ne pas laisser le générateur seedé après le test
  const deterministic = s1.join(',') === s2.join(',');
  const seedChanges = s3.join(',') !== s1.join(',');
  if (deterministic && seedChanges) {
    console.log('SEED OK', { s1, s2, s3 });
  } else {
    console.log('SEED FAIL', { deterministic, seedChanges, s1, s2, s3 });
  }
}

// DEV brique 2 - mode duo (à venir) : injection de lignes de malus (garbage).
// Gris distinct des 7 couleurs de pièce (PIECE_COLORS) pour rester
// reconnaissable au premier coup d'œil.
const GARBAGE_COLOR = '#5c6b85';

// Pure : ne touche ni au ref de jeu, ni à la pièce active, ni au score.
// Convention de grille reprise telle quelle (§0 de l'inspection) : rangée 0 =
// HAUT, cellule vide = null, cellule pleine = { color, ext }.
function applyGarbageLines(
  grid: GridCell[][],
  count: number,
  holeColumn: number,
): { grid: GridCell[][]; toppedOut: boolean } {
  if (count <= 0) return { grid, toppedOut: false };
  for (let r = 0; r < count; r++) {
    if (grid[r].some((cell) => cell)) return { grid, toppedOut: true };
  }
  const garbageRow = (): GridCell[] =>
    Array.from({ length: CFG.cols }, (_, c) => (c === holeColumn ? null : { color: GARBAGE_COLOR, ext: '' }));
  const added: GridCell[][] = Array.from({ length: count }, garbageRow);
  return { grid: [...grid.slice(count), ...added], toppedOut: false };
}

interface PdfTetrisProps {
  /** Lancé depuis l'accueil comme jeu autonome (pas pendant une recherche
   * web) : affiche un en-tête titre + retour au lieu de rien. */
  standalone?: boolean;
  /** Fourni uniquement par le menu d'attente de la recherche web : affiche un
   * bouton "Classement" à côté de "Rejouer" sur l'écran de fin de partie,
   * pour retourner au sous-écran classement du parent. */
  onShowLeaderboard?: () => void;
  /** DEV brique 4 - fourni uniquement par GameDuoLobbyScreen une fois les
   * deux joueurs réunis. Présence seule => mode duo : seedPieces(seed) au
   * lieu de seedPieces(null), pas de soumission au classement solo. `code`
   * n'est pas dans le typage donné en brief (matchId/seed/role) mais est
   * nécessaire au bandeau de vérification visuelle (e) — ajouté ici. matchId/
   * role posés pour la brique 5 (sync/attaques), non utilisés en brique 4. */
  duoMatch?: { matchId: string; code: string; seed: number; role: 'host' | 'guest' };
}

export default function PdfTetris({ standalone = false, onShowLeaderboard, duoMatch }: PdfTetrisProps) {
  const nav = useNavigation();
  const { session } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(1);
  const [over, setOver] = useState(false);
  const [score, setScore] = useState(0);
  const [target, setTarget] = useState(() => EXT_LIST[(Math.random() * EXT_LIST.length) | 0]);
  const [bonusFx, setBonusFx] = useState(0); // horodatage pour animer le "+bonus"

  // Classement — bonus non bloquant : une panne réseau ne doit jamais
  // empêcher de voir/rejouer l'écran de fin de partie (CLAUDE.md, hors ligne
  // = situation nominale). `null` = pas encore résolu, `undefined` = échec.
  const [bestScore, setBestScore] = useState<number | null | undefined>(null);
  const [leaderboard, setLeaderboard] = useState<GameLeaderboardEntry[] | null | undefined>(null);
  const [isNewRecord, setIsNewRecord] = useState(false);
  const submittedRef = useRef(false);
  // Meilleur score connu AVANT la partie qui vient de se terminer — jamais
  // réinitialisé par restart() (contrairement à bestScore/leaderboard), pour
  // détecter un nouveau record par simple comparaison côté client, sans RPC
  // ni colonne dédiée.
  const lastKnownBestRef = useRef<number | null>(null);

  // DEV brique 4 - calcule l'état initial via l'initialiseur PARESSEUX de
  // useState (garanti par React de n'être appelé qu'UNE fois, jamais réévalué
  // aux re-renders suivants — même pattern que `target` juste au-dessus),
  // donc seedPieces()/randomPiece() n'y tirent bien qu'au montage, pas à
  // chaque re-render. `g` reste un ref (mutation impérative partout ailleurs
  // dans ce fichier) : on ne fait que lui passer cette valeur déjà calculée,
  // sans jamais lire/écrire `.current` pendant le rendu lui-même.
  const [initialGameState] = useState<GameState>(() => {
    seedPieces(duoMatch ? duoMatch.seed : null);
    return {
      grid: emptyGrid(),
      piece: randomPiece(),
      next: randomPiece(),
      dropMs: CFG.startDropMs,
      acc: 0,
      lines: 0,
      score: 0,
      over: false,
      flash: [], // lignes en cours d'illumination
      flashUntil: 0,
      soft: false,
      softConsumed: false,
      spawnLockUntil: 0,
    };
  });
  const g = useRef<GameState>(initialGameState);
  const targetRef = useRef(target);

  const collides = useCallback((shape: Shape, px: number, py: number): boolean => {
    const st = g.current;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const x = px + c, y = py + r;
        if (x < 0 || x >= CFG.cols || y >= CFG.rows) return true;
        if (y >= 0 && st.grid[y][x]) return true;
      }
    return false;
  }, []);

  // DEV brique 2 - file d'attente de lignes de malus en attente d'application
  // (mode duo à venir). Ref, pas state : évite les stale closures dans les
  // callbacks impératifs (lockAndClear/applyClears), cohérent avec le fait
  // que la grille elle-même est déjà en ref (§0 de l'inspection).
  const pendingGarbageRef = useRef(0);

  // Tire un holeColumn commun à toute la salve, applique le garbage à la
  // grille du ref et vide la file. Ne fait rien si rien n'est en attente.
  const flushPendingGarbage = useCallback((st: GameState): boolean => {
    if (pendingGarbageRef.current <= 0) return false;
    const holeColumn = Math.floor(Math.random() * CFG.cols);
    const result = applyGarbageLines(st.grid, pendingGarbageRef.current, holeColumn);
    st.grid = result.grid;
    pendingGarbageRef.current = 0;
    return result.toppedOut;
  }, []);

  // DEV brique 5 - mode duo uniquement (tout reste à 0/false, jamais lu, si
  // duoMatch est absent). Refs, pas state : lues/écrites depuis des
  // callbacks impératifs (applyClears, boucle de sync ~1s) sans jamais
  // provoquer de re-render pour ces compteurs internes.
  const myAttackTotalRef = useRef(0); // total CUMULÉ de lignes que j'ai envoyées
  const appliedFromOpponentRef = useRef(0); // dernier total adverse déjà transformé en garbage
  const resolvedRef = useRef(false); // true dès que l'issue du duel est figée
  const [duoOutcome, setDuoOutcome] = useState<DuoOutcome | null>(null);

  const lockAndClear = useCallback(() => {
    sfxRef.current?.play('lock');
    const st = g.current;
    const { shape, x, y, color, ext } = st.piece;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const gy = y + r, gx = x + c;
          if (gy < 0) { st.over = true; setOver(true); return; }
          st.grid[gy][gx] = { color, ext };
        }
    // lignes pleines
    const full: number[] = [];
    for (let r = 0; r < CFG.rows; r++)
      if (st.grid[r].every((cell) => cell)) full.push(r);
    if (full.length) {
      st.flash = full;
      st.flashUntil = performance.now() + 180;
    } else {
      // DEV brique 2 - lock SANS clear : applyClears ne sera pas appelée pour
      // ce tour (gate st.flash.length côté boucle rAF), donc le garbage
      // s'applique ici, immédiatement, avant le spawn. Le cas "lock AVEC
      // clear" est géré en fin d'applyClears, où st.grid = keep s'est déjà
      // résolu (§0 de l'inspection : le spawn ci-dessous est déjà antérieur
      // à ce clear-là, timing existant non modifié).
      if (flushPendingGarbage(st)) { st.over = true; setOver(true); return; }
    }
    // spawn suivant — on repart d'un rythme normal :
    st.piece = st.next;
    st.next = randomPiece();
    st.acc = 0; // vide le trop-plein de chute (sinon la pièce plonge)
    st.soft = false; // coupe le soft drop hérité du geste précédent
    st.softConsumed = true; // bloque le réarmement tant que le doigt n'est pas relâché
    st.spawnLockUntil = performance.now() + (full.length ? 180 : 0) + CFG.spawnDelayMs; // petit répit, après le flash s'il y en a un
    if (collides(st.piece.shape, st.piece.x, st.piece.y)) { st.over = true; setOver(true); }
  }, [collides, flushPendingGarbage]);

  const applyClears = useCallback(() => {
    const st = g.current;
    if (!st.flash.length) return;
    // une ligne effacée "compte" pour la cible si elle contient au moins un
    // bloc de l'extension recherchée
    let bonusLines = 0;
    for (const r of st.flash) {
      if (st.grid[r].some((cell) => cell && cell.ext === targetRef.current)) bonusLines++;
    }
    const keep: GridCell[][] = [];
    for (let r = 0; r < CFG.rows; r++)
      if (!st.flash.includes(r)) keep.push(st.grid[r]);
    const cleared = st.flash.length;
    // DEV brique 5 - émission d'attaque (mode duo uniquement) : cumule selon
    // le barème ATTAQUE (distinct du barème de score LINE_POINTS ci-dessous).
    // Pas d'appel réseau ici — juste le compteur ; l'envoi se fait dans la
    // boucle de sync lente (~1s), qui lit myAttackTotalRef.current.
    if (duoMatch) myAttackTotalRef.current += ATTACK_LINES[cleared] ?? 0;
    const clearSfx: Record<number, SfxName> = { 1: 'clearSingle', 2: 'clearDouble', 3: 'clearTriple', 4: 'tetris' };
    const sfxName = clearSfx[cleared];
    if (sfxName) sfxRef.current?.play(sfxName);
    while (keep.length < CFG.rows) keep.unshift(Array<GridCell>(CFG.cols).fill(null));
    st.grid = keep;
    st.lines += cleared;
    setLines(st.lines);
    // accélération par paliers — niveau courant, réutilisé tel quel pour le barème de score
    const lvl = 1 + Math.floor(st.lines / CFG.speedupEvery);
    setLevel(lvl);
    st.dropMs = Math.max(CFG.minDropMs, CFG.startDropMs * Math.pow(CFG.speedupFactor, lvl - 1));
    // score : barème multi-lignes (LINE_POINTS) × niveau courant + bonus cible
    st.score += (LINE_POINTS[cleared] ?? 0) * lvl + bonusLines * CFG.bonusPoints;
    setScore(st.score);
    if (bonusLines > 0) {
      setBonusFx(performance.now()); // déclenche l'animation "+bonus"
      // nouvelle cible différente de l'actuelle
      let nt = targetRef.current;
      while (nt === targetRef.current) nt = EXT_LIST[(Math.random() * EXT_LIST.length) | 0];
      targetRef.current = nt;
      setTarget(nt);
    }
    st.flash = [];

    // DEV brique 2 - lock AVEC clear : le clear vient de se résoudre
    // (st.grid = keep ci-dessus) et ses SFX ont déjà joué ; le garbage ne
    // monte que maintenant. La pièce suivante a déjà spawné dans
    // lockAndClear (timing existant, non modifié, §0 de l'inspection) : on
    // reteste sa collision contre la grille poussée avec la MÊME fonction
    // que le check de spawn existant, plutôt qu'un nouveau mécanisme.
    const topped = flushPendingGarbage(st);
    if (topped || collides(st.piece.shape, st.piece.x, st.piece.y)) {
      st.over = true;
      setOver(true);
    }
  }, [collides, flushPendingGarbage, duoMatch]);

  const step = useCallback(() => {
    const st = g.current;
    if (st.over) return;
    if (!collides(st.piece.shape, st.piece.x, st.piece.y + 1)) {
      st.piece.y += 1;
    } else {
      lockAndClear();
    }
  }, [collides, lockAndClear]);

  // boucle
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0, last = performance.now();
    let cell = 20, offX = 0, offY = 0, dpr = 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.floor(rect.width), h = Math.floor(rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cell = Math.floor(Math.min(w / CFG.cols, h / CFG.rows));
      offX = Math.floor((w - cell * CFG.cols) / 2);
      offY = Math.floor((h - cell * CFG.rows) / 2);
    };
    resize();
    window.addEventListener('resize', resize);

    const drawCell = (gx: number, gy: number, color: string | null, ghost = false) => {
      const x = offX + gx * cell, y = offY + gy * cell;
      ctx.fillStyle = ghost ? 'rgba(255,255,255,0.10)' : (color as string);
      roundRect(ctx, x + 1, y + 1, cell - 2, cell - 2, 3);
      ctx.fill();
      if (!ghost) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(x + 3, y + 2, cell * 0.4, 2);
      }
    };

    // label d'extension centré sur une forme (une seule fois par pièce)
    const drawExtLabel = (shape: Shape, px: number, py: number, ext: string, alpha = 1) => {
      // centre géométrique des cases pleines
      let sx = 0, sy = 0, n = 0;
      for (let r = 0; r < shape.length; r++)
        for (let c = 0; c < shape[r].length; c++)
          if (shape[r][c]) { sx += px + c + 0.5; sy += py + r + 0.5; n++; }
      if (!n) return;
      const cx = offX + (sx / n) * cell, cy = offY + (sy / n) * cell;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(15,36,68,0.92)';
      ctx.font = `700 ${Math.max(10, Math.floor(cell * 0.5))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeText(ext, cx, cy);
      ctx.fillText(ext, cx, cy);
      ctx.restore();
    };

    const loop = (now: number) => {
      const st = g.current;
      const dt = now - last; last = now;

      // gestion flash lignes
      if (st.flash.length && now >= st.flashUntil) applyClears();

      if (!st.over && !st.flash.length) {
        // pendant le petit répit de spawn, pas de chute auto (la pièce vient
        // d'apparaître) — le joueur peut déjà la déplacer/tourner
        if (now >= (st.spawnLockUntil || 0)) {
          st.acc += dt;
          const interval = st.soft ? CFG.softDropMs : st.dropMs;
          while (st.acc >= interval) { st.acc -= interval; step(); }
        } else {
          st.acc = 0;
        }
      }

      // fond panneau
      const rect = wrap.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      // grille
      ctx.fillStyle = C.grid;
      ctx.fillRect(offX, offY, cell * CFG.cols, cell * CFG.rows);
      ctx.strokeStyle = C.gridLine; ctx.lineWidth = 1;
      for (let c = 0; c <= CFG.cols; c++) {
        ctx.beginPath(); ctx.moveTo(offX + c * cell, offY); ctx.lineTo(offX + c * cell, offY + cell * CFG.rows); ctx.stroke();
      }
      for (let r = 0; r <= CFG.rows; r++) {
        ctx.beginPath(); ctx.moveTo(offX, offY + r * cell); ctx.lineTo(offX + cell * CFG.cols, offY + r * cell); ctx.stroke();
      }

      // blocs posés (chaque bloc garde sa couleur ; petit label d'extension)
      for (let r = 0; r < CFG.rows; r++)
        for (let c = 0; c < CFG.cols; c++) {
          const cellData = st.grid[r][c];
          if (cellData) {
            drawCell(c, r, cellData.color);
            // mini-label discret au centre du bloc
            const x = offX + c * cell, y = offY + r * cell;
            ctx.save();
            ctx.fillStyle = 'rgba(15,36,68,0.75)';
            ctx.font = `600 ${Math.max(7, Math.floor(cell * 0.30))}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cellData.ext, x + cell / 2, y + cell / 2);
            ctx.restore();
          }
        }

      // lignes qui s'illuminent
      if (st.flash.length) {
        ctx.fillStyle = C.shelf;
        for (const r of st.flash) ctx.fillRect(offX, offY + r * cell, cell * CFG.cols, cell);
      }

      // pièce fantôme (où elle va tomber)
      if (!st.over && !st.flash.length) {
        let gy = st.piece.y;
        while (!collides(st.piece.shape, st.piece.x, gy + 1)) gy++;
        const sh = st.piece.shape;
        for (let r = 0; r < sh.length; r++)
          for (let c = 0; c < sh[r].length; c++)
            if (sh[r][c]) drawCell(st.piece.x + c, gy + r, null, true);
        drawExtLabel(sh, st.piece.x, gy, st.piece.ext, 0.35); // label fantôme discret
        // pièce active
        for (let r = 0; r < sh.length; r++)
          for (let c = 0; c < sh[r].length; c++)
            if (sh[r][c]) drawCell(st.piece.x + c, st.piece.y + r, st.piece.color);
        drawExtLabel(sh, st.piece.x, st.piece.y, st.piece.ext, 1); // label pièce active
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [step, applyClears, collides]);

  // Musique de fond, en boucle pendant toute la durée de vie du composant
  // (partie + écran de fin) — volume moyen/bas pour rester secondaire à la
  // recherche. Le montage vient toujours d'un geste utilisateur (bouton
  // "Jouer" ou soumission du formulaire de recherche), donc play() est
  // généralement autorisé ; si le navigateur le bloque quand même, on
  // n'insiste pas (le jeu doit rester jouable sans son).
  useEffect(() => {
    const audio = new Audio('/tetris_audio.mp3');
    audio.loop = true;
    audio.volume = 0.35;
    void audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, []);

  // Bruitages (rotation, hard drop, clears, game over) — préchargés une
  // seule fois au montage, volume constant sous la musique. Ref (pas de
  // state) : joués depuis des callbacks impératifs (loop rAF, handlers de
  // geste), aucun besoin de re-render.
  const sfxRef = useRef<TetrisSfx | null>(null);
  useEffect(() => {
    const sfx = createTetrisSfx();
    sfxRef.current = sfx;
    return () => {
      sfx.dispose();
      sfxRef.current = null;
    };
  }, []);

  // ---- actions ----
  const move = useCallback((dx: number) => {
    const st = g.current;
    if (st.over || st.flash.length) return;
    if (!collides(st.piece.shape, st.piece.x + dx, st.piece.y)) st.piece.x += dx;
  }, [collides]);

  const rotatePiece = useCallback(() => {
    const st = g.current;
    if (st.over || st.flash.length) return;
    const rs = rotate(st.piece.shape);
    // wall kicks simples
    for (const k of [0, -1, 1, -2, 2]) {
      if (!collides(rs, st.piece.x + k, st.piece.y)) {
        st.piece.shape = rs; st.piece.x += k;
        sfxRef.current?.play('rotate');
        return;
      }
    }
  }, [collides]);

  const hardDrop = useCallback(() => {
    const st = g.current;
    if (inSpawnWindow(st)) return;
    if (st.over || st.flash.length) return;
    while (!collides(st.piece.shape, st.piece.x, st.piece.y + 1)) st.piece.y += 1;
    lockAndClear();
  }, [collides, lockAndClear]);

  const restart = useCallback(() => {
    // DEV brique 3/4 - reseed explicitement à chaque restart : solo en
    // Math.random (au cas où le générateur serait resté seedé, ex. après
    // "Test seed"), duo sur le MÊME seed que le match (rejoue la même suite
    // de pièces, cohérent avec un seed qui identifie un match, pas une partie).
    seedPieces(duoMatch ? duoMatch.seed : null);
    const t0 = EXT_LIST[(Math.random() * EXT_LIST.length) | 0];
    g.current = {
      grid: emptyGrid(), piece: randomPiece(), next: randomPiece(),
      dropMs: CFG.startDropMs, acc: 0, lines: 0, score: 0, over: false,
      flash: [], flashUntil: 0, soft: false, softConsumed: false, spawnLockUntil: 0,
    };
    targetRef.current = t0;
    setTarget(t0); setScore(0); setLines(0); setLevel(1); setOver(false);
    submittedRef.current = false;
    setBestScore(null);
    setLeaderboard(null);
    setIsNewRecord(false);
  }, [duoMatch]);

  // fin de partie : enregistre le score une seule fois puis lit le classement —
  // le tout best-effort, jamais bloquant si hors ligne (CLAUDE.md, hors ligne =
  // situation nominale)
  useEffect(() => {
    if (!over || submittedRef.current) return;
    submittedRef.current = true;
    sfxRef.current?.play('gameOver');

    // DEV brique 4 - un duel n'a pas sa place dans le classement solo : pas
    // de submitScore/getLeaderboard en mode duo, `bestScore`/`leaderboard`
    // restent à leur valeur initiale `null` (jamais fetchés) — le rendu de
    // l'overlay (plus bas) traite ce cas séparément pour ne pas afficher un
    // "Chargement du classement…" indéfini. Reste du game over (overlay,
    // retour, SFX ci-dessus) inchangé.
    if (duoMatch) return;

    // si la toute dernière pièce complète aussi une ligne, laisse le flash
    // (180ms, cf. lockAndClear) se résoudre avant de lire le score définitif
    const delay = g.current.flash.length > 0 ? 220 : 0;
    const timer = window.setTimeout(() => {
      const finalScore = g.current.score;
      const finalLines = g.current.lines;
      const previousBest = lastKnownBestRef.current;
      void (async () => {
        try {
          const newBest = await submitScore(finalScore, finalLines);
          setBestScore(newBest);
          if (previousBest !== null && finalScore > previousBest) setIsNewRecord(true);
          lastKnownBestRef.current = newBest;
        } catch {
          setBestScore(undefined); // échec réseau/hors ligne — pas bloquant
        }
        try {
          setLeaderboard(await getLeaderboard());
        } catch {
          setLeaderboard(undefined);
        }
      })();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [over, duoMatch]);

  // DEV brique 5 - boucle de sync réseau (mode duo uniquement, ~1s) :
  // envoie mon total d'attaque cumulé + mon état "mort", lit celui de
  // l'adversaire (garbage entrant, résolution victoire/défaite/déconnexion).
  // Réseau UNIQUEMENT ici — jamais depuis applyClears ni la boucle rAF.
  // Gardée par duoMatch : aucun effet, aucun timer, aucun appel réseau en
  // solo (duoMatch absent).
  useEffect(() => {
    if (!duoMatch) return;
    let cancelled = false;
    const isHost = duoMatch.role === 'host';

    const tick = async () => {
      if (resolvedRef.current) return;
      const died = g.current.over; // état réel de game over local (ref, pas le state React `over`)
      let row;
      try {
        row = await syncDuoMatch(duoMatch.matchId, myAttackTotalRef.current, died);
      } catch {
        return; // best-effort : accroc réseau ponctuel, on retente au prochain tick
      }
      if (cancelled || resolvedRef.current) return;

      const oppTotal = isHost ? row.guest_attack_total : row.host_attack_total;
      const oppDiedAt = isHost ? row.guest_died_at : row.host_died_at;
      const myDiedAt = isHost ? row.host_died_at : row.guest_died_at;
      const oppLastSeen = isHost ? row.guest_last_seen : row.host_last_seen;

      // garbage entrant : delta cumulatif idempotent, jamais négatif (oppTotal
      // ne fait que croître côté serveur). Applique via la file brique 2 —
      // le prochain lock s'en charge, pas d'application directe ici.
      const delta = oppTotal - appliedFromOpponentRef.current;
      if (delta > 0) {
        pendingGarbageRef.current += delta;
        appliedFromOpponentRef.current = oppTotal;
      }

      // résolution
      let outcome: DuoOutcome | null = null;
      if (oppDiedAt && myDiedAt) {
        const oppTime = new Date(oppDiedAt).getTime();
        const myTime = new Date(myDiedAt).getTime();
        // le plus ANCIEN perd (mort en premier) ; égalité stricte => nul
        outcome = oppTime === myTime ? 'draw' : oppTime < myTime ? 'won' : 'lost';
      } else if (oppDiedAt) {
        outcome = 'won';
      } else if (died) {
        outcome = 'lost';
      } else if (oppLastSeen) {
        // temps SERVEUR uniquement (server_now/last_seen viennent tous deux
        // de la ligne) — jamais Date.now() du téléphone.
        const serverNow = new Date(row.server_now).getTime();
        const lastSeen = new Date(oppLastSeen).getTime();
        if (serverNow - lastSeen > DUO_DISCONNECT_MS) outcome = 'opponentDisconnected';
      }

      if (outcome) {
        resolvedRef.current = true;
        setDuoOutcome(outcome);
        window.clearInterval(intervalId);
      }
    };

    void tick();
    // `tick` ne lit `intervalId` qu'après un `await` (résolu de façon
    // asynchrone) — la déclaration ci-dessous, plus bas dans le même bloc,
    // est déjà faite au moment où ce code s'exécute réellement.
    const intervalId = window.setInterval(() => void tick(), DUO_SYNC_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [duoMatch]);

  // ---- gestes ----
  const touch = useRef({ x: 0, y: 0, lastColX: 0, moved: false, softOn: false, horiz: false });
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    touch.current = { x: e.clientX, y: e.clientY, lastColX: e.clientX, moved: false, softOn: false, horiz: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const t = touch.current;
    const dx = e.clientX - t.lastColX;
    const dyTotal = e.clientY - t.y;
    const dxTotal = e.clientX - t.x;
    // déplacement horizontal colonne par colonne
    if (Math.abs(dx) >= CFG.colStep) {
      const steps = Math.trunc(dx / CFG.colStep);
      for (let i = 0; i < Math.abs(steps); i++) move(Math.sign(steps));
      t.lastColX += steps * CFG.colStep;
      t.moved = true;
      t.horiz = true; // on est dans un geste horizontal
    }
    // soft drop : seulement si geste clairement vertical (pas pendant un calage
    // horizontal), et au-delà d'un seuil franc
    if (!t.horiz && dyTotal > CFG.softDropArm && Math.abs(dxTotal) < dyTotal && !t.softOn && !g.current.softConsumed && !inSpawnWindow(g.current)) {
      g.current.soft = true; t.softOn = true; t.moved = true;
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    g.current.soft = false;
    g.current.softConsumed = false;
    const dyTotal = e.clientY - t.y;
    const dxTotal = e.clientX - t.x;
    // hard drop : geste franc, vertical, et JAMAIS après un déplacement horizontal
    if (!t.horiz && dyTotal > CFG.swipeThreshold && Math.abs(dxTotal) < dyTotal * 0.5) {
      hardDrop();
      return;
    }
    // tap (aucun déplacement notable) = rotation
    if (!t.moved && Math.abs(dxTotal) < 10 && Math.abs(dyTotal) < 10) rotatePiece();
  };

  // clavier (desktop, pour tester)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowUp') rotatePiece();
      else if (e.key === 'ArrowDown') g.current.soft = true;
      else if (e.key === ' ') { e.preventDefault(); hardDrop(); }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'ArrowDown') g.current.soft = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [move, rotatePiece, hardDrop]);

  // Verrou anti-overscroll iOS — uniquement en mode standalone (partie plein
  // écran, GameScreen), jamais quand PdfTetris est embarqué dans
  // WebSearchScreen (où la page doit rester scrollable normalement). Le
  // onTouchMove synthétique de React est passif par défaut → preventDefault y
  // est ignoré ; d'où un listener natif { passive: false }. Restaure le body
  // au démontage (retour au menu ou vers le classement).
  useEffect(() => {
    if (!standalone) return;
    const preventOverscroll = (e: TouchEvent) => { e.preventDefault(); };
    document.addEventListener('touchmove', preventOverscroll, { passive: false });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('touchmove', preventOverscroll);
      document.body.style.overflow = previousOverflow;
    };
  }, [standalone]);

  const header = standalone ? (
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
      <button
        type="button"
        onClick={nav.goBack}
        aria-label="Retour"
        style={{
          flex: 'none',
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)',
          border: 'none',
          color: C.text,
          fontSize: 17,
          cursor: 'pointer',
        }}
      >
        ‹
      </button>
      <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Range la bibliothèque</span>
    </div>
  ) : null;

  const gameArea = (
    <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: 16, background: C.bgDeep, borderRadius: 16, boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: 384 }}>
        {/* DEV brique 4 - bandeau de vérification visuelle du seed partagé ;
            à retirer/reconditionner en brique 5. */}
        {duoMatch && (
          <div
            style={{
              fontSize: 10,
              fontFamily: 'monospace',
              color: C.textDim,
              textAlign: 'center',
              padding: '2px 4px 6px',
            }}
          >
            DEV duo — code {duoMatch.code} · seed {duoMatch.seed} · rôle {duoMatch.role}
          </div>
        )}

        {/* ---- ENTÊTE JEU : OBJECTIF + SCORE ---- */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, padding: '0 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: C.textDim }}>Objectif :</span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 6,
                fontFamily: 'monospace',
                fontWeight: 600,
                background: 'rgba(232,130,60,0.18)',
                color: C.orange,
              }}
            >
              range un {target}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'monospace', alignItems: 'center' }}>
            <span style={{ color: C.green }}>score&nbsp;{score}</span>
            <span style={{ color: C.textDim }}>niv.&nbsp;{level}</span>
            {/* DEV brique 2 - bouton de test manuel du garbage (mode duo à
                venir) ; à retirer/reconditionner en brique 3. stopPropagation
                sur pointerDown/Up pour ne pas déclencher les gestes de jeu
                (rotation au tap) captés par la couche plein écran standalone. */}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={() => { pendingGarbageRef.current += 2; }}
              style={{
                fontSize: 10,
                fontFamily: 'system-ui, sans-serif',
                padding: '2px 6px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(255,255,255,0.06)',
                color: C.textDim,
                cursor: 'pointer',
              }}
            >
              ＋2 malus
            </button>
            {/* DEV brique 3 - vérifie le déterminisme du PRNG de pièces
                seedé (console.log "SEED OK"/"SEED FAIL") ; à retirer en
                brique 4. Même garde stopPropagation que le bouton garbage. */}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={runSeedTest}
              style={{
                fontSize: 10,
                fontFamily: 'system-ui, sans-serif',
                padding: '2px 6px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(255,255,255,0.06)',
                color: C.textDim,
                cursor: 'pointer',
              }}
            >
              Test seed
            </button>
          </div>
        </div>

        {/* ---- PLATEAU ---- */}
        <div
          ref={wrapRef}
          style={{
            position: 'relative',
            borderRadius: 16,
            overflow: 'hidden',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            height: 'min(460px, 56vh)',
            border: '1px solid rgba(164,198,57,0.22)',
            background: C.bg,
          }}
          // En standalone, les gestes sont captés par gameCaptureLayerStyle
          // (écran entier, bande morte du bas incluse) — les rattacher aussi
          // ici doublerait chaque geste (bubbling). Usage embarqué
          // (WebSearchScreen, non standalone) : inchangé, gestes sur le
          // plateau uniquement.
          onPointerDown={standalone ? undefined : onPointerDown}
          onPointerMove={standalone ? undefined : onPointerMove}
          onPointerUp={standalone ? undefined : onPointerUp}
          onContextMenu={standalone ? undefined : (e) => e.preventDefault()}
        >
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          {/* feedback "+bonus" quand une ligne cible est rangée */}
          {bonusFx > 0 && (
            <div
              key={bonusFx}
              className="bonusfx"
              style={{ position: 'absolute', left: '50%', top: 24, transform: 'translateX(-50%)', pointerEvents: 'none', color: C.shelf }}
            >
              <span style={{ fontSize: 18, fontWeight: 700 }}>+{CFG.bonusPoints} bon dossier ! ⚡</span>
            </div>
          )}
          {over && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                background: 'rgba(15,36,68,0.86)',
                overflowY: 'auto',
                padding: '20px 16px',
                boxSizing: 'border-box',
              }}
            >
              <p style={{ fontSize: 18, fontWeight: 600, color: C.text, margin: 0 }}>Bibliothèque pleine !</p>
              <p style={{ fontSize: 14, color: C.textDim, margin: 0 }}>
                score {score} · {lines} documents rangés
              </p>
              {/* DEV brique 5 - issue du duel : couche d'affichage au-dessus
                  du game over local existant, pilotée par resolvedRef/
                  duoOutcome (résolution asynchrone via la boucle de sync,
                  peut prendre jusqu'à ~1s après la mort locale). */}
              {duoMatch && (
                <p
                  style={{
                    fontSize: 20,
                    fontWeight: 800,
                    color: duoOutcome === 'lost' ? C.orange : C.shelf,
                    margin: 0,
                  }}
                >
                  {duoOutcome ? DUO_OUTCOME_LABEL[duoOutcome] : 'En attente du résultat…'}
                </p>
              )}
              {isNewRecord && (
                <p style={{ fontSize: 13, fontWeight: 700, color: C.shelf, margin: 0 }}>Nouveau record !</p>
              )}
              {bestScore != null && (
                <p style={{ fontSize: 13, fontWeight: 700, color: C.green, margin: 0 }}>
                  Record perso&nbsp;: {bestScore}
                </p>
              )}
              <div style={{ width: '100%', maxWidth: 260 }}>
                {/* DEV brique 4 - `leaderboard` reste à `null` (jamais
                    fetché) en mode duo ; `undefined` au rendu plutôt que
                    `null` pour éviter un "Chargement du classement…" indéfini
                    (composant Leaderboard, inchangé — cf. useEffect ci-dessus). */}
                <Leaderboard entries={duoMatch ? undefined : leaderboard} currentUserId={session?.user.id} />
              </div>
              <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                <button
                  onClick={restart}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 12,
                    fontSize: 14,
                    fontWeight: 600,
                    background: C.green,
                    color: '#173000',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  Rejouer
                </button>
                {onShowLeaderboard && (
                  <button
                    onClick={onShowLeaderboard}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 12,
                      fontSize: 14,
                      fontWeight: 600,
                      background: 'transparent',
                      color: C.text,
                      border: `1px solid ${C.textDim}`,
                      cursor: 'pointer',
                    }}
                  >
                    Classement
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <p style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: '#5a6f92' }}>
          Glisse ← → pour ranger · tap pour tourner · glisse ↓ pour accélérer
        </p>
      </div>

      <style>{`
        @keyframes bonusfx {
          0%   { opacity: 0; transform: translate(-50%, 8px) scale(0.9); }
          20%  { opacity: 1; transform: translate(-50%, 0) scale(1.05); }
          80%  { opacity: 1; }
          100% { opacity: 0; transform: translate(-50%, -18px) scale(1); }
        }
        .bonusfx { animation: bonusfx 1.4s ease-out forwards; }
        @media (prefers-reduced-motion: reduce) {
          .bonusfx { animation-duration: 0.8s; }
        }
      `}</style>
      </div>
  );

  return standalone ? (
    <div
      style={gameCaptureLayerStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header}
      {gameArea}
    </div>
  ) : (
    gameArea
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
