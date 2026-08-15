import { useEffect, useRef, useState } from 'react';
import { getPhotoObjectUrl, updateDossierPhotoAnnotations } from '../lib/dossiers';
import {
  DEFAULT_COLOR,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_SIZE,
  PALETTE,
  denormPoint,
  denormScalar,
  makeId,
  normPoint,
  pointsToSvgD,
} from '../lib/photoAnnotations';
import type { AnnotationObject } from '../lib/photoAnnotations';
import { useToast } from '../lib/useToast';
import { colors, textA } from '../styles/tokens';
import type { DossierPhotoView } from '../types/database';

type Tool = 'select' | 'path' | 'text';

/** En pixels image (espace du viewBox, pas écran) : distingue un tap d'un glissé. */
const TAP_THRESHOLD_PX = 4;
/** Largeur minimale du jumeau invisible de sélection, pour capter un doigt sur un trait fin. */
const MIN_HIT_STROKE_PX = 24;

type PendingText = {
  xNorm: number;
  yNorm: number;
  screenLeft: number;
  screenTop: number;
  editingId?: string;
};

function translateObject(obj: AnnotationObject, dx: number, dy: number): AnnotationObject {
  switch (obj.type) {
    case 'path':
      return { ...obj, points: obj.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    case 'text':
      return { ...obj, x: obj.x + dx, y: obj.y + dy };
    case 'arrow':
      return { ...obj, x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy };
    case 'shape':
      return { ...obj, x: obj.x + dx, y: obj.y + dy };
  }
}

function maxPixelExtent(points: [number, number][], w: number, h: number): number {
  if (points.length === 0) return 0;
  const [x0, y0] = denormPoint(points[0], w, h);
  let max = 0;
  for (const p of points) {
    const [x, y] = denormPoint(p, w, h);
    const d = Math.hypot(x - x0, y - y0);
    if (d > max) max = d;
  }
  return max;
}

export interface PhotoAnnotatorProps {
  photo: DossierPhotoView;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Calque d'annotations vectoriel par-dessus une photo existante — fléchage,
 * repérage, légende. NON DESTRUCTIF : la photo originale sur R2 n'est jamais
 * réécrite ni aplatie, seul le JSON de `dossier_photos.annotations` change.
 * Toute conversion normalisé<->pixel passe par src/lib/photoAnnotations.ts,
 * contrat partagé avec le futur rendu-lecture et l'export.
 */
export function PhotoAnnotator({ photo, onClose, onSaved }: PhotoAnnotatorProps) {
  const { showToast } = useToast();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<{ id: string; startXNorm: number; startYNorm: number; original: AnnotationObject } | null>(null);
  const textStartRef = useRef<{ x: number; y: number } | null>(null);
  // Garde-fou contre le blur natif retardé/dupliqué (voir commitText/cancelText) :
  // true = aucune session de saisie en cours, ou déjà résolue une fois.
  const textResolvedRef = useRef(true);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(
    photo.largeur && photo.hauteur ? { w: photo.largeur, h: photo.hauteur } : null
  );
  const [objects, setObjects] = useState<AnnotationObject[]>(() =>
    (photo.annotations?.objects ?? []).map((o) => (o.id ? o : { ...o, id: makeId() }))
  );
  const [tool, setTool] = useState<Tool>('path');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftPoints, setDraftPoints] = useState<[number, number][] | null>(null);
  const [pendingText, setPendingText] = useState<PendingText | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Object URL de la photo — chargée ici (pas par le parent) car c'est cet
  // écran qui a besoin du blob pour le fond du <svg>, révoquée au démontage.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const u = await getPhotoObjectUrl(photo.storage_key);
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        url = u;
        setObjectUrl(u);
      } catch (err) {
        if (!cancelled) showToast(err instanceof Error ? err.message : 'Échec du chargement de la photo.');
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.storage_key]);

  // Repli legacy : dimensions absentes en base, on les lit sur l'image chargée.
  useEffect(() => {
    if (imgSize || !objectUrl) return;
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = objectUrl;
  }, [objectUrl, imgSize]);

  const ready = objectUrl !== null && imgSize !== null;

  function getSvgPoint(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const loc = pt.matrixTransform(ctm.inverse());
    return { x: loc.x, y: loc.y };
  }

  function svgToScreen(px: number, py: number): { left: number; top: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = px;
    pt.y = py;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const screen = pt.matrixTransform(ctm);
    return { left: screen.x, top: screen.y };
  }

  // --- Dessin (outils Trait / Texte) + désélection, gestes sur la surface
  // d'interaction du fond (le <rect> transparent, jamais l'<image> : voir
  // rendu plus bas — un menu contextuel natif se déclenche sur une <image>
  // au doigt long, jamais sur une forme vectorielle sans contenu image). ---

  const handleBackgroundPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (tool === 'select') {
      setSelectedId(null);
      return;
    }
    if (!imgSize) return;
    const p = getSvgPoint(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'path') {
      setDraftPoints([normPoint(p.x, p.y, imgSize.w, imgSize.h)]);
    } else if (tool === 'text') {
      textStartRef.current = p;
    }
  };

  const handleBackgroundPointerMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (tool !== 'path' || !draftPoints || !imgSize) return;
    const p = getSvgPoint(e);
    if (!p) return;
    setDraftPoints((prev) => (prev ? [...prev, normPoint(p.x, p.y, imgSize.w, imgSize.h)] : prev));
  };

  const finishDraftPath = () => {
    const pts = draftPoints;
    setDraftPoints(null);
    if (!pts || !imgSize || pts.length < 2) return;
    if (maxPixelExtent(pts, imgSize.w, imgSize.h) < TAP_THRESHOLD_PX) return;
    const newPath: AnnotationObject = { type: 'path', id: makeId(), color, width: DEFAULT_STROKE_WIDTH, points: pts };
    setObjects((prev) => [...prev, newPath]);
  };

  const finishTextTap = (e: React.PointerEvent<SVGRectElement>) => {
    const start = textStartRef.current;
    textStartRef.current = null;
    if (!start || !imgSize) return;
    const p = getSvgPoint(e);
    if (!p || Math.hypot(p.x - start.x, p.y - start.y) > TAP_THRESHOLD_PX) return;
    const [xNorm, yNorm] = normPoint(start.x, start.y, imgSize.w, imgSize.h);
    textResolvedRef.current = false;
    setPendingText({ xNorm, yNorm, screenLeft: e.clientX, screenTop: e.clientY });
    setTextDraft('');
  };

  const handleBackgroundPointerUp = (e: React.PointerEvent<SVGRectElement>) => {
    if (tool === 'path') finishDraftPath();
    else if (tool === 'text') finishTextTap(e);
  };

  const handleBackgroundPointerCancel = () => {
    setDraftPoints(null);
    textStartRef.current = null;
  };

  // --- Sélection / déplacement (outil Sélection), gestes par objet ---

  const handleObjectPointerDown = (e: React.PointerEvent, obj: AnnotationObject) => {
    if (tool !== 'select' || !imgSize || !obj.id) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = getSvgPoint(e);
    if (!p) return;
    const [xNorm, yNorm] = normPoint(p.x, p.y, imgSize.w, imgSize.h);
    dragStateRef.current = { id: obj.id, startXNorm: xNorm, startYNorm: yNorm, original: obj };
    setSelectedId(obj.id);
  };

  const handleObjectPointerMove = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || !imgSize) return;
    const p = getSvgPoint(e);
    if (!p) return;
    const [xNorm, yNorm] = normPoint(p.x, p.y, imgSize.w, imgSize.h);
    const dx = xNorm - drag.startXNorm;
    const dy = yNorm - drag.startYNorm;
    setObjects((prev) => prev.map((o) => (o.id === drag.id ? translateObject(drag.original, dx, dy) : o)));
  };

  const handleObjectPointerUp = () => {
    dragStateRef.current = null;
  };

  // --- Champ de saisie inline (création ou édition de texte) ---

  // Démonter l'<input> (pointe déjà résolue) déclenche un blur natif qui
  // rejoue onBlur={commitText} avec la fermeture FIGÉE de ce render — donc
  // avec le même pendingText/textDraft qu'à l'instant du premier appel. Sans
  // garde, ce second appel fantôme duplique l'objet (ou, s'il arrive après
  // l'ouverture d'une session suivante, écrase son pendingText en cours). Le
  // ref est lu à jour même par cette fermeture obsolète : une seule
  // résolution (commit XOR annulation) par session, quel que soit l'ordre
  // d'arrivée des événements.
  const commitText = () => {
    if (textResolvedRef.current) return;
    textResolvedRef.current = true;
    const value = textDraft.trim();
    if (value && pendingText) {
      if (pendingText.editingId) {
        const id = pendingText.editingId;
        setObjects((prev) => prev.map((o) => (o.id === id && o.type === 'text' ? { ...o, text: value } : o)));
      } else {
        const newText: AnnotationObject = {
          type: 'text',
          id: makeId(),
          color,
          size: DEFAULT_TEXT_SIZE,
          x: pendingText.xNorm,
          y: pendingText.yNorm,
          text: value,
          anchor: 'start',
        };
        setObjects((prev) => [...prev, newText]);
      }
    }
    setPendingText(null);
    setTextDraft('');
  };

  const cancelText = () => {
    if (textResolvedRef.current) return;
    textResolvedRef.current = true;
    setPendingText(null);
    setTextDraft('');
  };

  const openTextEditor = () => {
    const obj = objects.find((o) => o.id === selectedId);
    if (!obj || obj.type !== 'text' || !imgSize) return;
    const screen = svgToScreen(obj.x * imgSize.w, obj.y * imgSize.h);
    if (!screen) return;
    textResolvedRef.current = false;
    setPendingText({ xNorm: obj.x, yNorm: obj.y, screenLeft: screen.left, screenTop: screen.top, editingId: obj.id });
    setTextDraft(obj.text);
  };

  // --- Actions globales ---

  const handleColorPick = (c: string) => {
    setColor(c);
    if (selectedId) {
      setObjects((prev) => prev.map((o) => (o.id === selectedId ? { ...o, color: c } : o)));
    }
  };

  const handleUndo = () => {
    setObjects((prev) => prev.slice(0, -1));
    setSelectedId((prev) => (objects.length > 0 && objects[objects.length - 1].id === prev ? null : prev));
  };

  const handleClear = () => {
    setObjects([]);
    setSelectedId(null);
  };

  const handleDeleteSelected = () => {
    setObjects((prev) => prev.filter((o) => o.id !== selectedId));
    setSelectedId(null);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateDossierPhotoAnnotations(photo.id, objects.length > 0 ? { v: 1, objects } : null);
      onSaved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de l’enregistrement.');
    } finally {
      setSaving(false);
    }
  };

  const selectedObject = objects.find((o) => o.id === selectedId) ?? null;

  // --- Rendu d'un objet du calque, switch exhaustif sur les 4 types ---

  function renderObject(obj: AnnotationObject, L: number, H: number) {
    const selected = selectedId === obj.id;
    const haloWidthBoost = denormScalar(0.006, L, H);

    switch (obj.type) {
      case 'path': {
        const d = pointsToSvgD(obj.points, L, H);
        const strokeW = denormScalar(obj.width, L, H);
        return (
          <g key={obj.id}>
            {selected && (
              <path d={d} stroke={colors.accent} strokeWidth={strokeW + haloWidthBoost} fill="none"
                strokeLinecap="round" strokeLinejoin="round" opacity={0.45} style={{ pointerEvents: 'none' }} />
            )}
            <path d={d} stroke={obj.color} strokeWidth={strokeW} fill="none"
              strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
            {tool === 'select' && (
              <path d={d} stroke="transparent" strokeWidth={Math.max(strokeW, MIN_HIT_STROKE_PX)} fill="none"
                strokeLinecap="round" strokeLinejoin="round"
                style={{ pointerEvents: 'stroke', cursor: 'pointer', touchAction: 'none' }}
                onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                onPointerMove={handleObjectPointerMove}
                onPointerUp={handleObjectPointerUp}
                onPointerCancel={handleObjectPointerUp}
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
            stroke={selected ? colors.accent : 'none'}
            strokeWidth={selected ? Math.max(fontSize * 0.06, 1.5) : 0}
            paintOrder="stroke"
            style={{
              pointerEvents: tool === 'select' ? 'auto' : 'none',
              cursor: tool === 'select' ? 'pointer' : 'default',
              userSelect: 'none',
              touchAction: 'none',
            }}
            onPointerDown={tool === 'select' ? (e) => handleObjectPointerDown(e, obj) : undefined}
            onPointerMove={tool === 'select' ? handleObjectPointerMove : undefined}
            onPointerUp={tool === 'select' ? handleObjectPointerUp : undefined}
            onPointerCancel={tool === 'select' ? handleObjectPointerUp : undefined}
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
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors.accent}
                strokeWidth={strokeW + haloWidthBoost} strokeLinecap="round" opacity={0.45} />
            )}
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={obj.color} strokeWidth={strokeW} strokeLinecap="round" />
            <line x1={x2} y1={y2} x2={hx1} y2={hy1} stroke={obj.color} strokeWidth={strokeW} strokeLinecap="round" />
            <line x1={x2} y1={y2} x2={hx2} y2={hy2} stroke={obj.color} strokeWidth={strokeW} strokeLinecap="round" />
            {tool === 'select' && (
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(strokeW, MIN_HIT_STROKE_PX)}
                strokeLinecap="round" style={{ pointerEvents: 'stroke', cursor: 'pointer', touchAction: 'none' }}
                onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                onPointerMove={handleObjectPointerMove}
                onPointerUp={handleObjectPointerUp}
                onPointerCancel={handleObjectPointerUp}
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
              <Tag {...geom} stroke={colors.accent} strokeWidth={strokeW + haloWidthBoost} fill="none" opacity={0.45} />
            )}
            <Tag {...geom} stroke={obj.color} strokeWidth={strokeW} fill="none" />
            {tool === 'select' && (
              <Tag {...geom} stroke="transparent" strokeWidth={Math.max(strokeW, MIN_HIT_STROKE_PX)} fill="none"
                style={{ pointerEvents: 'stroke', cursor: 'pointer', touchAction: 'none' }}
                onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                onPointerMove={handleObjectPointerMove}
                onPointerUp={handleObjectPointerUp}
                onPointerCancel={handleObjectPointerUp}
              />
            )}
          </g>
        );
      }
    }
  }

  return (
    <div style={overlayStyle} onContextMenu={(e) => e.preventDefault()}>
      <div style={headerStyle}>
        <button type="button" onClick={onClose} disabled={saving} style={textButtonStyle}>
          Fermer
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: textA(0.85) }}>Annoter la photo</span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!ready || saving}
          style={{ ...saveButtonStyle, opacity: !ready || saving ? 0.4 : 1 }}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>

      <div style={svgWrapStyle}>
        {!ready && <span style={{ fontSize: 13, color: textA(0.6) }}>Chargement…</span>}
        {ready && imgSize && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
            style={svgStyle}
            onContextMenu={(e) => e.preventDefault()}
          >
            <image
              href={objectUrl ?? undefined}
              x={0}
              y={0}
              width={imgSize.w}
              height={imgSize.h}
              style={{ pointerEvents: 'none' }}
            />
            {/* Surface d'interaction du fond : un <rect> transparent, jamais l'<image>
                elle-même (une <image> déclenche le menu contextuel natif Android au
                doigt long ; une forme vectorielle sans contenu image ne le fait pas). */}
            <rect
              x={0}
              y={0}
              width={imgSize.w}
              height={imgSize.h}
              fill="transparent"
              style={{ pointerEvents: 'all', touchAction: 'none', cursor: tool === 'select' ? 'default' : 'crosshair' }}
              onPointerDown={handleBackgroundPointerDown}
              onPointerMove={handleBackgroundPointerMove}
              onPointerUp={handleBackgroundPointerUp}
              onPointerCancel={handleBackgroundPointerCancel}
            />
            {objects.map((obj) => renderObject(obj, imgSize.w, imgSize.h))}
            {draftPoints && draftPoints.length > 0 && (
              <path
                d={pointsToSvgD(draftPoints, imgSize.w, imgSize.h)}
                stroke={color}
                strokeWidth={denormScalar(DEFAULT_STROKE_WIDTH, imgSize.w, imgSize.h)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: 'none' }}
              />
            )}
          </svg>
        )}
      </div>

      {pendingText && (
        <input
          autoFocus
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText();
            if (e.key === 'Escape') cancelText();
          }}
          placeholder="Texte…"
          style={{ ...pendingTextInputStyle, left: pendingText.screenLeft, top: pendingText.screenTop, color }}
        />
      )}

      <div style={toolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={toolToggleStyle}>
            <button type="button" onClick={() => setTool('select')} style={{ ...toolButtonStyle, ...(tool === 'select' ? toolButtonActiveStyle : {}) }}>
              Sélection
            </button>
            <button type="button" onClick={() => setTool('path')} style={{ ...toolButtonStyle, ...(tool === 'path' ? toolButtonActiveStyle : {}) }}>
              Trait
            </button>
            <button type="button" onClick={() => setTool('text')} style={{ ...toolButtonStyle, ...(tool === 'text' ? toolButtonActiveStyle : {}) }}>
              Texte
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => handleColorPick(c)}
                aria-label={`Couleur ${c}`}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: c,
                  border: color === c ? `2px solid ${colors.text}` : '2px solid transparent',
                  boxShadow: color === c ? '0 0 0 2px rgba(0,0,0,0.4)' : 'none',
                  cursor: 'pointer',
                  padding: 0,
                  flex: 'none',
                }}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {selectedObject && selectedObject.type === 'text' && (
            <button type="button" onClick={openTextEditor} style={textButtonStyle}>
              Éditer le texte
            </button>
          )}
          {selectedObject && (
            <button type="button" onClick={handleDeleteSelected} style={textButtonStyle}>
              Supprimer
            </button>
          )}
          <button type="button" onClick={handleUndo} disabled={objects.length === 0} style={{ ...textButtonStyle, opacity: objects.length ? 1 : 0.4 }}>
            Annuler
          </button>
          <button type="button" onClick={handleClear} disabled={objects.length === 0} style={{ ...textButtonStyle, opacity: objects.length ? 1 : 0.4 }}>
            Tout effacer
          </button>
        </div>
      </div>
    </div>
  );
}

// Coupe la sélection de texte et le callout iOS/Android ("copier / partager
// l'image") sur un appui long — le conteneur racine ET le <svg> le portent,
// en complément du <rect> d'interaction (pointer-events) et de
// onContextMenu (menu contextuel classique, clic droit/long-press desktop).
const noCalloutStyle: React.CSSProperties = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.94)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 1500,
  ...noCalloutStyle,
};

const svgStyle: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: '100%',
  width: 'auto',
  height: 'auto',
  touchAction: 'none',
  borderRadius: 8,
  ...noCalloutStyle,
};

const headerStyle: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 16px',
};

const svgWrapStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 12px',
};

const toolbarStyle: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 16px',
  borderTop: `1px solid rgba(255,255,255,0.12)`,
  flexWrap: 'wrap',
};

const toolToggleStyle: React.CSSProperties = {
  display: 'flex',
  border: `1px solid rgba(255,255,255,0.25)`,
  borderRadius: 8,
  overflow: 'hidden',
};

const toolButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'rgba(255,255,255,0.6)',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '7px 12px',
  cursor: 'pointer',
};

const toolButtonActiveStyle: React.CSSProperties = {
  background: colors.accent,
  color: '#132146',
};

const textButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  padding: 0,
};

const saveButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 10,
  background: colors.accent,
  color: '#132146',
  fontSize: 13,
  fontWeight: 700,
  padding: '8px 14px',
  cursor: 'pointer',
};

const pendingTextInputStyle: React.CSSProperties = {
  position: 'fixed',
  transform: 'translate(-50%, -110%)',
  zIndex: 1600,
  minWidth: 160,
  maxWidth: '70vw',
  borderRadius: 8,
  border: `1px solid rgba(255,255,255,0.4)`,
  background: 'rgba(20,20,20,0.92)',
  fontSize: 15,
  fontWeight: 700,
  padding: '8px 10px',
  boxSizing: 'border-box',
};
