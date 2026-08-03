import { useEffect, useRef, useState } from 'react';
import { uploadDossierPhoto } from '../lib/dossiers';
import { useToast } from '../lib/useToast';
import { colors, fonts, textA } from '../styles/tokens';

interface Point {
  x: number;
  y: number;
}

type Action =
  | { kind: 'stroke'; color: string; points: Point[] }
  | { kind: 'text'; color: string; x: number; y: number; text: string; fontSize: number };

type Tool = 'draw' | 'text';

const PALETTE = ['#E8433A', '#F2E9A8', '#3AA6E8'] as const;

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

export interface PhotoAnnotatorProps {
  photoUrl: string;
  dossierId: string;
  auteur: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Dessin libre et texte par-dessus une photo existante (fléchage/repérage +
 * légende explicative sur chantier). N'écrase jamais l'original : l'aplat
 * est toujours envoyé comme une NOUVELLE photo du dossier, via le même
 * pipeline d'upload que la prise de vue directe.
 */
export function PhotoAnnotator({ photoUrl, dossierId, auteur, onClose, onSaved }: PhotoAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const actionsRef = useRef<Action[]>([]);
  const drawingRef = useRef<Extract<Action, { kind: 'stroke' }> | null>(null);
  const [tool, setTool] = useState<Tool>('draw');
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [ready, setReady] = useState(false);
  const [hasActions, setHasActions] = useState(false);
  const [saving, setSaving] = useState(false);
  // Texte en cours de saisie : position canvas (où il sera dessiné) + position
  // écran (où flotte le champ de saisie, en coordonnées viewport — plus simple
  // et plus fiable que de reconvertir depuis l'espace canvas mis à l'échelle).
  const [pendingCanvasPos, setPendingCanvasPos] = useState<Point | null>(null);
  const [pendingScreenPos, setPendingScreenPos] = useState<{ left: number; top: number } | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const { showToast } = useToast();

  const fontSizeFor = (canvasWidth: number) => Math.max(24, canvasWidth / 32);

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const lineWidth = Math.max(4, canvas.width / 180);
    const allActions = drawingRef.current ? [...actionsRef.current, drawingRef.current] : actionsRef.current;
    for (const action of allActions) {
      if (action.kind === 'stroke') {
        if (action.points.length === 0) continue;
        ctx.strokeStyle = action.color;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(action.points[0].x, action.points[0].y);
        for (const point of action.points.slice(1)) {
          ctx.lineTo(point.x, point.y);
        }
        // Point isolé (tap sans glisser) : dessine un petit point visible.
        if (action.points.length === 1) {
          ctx.lineTo(action.points[0].x + 0.01, action.points[0].y + 0.01);
        }
        ctx.stroke();
      } else {
        ctx.font = `700 ${action.fontSize}px ${fonts.sans}`;
        ctx.textBaseline = 'top';
        const lines = wrapText(ctx, action.text, canvas.width * 0.6);
        const lineHeight = action.fontSize * 1.3;
        ctx.lineWidth = action.fontSize / 6;
        ctx.lineJoin = 'round';
        lines.forEach((line, i) => {
          const y = action.y + i * lineHeight;
          // Contour sombre pour rester lisible quel que soit le fond de la
          // photo, quelle que soit la couleur de texte choisie.
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
          ctx.strokeText(line, action.x, y);
          ctx.fillStyle = action.color;
          ctx.fillText(line, action.x, y);
        });
      }
    }
  };

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        redraw();
      }
      setReady(true);
    };
    img.src = photoUrl;
  }, [photoUrl]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || pendingCanvasPos) return;
    if (tool === 'text') {
      setPendingCanvasPos(pointFromEvent(e));
      setPendingScreenPos({ left: e.clientX, top: e.clientY });
      setTextDraft('');
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = { kind: 'stroke', color, points: [pointFromEvent(e)] };
    redraw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current.points.push(pointFromEvent(e));
    redraw();
  };

  const finishStroke = () => {
    if (!drawingRef.current) return;
    actionsRef.current = [...actionsRef.current, drawingRef.current];
    drawingRef.current = null;
    setHasActions(actionsRef.current.length > 0);
    redraw();
  };

  const commitText = () => {
    const value = textDraft.trim();
    if (value && pendingCanvasPos) {
      const fontSize = canvasRef.current ? fontSizeFor(canvasRef.current.width) : 32;
      actionsRef.current = [...actionsRef.current, { kind: 'text', color, x: pendingCanvasPos.x, y: pendingCanvasPos.y, text: value, fontSize }];
      setHasActions(true);
    }
    setPendingCanvasPos(null);
    setPendingScreenPos(null);
    setTextDraft('');
    redraw();
  };

  const cancelText = () => {
    setPendingCanvasPos(null);
    setPendingScreenPos(null);
    setTextDraft('');
  };

  const handleUndo = () => {
    actionsRef.current = actionsRef.current.slice(0, -1);
    setHasActions(actionsRef.current.length > 0);
    redraw();
  };

  const handleClear = () => {
    actionsRef.current = [];
    setHasActions(false);
    redraw();
  };

  const handleSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    setSaving(true);
    try {
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Rendu échoué'))), 'image/jpeg', 0.9);
      });
      const file = new File([blob], 'annotation.jpg', { type: 'image/jpeg' });
      await uploadDossierPhoto(dossierId, file, auteur);
      onSaved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de l’enregistrement.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={overlayStyle}>
      <div style={headerStyle}>
        <button type="button" onClick={onClose} disabled={saving} style={textButtonStyle}>
          Annuler
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: textA(0.85) }}>Annoter la photo</span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!ready || !hasActions || saving}
          style={{ ...saveButtonStyle, opacity: !ready || !hasActions || saving ? 0.4 : 1 }}
        >
          {saving ? 'Envoi…' : 'Enregistrer'}
        </button>
      </div>

      <div style={canvasWrapStyle}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', touchAction: 'none', borderRadius: 8 }}
        />
      </div>

      {pendingScreenPos && (
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
          style={{
            ...pendingTextInputStyle,
            left: pendingScreenPos.left,
            top: pendingScreenPos.top,
            color,
          }}
        />
      )}

      <div style={toolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={toolToggleStyle}>
            <button
              type="button"
              onClick={() => setTool('draw')}
              style={{ ...toolButtonStyle, ...(tool === 'draw' ? toolButtonActiveStyle : {}) }}
            >
              Dessin
            </button>
            <button
              type="button"
              onClick={() => setTool('text')}
              style={{ ...toolButtonStyle, ...(tool === 'text' ? toolButtonActiveStyle : {}) }}
            >
              Texte
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
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
        <div style={{ display: 'flex', gap: 14 }}>
          <button type="button" onClick={handleUndo} disabled={!hasActions} style={{ ...textButtonStyle, opacity: hasActions ? 1 : 0.4 }}>
            Annuler
          </button>
          <button type="button" onClick={handleClear} disabled={!hasActions} style={{ ...textButtonStyle, opacity: hasActions ? 1 : 0.4 }}>
            Tout effacer
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.94)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 1500,
};

const headerStyle: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 16px',
};

const canvasWrapStyle: React.CSSProperties = {
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
