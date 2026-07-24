/**
 * Mandatory treatment for search excerpts (CLAUDE.md §6). `content` comes
 * from uploaded PDFs and can contain anything, including tags; `ts_headline`
 * (online) returns unescaped HTML. The 3-step process below is the only
 * thing that makes it safe to inject:
 *
 *  1. Escape ALL HTML in the raw string (this also escapes ts_headline's own
 *     real <b> tags, or any lookalike coincidentally present in the source
 *     text).
 *  2. Restore *only* the literal &lt;b&gt; / &lt;/b&gt; substrings back to
 *     <b> / </b>. A plain string replace of a fixed substring can't be
 *     coerced into emitting attributes or any other tag, so the result can
 *     only ever contain bare <b>/</b> around otherwise fully-inert text.
 *  3. Only then is it safe to inject.
 *
 * The offline (MiniSearch) excerpt builder in offlineSearch.ts reuses this
 * same function so both engines render through one code path — CLAUDE.md's
 * "visuellement identiques" requirement holds by construction, not by
 * coincidence.
 */
export function sanitizeHeadline(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped.replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
}
