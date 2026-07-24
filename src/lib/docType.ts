import type { DocType } from '../types/database';

const LABELS: Record<DocType, string> = {
  notice_installation: "Notice d'installation",
  manuel_programmation: 'Manuel de programmation',
  fiche_technique: 'Fiche technique',
  schema: 'Schéma',
  fiche_perso: 'Fiche perso',
  autre: 'Autre',
};

export function docTypeLabel(docType: DocType): string {
  return LABELS[docType];
}
