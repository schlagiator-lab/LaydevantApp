import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { WebSearchContext } from '../lib/navigationContext';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { searchWebNotices } from '../lib/webSearch';
import { docTypeLabel } from '../lib/docType';
import type { WebSearchResult } from '../types/webSearch';
import { StatusPill } from '../components/StatusPill';
import { CaptureSheet } from '../components/CaptureSheet';
import { colors, fonts, textA } from '../styles/tokens';

const CONFIDENCE_LABELS: Record<WebSearchResult['confidence'], string> = {
  haute: 'Confiance haute',
  moyenne: 'Confiance moyenne',
  faible: 'Confiance faible',
};

/**
 * Mode "recherche web" (Feature recherche web notices.md, §4) : distinct de
 * la recherche interne, en ligne uniquement. Saisie marque + modèle → Edge
 * Function web-search-notices → liste courte triée, avec capture directe
 * vers la bibliothèque pour les résultats PDF (§5).
 */
export function WebSearchScreen({ context }: { context: WebSearchContext }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();

  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<WebSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captureTarget, setCaptureTarget] = useState<WebSearchResult | null>(null);

  const trimmedBrand = brand.trim();
  const trimmedModel = model.trim();
  const canSearch = isOnline && trimmedBrand.length > 0 && trimmedModel.length > 0 && !loading;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSearch) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const rows = await searchWebNotices({
        brand: trimmedBrand,
        model: trimmedModel,
        departmentName: context.departmentName,
        specialtyName: context.specialtyName,
        equipmentType,
      });
      setResults(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La recherche web a échoué.');
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = (result: WebSearchResult) => {
    window.open(result.url, '_blank', 'noopener');
  };

  const handleCaptured = () => {
    setCaptureTarget(null);
  };

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
      <div style={{ flex: 'none', padding: '14px 16px 10px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={nav.goBack} aria-label="Retour" style={backButtonStyle}>
              ‹
            </button>
            <span style={eyebrowStyle}>Recherche web</span>
          </div>
          <StatusPill online={isOnline} />
        </div>

        {!isOnline ? (
          <div style={offlineBannerStyle}>
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
              Connexion réseau requise pour la recherche web.
            </span>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                value={brand}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setBrand(e.target.value)}
                placeholder="Marque (ex. Hager)"
                style={{ ...inputStyle, flex: 1 }}
              />
              <input
                value={model}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setModel(e.target.value)}
                placeholder="Modèle (ex. TN225)"
                style={{ ...inputStyle, flex: 1 }}
              />
            </div>
            <input
              value={equipmentType}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEquipmentType(e.target.value)}
              placeholder="Type d'équipement (optionnel, ex. disjoncteur)"
              style={inputStyle}
            />
            <button type="submit" disabled={!canSearch} style={{ ...primaryButtonStyle, opacity: canSearch ? 1 : 0.5 }}>
              {loading ? 'Recherche en cours…' : 'Chercher sur le web'}
            </button>
          </form>
        )}
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '14px 16px 24px', boxSizing: 'border-box' }}
      >
        {loading && (
          <p style={{ fontSize: 14, color: textA(0.55), textAlign: 'center', marginTop: 40 }}>
            Recherche sur le web… quelques secondes.
          </p>
        )}

        {error && <p style={{ fontSize: 14, color: colors.accent }}>{error}</p>}

        {!loading && !error && results && results.length === 0 && (
          <div style={{ textAlign: 'center', padding: '50px 20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Aucune notice fiable trouvée</div>
            <div style={{ fontSize: 14, color: textA(0.6), lineHeight: 1.5 }}>
              Essayez une autre orthographe du modèle, ou saisissez la référence complète.
            </div>
          </div>
        )}

        {!loading && !error && results && results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {results.map((result, i) => (
              <div key={`${result.url}-${i}`} style={cardStyle}>
                <div style={{ fontSize: 13, color: textA(0.6), fontWeight: 600 }}>
                  {docTypeLabel(result.type)} · {result.source}
                </div>
                <div style={{ fontSize: 16.5, fontWeight: 700, lineHeight: 1.3 }}>{result.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 }}>
                  <span style={confidenceBadgeStyle(result.confidence)}>{CONFIDENCE_LABELS[result.confidence]}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={() => handleOpen(result)} style={smallSecondaryButtonStyle}>
                      {result.is_pdf ? 'Consulter' : 'Ouvrir'}
                    </button>
                    {result.is_pdf && (
                      <button type="button" onClick={() => setCaptureTarget(result)} style={smallPrimaryButtonStyle}>
                        Ajouter à la bibliothèque
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {captureTarget && (
        <CaptureSheet
          result={captureTarget}
          brand={trimmedBrand}
          model={trimmedModel}
          onClose={() => setCaptureTarget(null)}
          onCaptured={handleCaptured}
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

const offlineBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '9px 12px',
};

const inputStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: textA(0.08),
  color: colors.text,
  fontSize: 15,
  fontFamily: fonts.sans,
  padding: '0 14px',
  boxSizing: 'border-box',
  minWidth: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  background: colors.card,
  borderRadius: 14,
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

function confidenceBadgeStyle(confidence: WebSearchResult['confidence']): React.CSSProperties {
  const bg = confidence === 'haute' ? colors.success : confidence === 'moyenne' ? colors.accent : textA(0.25);
  return {
    fontSize: 11,
    fontWeight: 700,
    color: confidence === 'faible' ? colors.text : '#132146',
    background: bg,
    borderRadius: 100,
    padding: '4px 9px',
  };
}

const smallPrimaryButtonStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 10,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 13,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const smallSecondaryButtonStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 10,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 13,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};
