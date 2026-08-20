import { lazy, Suspense, useEffect, useState } from 'react';
import {
  attachEquipmentRequestNotice,
  deleteEquipmentRequestNotice,
  getEquipmentRequestNoticeBlob,
  promoteEquipmentNotice,
} from '../lib/dossiers';
import { useToast } from '../lib/useToast';
import { isIosDevice } from '../lib/pdfMeasure';
import { docTypeLabel } from '../lib/docType';
import { NOTICE_DOC_TYPES } from './EquipmentRequestSheet';
import type { DocType, EquipmentRequestFile, EquipmentRequestStatus } from '../types/database';
import { ConfirmSheet } from './ConfirmSheet';
import { colors, fonts, radius, textA } from '../styles/tokens';

// pdf.js (~1 MB with its worker) is only needed once a notice is actually
// opened on iOS — code-split out, same pattern as PlansSection/DocumentScreen.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));

export interface EquipmentRequestNoticesProps {
  requestId: string;
  notices: EquipmentRequestFile[];
  isOnline: boolean;
  /** Statut de la demande parente — le bouton de promotion n'apparaît que
   * pour une demande 'approved' (même précondition que l'Edge Function). */
  status: EquipmentRequestStatus;
  marque: string;
  modele: string | null;
  /** Même mécanisme que VaultAdminScreen (isVaultAdmin, RPC is_vault_admin),
   * calculé une fois par le parent (DossierScreen) plutôt que par notice. */
  isAdmin: boolean;
  /** Appelé après tout ajout/suppression réussi — le parent recharge la liste des demandes. */
  onChanged: () => void;
}

/** Titre par défaut à la promotion : marque + modèle si non vide, sinon le
 * nom de fichier sans l'extension .pdf. */
function defaultPromoteTitle(marque: string, modele: string | null, nomFichier: string): string {
  const base = `${marque} ${modele ?? ''}`.trim();
  if (base) return base;
  return nomFichier.replace(/\.pdf$/i, '');
}

/** doc_type_suggere n'est jamais garanti dans le sous-ensemble proposé à la
 * promotion (saisi à la déclaration, potentiellement plus ancien) — repli
 * sur 'autre' plutôt que de présélectionner une valeur hors de la liste. */
function defaultPromoteDocType(suggested: DocType | null): DocType {
  return suggested && (NOTICE_DOC_TYPES as readonly DocType[]).includes(suggested) ? suggested : 'autre';
}

/**
 * Notices PDF jointes à une demande d'équipement (staging, §11 CLAUDE.md —
 * aucune validation admin requise). Construit indépendamment de PlansSection
 * plutôt que factorisé : viewer plein écran + ouverture propres à cette
 * fonctionnalité, même logique que CarnetSection (mémoire projet — pas
 * d'abstraction partagée entre visualiseurs plein écran).
 */
export function EquipmentRequestNotices({
  requestId,
  notices,
  isOnline,
  status,
  marque,
  modele,
  isAdmin,
  onChanged,
}: EquipmentRequestNoticesProps) {
  const { showToast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EquipmentRequestFile | null>(null);

  // Promotion vers la bibliothèque (admin, demande approuvée uniquement).
  const [pendingPromote, setPendingPromote] = useState<EquipmentRequestFile | null>(null);
  const [promoteTitle, setPromoteTitle] = useState('');
  const [promoteDocType, setPromoteDocType] = useState<DocType>('autre');
  const [promoting, setPromoting] = useState(false);
  // fileId -> document_id : bascule l'affichage sur "déjà dans la
  // bibliothèque" immédiatement après une promotion réussie, sans attendre
  // le rechargement complet de la liste des demandes (onChanged).
  const [promotedOverrides, setPromotedOverrides] = useState<Record<string, string>>({});

  // Viewer plein écran in-app pour iOS uniquement — window.open('blob:…')
  // échoue sur iOS quand il suit un await (Safari bloque hors du geste
  // synchrone), même pattern que PlansSection.handleOpenPdf.
  const [openedNotice, setOpenedNotice] = useState<EquipmentRequestFile | null>(null);
  const [openedBlob, setOpenedBlob] = useState<Blob | null>(null);
  const [openedLoading, setOpenedLoading] = useState(false);
  const [openedError, setOpenedError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset volontaire à chaque changement de notice ouverte, avant de recharger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenedBlob(null);
    setOpenedError(null);
    if (!openedNotice) return;
    setOpenedLoading(true);
    void (async () => {
      try {
        const blob = await getEquipmentRequestNoticeBlob(openedNotice.storage_key);
        if (!cancelled) setOpenedBlob(blob);
      } catch (err) {
        if (!cancelled) setOpenedError(err instanceof Error ? err.message : "Échec de l'ouverture de la notice.");
      } finally {
        if (!cancelled) setOpenedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openedNotice]);

  /** Ouverture native (non-iOS) : window.open('_blank', 'noopener') renvoie
   * toujours null avec 'noopener' (par design) — pas de branchement sur son
   * retour. Revoke différé, jamais immédiat, sinon le lecteur natif n'a pas
   * le temps de charger. Même pattern que PlansSection.handleOpenPdfNative. */
  const handleOpenNative = async (notice: EquipmentRequestFile) => {
    if (busyId) return;
    setBusyId(notice.id);
    try {
      const blob = await getEquipmentRequestNoticeBlob(notice.storage_key);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Échec de l'ouverture de la notice.");
    } finally {
      setBusyId(null);
    }
  };

  const handleOpen = (notice: EquipmentRequestFile) => {
    if (!isOnline) return;
    if (isIosDevice()) {
      setOpenedNotice(notice);
    } else {
      void handleOpenNative(notice);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Seuls les fichiers PDF peuvent être joints.');
      return;
    }
    setUploading(true);
    try {
      await attachEquipmentRequestNotice(requestId, file);
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Échec de l'envoi de la notice.");
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteEquipmentRequestNotice(pendingDelete.id, pendingDelete.storage_key);
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de la suppression.');
    } finally {
      setPendingDelete(null);
    }
  };

  const openPromote = (notice: EquipmentRequestFile) => {
    setPromoteTitle(defaultPromoteTitle(marque, modele, notice.nom_fichier));
    setPromoteDocType(defaultPromoteDocType(notice.doc_type_suggere));
    setPendingPromote(notice);
  };

  const confirmPromote = async () => {
    if (!pendingPromote) return;
    const notice = pendingPromote;
    setPromoting(true);
    try {
      const result = await promoteEquipmentNotice(notice.id, promoteTitle.trim(), promoteDocType);
      if (result.document_id) {
        setPromotedOverrides((prev) => ({ ...prev, [notice.id]: result.document_id! }));
        showToast(
          result.alreadyPromoted ? 'Cette notice est déjà dans la bibliothèque.' : 'Notice ajoutée à la bibliothèque.'
        );
      } else {
        // La notice reste promouvable (aucun état local changé) — spec §3.
        showToast(result.message ?? "L'ajout à la bibliothèque a échoué, réessayez.");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "L'ajout à la bibliothèque a échoué, réessayez.");
    } finally {
      setPromoting(false);
      setPendingPromote(null);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      {notices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {notices.map((notice) => {
            const promotedId = notice.promoted_document_id ?? promotedOverrides[notice.id] ?? null;
            const canPromote = !promotedId && isAdmin && status === 'approved';
            return (
              <div key={notice.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={noticeRowStyle}>
                  <button
                    type="button"
                    onClick={() => handleOpen(notice)}
                    disabled={!isOnline || busyId === notice.id}
                    style={{ ...noticeButtonStyle, opacity: !isOnline ? 0.5 : 1 }}
                  >
                    <NoticeIcon />
                    <span style={{ minWidth: 0, textAlign: 'left' }}>
                      <span style={noticeNameStyle}>{notice.nom_fichier}</span>
                      {notice.doc_type_suggere && (
                        <span style={noticeMetaStyle}>{docTypeLabel(notice.doc_type_suggere)}</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(notice)}
                    disabled={!isOnline}
                    style={{ ...noticeDeleteButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                  >
                    Supprimer
                  </button>
                </div>
                {promotedId ? (
                  <span style={promotedBadgeStyle}>✓ dans la bibliothèque</span>
                ) : (
                  canPromote && (
                    <button
                      type="button"
                      onClick={() => openPromote(notice)}
                      disabled={!isOnline}
                      style={{ ...promoteButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                    >
                      Promouvoir vers la bibliothèque
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      <label style={{ ...attachButtonStyle, opacity: !isOnline || uploading ? 0.5 : 1 }}>
        {uploading ? 'Envoi…' : '+ Joindre une notice'}
        <input
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => void handleFileChange(e)}
          disabled={!isOnline || uploading}
          style={{ display: 'none' }}
        />
      </label>

      {pendingDelete && (
        <ConfirmSheet
          title="Supprimer cette notice ?"
          message={`« ${pendingDelete.nom_fichier} » sera définitivement retirée de la demande.`}
          confirmLabel="Supprimer"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {pendingPromote && (
        <ConfirmSheet
          title="Promouvoir vers la bibliothèque ?"
          message="Confirme le titre et le type avant l'ajout — l'ingestion prend quelques secondes."
          confirmLabel={promoting ? 'Promotion…' : 'Promouvoir'}
          confirmDisabled={promoting}
          onCancel={() => setPendingPromote(null)}
          onConfirm={() => void confirmPromote()}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
              <span style={{ color: textA(0.65) }}>Titre</span>
              <input
                value={promoteTitle}
                onChange={(e) => setPromoteTitle(e.target.value)}
                disabled={promoting}
                style={promoteInputStyle}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
              <span style={{ color: textA(0.65) }}>Type de document</span>
              <select
                value={promoteDocType}
                onChange={(e) => setPromoteDocType(e.target.value as DocType)}
                disabled={promoting}
                style={promoteInputStyle}
              >
                {NOTICE_DOC_TYPES.map((dt) => (
                  <option key={dt} value={dt}>
                    {docTypeLabel(dt)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </ConfirmSheet>
      )}

      {openedNotice && (
        <div style={pdfViewerOverlayStyle}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <button type="button" onClick={() => setOpenedNotice(null)} aria-label="Fermer" style={viewerCloseButtonStyle}>
              ‹
            </button>
            <span style={viewerTitleStyle}>{openedNotice.nom_fichier}</span>
          </div>
          <div style={pdfViewerBodyStyle}>
            {openedError ? (
              <span style={pdfViewerMessageStyle}>Aperçu impossible : {openedError}</span>
            ) : openedLoading || !openedBlob ? (
              <span style={pdfViewerMessageStyle}>Chargement de l'aperçu…</span>
            ) : (
              <Suspense fallback={<span style={pdfViewerMessageStyle}>Chargement de l'aperçu…</span>}>
                <PdfViewer blob={openedBlob} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoticeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: 'none' }}>
      <path
        d="M5 2.5h7l3 3v12a1 1 0 01-1 1H5a1 1 0 01-1-1v-14a1 1 0 011-1z"
        fill="none"
        stroke={colors.accent}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 2.5v3h3" fill="none" stroke={colors.accent} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const noticeRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: colors.card,
  borderRadius: 10,
  padding: '8px 10px',
};

const noticeButtonStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
};

const noticeNameStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13.5,
  fontWeight: 700,
  color: colors.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const noticeMetaStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  color: textA(0.55),
  fontWeight: 500,
  marginTop: 1,
};

const noticeDeleteButtonStyle: React.CSSProperties = {
  flex: 'none',
  background: 'transparent',
  border: 'none',
  color: textA(0.55),
  fontSize: 11.5,
  fontWeight: 700,
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
};

const attachButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  marginTop: 8,
  fontSize: 12.5,
  fontWeight: 700,
  color: colors.accent,
  cursor: 'pointer',
};

const promoteButtonStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  background: 'transparent',
  border: `1px solid ${colors.accent}`,
  borderRadius: radius.pill,
  color: colors.accent,
  fontSize: 11.5,
  fontWeight: 700,
  padding: '4px 10px',
  cursor: 'pointer',
};

const promotedBadgeStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 11.5,
  fontWeight: 700,
  color: textA(0.55),
  padding: '2px 2px',
};

const promoteInputStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 10,
  border: `1px solid ${textA(0.25)}`,
  background: textA(0.08),
  color: colors.text,
  fontSize: 15,
  fontFamily: fonts.sans,
  padding: '0 12px',
  boxSizing: 'border-box',
  width: '100%',
};

const pdfViewerOverlayStyle: React.CSSProperties = {
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

const viewerCloseButtonStyle: React.CSSProperties = {
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

const viewerTitleStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 16,
  fontWeight: 700,
  color: colors.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const pdfViewerBodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: radius.xl,
  background: colors.bgDark,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
};

const pdfViewerMessageStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 13,
  color: textA(0.55),
  padding: 16,
  textAlign: 'center',
  lineHeight: 1.6,
};
