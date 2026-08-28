import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import {
  canPublishCommunications,
  COMM_LAST_SEEN_KEY,
  getCommunicationBlob,
  listCommunications,
  softDeleteCommunication,
  uploadCommunication,
} from '../lib/communications';
import type { Communication } from '../types/database';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { PushNotificationsToggle } from '../components/PushNotificationsToggle';
import { colors, fonts, radius, textA } from '../styles/tokens';

// pdf.js (~1 MB with its worker) is only needed once a preview is actually
// rendered — code-split out, same pattern as DocumentScreen.
const PdfViewer = lazy(() => import('../components/PdfViewer').then((m) => ({ default: m.PdfViewer })));

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

// Clé R2 = communications/<uuid v4>-<nom-sanitisé>. Un UUID v4 contient des
// tirets internes (8-4-4-4-12) : couper au "premier tiret" (comme planLabel,
// PlansSection.tsx — bug préexistant, hors scope ici) laisse la moitié de
// l'UUID visible. On ancre donc sur la forme exacte de l'UUID plutôt que sur
// la position d'un caractère.
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/** Libellé affiché : le titre s'il existe, sinon le nom de fichier dérivé de
 * storage_key (préfixe de dossier retiré, puis préfixe UUID retiré). */
function deriveLabel(storageKey: string): string {
  const slash = storageKey.lastIndexOf('/');
  const filename = slash === -1 ? storageKey : storageKey.slice(slash + 1);
  return filename.replace(UUID_PREFIX_RE, '');
}

// Viewer plein écran in-app pour une communication — remplace window.open()
// sur une URL blob:, bloqué par Safari iOS en PWA standalone. zIndex aligné
// sur les autres lightbox plein écran de l'app (GalerieScreen).
const commViewerOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: colors.bg,
  color: colors.text,
  fontFamily: fonts.sans,
  zIndex: 1400,
  display: 'flex',
  flexDirection: 'column',
  padding: 16,
  boxSizing: 'border-box',
};

function PdfPlaceholder({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 16 }}>
      <svg width="40" height="40" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M5 2.5h7l3 3v12a1 1 0 01-1 1H5a1 1 0 01-1-1v-14a1 1 0 011-1z"
          fill="none"
          stroke={colors.accent}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M12 2.5v3h3" fill="none" stroke={colors.accent} strokeWidth="1.5" strokeLinejoin="round" />
        <text x="10" y="14.5" textAnchor="middle" fontSize="5.5" fontWeight="700" fill={colors.accent}>
          PDF
        </text>
      </svg>
      <span style={{ fontSize: 13, fontWeight: 600, color: textA(0.6), textAlign: 'center', lineHeight: 1.3 }}>
        {label}
      </span>
    </div>
  );
}

/**
 * Communication d'entreprise (item 4) — liste des PDF publiés, espace global
 * (pas de dossier_id, contrairement aux plans/carnet). La plus récente est
 * mise en avant avec un aperçu pdf.js de sa 1re page ; les suivantes en
 * liste texte compacte, sans aperçu.
 */
export function CommunicationsScreen() {
  const nav = useNavigation();
  const { session, isOnline } = useAuth();
  const { showToast } = useToast();
  const [items, setItems] = useState<Communication[] | null | undefined>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Communication | null>(null);
  const [featuredBlob, setFeaturedBlob] = useState<Blob | null>(null);
  const [featuredLoading, setFeaturedLoading] = useState(false);

  // Viewer plein écran in-app (calqué sur DocumentScreen) : remplace
  // window.open('blob:…'), bloqué par Safari iOS en PWA standalone.
  const [openedComm, setOpenedComm] = useState<Communication | null>(null);
  const [openedBlob, setOpenedBlob] = useState<Blob | null>(null);
  const [openedLoading, setOpenedLoading] = useState(false);
  const [openedError, setOpenedError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const rows = await listCommunications();
      setItems(rows);
    } catch {
      setItems(undefined);
    }
  };

  useEffect(() => {
    // Chargement initial de la liste au montage ; setState après résolution
    // async, pattern fetch-on-mount voulu.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, []);

  useEffect(() => {
    // Marque "lu" dès l'ouverture de l'écran (pas seulement après chargement
    // de la liste) : voir/masquer la pastille de l'accueil ne dépend que de
    // la visite de cet écran, pas de son contenu. Efface aussi la pastille
    // d'icône (Badging API, brique 3b) posée par le SW sur réception d'un
    // push — même geste "lu" que localStorage, best-effort selon le support.
    localStorage.setItem(COMM_LAST_SEEN_KEY, new Date().toISOString());
    if ('clearAppBadge' in navigator) void navigator.clearAppBadge();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await canPublishCommunications();
        if (!cancelled) setCanPublish(value);
      } catch {
        // Reste caché en cas d'échec — pas d'entrée "Publier" affichée à tort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const featured = items && items.length > 0 ? items[0] : null;
  const rest = items && items.length > 1 ? items.slice(1) : [];

  // Gate sur isOnline AVANT tout fetch : hors ligne, on ne tente même pas —
  // placeholder immédiat plutôt qu'un fetch voué à l'échec.
  useEffect(() => {
    let cancelled = false;
    // Reset volontaire de l'aperçu à chaque changement de featured/isOnline
    // avant de recharger ; restructurer introduirait un flash de l'aperçu
    // précédent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeaturedBlob(null);
    if (!featured || !isOnline) return;
    setFeaturedLoading(true);
    void (async () => {
      try {
        const blob = await getCommunicationBlob(featured.storage_key);
        if (!cancelled) setFeaturedBlob(blob);
      } catch {
        // Reste null → placeholder (icône PDF + titre), jamais de crash.
      } finally {
        if (!cancelled) setFeaturedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [featured, isOnline]);

  // Fetch du Blob de la communication ouverte en plein écran — même fetch
  // authentifié que la vignette featured (getCommunicationBlob), déclenché à
  // l'ouverture plutôt qu'au montage. Reset au démontage/à la fermeture pour
  // ne pas garder un gros Blob PDF en mémoire une fois le viewer fermé.
  useEffect(() => {
    let cancelled = false;
    // Reset volontaire à chaque changement de communication ouverte, avant
    // de recharger — même pattern que l'effet de la vignette featured.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenedBlob(null);
    setOpenedError(null);
    if (!openedComm) return;
    setOpenedLoading(true);
    void (async () => {
      try {
        const blob = await getCommunicationBlob(openedComm.storage_key);
        if (!cancelled) setOpenedBlob(blob);
      } catch (err) {
        if (!cancelled) setOpenedError(err instanceof Error ? err.message : "Échec de l'ouverture du PDF.");
      } finally {
        if (!cancelled) setOpenedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openedComm]);

  const handleFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < files.length; i++) {
      setUploadProgress({ current: i + 1, total: files.length });
      try {
        await uploadCommunication({ file: files[i], titre: files[i].name });
        successCount++;
      } catch {
        failCount++;
      }
    }
    setUploadProgress(null);
    void reload();
    if (failCount > 0) {
      showToast(
        `${successCount} communication${successCount > 1 ? 's' : ''} ajoutée${successCount > 1 ? 's' : ''}, ${failCount} échec${failCount > 1 ? 's' : ''}`
      );
    }
  };

  const handleOpen = (comm: Communication) => {
    if (!isOnline) return;
    setOpenedComm(comm);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await softDeleteCommunication(pendingDelete.id);
      void reload();
    } catch (err) {
      console.error('[communications] softDelete failed:', err);
      const message =
        typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Échec de la suppression.';
      showToast(message);
    } finally {
      setPendingDelete(null);
    }
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
        padding: 16,
        gap: 16,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
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
        <span style={{ flex: 1, fontSize: 18, fontWeight: 700 }}>Communication d'entreprise</span>

        {canPublish && (
          <label
            style={{
              flex: 'none',
              height: 32,
              borderRadius: radius.md,
              border: 'none',
              background: colors.accent,
              color: '#132146',
              fontSize: 12.5,
              fontWeight: 700,
              padding: '0 12px',
              display: 'inline-flex',
              alignItems: 'center',
              opacity: !isOnline || uploadProgress ? 0.4 : 1,
              cursor: !isOnline || uploadProgress ? 'default' : 'pointer',
            }}
          >
            {uploadProgress ? `${uploadProgress.current}/${uploadProgress.total}` : '+ Publier'}
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => void handleFilesChange(e)}
              disabled={!isOnline || uploadProgress !== null || !session?.user.id}
              style={{ display: 'none' }}
            />
          </label>
        )}
      </div>

      <div style={{ flex: 'none' }}>
        <PushNotificationsToggle />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items === null ? (
          <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
        ) : items === undefined ? (
          <p style={{ fontSize: 14, color: colors.accent }}>Impossible de charger les communications.</p>
        ) : items.length === 0 ? (
          <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune communication pour le moment.</p>
        ) : (
          <>
            {featured && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  background: colors.card,
                  borderRadius: 14,
                  padding: 12,
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    height: 260,
                    borderRadius: 10,
                    background: colors.bgDark,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  {!isOnline ? (
                    <PdfPlaceholder label={featured.titre ?? deriveLabel(featured.storage_key)} />
                  ) : featuredLoading ? (
                    <span style={{ fontFamily: fonts.mono, fontSize: 12.5, color: textA(0.55) }}>
                      Chargement de l'aperçu…
                    </span>
                  ) : featuredBlob ? (
                    <Suspense
                      fallback={
                        <span style={{ fontFamily: fonts.mono, fontSize: 12.5, color: textA(0.55) }}>
                          Chargement de l'aperçu…
                        </span>
                      }
                    >
                      <PdfViewer blob={featuredBlob} />
                    </Suspense>
                  ) : (
                    <PdfPlaceholder label={featured.titre ?? deriveLabel(featured.storage_key)} />
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => handleOpen(featured)}
                  disabled={!isOnline}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: isOnline ? 'pointer' : 'default',
                    textAlign: 'left',
                    opacity: isOnline ? 1 : 0.6,
                  }}
                >
                  <span style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
                    {featured.titre ?? deriveLabel(featured.storage_key)}
                  </span>
                  <span style={{ fontSize: 12.5, color: textA(0.55), fontWeight: 500 }}>
                    publié par {featured.auteur_nom ?? 'inconnu'} le {formatDate(featured.created_at)}
                  </span>
                </button>

                {canPublish && (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(featured)}
                    style={{
                      alignSelf: 'flex-start',
                      background: 'transparent',
                      border: 'none',
                      color: textA(0.55),
                      fontSize: 12,
                      fontWeight: 700,
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    Supprimer
                  </button>
                )}
              </div>
            )}

            {rest.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rest.map((comm) => {
                  return (
                    <div
                      key={comm.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        background: colors.card,
                        borderRadius: 12,
                        padding: '10px 12px',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => handleOpen(comm)}
                        disabled={!isOnline}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 2,
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: isOnline ? 'pointer' : 'default',
                          textAlign: 'left',
                          opacity: isOnline ? 1 : 0.6,
                        }}
                      >
                        <span style={{ fontSize: 14.5, fontWeight: 700, color: colors.text }}>
                          {comm.titre ?? deriveLabel(comm.storage_key)}
                        </span>
                        <span style={{ fontSize: 12, color: textA(0.55), fontWeight: 500 }}>
                          publié par {comm.auteur_nom ?? 'inconnu'} le {formatDate(comm.created_at)}
                        </span>
                      </button>
                      {canPublish && (
                        <button
                          type="button"
                          onClick={() => setPendingDelete(comm)}
                          style={{
                            flex: 'none',
                            background: 'transparent',
                            border: 'none',
                            color: textA(0.55),
                            fontSize: 12,
                            fontWeight: 700,
                            textDecoration: 'underline',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                        >
                          Supprimer
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {pendingDelete && (
        <ConfirmSheet
          title="Supprimer cette communication ?"
          message="Elle sera retirée de la liste."
          confirmLabel="Supprimer"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {openedComm && (
        <div style={commViewerOverlayStyle}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setOpenedComm(null)}
              aria-label="Fermer"
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
                flex: 1,
                fontSize: 16,
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {openedComm.titre ?? deriveLabel(openedComm.storage_key)}
            </span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              borderRadius: 14,
              background: colors.bgDark,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {openedError ? (
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  color: textA(0.55),
                  padding: 16,
                  textAlign: 'center',
                  lineHeight: 1.6,
                }}
              >
                Aperçu impossible : {openedError}
              </span>
            ) : openedLoading || !openedBlob ? (
              <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55) }}>
                Chargement de l'aperçu…
              </span>
            ) : (
              <Suspense
                fallback={
                  <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55) }}>
                    Chargement de l'aperçu…
                  </span>
                }
              >
                <PdfViewer blob={openedBlob} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
