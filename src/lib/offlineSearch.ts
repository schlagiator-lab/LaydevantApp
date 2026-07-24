import MiniSearch from 'minisearch';
import type { DocumentRow } from '../types/database';
import { sanitizeHeadline } from './excerpt';

const EXCERPT_CONTEXT_CHARS = 60;

/**
 * Index built on-demand over the currently pinned documents (CLAUDE.md §4).
 * Pinned counts are small (a technician's own device cache), so rebuilding
 * per search is cheap — no need for the incremental-update complexity of
 * keeping a persistent index in sync with pin/unpin.
 */
export function buildOfflineIndex(docs: DocumentRow[]): MiniSearch<DocumentRow> {
  const index = new MiniSearch<DocumentRow>({
    fields: ['title', 'content'],
    storeFields: ['id'],
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2 } },
  });
  index.addAll(docs.map((d) => ({ ...d, content: d.content ?? '' })));
  return index;
}

export function searchOfflineIds(index: MiniSearch<DocumentRow>, query: string): string[] {
  if (!query.trim()) return [];
  return index.search(query).map((result) => String(result.id));
}

/**
 * Builds a ts_headline-style snippet ("…before <b>match</b> after…") from a
 * plain-text field, then runs it through the exact same sanitizeHeadline()
 * used for the online RPC's `extrait` — so both engines render through one
 * code path and are guaranteed visually identical, not just similar.
 *
 * This is a simple case-insensitive substring match, not real stemming/text
 * search like Postgres' ts_headline — good enough for "does the query term
 * appear here", which is all an offline fallback needs.
 */
export function buildOfflineExcerptHtml(content: string, query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();

  let matchIndex = -1;
  let matchLen = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1) {
      matchIndex = idx;
      matchLen = term.length;
      break;
    }
  }

  if (matchIndex === -1) {
    const snippet = content.slice(0, EXCERPT_CONTEXT_CHARS * 2).trim();
    const suffix = content.length > EXCERPT_CONTEXT_CHARS * 2 ? '…' : '';
    return sanitizeHeadline(snippet + suffix);
  }

  const start = Math.max(0, matchIndex - EXCERPT_CONTEXT_CHARS);
  const end = Math.min(content.length, matchIndex + matchLen + EXCERPT_CONTEXT_CHARS);
  const before = content.slice(start, matchIndex);
  const match = content.slice(matchIndex, matchIndex + matchLen);
  const after = content.slice(matchIndex + matchLen, end);
  const raw =
    (start > 0 ? '…' : '') + before + '<b>' + match + '</b>' + after + (end < content.length ? '…' : '');
  return sanitizeHeadline(raw);
}
