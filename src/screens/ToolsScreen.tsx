import { useNavigation } from '../lib/useNavigation';
import { departmentBadge } from '../lib/departmentStyle';
import { colors, fonts, textA } from '../styles/tokens';

/**
 * Sous-menu "Outils" — regroupe des accès secondaires auparavant listés en
 * petits liens sous le logo de l'accueil : diagnostic stockage et
 * enrôlement au coffre. Les deux fonctionnalités sont strictement
 * inchangées, seul leur point d'accès est déplacé ici.
 */
export function ToolsScreen() {
  const nav = useNavigation();

  const items = [
    { key: 'diagnostic', label: 'Diagnostic stockage', letter: 'D', onClick: nav.goDiagnostic },
    { key: 'vaultEnroll', label: 'Coffre (enrôlement)', letter: 'C', onClick: nav.goVaultEnroll },
  ];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        padding: 16,
        gap: 16,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={nav.goBack}
          aria-label="Retour"
          style={{
            flex: 'none',
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: textA(0.1),
            border: 'none',
            color: colors.text,
            fontSize: 17,
            cursor: 'pointer',
          }}
        >
          ‹
        </button>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Outils</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, index) => {
          const badge = departmentBadge(index);
          return (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                minHeight: 64,
                flex: 'none',
                background: colors.card,
                border: 'none',
                borderRadius: 14,
                padding: '0 16px',
                cursor: 'pointer',
                textAlign: 'left',
                boxSizing: 'border-box',
              }}
            >
              <span
                style={{
                  flex: 'none',
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: fonts.mono,
                  fontWeight: 700,
                  fontSize: 16,
                  background: badge.bg,
                  color: badge.color,
                }}
              >
                {item.letter}
              </span>
              <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: colors.text }}>{item.label}</span>
              <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
