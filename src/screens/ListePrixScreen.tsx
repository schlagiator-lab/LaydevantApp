import { useEffect, useMemo, useState } from 'react';
import type { PrixArticle, Specialty } from '../types/database';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { fetchPrixArticles } from '../lib/prixArticles';
import { normalize } from '../lib/galerie';
import { StatusPill } from '../components/StatusPill';
import { PrixArticleFormSheet } from '../components/PrixArticleFormSheet';
import { colors, fonts, textA } from '../styles/tokens';

const priceFormatter = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return `${priceFormatter.format(value)} CHF HT`;
}

export function ListePrixScreen({ specialty }: { specialty: Specialty }) {
  const { isOnline, session } = useAuth();
  const nav = useNavigation();

  const [articles, setArticles] = useState<PrixArticle[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [articleSheet, setArticleSheet] = useState<'new' | PrixArticle | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setArticles(null);
      setLoadError(null);
      try {
        const rows = await fetchPrixArticles(specialty.id);
        if (!cancelled) setArticles(rows);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [specialty.id, reloadKey]);

  const filtered = useMemo(() => {
    if (!articles) return null;
    const q = normalize(query.trim());
    if (!q) return articles;
    return articles.filter(
      (article) => normalize(article.nom).includes(q) || (article.remarque && normalize(article.remarque).includes(q)),
    );
  }, [articles, query]);

  const loading = filtered === null;
  const showEmpty = filtered !== null && filtered.length === 0;

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
              Liste de prix
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
            placeholder="Rechercher un article..."
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

        <button
          type="button"
          onClick={() => setArticleSheet('new')}
          disabled={!isOnline || !session?.user.id}
          style={{
            marginTop: 12,
            width: '100%',
            height: 44,
            borderRadius: 12,
            border: 'none',
            background: colors.accent,
            color: '#132146',
            fontSize: 14,
            fontWeight: 700,
            opacity: !isOnline || !session?.user.id ? 0.5 : 1,
            cursor: !isOnline || !session?.user.id ? 'default' : 'pointer',
          }}
        >
          + Ajouter un article
        </button>
      </div>

      <div style={{ flex: 1, padding: '14px 16px 24px', boxSizing: 'border-box' }}>
        {loadError && <p style={{ fontSize: 14, color: colors.accent }}>Erreur : {loadError}</p>}

        {!loadError && loading && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 40 }}>Chargement…</p>
        )}

        {!loadError && showEmpty && (
          <p style={{ fontSize: 14, color: textA(0.55), textAlign: 'center', marginTop: 40 }}>
            {query ? 'Aucun résultat.' : 'Aucun article pour l’instant.'}
          </p>
        )}

        {!loadError && filtered && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.map((article) => (
              <button
                key={article.id}
                type="button"
                onClick={() => setArticleSheet(article)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  width: '100%',
                  background: colors.card,
                  border: 'none',
                  borderRadius: 12,
                  padding: '12px 14px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>{article.nom}</div>
                  {article.remarque && (
                    <div style={{ fontSize: 12.5, color: textA(0.6), marginTop: 2 }}>{article.remarque}</div>
                  )}
                </div>
                <div style={{ flex: 'none', fontSize: 14, fontWeight: 700, color: colors.text, whiteSpace: 'nowrap' }}>
                  {formatPrice(article.prix_vente_ht)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {articleSheet && (
        <PrixArticleFormSheet
          specialtyId={specialty.id}
          article={articleSheet === 'new' ? null : articleSheet}
          onClose={() => setArticleSheet(null)}
          onSaved={() => {
            setArticleSheet(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
