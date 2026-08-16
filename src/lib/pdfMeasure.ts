/**
 * Mesure la résolution des images embarquées dans un PDF sans jamais décoder
 * l'image elle-même — nécessaire sur iOS où décoder une image PDF de
 * plusieurs centaines de mégapixels (PDF-image issu d'un scan) tue le
 * process WebKit (mémoire plafonnée), y compris avant tout rendu pdf.js.
 * Voir CLAUDE.md / PlansSection pour le contexte (plan Zhukov, 13141x9420).
 */

const SCAN_WINDOW = 1000;

/**
 * Renvoie le nombre de mégapixels de la plus grande image `/Subtype /Image`
 * trouvée dans les octets bruts du PDF (recherche textuelle latin1, aucun
 * décodage d'image), ou 0 si aucune image détectée.
 */
export function pdfImageMegapixels(bytes: ArrayBuffer | Uint8Array): number {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = new TextDecoder('latin1').decode(buf);

  const subtypeRe = /\/Subtype\s*\/Image\b/g;
  let maxMegapixels = 0;
  let match: RegExpExecArray | null;

  while ((match = subtypeRe.exec(text)) !== null) {
    const windowStart = Math.max(0, match.index - SCAN_WINDOW);
    const windowEnd = Math.min(text.length, match.index + match[0].length + SCAN_WINDOW);
    const window = text.slice(windowStart, windowEnd);

    const widthMatch = /\/Width\s+(\d+)/.exec(window);
    const heightMatch = /\/Height\s+(\d+)/.exec(window);
    if (!widthMatch || !heightMatch) continue;

    const width = parseInt(widthMatch[1], 10);
    const height = parseInt(heightMatch[1], 10);
    const megapixels = (width * height) / 1e6;
    if (megapixels > maxMegapixels) maxMegapixels = megapixels;
  }

  return maxMegapixels;
}

/**
 * Détection iOS (iPhone/iPad, y compris iPadOS moderne qui se présente en
 * MacIntel) — aucune autre branche de l'app n'en a besoin aujourd'hui, d'où
 * l'absence de helper de plateforme partagé jusqu'ici.
 */
export function isIosDevice(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
