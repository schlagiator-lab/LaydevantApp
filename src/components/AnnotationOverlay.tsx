import { denormScalar, pointsToSvgD } from '../lib/photoAnnotations';
import type { AnnotationObject, PhotoAnnotations } from '../lib/photoAnnotations';

/** Largeur minimale du jumeau invisible de sélection, pour capter un doigt sur un trait fin. */
export const MIN_HIT_STROKE_PX = 24;

// Couleur dédiée à la sélection — n'appartient à AUCUNE couleur de PALETTE
// (rouge/noir/jaune/vert), pour rester visuellement distincte quel que soit
// l'objet sélectionné, plutôt que l'ancien halo orange (colors.accent) qui se
// confondait avec le rouge/jaune. Traits pointillés en plus de la couleur :
// se distingue même sur un fond photo qui matcherait accidentellement le bleu.
const SELECTION_COLOR = '#29b6f6';

export interface RenderAnnotationObjectOptions {
  /** Halo visuel de sélection (éditeur uniquement). */
  selected?: boolean;
  /** Outil Sélection actif : ajoute un jumeau de capture tactile (trait/flèche/
   *  forme) ou rend le texte lui-même tapable (éditeur uniquement). */
  interactive?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerCancel?: (e: React.PointerEvent) => void;
}

/**
 * Rendu d'UN objet du calque, switch exhaustif sur les 4 types — SEULE
 * implémentation de cette géométrie dans l'app. Sans `opts` : rendu purement
 * décoratif, pointer-events none partout (utilisé par <AnnotationOverlay> en
 * lecture seule, et par l'éditeur pour la couche visible de base). Avec
 * `opts` : PhotoAnnotator superpose le halo de sélection et les jumeaux de
 * capture tactile, sans dupliquer la géométrie ni la conversion normalisé
 * <-> pixel (toujours via denormScalar/pointsToSvgD).
 */
export function renderAnnotationObject(
  obj: AnnotationObject,
  L: number,
  H: number,
  opts: RenderAnnotationObjectOptions = {}
) {
  const { selected = false, interactive = false, onPointerDown, onPointerMove, onPointerUp, onPointerCancel } = opts;
  const haloWidthBoost = denormScalar(0.010, L, H);
  const haloDash = `${denormScalar(0.014, L, H)} ${denormScalar(0.009, L, H)}`;

  switch (obj.type) {
    case 'path': {
      const d = pointsToSvgD(obj.points, L, H);
      const strokeW = denormScalar(obj.width, L, H);
      return (
        <g key={obj.id}>
          {selected && (
            <path d={d} stroke={SELECTION_COLOR} strokeWidth={strokeW + haloWidthBoost} strokeDasharray={haloDash} fill="none"
              strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
          )}
          <path d={d} stroke={obj.color} strokeWidth={strokeW} fill="none"
            strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
          {interactive && (
            <path d={d} stroke="transparent" strokeWidth={Math.max(strokeW, MIN_HIT_STROKE_PX)} fill="none"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ pointerEvents: 'stroke', cursor: 'pointer', touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            />
          )}
        </g>
      );
    }
    case 'text': {
      const x = obj.x * L;
      const y = obj.y * H;
      const fontSize = denormScalar(obj.size, L, H);
      return (
        <text
          key={obj.id}
          x={x}
          y={y}
          fill={obj.color}
          fontSize={fontSize}
          textAnchor={obj.anchor || 'start'}
          dominantBaseline="middle"
          fontFamily="system-ui, -apple-system, Arial, sans-serif"
          stroke={selected ? SELECTION_COLOR : 'none'}
          strokeWidth={selected ? Math.max(fontSize * 0.09, 2.5) : 0}
          paintOrder="stroke"
          style={{
            pointerEvents: interactive ? 'auto' : 'none',
            cursor: interactive ? 'pointer' : 'default',
            userSelect: 'none',
            touchAction: 'none',
          }}
          onPointerDown={interactive ? onPointerDown : undefined}
          onPointerMove={interactive ? onPointerMove : undefined}
          onPointerUp={interactive ? onPointerUp : undefined}
          onPointerCancel={interactive ? onPointerCancel : undefined}
        >
          {obj.text}
        </text>
      );
    }
    case 'arrow': {
      const x1 = obj.x1 * L;
      const y1 = obj.y1 * H;
      const x2 = obj.x2 * L;
      const y2 = obj.y2 * H;
      const strokeW = denormScalar(obj.width, L, H);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = Math.max(strokeW * 4, denormScalar(0.02, L, H));
      const headAngle = Math.PI / 7;
      const hx1 = x2 - headLen * Math.cos(angle - headAngle);
      const hy1 = y2 - headLen * Math.sin(angle - headAngle);
      const hx2 = x2 - headLen * Math.cos(angle + headAngle);
      const hy2 = y2 - headLen * Math.sin(angle + headAngle);
      return (
        <g key={obj.id} style={{ pointerEvents: 'none' }}>
          {selected && (
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={SELECTION_COLOR}
              strokeWidth={strokeW + haloWidthBoost} strokeDasharray={haloDash} strokeLinecap="round" />
          )}
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={obj.color} strokeWidth={strokeW} strokeLinecap="round" />
          <line x1={x2} y1={y2} x2={hx1} y2={hy1} stroke={obj.color} strokeWidth={strokeW} strokeLinecap="round" />
          <line x1={x2} y1={y2} x2={hx2} y2={hy2} stroke={obj.color} strokeWidth={strokeW} strokeLinecap="round" />
          {interactive && (
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(strokeW, MIN_HIT_STROKE_PX)}
              strokeLinecap="round" style={{ pointerEvents: 'stroke', cursor: 'pointer', touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            />
          )}
        </g>
      );
    }
    case 'shape': {
      const x = obj.x * L;
      const y = obj.y * H;
      const w = obj.w * L;
      const h = obj.h * H;
      const strokeW = denormScalar(obj.width, L, H);
      const geom =
        obj.shape === 'rect'
          ? { x, y, width: w, height: h }
          : { cx: x + w / 2, cy: y + h / 2, rx: Math.abs(w) / 2, ry: Math.abs(h) / 2 };
      const Tag = obj.shape === 'rect' ? 'rect' : 'ellipse';
      return (
        <g key={obj.id} style={{ pointerEvents: 'none' }}>
          {selected && (
            <Tag {...geom} stroke={SELECTION_COLOR} strokeWidth={strokeW + haloWidthBoost} strokeDasharray={haloDash} fill="none" />
          )}
          <Tag {...geom} stroke={obj.color} strokeWidth={strokeW} fill="none" />
          {interactive && (
            <Tag {...geom} stroke="transparent" strokeWidth={Math.max(strokeW, MIN_HIT_STROKE_PX)} fill="none"
              style={{ pointerEvents: 'stroke', cursor: 'pointer', touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            />
          )}
        </g>
      );
    }
  }
}

export interface AnnotationOverlayProps {
  annotations: PhotoAnnotations | null;
  /** Dimensions natives de l'image (viewBox) — jamais celles de la boîte affichée. */
  width: number;
  height: number;
  className?: string;
}

/**
 * Superpose le calque d'annotations à une photo, en LECTURE SEULE — vignette
 * du carnet, visualiseur plein écran. Purement décoratif : aucun handler,
 * pointer-events none, ne gêne jamais un tap sur la photo dessous. Le parent
 * est responsable du positionnement (conteneur `position:relative` de la
 * taille exacte de l'image affichée ; ce composant se cale en `inset:0`).
 */
export function AnnotationOverlay({ annotations, width, height, className }: AnnotationOverlayProps) {
  if (!annotations || annotations.objects.length === 0) return null;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} style={overlaySvgStyle} aria-hidden="true">
      {annotations.objects.map((obj) => renderAnnotationObject(obj, width, height))}
    </svg>
  );
}

const overlaySvgStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
};
