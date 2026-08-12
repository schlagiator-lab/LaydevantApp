import { useState, type ReactNode } from 'react';
import { colors, radius, textA } from '../styles/tokens';

export interface CollapsibleSectionProps {
  title: string;
  /** Compteur/état affiché à droite du titre, dans l'en-tête cliquable. */
  badge?: ReactNode;
  /** Élément d'action (ex. bouton "+ Ajouter"), à droite de l'en-tête, EN DEHORS
   * du bouton de bascule — reste cliquable/visible section repliée ou non. */
  action?: ReactNode;
  defaultOpen?: boolean;
  /** true : le contenu reste monté en permanence, masqué en CSS quand fermé
   * (préserve l'état interne des enfants). false (défaut) : démonté à la
   * fermeture. */
  keepMounted?: boolean;
  children: ReactNode;
}

/** Bloc de section repliable/dépliable, réutilisé par les 4 sections de la fiche dossier. */
export function CollapsibleSection({
  title,
  badge,
  action,
  defaultOpen = false,
  keepMounted = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section>
      <div style={headerRowStyle}>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={toggleButtonStyle}>
          <span style={titleRowStyle}>
            <span style={titleTextStyle}>{title}</span>
            {badge}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 20 20"
            aria-hidden="true"
            style={{ flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
          >
            <path d="M5 7.5l5 5 5-5" fill="none" stroke={textA(0.6)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {action && (
          <div onClick={(e) => e.stopPropagation()} style={{ flex: 'none' }}>
            {action}
          </div>
        )}
      </div>

      {keepMounted ? (
        <div style={{ display: open ? 'block' : 'none', marginTop: 10 }}>{children}</div>
      ) : (
        open && <div style={{ marginTop: 10 }}>{children}</div>
      )}
    </section>
  );
}

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const toggleButtonStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  background: colors.card,
  border: 'none',
  borderRadius: radius.lg,
  padding: '12px 14px',
  color: colors.text,
  fontFamily: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
};

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
};

const titleTextStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
