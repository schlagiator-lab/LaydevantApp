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
  type DossierEquipment,
} from '../lib/dossiers';
import type { Dossier, DossierDocumentComplet } from '../types/database';
import { StatusPill } from '../components/StatusPill';
import { DocumentCard } from '../components/DocumentCard';
import { AddEquipmentSheet } from '../components/AddEquipmentSheet';
import { AddDossierDocumentSheet } from '../components/AddDossierDocumentSheet';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { VaultSheet } from '../components/VaultSheet';
import { VaultRotationSheet } from '../components/VaultRotationSheet';
import { getVaultSecret } from '../lib/vaultSecrets';
import { isVaultAdmin } from '../lib/vaultAdmin';
import { colors, fonts, textA } from '../styles/tokens';

/**
 * Fiche dossier client (brief dossiers clients, étape A). Tout en ligne pour
 * cette étape : le chargement initial exige le réseau, mais des données déjà
 * chargées restent affichées si la connexion tombe ensuite — seules les
 * actions d'écriture (ajout/retrait) sont bloquées hors ligne.
 */
export function DossierScreen({ dossierId }: { dossierId: string }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();
  const { showToast } = useToast();

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [equipments, setEquipments] = useState<DossierEquipment[] | null>(null);
  const [documents, setDocuments] = useState<DossierDocumentComplet[] | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddEquipment, setShowAddEquipment] = useState(false);
  const [showAddDocument, setShowAddDocument] = useState(false);
  const [pendingRemoveEquipment, setPendingRemoveEquipment] = useState<DossierEquipment | null>(null);
  const [pendingRemoveDocument, setPendingRemoveDocument] = useState<DossierDocumentComplet | null>(null);
  const [showVault, setShowVault] = useState(false);
  // null = pas encore su (chargement ou hors ligne) ; true/false = présence
  // réelle d'une ligne vault_secrets, sans jamais la déchiffrer ici.
  const [hasVaultNote, setHasVaultNote] = useState<boolean | null>(null);
  // Gate d'affichage du bouton de rotation uniquement : la RPC
  // rotate_vault_secret revérifie is_vault_admin() elle-même côté serveur,
  // ce n'est donc jamais le SEUL garde-fou. Défaut false (fail-safe) si le
  // check échoue — jamais afficher un geste destructeur sur une incertitude.
  const [isAdmin, setIsAdmin] = useState(false);
  const [showRotation, setShowRotation] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isOnline) return;
      setLoadError(null);
      try {
        const [d, eqs, docs, pinned, vaultSecret, admin] = await Promise.all([
          getDossier(dossierId),
          listDossierEquipments(dossierId),
          getDossierDocumentsComplets(dossierId),
          getAllPinnedDocuments(),
          // Existence seule (RLS filtre déjà les non-autorisés) — jamais de
          // déchiffrement ici, juste savoir s'il y a quelque chose à ouvrir.
          getVaultSecret(dossierId).catch(() => null),
          isVaultAdmin().catch(() => false),
        ]);
        if (cancelled) return;
        setDossier(d);
        setEquipments(eqs);
        setDocuments(docs);
        setPinnedIds(new Set(pinned.map((p) => p.id)));
        setHasVaultNote(vaultSecret !== null);
        setIsAdmin(admin);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dossierId, isOnline]);

  const handleRemoveEquipment = async (productId: string) => {
    try {
      await removeDossierEquipment(dossierId, productId);
      setEquipments((prev) => (prev ? prev.filter((e) => e.productId !== productId) : prev));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec du retrait.');
    }
  };

  const handleRemoveDocument = async (documentId: string) => {
    try {
      await removeDossierDocument(dossierId, documentId);
      setDocuments((prev) => (prev ? prev.filter((d) => d.id !== documentId) : prev));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec du retrait.');
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

  const handleOpenDocument = (doc: DossierDocumentComplet) => {
    const pinned = pinnedIds.has(doc.id);
    if (!pinned && !isOnline) {
      showToast(`Connexion réseau requise pour ouvrir « ${doc.title} ».`);
      return;
    }
    nav.goDocument(doc.id);
  };

  const equipmentProductIds = new Set((equipments ?? []).map((e) => e.productId));
  const documentIds = new Set((documents ?? []).map((d) => d.id));

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
          <StatusPill online={isOnline} />
        </div>

        {dossier && (
          <>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>{dossier.nom_client}</div>
            {dossier.adresse && (
              <div style={{ fontSize: 14, color: textA(0.65), fontWeight: 500, marginTop: 4 }}>{dossier.adresse}</div>
            )}
            {dossier.notes && (
              <div style={{ fontSize: 13.5, color: textA(0.6), lineHeight: 1.5, marginTop: 8 }}>{dossier.notes}</div>
            )}
          </>
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

      {loadError && <p style={{ margin: '16px', fontSize: 14, color: colors.accent }}>Erreur : {loadError}</p>}

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

          <section>
            <SectionHeader title="Équipements" onAdd={() => setShowAddEquipment(true)} addDisabled={!isOnline} />
            {equipments === null ? (
              <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
            ) : equipments.length === 0 ? (
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
          </section>

          <section>
            <SectionHeader title="Documentation" onAdd={() => setShowAddDocument(true)} addDisabled={!isOnline} />
            {documents === null ? (
              <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
            ) : documents.length === 0 ? (
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
          </section>

          <section>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Données sensibles</div>
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
            {isAdmin && hasVaultNote === true && (
              <button
                type="button"
                onClick={() => setShowRotation(true)}
                disabled={!isOnline}
                style={{ ...rotateVaultButtonStyle, opacity: isOnline ? 1 : 0.4 }}
              >
                Faire tourner la clé de ce coffre
              </button>
            )}
          </section>
        </div>
      )}

      {showAddEquipment && dossier && (
        <AddEquipmentSheet
          dossierId={dossier.id}
          excludeProductIds={equipmentProductIds}
          onClose={() => setShowAddEquipment(false)}
          onAdded={() => {
            void listDossierEquipments(dossier.id).then(setEquipments);
          }}
        />
      )}

      {showAddDocument && dossier && (
        <AddDossierDocumentSheet
          dossierId={dossier.id}
          excludeDocumentIds={documentIds}
          onClose={() => setShowAddDocument(false)}
          onAdded={() => {
            void getDossierDocumentsComplets(dossier.id).then(setDocuments);
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

      {showVault && dossier && (
        <VaultSheet
          dossierId={dossier.id}
          onClose={() => {
            setShowVault(false);
            void getVaultSecret(dossier.id)
              .then((secret) => setHasVaultNote(secret !== null))
              .catch(() => {});
          }}
        />
      )}

      {showRotation && dossier && (
        <VaultRotationSheet dossierId={dossier.id} dossierName={dossier.nom_client} onClose={() => setShowRotation(false)} />
      )}
    </div>
  );
}

function SectionHeader({ title, onAdd, addDisabled }: { title: string; onAdd: () => void; addDisabled: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      <button
        type="button"
        onClick={onAdd}
        disabled={addDisabled}
        style={{ ...addButtonStyle, opacity: addDisabled ? 0.4 : 1 }}
      >
        + Ajouter
      </button>
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

const addButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 32,
  borderRadius: 10,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
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

const rotateVaultButtonStyle: React.CSSProperties = {
  marginTop: 8,
  width: '100%',
  height: 40,
  borderRadius: 12,
  border: `1px solid ${colors.accent}`,
  background: 'transparent',
  color: colors.accent,
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  boxSizing: 'border-box',
};
