import { colors, fonts, textA } from '../styles/tokens';

export interface ConfirmSheetProps {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Rouge plutôt que l'accent par défaut — réservé aux actions les plus destructives. */
  danger?: boolean;
  /** Désactive les deux boutons et atténue "Confirmer" — appel en cours (le
   * texte du bouton, lui, vient de `confirmLabel` : l'appelant y met déjà
   * l'état de chargement, ex. "Promotion…"). */
  confirmDisabled?: boolean;
  /** Zone de contenu optionnelle entre le message et les boutons — champs
   * éditables pré-remplis pour une confirmation qui n'est pas qu'une
   * suppression (ex. titre + type de document avant promotion). */
  children?: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Feuille de confirmation générique avant une action à confirmer — un clic seul ne doit jamais suffire. */
export function ConfirmSheet({
  title,
  message,
  confirmLabel = 'Retirer',
  danger = false,
  confirmDisabled = false,
  children,
  onCancel,
  onConfirm,
}: ConfirmSheetProps) {
  return (
    <div onClick={onCancel} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} style={sheetStyle}>
        <div style={grabberStyle} />
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{title}</div>
        <p style={{ fontSize: 14, color: textA(0.65), lineHeight: 1.5, marginBottom: children ? 14 : 20 }}>{message}</p>
        {children && <div style={{ marginBottom: 20 }}>{children}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onCancel} disabled={confirmDisabled} style={cancelButtonStyle}>
            Annuler
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            style={{
              ...(danger ? dangerConfirmButtonStyle : confirmButtonStyle),
              opacity: confirmDisabled ? 0.6 : 1,
              cursor: confirmDisabled ? 'default' : 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'flex-end',
  zIndex: 1300,
};

const sheetStyle: React.CSSProperties = {
  width: '100%',
  background: colors.bg,
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
  padding: '18px 16px 24px',
  boxSizing: 'border-box',
  fontFamily: fonts.sans,
  color: colors.text,
};

const grabberStyle: React.CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 2,
  background: textA(0.25),
  margin: '0 auto 16px',
};

const cancelButtonStyle: React.CSSProperties = {
  flex: 1,
  height: 48,
  borderRadius: 12,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  boxSizing: 'border-box',
};

const confirmButtonStyle: React.CSSProperties = {
  flex: 1,
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
  boxSizing: 'border-box',
};

const dangerConfirmButtonStyle: React.CSSProperties = {
  ...confirmButtonStyle,
  background: '#D14343',
  color: '#FFFFFF',
};
