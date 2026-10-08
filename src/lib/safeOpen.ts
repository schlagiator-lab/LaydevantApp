// Ouverture sûre des contenus non fiables (SECURITY_AUDIT.md E1 et M1).
//
// Un blob ouvert via une URL `blob:` hérite de l'origine de l'app : un type
// `text/html` ou `image/svg+xml` venu des données (choisi par l'uploadeur, ou
// écrit par n8n) y exécuterait du script avec accès à la session Supabase.
// Une URL externe venue des données (juge LLM de la recherche web, source
// fabricant) peut porter un schéma `javascript:`/`data:`.

const OPENABLE_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Valeur de l'attribut `accept` des champs de fichier alignée sur la liste blanche. */
export const OPENABLE_ACCEPT = [...OPENABLE_MIMES].join(',');

function normalizeMime(declared: string | null | undefined): string {
  return (declared ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Type à donner à tout Blob construit ou rouvert à partir d'un type stocké.
 * Liste blanche stricte : tout le reste (SVG, HTML, texte, vide, inconnu)
 * devient `application/octet-stream`, un téléchargement inerte que le
 * navigateur n'exécute jamais.
 */
export function safeMimeForOpen(declared: string | null | undefined): string {
  const mime = normalizeMime(declared);
  return OPENABLE_MIMES.has(mime) ? mime : 'application/octet-stream';
}

/** Contrôle côté envoi (défense supplémentaire, le verrou réel est à la lecture). */
export function isOpenableMime(declared: string | null | undefined): boolean {
  return OPENABLE_MIMES.has(normalizeMime(declared));
}

/** Re-type un Blob avec `safeMimeForOpen` (même blob si déjà conforme). */
export function withSafeMime(blob: Blob, declared: string | null | undefined): Blob {
  const mime = safeMimeForOpen(declared);
  return blob.type === mime ? blob : new Blob([blob], { type: mime });
}

/** L'URL (normalisée) si elle est absolue et en `http:`/`https:`, sinon `null` (ne pas en faire un lien). */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
