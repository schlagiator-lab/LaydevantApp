import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { WebSearchContext } from '../lib/navigationContext';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { searchWebNotices, WebSearchFailedError, WebSearchTimeoutError } from '../lib/webSearch';
import { docTypeLabel } from '../lib/docType';
import type { WebSearchResult } from '../types/webSearch';
import { StatusPill } from '../components/StatusPill';
import { CaptureSheet } from '../components/CaptureSheet';
import PdfTetris from '../components/PdfTetris';
import { colors, fonts, textA } from '../styles/tokens';

const CONFIDENCE_LABELS: Record<WebSearchResult['confidence'], string> = {
  haute: 'Confiance haute',
  moyenne: 'Confiance moyenne',
  faible: 'Confiance faible',
};

const PATIENCE_MESSAGES = [
  'On fouille tout le web, promis on ne lâche rien 🔌',
  "La notice se planque comme un electro sur un chantier… on la traque 🔦",
  'Surtout ne rafraîchissez pas la page : tout serait à refaire !',
  'On interroge les fabricants un par un, ça arrive…',
  'Patience, on déroule le web comme un touret de câble 🧵',
  "Presque : on vérifie que c'est bien le bon modèle.",
  'Toujours là ? Nous aussi. La recherche continue.',
  'Un instant, on met la main sur le bon PDF 📄',
  'On teste la continuité entre votre requête et le bon manuel ⚡',
  'Ça descend en gaine technique, ça remonte avec la doc 📡',
  "On cherche la notice du bon moteur de porte, pas d'un autre 🚪",
  'Encore quelques bornes à sonder et c\'est bon…',
  'Ne coupez pas le courant : la recherche est presque bouclée !',
  'On démêle les références comme un tableau mal repéré 🔧',
  "Le web est grand, votre notice y est quelque part. On approche.",
  'Merci de patienter, un rafraîchissement relancerait tout à zéro.',
];

/**
 * Mode "recherche web" (Feature recherche web notices.md, §4) : distinct de
 * la recherche interne, en ligne uniquement. Saisie marque + modèle → job
 * asynchrone `web_search_jobs` (polling, voir src/lib/webSearch.ts) → liste
 * courte triée, avec capture directe vers la bibliothèque pour les résultats
 * PDF (§5).
 */
export function WebSearchScreen({ context }: { context: WebSearchContext }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();

  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<WebSearchResult[] | null>(null);
  const [stillSearching, setStillSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureTarget, setCaptureTarget] = useState<WebSearchResult | null>(null);
  const [patienceIndex, setPatienceIndex] = useState(() =>
    Math.floor(Math.random() * PATIENCE_MESSAGES.length)
  );

  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => {
      setPatienceIndex((i) => (i + 1) % PATIENCE_MESSAGES.length);
    }, 7000);
    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    if (!loading) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [loading]);

  // Recherche asynchrone (job + polling, voir src/lib/webSearch.ts) : si le
  // monteur quitte l'écran en cours de recherche, on coupe le polling plutôt
  // que de le laisser tourner et mettre à jour un composant démonté.
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

  // Le plateau + son en-tête + l'indication de contrôles en dessous dépassent
  // souvent la hauteur visible : sans ce scroll, la partie basse (indication
  // de jeu) reste tronquée tant que l'utilisateur ne scrolle pas lui-même.
  // scrollIntoView (plutôt qu'un scrollTop sur un conteneur précis) trouve
  // tout seul l'ancêtre réellement scrollable — ici la page elle-même, #root
  // n'ayant qu'un min-height (global.css) et grandissant avec son contenu.
  const gameBottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!loading || results !== null) return;
    const el = gameBottomRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(raf);
  }, [loading, results]);

  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!loading) return;
    if (!('wakeLock' in navigator)) return;

    const requestWakeLock = async () => {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        wakeLockRef.current = null;
      }
    };
    void requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && loading && !wakeLockRef.current) {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      const sentinel = wakeLockRef.current;
      if (sentinel) {
        wakeLockRef.current = null;
        void sentinel.release();
      }
    };
  }, [loading]);

  const trimmedBrand = brand.trim();
  const trimmedModel = model.trim();
  const canSearch = isOnline && trimmedBrand.length > 0 && trimmedModel.length > 0 && !loading;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSearch) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setStillSearching(false);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const rows = await searchWebNotices(
        {
          brand: trimmedBrand,
          model: trimmedModel,
          departmentName: context.departmentName,
          specialtyName: context.specialtyName,
          equipmentType,
        },
        {
          signal: controller.signal,
          onUpdate: ({ results: partial, stillSearching: searching }) => {
            setResults(partial);
            setStillSearching(searching);
          },
        },
      );
      setResults(rows);
      setStillSearching(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return; // composant démonté pendant le polling : rien à mettre à jour
      }
      if (err instanceof WebSearchTimeoutError) {
        setError('La recherche a pris trop de temps, réessaie.');
      } else if (err instanceof WebSearchFailedError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'La recherche web a échoué.');
      }
      setStillSearching(false);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
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
        ) : loading ? (
          <div style={searchSummaryStyle}>
            <span style={{ color: textA(0.55) }}>On cherche : </span>
            <span style={{ color: colors.text, fontWeight: 600 }}>
              {trimmedBrand} · {trimmedModel}
              {equipmentType.trim() && ` · ${equipmentType.trim()}`}
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
        {loading && results === null && (
          <div style={{ marginTop: 40 }}>
            <div style={loadingBarTrackStyle}>
              <div style={loadingBarFillStyle} />
            </div>
            <p style={{ fontSize: 14, color: textA(0.55), textAlign: 'center', marginTop: 14 }}>
              Recherche sur le web… quelques secondes.
            </p>
            <p style={patienceMessageStyle}>{PATIENCE_MESSAGES[patienceIndex]}</p>
            <div ref={gameBottomRef} style={{ marginTop: 20 }}>
              <PdfTetris />
            </div>
          </div>
        )}

        {loading && results !== null && results.length === 0 && (
          <div style={{ marginTop: 40 }}>
            <p style={{ fontSize: 14, color: textA(0.55), textAlign: 'center', marginTop: 14 }}>
              Recherche sur le web… quelques secondes.
            </p>
            <p style={{ fontSize: 13, color: textA(0.45), textAlign: 'center', marginTop: 6 }}>
              {PATIENCE_MESSAGES[patienceIndex]}
            </p>
          </div>
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

        {!error && results && results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stillSearching && (
              <div style={offlineBannerStyle}>
                <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
                  Recherche en cours — d'autres notices peuvent encore arriver.
                </span>
              </div>
            )}
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

// Hauteur réservée pour 3 lignes (lineHeight explicite pour un calc lisible) :
// un message plus long qu'anticipé ou un écran étroit peut faire passer le
// texte sur 3 lignes ; sans ce plancher, chaque rotation (7 s) fait varier la
// hauteur du <p> et décale PdfTetris juste en dessous, dans le même flux.
const patienceMessageStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.4,
  color: textA(0.45),
  textAlign: 'center',
  marginTop: 6,
  minHeight: 'calc(1.4em * 3)',
};

const searchSummaryStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 4,
  background: textA(0.06),
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 13.5,
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

const loadingBarTrackStyle: React.CSSProperties = {
  position: 'relative',
  height: 4,
  borderRadius: 100,
  background: textA(0.1),
  overflow: 'hidden',
  maxWidth: 220,
  margin: '0 auto',
};

const loadingBarFillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '28%',
  borderRadius: 100,
  background: colors.accent,
  animation: 'web-search-loading 1.1s ease-in-out infinite',
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
