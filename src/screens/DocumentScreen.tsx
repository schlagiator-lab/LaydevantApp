import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { DocumentRow } from '../types/database';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { getPinnedDocument, deletePinnedDocument, recordRecentDocument } from '../lib/db';
import { getDocumentDetail } from '../lib/documentDetail';
import { fetchPdfBlob } from '../lib/documents';
import { getPdf } from '../lib/pdfCache';
import { pinDocument, unpinDocument, isPinnedOnAccount } from '../lib/pinning';
import { StatusPill } from '../components/StatusPill';
import { docTypeLabel } from '../lib/docType';
import { colors, fonts, textA } from '../styles/tokens';

// pdf.js (~1 MB with its worker) is only needed once a document is actually
// opened — code-split it out so Home/Search/Department screens don't pay for
// it on first load, which matters on the flaky connections this app targets.
const PdfViewer = lazy(() => import('../components/PdfViewer').then((m) => ({ default: m.PdfViewer })));

function formatFetchedDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(iso),
  );
}

export function DocumentScreen({ documentId }: { documentId: string }) {
  const { session, isOnline } = useAuth();
  const nav = useNavigation();
  const { showToast } = useToast();
  const userId = session?.user.id ?? '';

  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [specialtyName, setSpecialtyName] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [productLabel, setProductLabel] = useState<string | null>(null);
  const [isPinnedOnDevice, setIsPinnedOnDevice] = useState(false);
  const [isPinnedElsewhere, setIsPinnedElsewhere] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The same blob feeds both the in-app pdf.js preview and the "Voir en
  // plein écran" fallback (window.open) — fetched once, reused for both
  // instead of downloading the PDF twice.
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const fetchOnlineDetail = useCallback(async (id: string, uid: string) => {
    try {
      const detail = await getDocumentDetail(id);
      setDoc(detail.doc);
      setSpecialtyName(detail.specialtyName);
      setDepartmentName(detail.departmentName);
      setProductLabel(detail.productLabel);
      void recordRecentDocument({ documentId: id, title: detail.doc.title, specialtyName: detail.specialtyName });
      const account = await isPinnedOnAccount(id, uid).catch(() => false);
      setIsPinnedElsewhere(account);
      try {
        setPdfBlob(await fetchPdfBlob(detail.doc.file_path, detail.doc.mime_type));
      } catch (err) {
        setPdfError(err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Pinned-local check, then online fallback.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const pinnedRecord = await getPinnedDocument(documentId);
      if (cancelled) return;

      if (pinnedRecord) {
        const blob = await getPdf(documentId);
        if (cancelled) return;

        if (blob) {
          setDoc(pinnedRecord);
          setSpecialtyName(pinnedRecord.specialtyName);
          setDepartmentName(pinnedRecord.departmentName);
          setProductLabel(pinnedRecord.productLabel);
          setIsPinnedOnDevice(true);
          setPdfBlob(blob);
          void recordRecentDocument({
            documentId,
            title: pinnedRecord.title,
            specialtyName: pinnedRecord.specialtyName,
          });
          return;
        }

        // Metadata says pinned, but the blob is gone from this device's Cache
        // API (e.g. evicted under storage pressure). Drop the stale record so
        // the UI doesn't show "Disponible hors ligne" for a file that isn't
        // actually there — falls through to the online path below.
        await deletePinnedDocument(documentId);
      }

      setIsPinnedOnDevice(false);
      if (!navigator.onLine) return; // no data yet; retry effect below picks it up on reconnect
      await fetchOnlineDetail(documentId, userId);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [documentId, userId, fetchOnlineDetail]);

  // Retry once back online, if the first attempt never got data (opened this
  // document for the first time while offline).
  useEffect(() => {
    if (!isOnline || doc !== null) return;
    let cancelled = false;
    async function retry() {
      if (!cancelled) await fetchOnlineDetail(documentId, userId);
    }
    void retry();
    return () => {
      cancelled = true;
    };
  }, [isOnline, doc, documentId, userId, fetchOnlineDetail]);

  const handleSave = async () => {
    if (!isOnline) {
      showToast('Connexion réseau requise pour enregistrer ce document.');
      return;
    }
    if (!doc) return;
    setSaving(true);
    try {
      await pinDocument({ doc, specialtyName, departmentName, productLabel }, userId);
      setIsPinnedOnDevice(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Échec de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!doc) return;
    try {
      await unpinDocument(doc.id, userId, isOnline);
      setIsPinnedOnDevice(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec du retrait.');
    }
  };

  /**
   * Secondary action next to the in-app pdf.js preview: hands the same
   * already-fetched blob to Android's native full-screen PDF viewer via
   * window.open(), for anyone who prefers it (e.g. to use its search/zoom).
   */
  const handleOpenFullscreen = () => {
    if (!pdfBlob) return;
    const objectUrl = URL.createObjectURL(pdfBlob);
    window.open(objectUrl, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  };

  const fetchedDate = doc ? formatFetchedDate(doc.retrieved_at) : null;
  const viewerBlocked = !doc || (!pdfBlob && !isPinnedOnDevice && !pdfError);

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
      <div style={{ flex: 'none', padding: '14px 16px 12px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
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
              Fiche document
            </span>
          </div>
          <StatusPill online={isOnline} />
        </div>

        <button
          type="button"
          onClick={nav.goSearchBlank}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: textA(0.08),
            border: 'none',
            borderRadius: 14,
            padding: '0 14px',
            height: 52,
            color: textA(0.55),
            fontSize: 16,
            fontFamily: fonts.sans,
            cursor: 'pointer',
            textAlign: 'left',
            marginBottom: 12,
            boxSizing: 'border-box',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" style={{ flex: 'none' }} aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="6.5" fill="none" stroke={textA(0.6)} strokeWidth="2" />
            <line x1="13.2" y1="13.2" x2="18" y2="18" stroke={textA(0.6)} strokeWidth="2" strokeLinecap="round" />
          </svg>
          Rechercher une référence, une notice…
        </button>

        {doc ? (
          <>
            <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.25, marginBottom: 6 }}>{doc.title}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13, color: textA(0.6), fontWeight: 500 }}>
              <span>{docTypeLabel(doc.doc_type)}</span>
              <span>·</span>
              <span>{departmentName || specialtyName}</span>
              {productLabel && (
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontWeight: 700,
                    color: colors.text,
                    background: textA(0.1),
                    borderRadius: 6,
                    padding: '2px 6px',
                  }}
                >
                  {productLabel}
                </span>
              )}
            </div>
          </>
        ) : (
          <p style={{ fontSize: 14, color: textA(0.6) }}>
            {loadError ? `Erreur : ${loadError}` : 'Chargement…'}
          </p>
        )}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 280,
          margin: '14px 16px 0',
          borderRadius: 14,
          background:
            'repeating-linear-gradient(135deg, rgba(242,233,168,0.06) 0 12px, rgba(242,233,168,0.03) 12px 24px)',
          border: `1px solid ${textA(0.15)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: pdfBlob ? 8 : 24,
          textAlign: 'center',
          overflow: 'hidden',
        }}
      >
        {pdfBlob ? (
          <Suspense
            fallback={
              <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55) }}>
                Chargement de l'aperçu…
              </span>
            }
          >
            <PdfViewer blob={pdfBlob} />
          </Suspense>
        ) : (
          <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55), lineHeight: 1.6 }}>
            {loadError ??
              pdfError ??
              (viewerBlocked
                ? "Aperçu indisponible hors ligne — enregistrez ce document en ligne pour le consulter sans réseau."
                : 'Chargement du document…')}
          </span>
        )}
      </div>

      {pdfBlob && (
        <div style={{ flex: 'none', display: 'flex', justifyContent: 'center', padding: '8px 16px 0' }}>
          <button
            type="button"
            onClick={handleOpenFullscreen}
            style={{
              background: 'transparent',
              border: 'none',
              color: textA(0.55),
              fontSize: 12.5,
              fontWeight: 600,
              textDecoration: 'underline',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Voir en plein écran
          </button>
        </div>
      )}

      <div style={{ flex: 'none', padding: '14px 16px 8px' }}>
        {isPinnedOnDevice ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="8.5" fill="none" stroke={colors.success} strokeWidth="2" />
                <path d="M6.5 10.3l2.3 2.3 4.7-5.2" fill="none" stroke={colors.success} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: colors.success }}>Disponible hors ligne</span>
            </div>
            <button
              type="button"
              onClick={() => void handleRemove()}
              style={{
                background: 'transparent',
                border: 'none',
                color: textA(0.5),
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'underline',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Retirer de l'appareil
            </button>
          </div>
        ) : saving ? (
          <div
            style={{
              width: '100%',
              height: 56,
              borderRadius: 14,
              background: 'rgba(222, 122, 34, 0.35)',
              color: colors.text,
              fontSize: 16,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              position: 'relative',
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: 'none' }}>
              <circle cx="10" cy="10" r="7.5" fill="none" stroke={textA(0.35)} strokeWidth="2.5" />
              <path d="M10 2.5a7.5 7.5 0 015.3 12.8" fill="none" stroke={colors.text} strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span>Enregistrement…</span>
            <span
              style={{
                position: 'absolute',
                left: 0,
                bottom: 0,
                height: 3,
                width: '100%',
                background: colors.accent,
              }}
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!doc}
              style={{
                width: '100%',
                height: 56,
                borderRadius: 14,
                border: 'none',
                background: colors.accent,
                color: '#132146',
                fontSize: 16,
                fontWeight: 700,
                cursor: doc ? 'pointer' : 'default',
                opacity: doc ? 1 : 0.6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M10 2.5v10.5M5.5 9l4.5 4.5L14.5 9M4 16.5h12"
                  fill="none"
                  stroke="#132146"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {isPinnedElsewhere ? 'Télécharger sur cet appareil' : "Enregistrer sur l'appareil"}
            </button>
            {isPinnedElsewhere && (
              <p style={{ fontSize: 12, color: textA(0.5), marginTop: 6 }}>
                Épinglé sur votre compte, mais pas encore téléchargé sur cet appareil.
              </p>
            )}
          </>
        )}
      </div>

      {doc && (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '8px 16px 20px',
            fontSize: 12,
            color: textA(0.45),
          }}
        >
          <span>{fetchedDate ? `Récupéré le ${fetchedDate}` : ''}</span>
          {doc.source_url && (
            <a href={doc.source_url} target="_blank" rel="noreferrer" style={{ color: colors.accent, textDecoration: 'none', fontWeight: 600 }}>
              Source fabricant ›
            </a>
          )}
        </div>
      )}
    </div>
  );
}
