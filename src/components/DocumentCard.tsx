import type { DocType } from '../types/database';
import { docTypeLabel } from '../lib/docType';
import { Excerpt } from './Excerpt';
import { colors, fonts, textA } from '../styles/tokens';

export interface DocumentCardProps {
  title: string;
  docType: DocType;
  specialtyName: string;
  /** JetBrains Mono badge next to the title (product model/brand) — null hides it. */
  productLabel: string | null;
  /** Sanitized excerpt HTML (search mode) — null renders the compact browse-mode card. */
  excerptHtml: string | null;
  pinned: boolean;
  dim: boolean;
  onTap: () => void;
}

export function DocumentCard({
  title,
  docType,
  specialtyName,
  productLabel,
  excerptHtml,
  pinned,
  dim,
  onTap,
}: DocumentCardProps) {
  return (
    <div
      onClick={onTap}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onTap();
      }}
      style={{
        background: colors.card,
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
        opacity: dim ? 0.55 : 1,
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: colors.text, lineHeight: 1.25 }}>{title}</span>
        {productLabel && (
          <span
            style={{
              flex: 'none',
              fontFamily: fonts.mono,
              fontSize: 13,
              fontWeight: 700,
              color: colors.text,
              background: textA(0.1),
              borderRadius: 6,
              padding: '3px 7px',
            }}
          >
            {productLabel}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, color: textA(0.6), fontWeight: 500 }}>
        {docTypeLabel(docType)} · {specialtyName}
      </div>

      {excerptHtml !== null && (
        <div style={{ fontSize: 14.5, lineHeight: 1.5, color: textA(0.85), wordBreak: 'break-word' }}>
          <Excerpt html={excerptHtml} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: '#132146',
            background: pinned ? colors.success : colors.accent,
            borderRadius: 100,
            padding: '5px 10px',
          }}
        >
          {pinned ? 'Disponible hors ligne' : 'Nécessite du réseau'}
        </span>
        <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
      </div>
    </div>
  );
}
