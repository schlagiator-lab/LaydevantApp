import { useRef, useEffect, useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react';

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
  speedupFactor: 0.85, // facteur d'accélération par palier
  softDropMs: 55, // chute pendant un glisser bas
  spawnDelayMs: 250, // petit répit avant que la nouvelle pièce commence à tomber
  swipeThreshold: 90, // px verticaux pour déclencher un hard drop (peu sensible)
  softDropArm: 40, // px verticaux avant d'armer le soft drop
  colStep: 22, // px horizontaux par colonne déplacée
  bonusPoints: 5, // points bonus si la ligne complétée contient l'extension cible
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

function randomPiece(): Piece {
  const k = KEYS[(Math.random() * KEYS.length) | 0];
  return { key: k, shape: SHAPES[k], color: PIECE_COLORS[k], ext: PIECE_EXT[k], x: (CFG.cols >> 1) - 1, y: 0 };
}

export default function PdfTetris() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(1);
  const [over, setOver] = useState(false);
  const [score, setScore] = useState(0);
  const [target, setTarget] = useState(EXT_LIST[(Math.random() * EXT_LIST.length) | 0]);
  const [bonusFx, setBonusFx] = useState(0); // horodatage pour animer le "+bonus"

  const g = useRef<GameState>({
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
  });
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

  const lockAndClear = useCallback(() => {
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
    }
    // spawn suivant — on repart d'un rythme normal :
    st.piece = st.next;
    st.next = randomPiece();
    st.acc = 0; // vide le trop-plein de chute (sinon la pièce plonge)
    st.soft = false; // coupe le soft drop hérité du geste précédent
    st.softConsumed = true; // bloque le réarmement tant que le doigt n'est pas relâché
    st.spawnLockUntil = performance.now() + (full.length ? 180 : 0) + CFG.spawnDelayMs; // petit répit, après le flash s'il y en a un
    if (collides(st.piece.shape, st.piece.x, st.piece.y)) { st.over = true; setOver(true); }
  }, [collides]);

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
    while (keep.length < CFG.rows) keep.unshift(Array<GridCell>(CFG.cols).fill(null));
    st.grid = keep;
    st.lines += cleared;
    setLines(st.lines);
    // score : 1 point par ligne + bonus si la cible y était
    st.score += cleared + bonusLines * CFG.bonusPoints;
    setScore(st.score);
    if (bonusLines > 0) {
      setBonusFx(performance.now()); // déclenche l'animation "+bonus"
      // nouvelle cible différente de l'actuelle
      let nt = targetRef.current;
      while (nt === targetRef.current) nt = EXT_LIST[(Math.random() * EXT_LIST.length) | 0];
      targetRef.current = nt;
      setTarget(nt);
    }
    // accélération par paliers
    const lvl = 1 + Math.floor(st.lines / CFG.speedupEvery);
    setLevel(lvl);
    st.dropMs = Math.max(CFG.minDropMs, CFG.startDropMs * Math.pow(CFG.speedupFactor, lvl - 1));
    st.flash = [];
  }, []);

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
      if (!collides(rs, st.piece.x + k, st.piece.y)) { st.piece.shape = rs; st.piece.x += k; return; }
    }
  }, [collides]);

  const hardDrop = useCallback(() => {
    const st = g.current;
    if (st.over || st.flash.length) return;
    while (!collides(st.piece.shape, st.piece.x, st.piece.y + 1)) st.piece.y += 1;
    lockAndClear();
  }, [collides, lockAndClear]);

  const restart = useCallback(() => {
    const t0 = EXT_LIST[(Math.random() * EXT_LIST.length) | 0];
    g.current = {
      grid: emptyGrid(), piece: randomPiece(), next: randomPiece(),
      dropMs: CFG.startDropMs, acc: 0, lines: 0, score: 0, over: false,
      flash: [], flashUntil: 0, soft: false, softConsumed: false, spawnLockUntil: 0,
    };
    targetRef.current = t0;
    setTarget(t0); setScore(0); setLines(0); setLevel(1); setOver(false);
  }, []);

  // ---- gestes ----
  const touch = useRef({ x: 0, y: 0, lastColX: 0, moved: false, softOn: false, horiz: false });
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    touch.current = { x: e.clientX, y: e.clientY, lastColX: e.clientX, moved: false, softOn: false, horiz: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
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
    if (!t.horiz && dyTotal > CFG.softDropArm && Math.abs(dxTotal) < dyTotal && !t.softOn && !g.current.softConsumed) {
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

  return (
    <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: 16, background: C.bgDeep, borderRadius: 16, boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: 384 }}>
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
          <div style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'monospace' }}>
            <span style={{ color: C.green }}>score&nbsp;{score}</span>
            <span style={{ color: C.textDim }}>niv.&nbsp;{level}</span>
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
            height: 'min(460px, 56vh)',
            border: '1px solid rgba(164,198,57,0.22)',
            background: C.bg,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
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
                justifyContent: 'center',
                gap: 12,
                background: 'rgba(15,36,68,0.86)',
              }}
            >
              <p style={{ fontSize: 18, fontWeight: 600, color: C.text, margin: 0 }}>Bibliothèque pleine !</p>
              <p style={{ fontSize: 14, color: C.textDim, margin: 0 }}>
                score {score} · {lines} documents rangés
              </p>
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
