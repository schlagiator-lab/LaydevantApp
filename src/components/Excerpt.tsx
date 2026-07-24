/**
 * Renders a sanitizeHeadline() output. Highlighting is color+weight only —
 * no margin/padding/letter-spacing on <b> (CLAUDE.md §6): the break can land
 * inside a compound word (`<b>pare</b>-feu`) and any spacing would split it
 * visibly. The `.excerpt b` rule lives in styles/global.css.
 */
export function Excerpt({ html }: { html: string }) {
  return <span className="excerpt" dangerouslySetInnerHTML={{ __html: html }} />;
}
