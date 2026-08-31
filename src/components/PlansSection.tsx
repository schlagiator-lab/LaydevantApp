import { lazy, Suspense, useEffect, useState } from 'react';
import { useToast } from '../lib/useToast';
import { deleteDossierPlan, getDossierPlanBlob, getPhotoObjectUrl, updateDossierPlanTitre } from '../lib/dossiers';
import { isIosDevice, pdfImageMegapixels } from '../lib/pdfMeasure';
import { formatBytes } from '../lib/storagePersistence';
import type { DossierPlanView } from '../types/database';
import { ConfirmSheet } from './ConfirmSheet';
import { colors, fonts, radius, textA } from '../styles/tokens';

// pdf.js (~1 MB with its worker) is only needed once a PDF plan is actually
// opened — code-split out, same pattern as DocumentScreen/CommunicationsScreen.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));

// Certains plans sont des PDF-image (scan haute résolution, Adobe Image
// Conversion) : une seule image JPEG de plusieurs centaines de mégapixels.
// pdf.js doit la décoder en mémoire pour rendre le canvas — ce que le
// process WebKit d'iOS (mémoire plafonnée) ne supporte pas, il est tué
// ("un problème récurrent est survenu"). Android/desktop ouvrent l'original
// sans problème : ce plafond ne s'applique que sur iOS (mesure décode-free,
// pdfMeasure.ts). Ajustable au test.
const IOS_MAX_PLAN_MEGAPIXELS = 30;

export interface PlansSectionProps {
  isOnline: boolean;
  plans: DossierPlanView[] | null;
  onPlansChanged: () => void;
}

type PlanKind = 'pdf' | 'dwg' | 'image' | 'file';

function planKind(mime: string | null): PlanKind {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/acad') return 'dwg';
  if (mime?.startsWith('image/')) return 'image';
  return 'file';
}

/** Nom affiché/téléchargé : le titre s'il existe, sinon le nom de fichier
 * embarqué dans la clé R2 (plans/<dossier_id>/<uuid>-<nom>). */
function planLabel(plan: DossierPlanView): string {
  if (plan.titre) return plan.titre;
  const slash = plan.storage_key.lastIndexOf('/');
  const filename = slash === -1 ? plan.storage_key : plan.storage_key.slice(slash + 1);
  const dash = filename.indexOf('-');
  return dash === -1 ? filename : filename.slice(dash + 1);
}

const KIND_TEXT: Record<PlanKind, string> = { pdf: 'PDF', dwg: 'DWG', image: 'Image', file: 'Fichier' };

/**
 * Plans du dossier (PDF, DWG, images, autres fichiers) — carnet visuel dupliqué
 * volontairement depuis CarnetSection plutôt que factorisé (visualiseur plein
 * écran indépendant, comme la galerie), pour ne pas coupler deux fonctionnalités
 * qui évoluent séparément. L'ajout vit dans DossierScreen (slot `action` du
 * CollapsibleSection), pas ici.
 */
export function PlansSection({ isOnline, plans, onPlansChanged }: PlansSectionProps) {
  const { showToast } = useToast();

  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [viewedPlan, setViewedPlan] = useState<DossierPlanView | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DossierPlanView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Viewer plein écran in-app pour un plan PDF — remplace window.open('blob:…'),
  // bloqué par Safari iOS quand il suit un await (même pattern que
  // CommunicationsScreen/DocumentScreen).
  const [openedPlan, setOpenedPlan] = useState<DossierPlanView | null>(null);
  const [openedBlob, setOpenedBlob] = useState<Blob | null>(null);
  const [openedLoading, setOpenedLoading] = useState(false);
  const [openedError, setOpenedError] = useState<string | null>(null);
  // iOS uniquement : mesuré une fois le Blob obtenu, jamais sur Android/desktop.
  const [tooDetailedForIos, setTooDetailedForIos] = useState(false);
  // Bouton "Partager" de l'en-tête de l'overlay — état local à ce bouton,
  // indépendant du `sharing` interne à PlanTooDetailedCard (chemin > 30 Mpx).
  const [sharingOpenedPlan, setSharingOpenedPlan] = useState(false);

  // Vignettes uniquement pour les plans image — jamais de fetch pour
  // pdf/dwg/file avant un clic explicite (pas de preview pour ces types,
  // poids potentiellement lourd).
  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    const imagePlans = (plans ?? []).filter((p) => planKind(p.mime) === 'image');
    if (imagePlans.length > 0) {
      void (async () => {
        setThumbUrls({});
        for (const plan of imagePlans) {
          try {
            const url = await getPhotoObjectUrl(plan.storage_key);
            if (cancelled) {
              URL.revokeObjectURL(url);
              continue;
            }
            urls[plan.id] = url;
            setThumbUrls((prev) => ({ ...prev, [plan.id]: url }));
          } catch {
            // Vignette individuelle indisponible : le reste de la liste s'affiche quand même.
          }
        }
      })();
    }
    return () => {
      cancelled = true;
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [plans]);

  // Fetch du Blob du plan PDF ouvert en plein écran — déclenché à l'ouverture
  // plutôt qu'au montage. Reset au démontage/à la fermeture pour ne pas garder
  // un gros Blob PDF en mémoire une fois le viewer fermé.
  useEffect(() => {
    let cancelled = false;
    // Reset volontaire à chaque changement de plan ouvert, avant de recharger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenedBlob(null);
    setOpenedError(null);
    setTooDetailedForIos(false);
    if (!openedPlan) return;
    setOpenedLoading(true);
    void (async () => {
      try {
        const blob = await getDossierPlanBlob(openedPlan.storage_key);
        if (cancelled) return;
        // Mesure décode-free, iOS uniquement : ne jamais rendre un PDF-image
        // monstre dans un canvas sur iOS (§IOS_MAX_PLAN_MEGAPIXELS). Aucune
        // mesure sur Android/desktop — chemin inchangé.
        if (isIosDevice()) {
          const mpx = pdfImageMegapixels(await blob.arrayBuffer());
          if (cancelled) return;
          setTooDetailedForIos(mpx > IOS_MAX_PLAN_MEGAPIXELS);
        }
        setOpenedBlob(blob);
      } catch (err) {
        if (!cancelled) setOpenedError(err instanceof Error ? err.message : "Échec de l'ouverture du PDF.");
      } finally {
        if (!cancelled) setOpenedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openedPlan]);

  const startEditTitle = (plan: DossierPlanView) => {
    setEditingTitleId(plan.id);
    setTitleDraft(plan.titre ?? '');
  };

  const handleSaveTitle = async (planId: string) => {
    const trimmed = titleDraft.trim();
    const newTitre = trimmed === '' ? null : trimmed;
    setSavingTitle(true);
    try {
      await updateDossierPlanTitre(planId, newTitre);
      onPlansChanged();
      setEditingTitleId(null);
      setViewedPlan((prev) => (prev && prev.id === planId ? { ...prev, titre: newTitre } : prev));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de la mise à jour du titre.');
    } finally {
      setSavingTitle(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteDossierPlan(pendingDelete.id);
      onPlansChanged();
      setViewedPlan((prev) => (prev && prev.id === pendingDelete.id ? null : prev));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de la suppression.');
    } finally {
      setPendingDelete(null);
    }
  };

  /** PDF : bifurcation par plateforme.
   * - iOS : viewer in-app (PdfViewer) — window.open('blob:…') échoue sur iOS
   *   quand il suit un await (Safari bloque hors du geste synchrone), d'où le
   *   viewer plein écran in-app avec son propre garde-fou "trop détaillé".
   * - Android/desktop : lecteur PDF natif, qui re-rastérise au zoom (net),
   *   contrairement au canvas pdf.js à résolution fixe — restaure le
   *   comportement d'avant le viewer in-app pour cette plateforme. */
  const handleOpenPdf = (plan: DossierPlanView) => {
    if (!isOnline) return;
    if (isIosDevice()) {
      setOpenedPlan(plan);
    } else {
      void handleOpenPdfNative(plan);
    }
  };

  /** Ouverture native (non-iOS) : pattern direct, identique à
   * DocumentScreen.handleOpenFullscreen — window.open('_blank', 'noopener')
   * renvoie TOUJOURS null quand 'noopener' est passé (par design, pas un
   * signal de blocage popup), donc pas de pré-ouverture synchrone ni de
   * branchement sur son retour ici. Revoke différé 60s, jamais immédiat,
   * sinon le lecteur natif n'a pas le temps de charger. */
  const handleOpenPdfNative = async (plan: DossierPlanView) => {
    if (busyId) return;
    setBusyId(plan.id);
    try {
      const blob = await getDossierPlanBlob(plan.storage_key);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Échec de l'ouverture du PDF.");
    } finally {
      setBusyId(null);
    }
  };

  /** DWG / fichier générique : pas de preview possible dans un navigateur — téléchargement direct. */
  const handleDownload = async (plan: DossierPlanView) => {
    if (busyId) return;
    setBusyId(plan.id);
    try {
      const url = await getPhotoObjectUrl(plan.storage_key);
      const a = document.createElement('a');
      a.href = url;
      a.download = planLabel(plan);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec du téléchargement.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Bouton "Partager" de l'overlay plein écran (openedPlan/openedBlob) —
   * porte de sortie iOS vers le visionneur natif (Fichiers/Aperçu), où le PDF
   * s'affiche net contrairement au canvas <PdfViewer> (échelle fixe, sans
   * devicePixelRatio, jamais re-rendu au zoom). Réutilise le Blob déjà en
   * mémoire pour cet overlay : un `await` avant navigator.share casserait le
   * geste utilisateur sur Safari iOS — même contrainte que
   * handleOpenPdfNative. Dupliqué depuis PlanTooDetailedCard.handleShare
   * (même patron que VaultSheet.handleShareFile/CarnetSection.handleExportPhoto)
   * plutôt que réutilisé : chemin > 30 Mpx laissé intact.
   */
  const handleShareOpened = async () => {
    if (!openedPlan || !openedBlob || sharingOpenedPlan) return;
    setSharingOpenedPlan(true);
    try {
      const file = new File([openedBlob], planFileName(openedPlan), { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: planLabel(openedPlan) });
      } else {
        const objectUrl = URL.createObjectURL(openedBlob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = planFileName(openedPlan);
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }
    } catch (err) {
      // Annulation volontaire du partage natif : comportement normal, pas une erreur.
      if (err instanceof Error && err.name === 'AbortError') return;
      showToast(err instanceof Error ? err.message : 'Échec du partage.');
    } finally {
      setSharingOpenedPlan(false);
    }
  };

  const handlePrimaryAction = (plan: DossierPlanView, kind: PlanKind) => {
    if (kind === 'image') setViewedPlan(plan);
    else if (kind === 'pdf') handleOpenPdf(plan);
    else void handleDownload(plan);
  };

  return (
    <section>
      {plans === null ? (
        <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
      ) : plans.length === 0 ? (
        <p style={{ fontSize: 14, color: textA(0.55) }}>Aucun plan pour ce dossier.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plans.map((plan) => {
            const kind = planKind(plan.mime);
            const label = planLabel(plan);
            const isEditing = editingTitleId === plan.id;
            const isBusy = busyId === plan.id;
            return (
              <div key={plan.id} style={rowStyle}>
                <button
                  type="button"
                  onClick={() => handlePrimaryAction(plan, kind)}
                  disabled={!isOnline || isBusy}
                  style={{ ...primaryButtonStyle, opacity: !isOnline ? 0.5 : 1 }}
                >
                  <span style={thumbStyle}>
                    {kind === 'image' ? (
                      thumbUrls[plan.id] ? (
                        <img src={thumbUrls[plan.id]} alt="" style={thumbImgStyle} />
                      ) : (
                        <PlanKindIcon kind="image" />
                      )
                    ) : (
                      <PlanKindIcon kind={kind} />
                    )}
                  </span>

                  {isEditing ? null : (
                    <span style={{ minWidth: 0, textAlign: 'left' }}>
                      <span style={titleTextStyle}>{label}</span>
                      <span style={metaTextStyle}>
                        {isBusy
                          ? kind === 'pdf'
                            ? 'Ouverture…'
                            : 'Téléchargement…'
                          : `${KIND_TEXT[kind]} · ${formatBytes(plan.taille)}`}
                      </span>
                    </span>
                  )}
                </button>

                {isEditing ? (
                  <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
                    <input
                      autoFocus
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSaveTitle(plan.id);
                        if (e.key === 'Escape') setEditingTitleId(null);
                      }}
                      placeholder="Titre du plan"
                      disabled={savingTitle}
                      style={titleInputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveTitle(plan.id)}
                      disabled={savingTitle}
                      style={titleSaveButtonStyle}
                    >
                      {savingTitle ? '…' : 'OK'}
                    </button>
                  </div>
                ) : (
                  <div style={rowActionsStyle}>
                    <button
                      type="button"
                      onClick={() => startEditTitle(plan)}
                      disabled={!isOnline}
                      style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                    >
                      Renommer
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(plan)}
                      disabled={!isOnline}
                      style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                    >
                      Supprimer
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pendingDelete && (
        <ConfirmSheet
          title="Supprimer ce plan ?"
          message="Ce plan sera retiré de la liste du dossier."
          confirmLabel="Supprimer"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {viewedPlan && thumbUrls[viewedPlan.id] && (
        <div onClick={() => setViewedPlan(null)} style={viewerOverlayStyle}>
          <button type="button" onClick={() => setViewedPlan(null)} aria-label="Fermer" style={viewerCloseButtonStyle}>
            ×
          </button>
          <div onClick={(e) => e.stopPropagation()} style={viewerContentStyle}>
            <div style={viewerTitleBarStyle}>
              {editingTitleId === viewedPlan.id ? (
                <>
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSaveTitle(viewedPlan.id);
                      if (e.key === 'Escape') setEditingTitleId(null);
                    }}
                    placeholder="Titre du plan"
                    disabled={savingTitle}
                    style={viewerTitleInputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveTitle(viewedPlan.id)}
                    disabled={savingTitle}
                    style={titleSaveButtonStyle}
                  >
                    {savingTitle ? '…' : 'OK'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => isOnline && startEditTitle(viewedPlan)}
                  disabled={!isOnline}
                  style={{ ...viewerTitleDisplayStyle, opacity: isOnline ? 1 : 0.6 }}
                >
                  {viewedPlan.titre ? viewedPlan.titre : '+ Ajouter un titre'}
                </button>
              )}
            </div>
            <img
              src={thumbUrls[viewedPlan.id]}
              alt=""
              style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain', borderRadius: 8 }}
            />
            <button
              type="button"
              onClick={() => setPendingDelete(viewedPlan)}
              disabled={!isOnline}
              style={{ ...viewerDeleteButtonStyle, opacity: isOnline ? 1 : 0.5 }}
            >
              Supprimer ce plan
            </button>
          </div>
        </div>
      )}

      {openedPlan && (
        <div style={pdfViewerOverlayStyle}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setOpenedPlan(null)}
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
                color: colors.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {planLabel(openedPlan)}
            </span>
            <button
              type="button"
              onClick={() => void handleShareOpened()}
              disabled={!openedBlob || sharingOpenedPlan}
              style={{
                flex: 'none',
                height: 32,
                borderRadius: radius.pill,
                background: textA(0.1),
                border: 'none',
                color: colors.text,
                fontSize: 13,
                fontWeight: 700,
                padding: '0 14px',
                cursor: 'pointer',
                opacity: !openedBlob || sharingOpenedPlan ? 0.5 : 1,
              }}
            >
              {sharingOpenedPlan ? 'Partage…' : 'Partager'}
            </button>
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
            ) : tooDetailedForIos ? (
              <PlanTooDetailedCard plan={openedPlan} blob={openedBlob} />
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
    </section>
  );
}

/** Nom de fichier pour le partage/téléchargement de l'original — le libellé
 * affiché du plan, complété en .pdf s'il ne l'a pas déjà (un titre saisi à la
 * main n'a pas forcément l'extension). */
function planFileName(plan: DossierPlanView): string {
  const label = planLabel(plan);
  return label.toLowerCase().endsWith('.pdf') ? label : `${label}.pdf`;
}

/**
 * Repli iOS pour un plan PDF-image trop lourd (§IOS_MAX_PLAN_MEGAPIXELS) :
 * décoder l'image pour le rendre tuerait le process WebKit, donc pas de
 * rendu du tout — juste le partage/téléchargement de l'original, exactement
 * le pattern navigator.share de CarnetSection.handleExportPhoto.
 */
function PlanTooDetailedCard({ plan, blob }: { plan: DossierPlanView; blob: Blob }) {
  const { showToast } = useToast();
  const [sharing, setSharing] = useState(false);

  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const file = new File([blob], planFileName(plan), { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: planLabel(plan) });
      } else {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = planFileName(plan);
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }
    } catch (err) {
      // Annulation volontaire du partage natif : comportement normal, pas une erreur.
      if (err instanceof Error && err.name === 'AbortError') return;
      showToast(err instanceof Error ? err.message : 'Échec du partage.');
    } finally {
      setSharing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
      <PlanKindIcon kind="pdf" />
      <span style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>Plan trop détaillé pour iPhone</span>
      <span style={{ fontSize: 13.5, color: textA(0.6), lineHeight: 1.5, maxWidth: 260 }}>
        Ce plan est consultable sur Android ou sur ordinateur.
      </span>
      <button type="button" onClick={() => void handleShare()} disabled={sharing} style={planShareButtonStyle}>
        {sharing ? 'Partage…' : "Partager / enregistrer l'original"}
      </button>
    </div>
  );
}

function PlanKindIcon({ kind }: { kind: PlanKind }) {
  if (kind === 'pdf') {
    return (
      <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
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
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M5 2.5h7l3 3v12a1 1 0 01-1 1H5a1 1 0 01-1-1v-14a1 1 0 011-1z"
        fill="none"
        stroke={textA(0.45)}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 2.5v3h3" fill="none" stroke={textA(0.45)} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: colors.card,
  borderRadius: 12,
  padding: '10px 12px',
};

const primaryButtonStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
};

const thumbStyle: React.CSSProperties = {
  flex: 'none',
  width: 44,
  height: 44,
  borderRadius: 10,
  overflow: 'hidden',
  background: textA(0.08),
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const thumbImgStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const titleTextStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 15,
  fontWeight: 700,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const metaTextStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  color: textA(0.55),
  fontWeight: 500,
  marginTop: 2,
};

const rowActionsStyle: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
};

const linkButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: textA(0.55),
  fontSize: 12,
  fontWeight: 700,
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
};

const titleInputStyle: React.CSSProperties = {
  flex: 1,
  height: 34,
  minWidth: 0,
  borderRadius: 8,
  border: `1px solid ${textA(0.25)}`,
  background: textA(0.05),
  color: colors.text,
  fontSize: 14,
  fontWeight: 600,
  padding: '0 10px',
  boxSizing: 'border-box',
};

const titleSaveButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 34,
  border: 'none',
  borderRadius: 8,
  background: colors.accent,
  color: '#132146',
  fontSize: 13,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const viewerOverlayStyle: React.CSSProperties = {
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

// Viewer plein écran in-app pour un plan PDF — remplace window.open() sur une
// URL blob:, bloqué par Safari iOS quand il suit un await. Même patron que
// CommunicationsScreen (commViewerOverlayStyle).
const pdfViewerOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: colors.bg,
  color: colors.text,
  zIndex: 1400,
  display: 'flex',
  flexDirection: 'column',
  padding: 16,
  boxSizing: 'border-box',
};

const viewerCloseButtonStyle: React.CSSProperties = {
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

const viewerContentStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  maxWidth: '100%',
  maxHeight: '100%',
};

const viewerTitleBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  maxWidth: 320,
};

const viewerTitleDisplayStyle: React.CSSProperties = {
  flex: 1,
  border: 'none',
  background: 'transparent',
  color: '#fff',
  fontSize: 14,
  fontWeight: 700,
  textAlign: 'center',
  cursor: 'pointer',
  padding: '4px 8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const viewerTitleInputStyle: React.CSSProperties = {
  flex: 1,
  height: 34,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.3)',
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  fontSize: 14,
  fontWeight: 600,
  padding: '0 10px',
  boxSizing: 'border-box',
};

const planShareButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: radius.pill,
  background: colors.accent,
  color: '#132146',
  fontSize: 14,
  fontWeight: 700,
  padding: '12px 20px',
  cursor: 'pointer',
};

const viewerDeleteButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: radius.pill,
  background: 'rgba(255, 255, 255, 0.15)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  padding: '10px 18px',
  cursor: 'pointer',
};
