import { colors } from '../styles/tokens';

/** En-tête de section réutilisé par les fiches dossier (Équipements, Documentation, Carnet…). */
export function SectionHeader({ title, onAdd, addDisabled }: { title: string; onAdd: () => void; addDisabled: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      <button
        type="button"
        onClick={onAdd}
        disabled={addDisabled}
        style={{ ...addButtonStyle, opacity: addDisabled ? 0.4 : 1 }}
      >
        + Ajouter
      </button>
    </div>
  );
}

const addButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 32,
  borderRadius: 10,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};
