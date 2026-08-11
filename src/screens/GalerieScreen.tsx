import { useEffect, useMemo, useRef, useState } from 'react';
import type { GalerieItem, Specialty } from '../types/database';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { listGalerieItems } from '../lib/galerie';
import { getPhotoObjectUrl } from '../lib/dossiers';
import { StatusPill } from '../components/StatusPill';
import { colors, fonts, textA } from '../styles/tokens';

/** Insensible à la casse et aux accents ("télécommande" ~ "telecommande"). */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

interface Viewer {
  item: GalerieItem;
  index: number;
}

const SWIPE_THRESHOLD = 40;

export function GalerieScreen({ specialty }: { specialty: Specialty }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();

  const [items, setItems] = useState<GalerieItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerUrls, setViewerUrls] = useState<Record<string, string>>({});
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setItems(null);
      setLoadError(null);
      try {
        const rows = await listGalerieItems(specialty.id);
        if (!cancelled) setItems(rows);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [specialty.id]);

  // Vignette = 1re photo de chaque item. Même pattern que CarnetSection :
  // chargement séquentiel des object URLs, révocation au démontage / changement.
  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    if (items) {
      void (async () => {
        setThumbUrls({});
        for (const item of items) {
          const first = item.photos[0];
          if (!first) continue;
          try {
            const url = await getPhotoObjectUrl(first.storage_key);
            if (cancelled) {
              URL.revokeObjectURL(url);
              continue;
            }
            urls[item.id] = url;
            setThumbUrls((prev) => ({ ...prev, [item.id]: url }));
          } catch {
            // Vignette individuelle indisponible : le reste de la grille s'affiche quand même.
          }
        }
      })();
    }
    return () => {
      cancelled = true;
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [items]);

  // Photos de l'item ouvert dans le visualiseur — chargées à l'ouverture,
  // révoquées à la fermeture ou au changement d'item (pas au simple
  // changement d'index : `viewer?.item` reste la même référence entre deux
  // photos du même item, seul `viewer.index` bouge).
  useEffect(() => {
    const item = viewer?.item;
    let cancelled = false;
    const urls: Record<string, string> = {};
    if (item) {
      void (async () => {
        setViewerUrls({});
        for (const photo of item.photos) {
          try {
            const url = await getPhotoObjectUrl(photo.storage_key);
            if (cancelled) {
              URL.revokeObjectURL(url);
              continue;
            }
            urls[photo.id] = url;
            setViewerUrls((prev) => ({ ...prev, [photo.id]: url }));
          } catch {
            // Photo individuelle indisponible : la navigation reste possible sur les autres.
          }
        }
      })();
    }
    return () => {
      cancelled = true;
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [viewer?.item]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = normalize(query.trim());
    if (!q) return items;
    return items.filter((item) => normalize(item.name).includes(q) || (item.brand && normalize(item.brand).includes(q)));
  }, [items, query]);

  const openViewer = (item: GalerieItem) => {
    if (item.photos.length === 0) return;
    setViewer({ item, index: 0 });
  };

  const showPrev = () => setViewer((v) => (v && v.index > 0 ? { ...v, index: v.index - 1 } : v));
  const showNext = () =>
    setViewer((v) => (v && v.index < v.item.photos.length - 1 ? { ...v, index: v.index + 1 } : v));

  const onTouchStart: React.TouchEventHandler = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchEnd: React.TouchEventHandler = (e) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (delta > SWIPE_THRESHOLD) showPrev();
    else if (delta < -SWIPE_THRESHOLD) showNext();
  };

  const loading = filtered === null;
  const showEmpty = filtered !== null && filtered.length === 0;
  const currentPhoto = viewer?.item.photos[viewer.index] ?? null;

  return (
    <div
      className="no-scrollbar"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        overflowX: 'hidden',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
      }}
    >
      <div style={{ flex: 'none', padding: '14px 16px 16px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 12,
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
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: textA(0.55),
              }}
            >
              Galerie
            </span>
          </div>
          <StatusPill online={isOnline} />
        </div>

        <div style={{ fontSize: 22, fontWeight: 700, color: colors.text, marginBottom: 12 }}>{specialty.name}</div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: textA(0.08),
            borderRadius: 14,
            padding: '0 14px',
            height: 48,
            boxSizing: 'border-box',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" style={{ flex: 'none' }} aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="6.5" fill="none" stroke={textA(0.6)} strokeWidth="2" />
            <line x1="13.2" y1="13.2" x2="18" y2="18" stroke={textA(0.6)} strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher par nom..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: colors.text,
              fontSize: 15,
              fontFamily: fonts.sans,
              minWidth: 0,
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Effacer"
              style={{
                flex: 'none',
                width: 24,
                height: 24,
                borderRadius: '50%',
                border: 'none',
                background: textA(0.18),
                color: colors.text,
                fontSize: 14,
                lineHeight: 1,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, padding: '14px 16px 24px', boxSizing: 'border-box' }}>
        {loadError && <p style={{ fontSize: 14, color: colors.accent }}>Erreur : {loadError}</p>}

        {!loadError && loading && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 40 }}>Chargement…</p>
        )}

        {!loadError && showEmpty && (
          <p style={{ fontSize: 14, color: textA(0.55), textAlign: 'center', marginTop: 40 }}>
            {query ? 'Aucun résultat.' : 'Aucune télécommande.'}
          </p>
        )}

        {!loadError && filtered && filtered.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 14 }}>
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openViewer(item)}
                disabled={item.photos.length === 0}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: item.photos.length === 0 ? 'default' : 'pointer',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    aspectRatio: '1',
                    borderRadius: 12,
                    overflow: 'hidden',
                    background: colors.card,
                  }}
                >
                  {thumbUrls[item.id] ? (
                    <img
                      src={thumbUrls[item.id]}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 22,
                        fontWeight: 700,
                        color: textA(0.35),
                      }}
                    >
                      {item.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  {item.nb_photos > 1 && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        minWidth: 18,
                        height: 18,
                        padding: '0 5px',
                        borderRadius: 100,
                        background: 'rgba(0, 0, 0, 0.65)',
                        color: '#fff',
                        fontSize: 10.5,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {item.nb_photos}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, lineHeight: 1.3 }}>{item.name}</div>
                {item.brand && <div style={{ fontSize: 11.5, fontWeight: 600, color: textA(0.55) }}>{item.brand}</div>}
              </button>
            ))}
          </div>
        )}
      </div>

      {viewer && currentPhoto && viewerUrls[currentPhoto.id] && (
        <div onClick={() => setViewer(null)} style={photoViewerOverlayStyle}>
          <button type="button" onClick={() => setViewer(null)} aria-label="Fermer" style={photoViewerCloseButtonStyle}>
            ×
          </button>

          <div
            onClick={(e) => e.stopPropagation()}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            style={photoViewerContentStyle}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', textAlign: 'center' }}>{viewer.item.name}</div>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
              {viewer.item.photos.length > 1 && (
                <button
                  type="button"
                  onClick={showPrev}
                  disabled={viewer.index === 0}
                  aria-label="Photo précédente"
                  style={{ ...navButtonStyle, opacity: viewer.index === 0 ? 0.3 : 1 }}
                >
                  ‹
                </button>
              )}
              <img
                src={viewerUrls[currentPhoto.id]}
                alt=""
                style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: 8 }}
              />
              {viewer.item.photos.length > 1 && (
                <button
                  type="button"
                  onClick={showNext}
                  disabled={viewer.index === viewer.item.photos.length - 1}
                  aria-label="Photo suivante"
                  style={{ ...navButtonStyle, opacity: viewer.index === viewer.item.photos.length - 1 ? 0.3 : 1 }}
                >
                  ›
                </button>
              )}
            </div>

            {currentPhoto.libelle && (
              <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)', textAlign: 'center' }}>
                {currentPhoto.libelle}
              </div>
            )}
            {viewer.item.photos.length > 1 && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                {viewer.index + 1} / {viewer.item.photos.length}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const photoViewerOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.9)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  boxSizing: 'border-box',
  zIndex: 1400,
};

const photoViewerCloseButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255, 255, 255, 0.15)',
  color: '#fff',
  fontSize: 20,
  lineHeight: '36px',
  padding: 0,
  cursor: 'pointer',
};

const photoViewerContentStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  maxWidth: '100%',
  maxHeight: '100%',
};

const navButtonStyle: React.CSSProperties = {
  flex: 'none',
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255, 255, 255, 0.15)',
  color: '#fff',
  fontSize: 20,
  lineHeight: '36px',
  padding: 0,
  cursor: 'pointer',
};
