import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { getAllPinnedDocuments } from '../lib/db';
import {
  getDossier,
  listDossierEquipments,
  getDossierDocumentsComplets,
  removeDossierEquipment,
  removeDossierDocument,
  listDossierNotes,
  listDossierPhotos,
  listDossierPlans,
  listDossierEquipmentRequests,
  deleteEquipmentRequest,
  uploadDossierPlan,
  type DossierEquipment,
} from '../lib/dossiers';
import type {
  Dossier,
  DossierDocumentComplet,
  DossierNoteView,
  DossierPhotoView,
  DossierPlanView,
  EquipmentRequest,
} from '../types/database';
import { StatusPill } from '../components/StatusPill';
import { DocumentCard } from '../components/DocumentCard';
import { AddEquipmentSheet } from '../components/AddEquipmentSheet';
import { AddDossierDocumentSheet } from '../components/AddDossierDocumentSheet';
import { EquipmentRequestSheet } from '../components/EquipmentRequestSheet';
import { EquipmentRequestNotices } from '../components/EquipmentRequestNotices';
import { DossierFormSheet } from '../components/DossierFormSheet';
import { CarnetSection } from '../components/CarnetSection';
import { PlansSection } from '../components/PlansSection';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { VaultSheet } from '../components/VaultSheet';
import { getVaultSecret, hasVaultAccess, dossierVaultHasContent } from '../lib/vaultSecrets';
import { isVaultAdmin } from '../lib/vaultAdmin';
import { colors, fonts, radius, textA, accentA } from '../styles/tokens';

/** Même format que VaultAdminScreen.tsx:783 — dupliqué localement (dette
 * connue, signalée §12 du morceau 2, pas de partage inter-écrans introduit
 * pour ce petit bout de texte). */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** "3 notes · 2 photos" — omet les segments à 0, "Vide" si les deux sont à 0. */
function formatCarnetBadge(notesCount: number, photosCount: number): string {
  const parts: string[] = [];
  if (notesCount > 0) parts.push(`${notesCount} note${notesCount > 1 ? 's' : ''}`);
  if (photosCount > 0) parts.push(`${photosCount} photo${photosCount > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(' · ') : 'Vide';
}

/** "3 plans" / "1 plan" — appelant ne rend ce badge que si count > 0. */
function formatPlansBadge(count: number): string {
  return `${count} plan${count > 1 ? 's' : ''}`;
}

/** Les erreurs Supabase/PostgREST sont de simples objets `{ message, ... }`,
 * jamais des instances d'Error — `String(err)` dessus donne "[object Object]".
 * Point de passage unique pour tout message d'erreur affiché à l'écran. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return String(err);
}

/**
 * Fiche dossier client (brief dossiers clients, étape A). Tout en ligne pour
 * cette étape : le chargement initial exige le réseau, mais des données déjà
 * chargées restent affichées si la connexion tombe ensuite — seules les
 * actions d'écriture (ajout/retrait) sont bloquées hors ligne.
 */
export function DossierScreen({ dossierId }: { dossierId: string }) {
  const { isOnline, session } = useAuth();
  const nav = useNavigation();
  const { showToast } = useToast();

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [equipments, setEquipments] = useState<DossierEquipment[] | null>(null);
  const [equipmentRequests, setEquipmentRequests] = useState<EquipmentRequest[] | null>(null);
  // Distinct de equipmentRequests (pending) : demandes déjà approuvées, dont
  // les notices jointes deviennent promouvables vers la bibliothèque.
  const [approvedEquipmentRequests, setApprovedEquipmentRequests] = useState<EquipmentRequest[] | null>(null);
  const [documents, setDocuments] = useState<DossierDocumentComplet[] | null>(null);
  const [notes, setNotes] = useState<DossierNoteView[] | null>(null);
  const [photos, setPhotos] = useState<DossierPhotoView[] | null>(null);
  const [plans, setPlans] = useState<DossierPlanView[] | null>(null);
  const [planUploadProgress, setPlanUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [equipmentsError, setEquipmentsError] = useState<string | null>(null);
  const [equipmentRequestsError, setEquipmentRequestsError] = useState<string | null>(null);
  const [approvedEquipmentRequestsError, setApprovedEquipmentRequestsError] = useState<string | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [photosError, setPhotosError] = useState<string | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [showAddEquipment, setShowAddEquipment] = useState(false);
  const [showAddEquipmentRequest, setShowAddEquipmentRequest] = useState(false);
  const [showAddDocument, setShowAddDocument] = useState(false);
  const [pendingRemoveEquipment, setPendingRemoveEquipment] = useState<DossierEquipment | null>(null);
  const [pendingRemoveDocument, setPendingRemoveDocument] = useState<DossierDocumentComplet | null>(null);
  const [pendingDeleteEquipmentRequest, setPendingDeleteEquipmentRequest] = useState<EquipmentRequest | null>(null);
  const [deletingEquipmentRequest, setDeletingEquipmentRequest] = useState(false);
  const [showVault, setShowVault] = useState(false);
  const [showEditDossier, setShowEditDossier] = useState(false);
  // null = pas encore su (chargement ou hors ligne) ; true/false = présence
  // réelle d'une ligne vault_secrets, sans jamais la déchiffrer ici.
  const [hasVaultNote, setHasVaultNote] = useState<boolean | null>(null);
  // Indicateur du badge "Chiffré" (en-tête repliée) : null = pas d'info à
  // montrer (pas encore su, ou pas d'accès coffre — ne RIEN révéler dans ce
  // cas). Sinon 'vide' | 'configure', via dossier_vault_has_content — qui
  // constate juste qu'une ligne vault_secrets existe, jamais son contenu
  // déchiffré. D'où "configuré" et non "contient des données" : supprimer la
  // dernière note laisse la ligne en place (ciphertext d'un tableau vide),
  // donc ce signal reste à true après un coffre vidé — libellé volontairement
  // sous-promettant plutôt que de prétendre refléter le nombre de notes.
  const [vaultBadgeExtra, setVaultBadgeExtra] = useState<'vide' | 'configure' | null>(null);
  // Même mécanisme que VaultAdminScreen (isVaultAdmin, RPC is_vault_admin) —
  // gate le bouton "Promouvoir vers la bibliothèque" des notices de demande
  // d'équipement (EquipmentRequestNotices). false par défaut : pas de bouton
  // tant que l'appel n'a pas répondu, jamais un faux positif.
  const [isAdmin, setIsAdmin] = useState(false);

  // Chaque section a son propre chargement, indépendant des autres : l'échec
  // d'une seule (ex. listDossierPlans) ne doit jamais empêcher les autres de
  // s'afficher — plus de Promise.all + try/catch unique qui faisait tomber
  // tout l'écran sur la moindre erreur. Chaque fonction sert aussi de retry
  // (bouton "Réessayer" dans la section concernée).
  const loadDossier = async () => {
    setLoadError(null);
    try {
      setDossier(await getDossier(dossierId));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const loadEquipments = async () => {
    setEquipmentsError(null);
    try {
      setEquipments(await listDossierEquipments(dossierId));
    } catch (err) {
      setEquipmentsError(errorMessage(err));
    }
  };

  const loadEquipmentRequests = async () => {
    setEquipmentRequestsError(null);
    try {
      setEquipmentRequests(await listDossierEquipmentRequests(dossierId));
    } catch (err) {
      setEquipmentRequestsError(errorMessage(err));
    }
  };

  const loadApprovedEquipmentRequests = async () => {
    setApprovedEquipmentRequestsError(null);
    try {
      setApprovedEquipmentRequests(await listDossierEquipmentRequests(dossierId, { status: 'approved' }));
    } catch (err) {
      setApprovedEquipmentRequestsError(errorMessage(err));
    }
  };

  const loadDocuments = async () => {
    setDocumentsError(null);
    try {
      setDocuments(await getDossierDocumentsComplets(dossierId));
    } catch (err) {
      setDocumentsError(errorMessage(err));
    }
  };

  const loadNotes = async () => {
    setNotesError(null);
    try {
      setNotes(await listDossierNotes(dossierId));
    } catch (err) {
      setNotesError(errorMessage(err));
    }
  };

  const loadPhotos = async () => {
    setPhotosError(null);
    try {
      setPhotos(await listDossierPhotos(dossierId));
    } catch (err) {
      setPhotosError(errorMessage(err));
    }
  };

  const loadPlans = async () => {
    setPlansError(null);
    try {
      setPlans(await listDossierPlans(dossierId));
    } catch (err) {
      setPlansError(errorMessage(err));
    }
  };

  useEffect(() => {
    if (!isOnline) return;
    void (async () => {
      // Chaque section part indépendamment (pas de await ici) : l'échec ou
      // la lenteur de l'une n'attend pas les autres et ne les bloque pas.
      void loadDossier();
      void loadEquipments();
      void loadEquipmentRequests();
      void loadApprovedEquipmentRequests();
      void loadDocuments();
      void loadNotes();
      void loadPhotos();
      void loadPlans();

      // Best-effort : une épingle non chargée dégrade juste l'affichage des
      // documents ("nécessite du réseau" au lieu de "disponible hors ligne"),
      // jamais bloquant pour le reste de l'écran — pas d'état d'erreur dédié.
      void getAllPinnedDocuments()
        .then((pinned) => setPinnedIds(new Set(pinned.map((p) => p.id))))
        .catch(() => {});

      // Coffre (Données sensibles) : comportement inchangé — existence seule
      // (RLS filtre déjà les non-autorisés), jamais de déchiffrement ici.
      void getVaultSecret(dossierId)
        .catch(() => null)
        .then((vaultSecret) => setHasVaultNote(vaultSecret !== null));

      // Gate admin des notices de demande d'équipement (promotion vers la
      // bibliothèque) — best-effort, comportement dégradé silencieux (pas de
      // bouton) en cas d'échec plutôt qu'un état d'erreur dédié.
      void isVaultAdmin()
        .catch(() => false)
        .then(setIsAdmin);

      // Indicateur du badge "Chiffré" : réutilise le pré-check d'accès déjà
      // en place (hasVaultAccess, celui de VaultSheet) — si l'utilisateur n'a
      // pas accès au coffre, on ne révèle rien, jamais d'appel RPC superflu.
      // Échec silencieux : ce n'est qu'un indicateur d'en-tête, comportement
      // inchangé.
      try {
        const allowed = await hasVaultAccess();
        if (!allowed) {
          setVaultBadgeExtra(null);
        } else {
          const contains = await dossierVaultHasContent(dossierId);
          setVaultBadgeExtra(contains ? 'configure' : 'vide');
        }
      } catch {
        setVaultBadgeExtra(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierId, isOnline]);

  const handleRemoveEquipment = async (productId: string) => {
    try {
      await removeDossierEquipment(dossierId, productId);
      setEquipments((prev) => (prev ? prev.filter((e) => e.productId !== productId) : prev));
    } catch (err) {
      showToast(errorMessage(err));
    }
  };

  const handleRemoveDocument = async (documentId: string) => {
    try {
      await removeDossierDocument(dossierId, documentId);
      setDocuments((prev) => (prev ? prev.filter((d) => d.id !== documentId) : prev));
    } catch (err) {
      showToast(errorMessage(err));
    }
  };

  const confirmRemoveEquipment = async () => {
    if (!pendingRemoveEquipment) return;
    await handleRemoveEquipment(pendingRemoveEquipment.productId);
    setPendingRemoveEquipment(null);
  };

  const confirmRemoveDocument = async () => {
    if (!pendingRemoveDocument) return;
    await handleRemoveDocument(pendingRemoveDocument.id);
    setPendingRemoveDocument(null);
  };

  // La demande peut venir de l'une ou l'autre liste (pending/approved) selon
  // son statut — recharger les deux plutôt que de suivre laquelle, plus
  // simple et sans risque d'incohérence.
  const confirmDeleteEquipmentRequest = async () => {
    if (!pendingDeleteEquipmentRequest) return;
    setDeletingEquipmentRequest(true);
    try {
      await deleteEquipmentRequest(pendingDeleteEquipmentRequest);
      void loadEquipmentRequests();
      void loadApprovedEquipmentRequests();
      setPendingDeleteEquipmentRequest(null);
    } catch (err) {
      showToast(errorMessage(err));
    } finally {
      setDeletingEquipmentRequest(false);
    }
  };

  const handleOpenDocument = (doc: DossierDocumentComplet) => {
    const pinned = pinnedIds.has(doc.id);
    if (!pinned && !isOnline) {
      showToast(`Connexion réseau requise pour ouvrir « ${doc.title} ».`);
      return;
    }
    nav.goDocument(doc.id);
  };

  // Envoi séquentiel (pas Promise.all) : une connexion chantier ne supporte
  // pas des uploads en parallèle. Un échec par fichier n'interrompt pas les
  // suivants ; onPlansChanged (ici : un simple re-fetch) n'est appelé qu'une
  // fois à la fin.
  const handlePlanFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const auteur = session?.user.id;
    if (files.length === 0 || !auteur) return;

    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < files.length; i++) {
      setPlanUploadProgress({ current: i + 1, total: files.length });
      try {
        await uploadDossierPlan(dossierId, files[i], auteur);
        successCount++;
      } catch {
        failCount++;
      }
    }
    setPlanUploadProgress(null);
    void listDossierPlans(dossierId).then(setPlans);
    if (failCount > 0) {
      showToast(
        `${successCount} plan${successCount > 1 ? 's' : ''} ajouté${successCount > 1 ? 's' : ''}, ${failCount} échec${failCount > 1 ? 's' : ''}`
      );
    }
  };

  const equipmentProductIds = new Set((equipments ?? []).map((e) => e.productId));
  const documentIds = new Set((documents ?? []).map((d) => d.id));

  // Pré-check UX de suppression : réutilise EXACTEMENT les compteurs déjà en
  // mémoire (aucune requête de comptage supplémentaire). Le résultat n'est
  // que pour l'affichage — delete_dossier_if_empty revérifie côté serveur.
  // Un coffre configuré n'entre PAS dans ce calcul : ce n'est plus un motif
  // de "dossier non vide" côté serveur, c'est géré par DossierFormSheet
  // (admin → suppression directe, non-admin → demande de suppression) —
  // le bouton doit donc rester actionnable même quand vaultBadgeExtra vaut
  // 'configure', sinon un monteur avec accès coffre ne peut jamais cliquer.
  const blockingLabels: string[] = [];
  if ((equipments?.length ?? 0) > 0) blockingLabels.push('équipements');
  if ((documents?.length ?? 0) > 0) blockingLabels.push('documentation');
  if ((notes?.length ?? 0) > 0) blockingLabels.push('notes');
  if ((photos?.length ?? 0) > 0) blockingLabels.push('photos');
  if ((plans?.length ?? 0) > 0) blockingLabels.push('plans');
  const dossierIsEmpty = blockingLabels.length === 0;

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: dossier ? 10 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={nav.goBack} aria-label="Retour" style={backButtonStyle}>
              ‹
            </button>
            <span style={eyebrowStyle}>Dossier client</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {dossier && (
              <button
                type="button"
                onClick={() => setShowEditDossier(true)}
                disabled={!isOnline}
                aria-label="Modifier le dossier"
                style={{ ...editButtonStyle, opacity: isOnline ? 1 : 0.4 }}
              >
                <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
                  <path
                    d="M14.5 3.5l2 2-9 9-2.6.6.6-2.6 9-9z"
                    fill="none"
                    stroke={colors.text}
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
            <StatusPill online={isOnline} />
          </div>
        </div>

        {dossier && (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>{dossier.nom_client}</div>
              {dossier.adresse && (
                <div style={{ fontSize: 14, color: textA(0.65), fontWeight: 500, marginTop: 4 }}>{dossier.adresse}</div>
              )}
            </div>
            {dossier.notes && <div style={noteBadgeStyle}>{dossier.notes}</div>}
          </div>
        )}
      </div>

      {!isOnline && !dossier && (
        <div style={{ margin: '16px', ...offlineBannerStyle }}>
          <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
            Connexion réseau requise pour ouvrir ce dossier.
          </span>
        </div>
      )}

      {loadError && (
        <div style={{ margin: '16px' }}>
          <SectionError title="Dossier indisponible" message={loadError} onRetry={() => void loadDossier()} />
        </div>
      )}

      {dossier && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 24 }}>
          {!isOnline && (
            <div style={offlineBannerStyle}>
              <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
                Hors ligne — ajout et retrait indisponibles pour ce dossier.
              </span>
            </div>
          )}

          <CollapsibleSection
            title="Équipements"
            badge={
              <>
                {equipments !== null && <span style={countBadgeStyle}>{equipments.length}</span>}
                {equipmentRequests !== null && equipmentRequests.length > 0 && (
                  <span style={pendingCountBadgeStyle}>{equipmentRequests.length} en attente</span>
                )}
              </>
            }
            action={
              <button
                type="button"
                onClick={() => setShowAddEquipment(true)}
                disabled={!isOnline}
                style={{ ...addButtonStyle, opacity: isOnline ? 1 : 0.4 }}
              >
                + Ajouter
              </button>
            }
          >
            {equipmentsError ? (
              <SectionError title="Équipements indisponibles" message={equipmentsError} onRetry={() => void loadEquipments()} />
            ) : equipments === null ? (
              <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
            ) : (
              <>
                {equipments.length === 0 ? (
                  <p style={{ fontSize: 14, color: textA(0.55) }}>Aucun équipement rattaché à ce dossier.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {equipments.map((eq) => (
                      <div key={eq.productId} style={rowStyle}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {eq.productLabel}
                          </div>
                          <div style={{ fontSize: 12.5, color: textA(0.55), fontWeight: 500 }}>
                            {eq.specialtyName}
                            {eq.note ? ` · ${eq.note}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPendingRemoveEquipment(eq)}
                          disabled={!isOnline}
                          style={{ ...removeButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                        >
                          Retirer
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {equipmentRequestsError && (
                  <div style={{ marginTop: 10 }}>
                    <SectionError
                      title="Demandes indisponibles"
                      message={equipmentRequestsError}
                      onRetry={() => void loadEquipmentRequests()}
                    />
                  </div>
                )}

                {equipmentRequests !== null && equipmentRequests.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                    <p style={pendingBlockTitleStyle}>Demandes en attente</p>
                    {equipmentRequests.map((req) => (
                      <div key={req.id} style={{ ...pendingRowStyle, flexDirection: 'column', alignItems: 'stretch' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {req.marque}
                              {req.modele ? ` ${req.modele}` : ''}
                            </div>
                            {req.commentaire && (
                              <div style={{ fontSize: 12.5, color: textA(0.6), fontWeight: 500, marginTop: 2 }}>
                                {req.commentaire}
                              </div>
                            )}
                            <div style={{ fontSize: 11.5, color: textA(0.5), fontWeight: 600, marginTop: 4 }}>
                              Demandé par {req.requested_by_nom ?? 'inconnu'} le {formatDate(req.created_at)}
                            </div>
                          </div>
                          <span style={pendingChipStyle}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.accent }} />
                            En attente
                          </span>
                        </div>
                        {(isAdmin || req.requested_by === session?.user.id) && (
                          <button
                            type="button"
                            onClick={() => setPendingDeleteEquipmentRequest(req)}
                            disabled={!isOnline}
                            style={{ ...removeButtonStyle, alignSelf: 'flex-start', marginTop: 6, opacity: isOnline ? 1 : 0.4 }}
                          >
                            Supprimer la demande
                          </button>
                        )}
                        <EquipmentRequestNotices
                          requestId={req.id}
                          dossierId={dossierId}
                          notices={req.notices ?? []}
                          isOnline={isOnline}
                          status={req.status}
                          marque={req.marque}
                          modele={req.modele}
                          isAdmin={isAdmin}
                          onChanged={() => void loadEquipmentRequests()}
                          onEquipmentAdded={() => void loadEquipments()}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {approvedEquipmentRequestsError && (
                  <div style={{ marginTop: 10 }}>
                    <SectionError
                      title="Demandes approuvées indisponibles"
                      message={approvedEquipmentRequestsError}
                      onRetry={() => void loadApprovedEquipmentRequests()}
                    />
                  </div>
                )}

                {approvedEquipmentRequests !== null && approvedEquipmentRequests.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                    <p style={pendingBlockTitleStyle}>Demandes approuvées</p>
                    {approvedEquipmentRequests.map((req) => (
                      <div key={req.id} style={{ ...pendingRowStyle, flexDirection: 'column', alignItems: 'stretch' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {req.marque}
                              {req.modele ? ` ${req.modele}` : ''}
                            </div>
                            {req.commentaire && (
                              <div style={{ fontSize: 12.5, color: textA(0.6), fontWeight: 500, marginTop: 2 }}>
                                {req.commentaire}
                              </div>
                            )}
                            <div style={{ fontSize: 11.5, color: textA(0.5), fontWeight: 600, marginTop: 4 }}>
                              Demandé par {req.requested_by_nom ?? 'inconnu'} le {formatDate(req.created_at)}
                            </div>
                          </div>
                          <span style={pendingChipStyle}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.accent }} />
                            Approuvée
                          </span>
                        </div>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => setPendingDeleteEquipmentRequest(req)}
                            disabled={!isOnline}
                            style={{ ...removeButtonStyle, alignSelf: 'flex-start', marginTop: 6, opacity: isOnline ? 1 : 0.4 }}
                          >
                            Supprimer la demande
                          </button>
                        )}
                        <EquipmentRequestNotices
                          requestId={req.id}
                          dossierId={dossierId}
                          notices={req.notices ?? []}
                          isOnline={isOnline}
                          status={req.status}
                          marque={req.marque}
                          modele={req.modele}
                          isAdmin={isAdmin}
                          onChanged={() => void loadApprovedEquipmentRequests()}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowAddEquipmentRequest(true)}
                  disabled={!isOnline}
                  style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4, marginTop: 12 }}
                >
                  + Équipement absent de la base ?
                </button>
              </>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Documentation"
            badge={documents !== null && <span style={countBadgeStyle}>{documents.length}</span>}
            action={
              <button
                type="button"
                onClick={() => setShowAddDocument(true)}
                disabled={!isOnline}
                style={{ ...addButtonStyle, opacity: isOnline ? 1 : 0.4 }}
              >
                + Ajouter
              </button>
            }
          >
            {documentsError ? (
              <SectionError title="Documentation indisponible" message={documentsError} onRetry={() => void loadDocuments()} />
            ) : documents === null ? (
              <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
            ) : (
              <>
                {documents.length === 0 ? (
                  <p style={{ fontSize: 14, color: textA(0.55) }}>Aucun document rattaché à ce dossier.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {documents.map((doc) => {
                      const pinned = pinnedIds.has(doc.id);
                      return (
                        <div key={doc.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <DocumentCard
                            title={doc.title}
                            docType={doc.doc_type}
                            specialtyName={doc.specialty_name}
                            productLabel={doc.product_label}
                            excerptHtml={null}
                            pinned={pinned}
                            dim={!pinned && !isOnline}
                            onTap={() => handleOpenDocument(doc)}
                          />
                          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 4px' }}>
                            {doc.origine === 'direct' ? (
                              <button
                                type="button"
                                onClick={() => setPendingRemoveDocument(doc)}
                                disabled={!isOnline}
                                style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                              >
                                Retirer du dossier
                              </button>
                            ) : (
                              <span style={{ fontSize: 12, color: textA(0.4), fontWeight: 600 }}>Via équipement</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowAddEquipmentRequest(true)}
                  disabled={!isOnline}
                  style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4, marginTop: 12 }}
                >
                  + Document absent de la base ?
                </button>
              </>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Plans"
            badge={plans !== null && plans.length > 0 && <span style={carnetBadgeStyle}>{formatPlansBadge(plans.length)}</span>}
            action={
              <label
                style={{
                  ...addButtonStyle,
                  opacity: !isOnline || planUploadProgress ? 0.4 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  cursor: !isOnline || planUploadProgress ? 'default' : 'pointer',
                }}
              >
                {planUploadProgress ? `${planUploadProgress.current}/${planUploadProgress.total}` : '+ Ajouter'}
                <input
                  type="file"
                  accept=".pdf,.dwg,image/*"
                  multiple
                  onChange={(e) => void handlePlanFilesChange(e)}
                  disabled={!isOnline || planUploadProgress !== null || !session?.user.id}
                  style={{ display: 'none' }}
                />
              </label>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {plansError && (
                <SectionError title="Plans indisponibles" message={plansError} onRetry={() => void loadPlans()} />
              )}
              <PlansSection isOnline={isOnline} plans={plans} onPlansChanged={() => void loadPlans()} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Carnet"
            badge={
              notes !== null && photos !== null && (
                <span style={carnetBadgeStyle}>{formatCarnetBadge(notes.length, photos.length)}</span>
              )
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {notesError && (
                <SectionError title="Notes indisponibles" message={notesError} onRetry={() => void loadNotes()} />
              )}
              {photosError && (
                <SectionError title="Photos indisponibles" message={photosError} onRetry={() => void loadPhotos()} />
              )}
              <CarnetSection
                dossierId={dossierId}
                isOnline={isOnline}
                notes={notes}
                photos={photos}
                onNotesChanged={() => void loadNotes()}
                onPhotosChanged={() => void loadPhotos()}
              />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Données sensibles"
            badge={renderEncryptedBadge(vaultBadgeExtra)}
            keepMounted
            accentHeader={vaultBadgeExtra === 'configure'}
          >
            <button
              type="button"
              onClick={() => setShowVault(true)}
              disabled={!isOnline}
              style={{ ...sensitivePlaceholderStyle, opacity: isOnline ? 1 : 0.4, width: '100%', cursor: isOnline ? 'pointer' : 'default' }}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: 'none' }}>
                <rect x="4.5" y="9" width="11" height="8" rx="2" fill="none" stroke={textA(0.4)} strokeWidth="1.6" />
                <path d="M7 9V6.5a3 3 0 016 0V9" fill="none" stroke={textA(0.4)} strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 13, color: textA(0.5), fontWeight: 600 }}>
                {hasVaultNote === null
                  ? 'Mastercodes, WiFi — ouvrir le coffre'
                  : hasVaultNote
                    ? 'Coffre configuré — mastercodes, WiFi'
                    : 'Coffre vide — mastercodes, WiFi'}
              </span>
            </button>
          </CollapsibleSection>
        </div>
      )}

      {showEditDossier && dossier && (
        <DossierFormSheet
          dossier={dossier}
          isEmpty={dossierIsEmpty}
          blockingLabels={blockingLabels}
          onClose={() => setShowEditDossier(false)}
          onCreated={(saved) => {
            setDossier(saved);
            setShowEditDossier(false);
          }}
          onDeleted={() => {
            setShowEditDossier(false);
            showToast(`« ${dossier.nom_client} » a été supprimé.`);
            nav.goDossiers();
          }}
        />
      )}

      {showAddEquipment && dossier && (
        <AddEquipmentSheet
          dossierId={dossier.id}
          excludeProductIds={equipmentProductIds}
          onClose={() => setShowAddEquipment(false)}
          onAdded={() => void loadEquipments()}
          onRequestMissing={() => {
            setShowAddEquipment(false);
            setShowAddEquipmentRequest(true);
          }}
        />
      )}

      {showAddEquipmentRequest && dossier && (
        <EquipmentRequestSheet
          dossierId={dossier.id}
          onClose={() => setShowAddEquipmentRequest(false)}
          onCreated={() => {
            setShowAddEquipmentRequest(false);
            void loadEquipmentRequests();
          }}
          onAddedDirect={() => {
            setShowAddEquipmentRequest(false);
            void loadEquipments();
            void loadDocuments();
          }}
        />
      )}

      {showAddDocument && dossier && (
        <AddDossierDocumentSheet
          dossierId={dossier.id}
          excludeDocumentIds={documentIds}
          onClose={() => setShowAddDocument(false)}
          onAdded={() => void loadDocuments()}
          onRequestMissing={() => {
            setShowAddDocument(false);
            setShowAddEquipmentRequest(true);
          }}
        />
      )}

      {pendingRemoveEquipment && (
        <ConfirmSheet
          title="Retirer cet équipement ?"
          message={`« ${pendingRemoveEquipment.productLabel} » sera retiré du dossier. Les documents qui n'étaient rattachés que via cet équipement disparaîtront aussi de la documentation du dossier.`}
          onCancel={() => setPendingRemoveEquipment(null)}
          onConfirm={() => void confirmRemoveEquipment()}
        />
      )}

      {pendingRemoveDocument && (
        <ConfirmSheet
          title="Retirer ce document ?"
          message={`« ${pendingRemoveDocument.title} » sera retiré de la documentation du dossier.`}
          onCancel={() => setPendingRemoveDocument(null)}
          onConfirm={() => void confirmRemoveDocument()}
        />
      )}

      {pendingDeleteEquipmentRequest && (
        <ConfirmSheet
          title="Supprimer cette demande ?"
          message={`La demande « ${pendingDeleteEquipmentRequest.marque}${pendingDeleteEquipmentRequest.modele ? ` ${pendingDeleteEquipmentRequest.modele}` : ''} » et les notices qui lui sont jointes seront définitivement supprimées.`}
          confirmLabel={deletingEquipmentRequest ? 'Suppression…' : 'Supprimer'}
          confirmDisabled={deletingEquipmentRequest}
          danger
          onCancel={() => setPendingDeleteEquipmentRequest(null)}
          onConfirm={() => void confirmDeleteEquipmentRequest()}
        />
      )}

      {showVault && dossier && (
        <VaultSheet
          dossierId={dossier.id}
          onNotesCountChange={(count) => setHasVaultNote(count > 0)}
          onDestroyed={() => {
            setHasVaultNote(false);
            setVaultBadgeExtra('vide');
          }}
          onClose={() => setShowVault(false)}
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

const editButtonStyle: React.CSSProperties = {
  flex: 'none',
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: textA(0.1),
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const noteBadgeStyle: React.CSSProperties = {
  flex: 'none',
  maxWidth: 140,
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
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '9px 12px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  background: colors.card,
  borderRadius: 12,
  padding: '10px 12px',
};

const removeButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 32,
  borderRadius: 10,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
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

/** État d'erreur discret et réessayable d'une section — jamais l'objet
 * d'erreur brut, toujours un message déjà passé par errorMessage(). */
function SectionError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div style={sectionErrorStyle}>
      <p style={sectionErrorTitleStyle}>{title}</p>
      <p style={sectionErrorMessageStyle}>{message}</p>
      <button type="button" onClick={onRetry} style={{ ...linkButtonStyle, alignSelf: 'flex-start' }}>
        Réessayer
      </button>
    </div>
  );
}

const sectionErrorStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  background: 'rgba(222, 122, 34, 0.1)',
  border: '1px solid rgba(222, 122, 34, 0.3)',
  borderRadius: 12,
  padding: '10px 12px',
};

const sectionErrorTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  color: colors.accent,
};

const sectionErrorMessageStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: textA(0.6),
};

const sensitivePlaceholderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  border: `2px dashed ${textA(0.2)}`,
  borderRadius: 14,
  padding: '14px 16px',
  background: 'transparent',
  textAlign: 'left',
  boxSizing: 'border-box',
};

const addButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 32,
  borderRadius: radius.md,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const countBadgeStyle: React.CSSProperties = {
  flex: 'none',
  minWidth: 20,
  height: 20,
  padding: '0 7px',
  borderRadius: radius.pill,
  background: textA(0.12),
  color: textA(0.75),
  fontSize: 12,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

/** Second badge d'en-tête, distinct du compteur d'équipements réels — ne
 * fusionne jamais les deux chiffres (une demande n'est pas un équipement
 * actif). N'apparaît que si des demandes 'pending' existent. */
const pendingCountBadgeStyle: React.CSSProperties = {
  flex: 'none',
  padding: '3px 9px',
  borderRadius: radius.pill,
  background: accentA(0.18),
  color: colors.accent,
  fontSize: 11.5,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const pendingBlockTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: textA(0.55),
};

/** Fond/bordure teintés accent + trait pointillé : distingue visuellement une
 * demande (provisoire) d'un équipement réel (rowStyle, carte pleine). */
const pendingRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  background: accentA(0.06),
  border: `1px dashed ${accentA(0.35)}`,
  borderRadius: 12,
  padding: '10px 12px',
};

/** Même style que StatusChip(kind: 'pending') de VaultAdminScreen.tsx:1068 —
 * dupliqué localement plutôt qu'exporté (pas d'abstraction partagée entre
 * écrans pour ce petit badge). */
const pendingChipStyle: React.CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 9px',
  borderRadius: 100,
  background: accentA(0.18),
  color: colors.accent,
  fontSize: 11.5,
  fontWeight: 700,
};

const carnetBadgeStyle: React.CSSProperties = {
  flex: 'none',
  padding: '3px 9px',
  borderRadius: radius.pill,
  background: textA(0.12),
  color: textA(0.75),
  fontSize: 11.5,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const encryptedBadgeStyle: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 8px 3px 6px',
  borderRadius: radius.pill,
  background: textA(0.12),
  color: textA(0.75),
  fontSize: 11.5,
  fontWeight: 700,
};

/** Badge "Données sensibles" de l'en-tête repliée. `extra` reste `null` tant
 * que l'accès coffre n'est pas confirmé — jamais de fuite avant vérification.
 * "configuré" plutôt que "contient des données" : la seule chose constatée
 * est qu'une ligne vault_secrets existe, jamais son contenu déchiffré. */
function renderEncryptedBadge(extra: 'vide' | 'configure' | null) {
  return (
    <span style={encryptedBadgeStyle}>
      <svg width="11" height="11" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="4.5" y="9" width="11" height="8" rx="2" fill="none" stroke={textA(0.75)} strokeWidth="1.8" />
        <path d="M7 9V6.5a3 3 0 016 0V9" fill="none" stroke={textA(0.75)} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {extra === 'configure' ? 'Chiffré · configuré' : extra === 'vide' ? 'Chiffré · vide' : 'Chiffré'}
    </span>
  );
}
