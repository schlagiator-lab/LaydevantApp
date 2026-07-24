import { fonts, textA } from '../styles/tokens';

export function SearchBarButton({
  placeholder = 'Rechercher une référence, une notice…',
  onClick,
}: {
  placeholder?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: textA(0.08),
        border: 'none',
        borderRadius: 14,
        padding: '0 14px',
        height: 52,
        color: textA(0.55),
        fontSize: 16,
        fontFamily: fonts.sans,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" style={{ flex: 'none' }} aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="6.5" fill="none" stroke={textA(0.6)} strokeWidth="2" />
        <line x1="13.2" y1="13.2" x2="18" y2="18" stroke={textA(0.6)} strokeWidth="2" strokeLinecap="round" />
      </svg>
      {placeholder}
    </button>
  );
}
