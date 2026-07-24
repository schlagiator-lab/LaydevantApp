import { colors } from '../styles/tokens';

/**
 * Online/offline indicator. The mockup renders this as a clickable button
 * that toggles a fake demo state — here connectivity is real (navigator.onLine
 * via useOnlineStatus), so there's nothing to toggle; it's a status readout.
 */
export function StatusPill({ online }: { online: boolean }) {
  return (
    <span
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 100,
        padding: '6px 12px 6px 10px',
        background: online ? colors.success : colors.accent,
        color: '#132146',
        fontWeight: 700,
        fontSize: 12,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#132146' }} />
      {online ? 'En ligne' : 'Hors ligne'}
    </span>
  );
}
