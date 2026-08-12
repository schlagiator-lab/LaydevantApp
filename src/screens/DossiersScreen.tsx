import { useEffect, useState, type ChangeEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { searchDossiers } from '../lib/dossiers';
import type { SearchDossiersResult } from '../types/database';
import { StatusPill } from '../components/StatusPill';
import { DossierFormSheet } from '../components/DossierFormSheet';
import { colors, fonts, textA } from '../styles/tokens';

/**
 * Liste des dossiers clients (brief dossiers clients, étape A). Tout est en
 * ligne pour cette étape — pas de repli hors ligne, juste un état bloqué
 * avec message explicite, à l'image de l'écran Recherche web.
 */
export function DossiersScreen() {
  const { isOnline } = useAuth();
  const nav = useNavigation();

  const [query, setQuery] = useState('');
  const [dossiers, setDossiers] = useState<SearchDossiersResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isOnline) {
        setDossiers(null);
        return;
      }
      setError(null);
      try {
        const rows = await searchDossiers(query.trim());
        if (!cancelled) setDossiers(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, isOnline]);

  const loading = isOnline && dossiers === null && !error;
  const showEmpty = dossiers !== null && dossiers.length === 0;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
      }}
    >
      <div style={{ flex: 'none', padding: '14px 16px 12px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={nav.goHome} aria-label="Retour" style={backButtonStyle}>
              ‹
            </button>
            <span style={eyebrowStyle}>Dossiers clients</span>
          </div>
          <StatusPill online={isOnline} />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: textA(0.08),
            borderRadius: 14,
            padding: '0 14px',
            height: 52,
            boxSizing: 'border-box',
            marginBottom: 10,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" style={{ flex: 'none' }} aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="6.5" fill="none" stroke={textA(0.6)} strokeWidth="2" />
            <line x1="13.2" y1="13.2" x2="18" y2="18" stroke={textA(0.6)} strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            placeholder="Nom du client, adresse..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: colors.text,
              fontSize: 17,
              fontFamily: fonts.sans,
              minWidth: 0,
            }}
          />
        </div>

        <button type="button" onClick={() => setShowForm(true)} style={primaryButtonStyle}>
          + Nouveau dossier
        </button>

        {!isOnline && (
          <div style={offlineBannerStyle}>
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
              Connexion réseau requise pour consulter les dossiers clients.
            </span>
          </div>
        )}
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '14px 16px 24px', boxSizing: 'border-box' }}
      >
        {error && <p style={{ fontSize: 14, color: colors.accent }}>Erreur : {error}</p>}

        {!error && loading && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 40 }}>Chargement…</p>
        )}

        {!error && showEmpty && (
          <div style={{ textAlign: 'center', padding: '60px 20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>
              {query.trim() ? `Aucun dossier pour « ${query.trim()} »` : 'Aucun dossier pour le moment'}
            </div>
            <div style={{ fontSize: 14, color: textA(0.6), lineHeight: 1.5 }}>
              Créez un dossier pour retrouver rapidement les équipements et documents d'un site.
            </div>
          </div>
        )}

        {!error && dossiers && dossiers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {dossiers.map((dossier) => (
              <div
                key={dossier.id}
                onClick={() => nav.goDossier(dossier.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') nav.goDossier(dossier.id);
                }}
                style={{
                  background: colors.card,
                  borderRadius: 14,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                  width: '100%',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: colors.text }}>{dossier.nom_client}</div>
                    {dossier.adresse && (
                      <div style={{ fontSize: 13.5, color: textA(0.65), fontWeight: 500, marginTop: 2 }}>{dossier.adresse}</div>
                    )}
                  </div>
                  {dossier.notes && <div style={noteBadgeStyle}>{dossier.notes}</div>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
                  <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <DossierFormSheet
          onClose={() => setShowForm(false)}
          onCreated={(dossier) => {
            setShowForm(false);
            nav.goDossier(dossier.id);
          }}
        />
      )}
    </div>
  );
}

const backButtonStyle: React.CSSProperties = {
  flex: 'none',
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: textA(0.1),
  border: 'none',
  color: colors.text,
  fontSize: 17,
  cursor: 'pointer',
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: textA(0.55),
};

const noteBadgeStyle: React.CSSProperties = {
  flex: 'none',
  maxWidth: 120,
  fontSize: 12,
  fontWeight: 600,
  color: colors.accent,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.35)',
  borderRadius: 100,
  padding: '5px 10px',
  lineHeight: 1.3,
  textAlign: 'right',
  overflowWrap: 'break-word',
};

const offlineBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 10,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '9px 12px',
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
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
