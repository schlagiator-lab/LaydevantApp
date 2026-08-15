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

export type AnnotationObject = AnnotationPath | AnnotationText;

export type PhotoAnnotations = {
  v: typeof ANNOTATIONS_VERSION;
  objects: AnnotationObject[];
};

export function emptyAnnotations(): PhotoAnnotations {
  return { v: ANNOTATIONS_VERSION, objects: [] };
}
