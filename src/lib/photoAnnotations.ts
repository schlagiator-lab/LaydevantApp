// Calque d'annotations vectorielles d'une photo (non destructif).
// La photo originale n'est jamais modifiée : ce calque se superpose à elle.
//
// CONVENTION DE NORMALISATION (contrat partagé par tous les moteurs de rendu —
// éditeur SVG, rendu lecture SVG, export canvas). Ne pas dévier :
//   - positions (x, y, points) : normalisées 0..1 relativement à l'image.
//       rendu : x * largeurImage, y * hauteurImage.
//   - grandeurs scalaires (width d'un trait, size d'un texte) : normalisées
//       en fraction de la PLUS PETITE dimension de l'image, min(largeur,hauteur).
//       rendu : valeur * min(largeurImage, hauteurImage).
//   Cette référence unique garantit un rendu isotrope et identique à l'écran
//   comme à l'export, quelle que soit la taille d'affichage.

export const ANNOTATIONS_VERSION = 1 as const;

export type AnnotationPath = {
  type: 'path';
  id?: string;                    // id stable pour la sélection / le React key
  color: string;                  // couleur CSS (ex. '#e11')
  width: number;                  // épaisseur, fraction de min(largeur,hauteur)
  points: [number, number][];     // suite de points, chacun normalisé 0..1
};

export type AnnotationText = {
  type: 'text';
  id?: string;
  color: string;
  size: number;                   // corps, fraction de min(largeur,hauteur)
  x: number;                      // 0..1
  y: number;                      // 0..1
  text: string;
  anchor?: 'start' | 'middle' | 'end';  // défaut 'start'
};

export type AnnotationArrow = {
  type: 'arrow';
  id?: string;
  color: string;
  width: number;              // épaisseur, fraction de min(l,h)
  x1: number; y1: number;     // départ, 0..1
  x2: number; y2: number;     // pointe (tête de flèche ici), 0..1
};

export type AnnotationShape = {
  type: 'shape';
  id?: string;
  shape: 'rect' | 'ellipse';
  color: string;
  width: number;              // épaisseur du trait, fraction de min(l,h)
  x: number; y: number;       // coin haut-gauche du cadre englobant, 0..1
  w: number; h: number;       // largeur/hauteur du cadre, 0..1
};

export type AnnotationObject = AnnotationPath | AnnotationText | AnnotationArrow | AnnotationShape;

export type PhotoAnnotations = {
  v: typeof ANNOTATIONS_VERSION;
  objects: AnnotationObject[];
};

export function emptyAnnotations(): PhotoAnnotations {
  return { v: ANNOTATIONS_VERSION, objects: [] };
}

export const DEFAULT_COLOR = '#e11d1d';
export const PALETTE = ['#e11d1d', '#111111', '#f5c400', '#16a34a']; // rouge, noir, jaune, vert
export const DEFAULT_STROKE_WIDTH = 0.006; // fraction de min(l,h)
export const DEFAULT_TEXT_SIZE = 0.05;     // fraction de min(l,h)

// Helpers de géométrie PURS (contrat partagé éditeur/lecture/export) — ne pas
// dupliquer cette conversion normalisé<->pixel ailleurs.

export function makeId(): string {
  return crypto.randomUUID();
}

export function denormPoint(p: [number, number], w: number, h: number): [number, number] {
  return [p[0] * w, p[1] * h];
}

export function normPoint(px: number, py: number, w: number, h: number): [number, number] {
  return [px / w, py / h];
}

export function denormScalar(v: number, w: number, h: number): number {
  return v * Math.min(w, h);
}

export function normScalar(v: number, w: number, h: number): number {
  return v / Math.min(w, h);
}

export function pointsToSvgD(points: [number, number][], w: number, h: number): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  const [fx, fy] = denormPoint(first, w, h);
  let d = `M ${fx} ${fy}`;
  for (const p of rest) {
    const [x, y] = denormPoint(p, w, h);
    d += ` L ${x} ${y}`;
  }
  return d;
}

// Géométrie de la tête de flèche — UNE seule définition, partagée par le
// rendu SVG (AnnotationOverlay) et l'export canvas (renderAnnotatedImage) ci-
// dessous, pour qu'ils ne puissent jamais diverger.
export const ARROW_HEAD_ANGLE = Math.PI / 7;

/** Longueur de la tête de flèche, en pixels dénormalisés (déjà à l'échelle de strokeWidthPx). */
export function arrowHeadLength(strokeWidthPx: number, w: number, h: number): number {
  return Math.max(strokeWidthPx * 4, denormScalar(0.02, w, h));
}

export function arrowHeadPoints(
  x2: number,
  y2: number,
  angle: number,
  headLen: number
): { hx1: number; hy1: number; hx2: number; hy2: number } {
  return {
    hx1: x2 - headLen * Math.cos(angle - ARROW_HEAD_ANGLE),
    hy1: y2 - headLen * Math.sin(angle - ARROW_HEAD_ANGLE),
    hx2: x2 - headLen * Math.cos(angle + ARROW_HEAD_ANGLE),
    hy2: y2 - headLen * Math.sin(angle + ARROW_HEAD_ANGLE),
  };
}

/** Mappe l'ancrage SVG (textAnchor) vers son équivalent canvas (textAlign) — seul le canvas en a besoin, le SVG utilise directement la même union de valeurs. */
function textAnchorToCanvasAlign(anchor: 'start' | 'middle' | 'end' | undefined): CanvasTextAlign {
  if (anchor === 'middle') return 'center';
  if (anchor === 'end') return 'right';
  return 'left';
}

function drawAnnotationObject(ctx: CanvasRenderingContext2D, obj: AnnotationObject, w: number, h: number): void {
  switch (obj.type) {
    case 'path': {
      if (obj.points.length === 0) break;
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = denormScalar(obj.width, w, h);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const [fx, fy] = denormPoint(obj.points[0], w, h);
      ctx.moveTo(fx, fy);
      for (const p of obj.points.slice(1)) {
        const [x, y] = denormPoint(p, w, h);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.fillStyle = obj.color;
      ctx.font = `${denormScalar(obj.size, w, h)}px system-ui, -apple-system, Arial, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = textAnchorToCanvasAlign(obj.anchor);
      ctx.fillText(obj.text, obj.x * w, obj.y * h);
      break;
    }
    case 'arrow': {
      const x1 = obj.x1 * w;
      const y1 = obj.y1 * h;
      const x2 = obj.x2 * w;
      const y2 = obj.y2 * h;
      const strokeW = denormScalar(obj.width, w, h);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = arrowHeadLength(strokeW, w, h);
      const { hx1, hy1, hx2, hy2 } = arrowHeadPoints(x2, y2, angle, headLen);
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = strokeW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(hx1, hy1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(hx2, hy2);
      ctx.stroke();
      break;
    }
    case 'shape': {
      const x = obj.x * w;
      const y = obj.y * h;
      const bw = obj.w * w;
      const bh = obj.h * h;
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = denormScalar(obj.width, w, h);
      if (obj.shape === 'rect') {
        ctx.strokeRect(x, y, bw, bh);
      } else {
        ctx.beginPath();
        ctx.ellipse(x + bw / 2, y + bh / 2, Math.abs(bw) / 2, Math.abs(bh) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

/** Charge un HTMLImageElement frais depuis un object URL local (blob same-origin, jamais réseau) et attend son onload — le CanvasImageSource requis par renderAnnotatedImage. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Chargement de la photo échoué.'));
    img.src = src;
  });
}

/**
 * Cuit la photo + le calque en un JPEG (ou autre mimeType), aux dimensions
 * NATIVES de l'image (`width`/`height` — jamais la taille d'affichage), pour
 * un export plein résolution. Fonction PURE : aucune UI, aucun accès réseau,
 * aucune écriture — l'appelant fournit un `imageSource` déjà chargé (ex. un
 * HTMLImageElement dont `.src` pointe vers un blob local same-origin) et
 * récupère un Blob éphémère, jamais stocké ici.
 *
 * IMPORTANT anti-taint : ne JAMAIS passer une image chargée depuis une URL
 * réseau distante (canvas taint → `toBlob` échoue) — seulement un blob local
 * same-origin déjà résolu par l'appelant.
 */
export async function renderAnnotatedImage(
  imageSource: CanvasImageSource,
  width: number,
  height: number,
  annotations: PhotoAnnotations | null,
  mimeType = 'image/jpeg',
  quality = 0.9
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Contexte canvas indisponible.');

  ctx.drawImage(imageSource, 0, 0, width, height);

  if (annotations) {
    for (const obj of annotations.objects) {
      drawAnnotationObject(ctx, obj, width, height);
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Rendu de l’export échoué.'))), mimeType, quality);
  });
}
