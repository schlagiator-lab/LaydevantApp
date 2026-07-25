import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { SearchParams } from '../lib/navigationContext';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { getLocalDepartments, getLocalSpecialties, getAllPinnedDocuments, type PinnedDocumentRecord } from '../lib/db';
import { searchDocuments, listDocuments } from '../lib/documents';
import { buildOfflineIndex, searchOfflineIds, buildOfflineExcerptHtml } from '../lib/offlineSearch';
import { sanitizeHeadline } from '../lib/excerpt';
import { docTypeLabel } from '../lib/docType';
import type { Department, DocType, Specialty } from '../types/database';
import { StatusPill } from '../components/StatusPill';
import { DocumentCard, type DocumentCardProps } from '../components/DocumentCard';
import { colors, fonts, textA } from '../styles/tokens';

// `brand` only ever comes from the browse-mode query (products.brand) — the
// search_documents RPC and pinned/offline records only carry a combined
// "brand model" product_label, with no reliable way to split brand back out.
// It's carried on the item purely to build the manufacturer filter, never
// rendered by DocumentCard.
type ResultItem = Omit<DocumentCardProps, 'onTap'> & { id: string; brand: string | null };

export function SearchScreen({ params }: { params: SearchParams }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();
  const { showToast } = useToast();

  const [query, setQuery] = useState(params.query);
  const [departmentId, setDepartmentId] = useState(params.departmentId);
  const [specialtyId, setSpecialtyId] = useState(params.specialtyId);
  const [pinnedOnly, setPinnedOnly] = useState(params.pinnedOnly);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [pinnedDocs, setPinnedDocs] = useState<PinnedDocumentRecord[]>([]);
  const [rawResults, setRawResults] = useState<ResultItem[] | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [docTypeFilter, setDocTypeFilter] = useState<DocType | null>(null);
  const [brandFilter, setBrandFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [depts, specs, pinned] = await Promise.all([
        getLocalDepartments(),
        getLocalSpecialties(),
        getAllPinnedDocuments(),
      ]);
      if (cancelled) return;
      setDepartments(depts);
      setSpecialties(specs);
      setPinnedDocs(pinned);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const specialtiesById = useMemo(() => new Map(specialties.map((s) => [s.id, s])), [specialties]);
  const departmentsById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);
  const pinnedIds = useMemo(() => new Set(pinnedDocs.map((d) => d.id)), [pinnedDocs]);

  const restrictToPinned = pinnedOnly || !isOnline;
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  // Already narrowed to a branch (came from Department/Specialty drill-down,
  // or picked a chip before that row got replaced below) — department chips
  // no longer earn their space, swap them for doc-type/manufacturer filters.
  const scoped = departmentId !== null;
  // Manufacturer is only ever known separately from the browse-mode query
  // (products.brand) — see the ResultItem comment above.
  const brandFilterUsable = scoped && !restrictToPinned && !hasQuery;

  useEffect(() => {
    let cancelled = false;

    const matchesFilter = (doc: PinnedDocumentRecord) => {
      if (specialtyId) return doc.specialty_id === specialtyId;
      if (departmentId) return specialtiesById.get(doc.specialty_id)?.department_id === departmentId;
      return true;
    };

    async function run() {
      setRawResults(null);
      setResultsError(null);
      try {
        if (restrictToPinned) {
          const pool = pinnedDocs.filter(matchesFilter);
          const items: ResultItem[] = hasQuery
            ? searchOfflineIds(buildOfflineIndex(pool), trimmedQuery)
                .map((id) => pool.find((d) => d.id === id))
                .filter((d): d is PinnedDocumentRecord => d !== undefined)
                .map((doc) => ({
                  id: doc.id,
                  title: doc.title,
                  docType: doc.doc_type,
                  specialtyName: doc.specialtyName,
                  productLabel: doc.productLabel,
                  brand: null,
                  excerptHtml: buildOfflineExcerptHtml(doc.content ?? '', trimmedQuery),
                  pinned: true,
                  dim: false,
                }))
            : pool
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((doc) => ({
                  id: doc.id,
                  title: doc.title,
                  docType: doc.doc_type,
                  specialtyName: doc.specialtyName,
                  productLabel: doc.productLabel,
                  brand: null,
                  excerptHtml: null,
                  pinned: true,
                  dim: false,
                }));
          if (!cancelled) setRawResults(items);
        } else if (hasQuery) {
          const rows = await searchDocuments({
            q: trimmedQuery,
            departmentSlug: departmentId ? (departmentsById.get(departmentId)?.slug ?? null) : null,
            specialtySlug: specialtyId ? (specialtiesById.get(specialtyId)?.slug ?? null) : null,
          });
          if (cancelled) return;
          setRawResults(
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              docType: r.doc_type,
              specialtyName: r.specialty_name,
              productLabel: r.product_label,
              brand: null,
              excerptHtml: sanitizeHeadline(r.extrait),
              pinned: pinnedIds.has(r.id),
              dim: !pinnedIds.has(r.id) && !isOnline,
            })),
          );
        } else {
          const scopeIds = specialtyId
            ? [specialtyId]
            : departmentId
              ? specialties.filter((s) => s.department_id === departmentId).map((s) => s.id)
              : undefined;
          const rows = await listDocuments(scopeIds);
          if (cancelled) return;
          setRawResults(
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              docType: r.doc_type,
              specialtyName: r.specialties?.name ?? '',
              productLabel: [r.products?.brand, r.products?.model].filter(Boolean).join(' ') || null,
              brand: r.products?.brand ?? null,
              excerptHtml: null,
              pinned: pinnedIds.has(r.id),
              dim: !pinnedIds.has(r.id) && !isOnline,
            })),
          );
        }
      } catch (err) {
        if (!cancelled) setResultsError(err instanceof Error ? err.message : String(err));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    restrictToPinned,
    hasQuery,
    trimmedQuery,
    departmentId,
    specialtyId,
    pinnedDocs,
    specialties,
    specialtiesById,
    departmentsById,
    pinnedIds,
    isOnline,
  ]);

  // Fresh branch — any filter picked in a different one no longer applies.
  // Reset during render (not an effect) per React's "adjusting state when a
  // prop changes" pattern, to avoid an extra render pass.
  const scopeKey = `${departmentId ?? ''}|${specialtyId ?? ''}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (scopeKey !== prevScopeKey) {
    setPrevScopeKey(scopeKey);
    setDocTypeFilter(null);
    setBrandFilter(null);
  }

  const availableDocTypes = useMemo(
    () => Array.from(new Set((rawResults ?? []).map((r) => r.docType))),
    [rawResults],
  );
  const availableBrands = useMemo(
    () =>
      Array.from(new Set((rawResults ?? []).map((r) => r.brand).filter((b): b is string => !!b))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [rawResults],
  );

  const results = useMemo(() => {
    if (!rawResults) return null;
    return rawResults.filter(
      (r) =>
        (!docTypeFilter || r.docType === docTypeFilter) &&
        (!brandFilterUsable || !brandFilter || r.brand === brandFilter),
    );
  }, [rawResults, docTypeFilter, brandFilter, brandFilterUsable]);

  const handleResultTap = (item: ResultItem) => {
    if (!item.pinned && !isOnline) {
      showToast(`Connexion réseau requise pour ouvrir « ${item.title} ».`);
      return;
    }
    nav.goDocument(item.id);
  };

  const selectDepartmentChip = (deptId: string | null) => {
    setDepartmentId(deptId);
    setSpecialtyId(null);
    setPinnedOnly(false);
  };

  const widenSearch = () => {
    setQuery('');
    setDepartmentId(null);
    setSpecialtyId(null);
  };

  const searchOnline = () => {
    if (!isOnline) {
      showToast('Impossible : aucune connexion réseau.');
      return;
    }
    setPinnedOnly(false);
  };

  const onQueryChange = (e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setPinnedOnly(false);
  };

  const searchLabel = pinnedOnly ? 'Documents téléchargés' : 'Documentation technique';
  const loading = results === null;
  const showEmpty = results !== null && results.length === 0;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        position: 'relative',
      }}
    >
      <div style={{ flex: 'none', padding: '14px 16px 10px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
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
              {searchLabel}
            </span>
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
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" style={{ flex: 'none' }} aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="6.5" fill="none" stroke={textA(0.6)} strokeWidth="2" />
            <line x1="13.2" y1="13.2" x2="18" y2="18" stroke={textA(0.6)} strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={onQueryChange}
            placeholder="Référence, notice, mot-clé..."
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
          {hasQuery && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Effacer"
              style={{
                flex: 'none',
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: 'none',
                background: textA(0.18),
                color: colors.text,
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          )}
        </div>

        {scoped ? (
          <>
            <div
              className="no-scrollbar chip-row"
              style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, marginTop: 12, overflowX: 'auto' }}
            >
              <button
                type="button"
                onClick={() => setDocTypeFilter(null)}
                style={chipStyle(docTypeFilter === null)}
              >
                Tout type
              </button>
              {availableDocTypes.map((dt) => (
                <button
                  key={dt}
                  type="button"
                  onClick={() => setDocTypeFilter(dt)}
                  style={chipStyle(docTypeFilter === dt)}
                >
                  {docTypeLabel(dt)}
                </button>
              ))}
            </div>

            {brandFilterUsable && availableBrands.length > 0 && (
              <div
                className="no-scrollbar chip-row"
                style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, marginTop: 8, overflowX: 'auto' }}
              >
                <button
                  type="button"
                  onClick={() => setBrandFilter(null)}
                  style={chipStyle(brandFilter === null)}
                >
                  Tout fabricant
                </button>
                {availableBrands.map((brand) => (
                  <button
                    key={brand}
                    type="button"
                    onClick={() => setBrandFilter(brand)}
                    style={chipStyle(brandFilter === brand)}
                  >
                    {brand}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div
            className="no-scrollbar chip-row"
            style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, marginTop: 12, overflowX: 'auto' }}
          >
            <button
              type="button"
              onClick={() => selectDepartmentChip(null)}
              style={chipStyle(departmentId === null)}
            >
              Tout
            </button>
            {departments.map((dept) => (
              <button
                key={dept.id}
                type="button"
                onClick={() => selectDepartmentChip(dept.id)}
                style={chipStyle(departmentId === dept.id)}
              >
                {dept.name}
              </button>
            ))}
          </div>
        )}

        {!isOnline && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              background: 'rgba(222, 122, 34, 0.15)',
              border: '1px solid rgba(222, 122, 34, 0.4)',
              borderRadius: 10,
              padding: '9px 12px',
            }}
          >
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
              Hors ligne — recherche limitée à vos {pinnedDocs.length} document
              {pinnedDocs.length === 1 ? '' : 's'} téléchargé{pinnedDocs.length === 1 ? '' : 's'}.
            </span>
          </div>
        )}
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '14px 16px 24px', boxSizing: 'border-box' }}
      >
        {resultsError && (
          <p style={{ fontSize: 14, color: colors.accent }}>Erreur : {resultsError}</p>
        )}

        {!resultsError && results && results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {results.map((item) => (
              <DocumentCard key={item.id} {...item} onTap={() => handleResultTap(item)} />
            ))}
          </div>
        )}

        {!resultsError && showEmpty && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 14,
              padding: '60px 20px 20px',
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                border: `2px dashed ${textA(0.3)}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="26" height="26" viewBox="0 0 20 20">
                <circle cx="8.5" cy="8.5" r="6.5" fill="none" stroke={textA(0.4)} strokeWidth="2" />
                <line x1="13.2" y1="13.2" x2="18" y2="18" stroke={textA(0.4)} strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>

            {!isOnline ? (
              <>
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  Aucun résultat parmi vos documents téléchargés
                </div>
                <div style={{ fontSize: 14, color: textA(0.6), maxWidth: 260, lineHeight: 1.5 }}>
                  Reconnectez-vous au réseau pour chercher dans toute la documentation.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 280, marginTop: 6 }}>
                  <button type="button" onClick={widenSearch} style={secondaryButtonStyle}>
                    Élargir la recherche
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 17, fontWeight: 700 }}>Aucun résultat pour « {query} »</div>
                <div style={{ fontSize: 14, color: textA(0.6), maxWidth: 260, lineHeight: 1.5 }}>
                  Vérifiez l'orthographe de la référence, ou élargissez la recherche.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 280, marginTop: 6 }}>
                  <button type="button" onClick={widenSearch} style={secondaryButtonStyle}>
                    Élargir la recherche
                  </button>
                  {pinnedOnly && (
                    <button type="button" onClick={searchOnline} style={primaryButtonStyle}>
                      Chercher en ligne
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {loading && !resultsError && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 40 }}>Recherche…</p>
        )}
      </div>
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    flex: 'none',
    whiteSpace: 'nowrap',
    height: 36,
    padding: '0 16px',
    borderRadius: 100,
    fontSize: 13.5,
    fontWeight: 600,
    cursor: 'pointer',
    border: `1px solid ${active ? colors.accent : textA(0.25)}`,
    background: active ? colors.accent : 'transparent',
    color: active ? '#132146' : colors.text,
  };
}

const secondaryButtonStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
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
