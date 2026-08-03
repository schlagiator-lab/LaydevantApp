import { useEffect, useRef, useState } from 'react';
import { uploadDossierPhoto } from '../lib/dossiers';
import { useToast } from '../lib/useToast';
import { colors, textA } from '../styles/tokens';

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  color: string;
  points: Point[];
}

const PALETTE = ['#E8433A', '#F2E9A8', '#3AA6E8'] as const;

export interface PhotoAnnotatorProps {
  photoUrl: string;
  dossierId: string;
  auteur: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Dessin libre par-dessus une photo existante (fléchage/repérage sur
 * chantier). N'écrase jamais l'original : l'aplat est toujours envoyé comme
 * une NOUVELLE photo du dossier, via le même pipeline d'upload que la prise
 * de vue directe.
 */
export function PhotoAnnotator({ photoUrl, dossierId, auteur, onClose, onSaved }: PhotoAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [ready, setReady] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const lineWidth = Math.max(4, canvas.width / 180);
    const allStrokes = drawingRef.current ? [...strokesRef.current, drawingRef.current] : strokesRef.current;
    for (const stroke of allStrokes) {
      if (stroke.points.length === 0) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (const point of stroke.points.slice(1)) {
        ctx.lineTo(point.x, point.y);
      }
      // Point isolé (tap sans glisser) : dessine un petit point visible.
      if (stroke.points.length === 1) {
        ctx.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01);
      }
      ctx.stroke();
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
    if (!ready) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = { color, points: [pointFromEvent(e)] };
    redraw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current.points.push(pointFromEvent(e));
    redraw();
  };

  const finishStroke = () => {
    if (!drawingRef.current) return;
    strokesRef.current = [...strokesRef.current, drawingRef.current];
    drawingRef.current = null;
    setHasStrokes(strokesRef.current.length > 0);
    redraw();
  };

  const handleUndo = () => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setHasStrokes(strokesRef.current.length > 0);
    redraw();
  };

  const handleClear = () => {
    strokesRef.current = [];
    setHasStrokes(false);
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
          disabled={!ready || !hasStrokes || saving}
          style={{ ...saveButtonStyle, opacity: !ready || !hasStrokes || saving ? 0.4 : 1 }}
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

      <div style={toolbarStyle}>
        <div style={{ display: 'flex', gap: 10 }}>
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Couleur ${c}`}
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: c,
                border: color === c ? `2px solid ${colors.text}` : '2px solid transparent',
                boxShadow: color === c ? '0 0 0 2px rgba(0,0,0,0.4)' : 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          <button type="button" onClick={handleUndo} disabled={!hasStrokes} style={{ ...textButtonStyle, opacity: hasStrokes ? 1 : 0.4 }}>
            Annuler le trait
          </button>
          <button type="button" onClick={handleClear} disabled={!hasStrokes} style={{ ...textButtonStyle, opacity: hasStrokes ? 1 : 0.4 }}>
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
