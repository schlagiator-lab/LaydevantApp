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
export const PALETTE = ['#e11d1d', '#111111', '#f5c400']; // rouge, noir, jaune
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
