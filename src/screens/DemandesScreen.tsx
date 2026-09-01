import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { acknowledgeFeedback, createDemande, demandeStatutLabel, demandeTypeLabel, listMesDemandes } from '../lib/demandes';
import { acknowledgeEquipmentRequests, listMyEquipmentRequests } from '../lib/dossiers';
import type { Demande, DemandeType, EquipmentRequest, EquipmentRequestStatus } from '../types/database';
import { accentA, colors, fonts, radius, successA, textA } from '../styles/tokens';

const TYPE_OPTIONS: DemandeType[] = ['amelioration', 'bug', 'autre'];

/** Le 4e onglet est un MODE d'affichage (source `dossier_equipment_requests`),
 * pas une valeur de `demandes.type` — jamais mélangé à `TYPE_OPTIONS`. */
type ActiveTab = DemandeType | 'equipment';

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/**
 * Dépôt d'une demande (canal de remontée terrain) + suivi des siennes. Écran
 * monteur uniquement, accessible depuis l'onglet "Outils" — le traitement
 * admin vit ailleurs. La RLS restreint déjà `listMesDemandes` aux lignes de
 * l'auteur courant, pas de filtre à faire ici.
 */
export function DemandesScreen() {
  const nav = useNavigation();
  const { session } = useAuth();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<ActiveTab>('amelioration');
  const mode: 'feedback' | 'equipment' = activeTab === 'equipment' ? 'equipment' : 'feedback';

  const [titre, setTitre] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [demandes, setDemandes] = useState<Demande[] | null | undefined>(null);
  const [opened, setOpened] = useState<Demande | null>(null);

  const [equipmentRequests, setEquipmentRequests] = useState<EquipmentRequest[] | null | undefined>(null);

  const reload = async () => {
    try {
      const rows = await listMesDemandes();
      setDemandes(rows);
    } catch {
      setDemandes(undefined);
    }
  };

  const reloadEquipment = async () => {
    try {
      const rows = await listMyEquipmentRequests();
      setEquipmentRequests(rows);
    } catch {
      setEquipmentRequests(undefined);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    void acknowledgeFeedback().catch(() => {});
  }, []);

  // Acquittement + rechargement à chaque bascule vers l'onglet équipement
  // (y compris si c'était déjà l'onglet actif au montage) — fire-and-forget,
  // un échec réseau ne casse pas l'affichage.
  useEffect(() => {
    if (mode !== 'equipment') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState survient après l'await réseau dans reloadEquipment, pas de façon synchrone (faux positif, même motif que reload() ci-dessus)
    void reloadEquipment();
    void acknowledgeEquipmentRequests().catch(() => {});
  }, [mode]);

  const canSubmit = mode === 'feedback' && message.trim().length > 0 && !submitting && !!session?.user.id;

  const handleSubmit = async () => {
    if (!canSubmit || !session?.user.id || mode !== 'feedback') return;
    setSubmitting(true);
    setError(null);
    try {
      await createDemande({
        type: activeTab as DemandeType,
        titre: titre.trim() || null,
        message: message.trim(),
        auteur: session.user.id,
      });
      showToast('Demande envoyée.');
      setActiveTab('amelioration');
      setTitre('');
      setMessage('');
      void reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'envoi.");
    } finally {
      setSubmitting(false);
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
        <span style={{ fontSize: 18, fontWeight: 700 }}>Mes demandes</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            background: colors.card,
            borderRadius: radius.xl,
            padding: 14,
            boxSizing: 'border-box',
          }}
        >
          <div className="no-scrollbar chip-row" style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, overflowX: 'auto' }}>
            {TYPE_OPTIONS.map((t) => (
              <button key={t} type="button" onClick={() => setActiveTab(t)} style={chipStyle(activeTab === t)}>
                {demandeTypeLabel(t)}
              </button>
            ))}
            <button type="button" onClick={() => setActiveTab('equipment')} style={chipStyle(activeTab === 'equipment')}>
              Demande d'équipement
            </button>
          </div>

          {mode === 'feedback' ? (
            <>
              <Field label="Titre (optionnel)">
                <input
                  value={titre}
                  onChange={(e) => setTitre(e.target.value)}
                  placeholder="ex. Ajouter un filtre par date"
                  style={inputStyle}
                />
              </Field>

              <Field label="Message">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder="Décris ta proposition, le bug rencontré, ou toute autre remarque…"
                  style={{ ...inputStyle, height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }}
                />
              </Field>

              {error && <p style={{ fontSize: 13, color: colors.accent, margin: 0 }}>{error}</p>}

              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}
              >
                {submitting ? 'Envoi…' : 'Envoyer'}
              </button>
            </>
          ) : (
            <p style={{ fontSize: 13, color: textA(0.55), margin: 0, lineHeight: 1.4 }}>
              Les demandes d'équipement se créent depuis un dossier, section Équipements/Documentation.
            </p>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: textA(0.65) }}>Mes demandes</span>

          {mode === 'feedback' ? (
            demandes === null ? (
              <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
            ) : demandes === undefined ? (
              <p style={{ fontSize: 14, color: colors.accent }}>Impossible de charger tes demandes.</p>
            ) : demandes.length === 0 ? (
              <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune demande pour l'instant.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {demandes.map((d) => (
                  <DemandeRow key={d.id} demande={d} onOpen={() => setOpened(d)} />
                ))}
              </div>
            )
          ) : equipmentRequests === null ? (
            <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
          ) : equipmentRequests === undefined ? (
            <p style={{ fontSize: 14, color: colors.accent }}>Impossible de charger tes demandes d'équipement.</p>
          ) : equipmentRequests.length === 0 ? (
            <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune demande d'équipement pour l'instant.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {equipmentRequests.map((r) => (
                <EquipmentRequestRow key={r.id} request={r} />
              ))}
            </div>
          )}
        </div>
      </div>

      {opened && <DemandeDetailSheet demande={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

function DemandeRow({ demande, onOpen }: { demande: Demande; onOpen: () => void }) {
  const label = demande.titre ?? demande.message.slice(0, 80) + (demande.message.length > 80 ? '…' : '');
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: colors.card,
        border: 'none',
        borderRadius: 12,
        padding: '10px 12px',
        boxSizing: 'border-box',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: colors.text }}>{label}</span>
          <span style={{ fontSize: 12, color: textA(0.55), fontWeight: 500 }}>
            {demandeTypeLabel(demande.type)} · {formatDate(demande.created_at)}
          </span>
        </div>
        <StatutBadge statut={demande.statut} />
        <span style={{ color: textA(0.35), fontSize: 18, lineHeight: '20px' }}>›</span>
      </div>

      {demande.reponse_admin && (
        <div
          style={{
            marginTop: 2,
            padding: '8px 10px',
            borderRadius: 8,
            background: textA(0.06),
            fontSize: 13,
            color: textA(0.8),
            lineHeight: 1.4,
          }}
        >
          <span style={{ fontWeight: 700, color: textA(0.6) }}>Réponse : </span>
          {demande.reponse_admin}
        </div>
      )}
    </button>
  );
}

/** Carte en lecture seule (pas de sheet de détail : la table n'a pas de
 * `reponse_admin`, rien de plus à montrer que ce qui est déjà ici). */
function EquipmentRequestRow({ request }: { request: EquipmentRequest }) {
  const label = (request.marque || 'Équipement') + (request.modele ? ` ${request.modele}` : '');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        background: colors.card,
        borderRadius: 12,
        padding: '10px 12px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: colors.text }}>{label}</span>
        <span style={{ fontSize: 12, color: textA(0.55), fontWeight: 500 }}>
          {request.nom_client ?? 'Dossier inconnu'} · {formatDate(request.created_at)}
        </span>
      </div>
      <EquipmentStatusBadge status={request.status} />
    </div>
  );
}

/** Détail en lecture seule d'une demande — message complet, statut, réponse
 * admin et date de résolution le cas échéant. Même pattern de bottom sheet
 * que NoteFormSheet, sans champs éditables (le suivi/traitement reste
 * exclusivement admin). */
function DemandeDetailSheet({ demande, onClose }: { demande: Demande; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        zIndex: 1200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="no-scrollbar"
        style={{
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          background: colors.bg,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: '18px 16px 24px',
          boxSizing: 'border-box',
          fontFamily: fonts.sans,
          color: colors.text,
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, background: textA(0.25), margin: '0 auto 16px' }} />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{demande.titre ?? demandeTypeLabel(demande.type)}</span>
            <span style={{ fontSize: 12.5, color: textA(0.55), fontWeight: 500 }}>
              {demandeTypeLabel(demande.type)} · déposée le {formatDate(demande.created_at)}
            </span>
          </div>
          <StatutBadge statut={demande.statut} />
        </div>

        <p style={{ fontSize: 14.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0, color: textA(0.9) }}>
          {demande.message}
        </p>

        {demande.reponse_admin && (
          <div
            style={{
              marginTop: 16,
              padding: '10px 12px',
              borderRadius: 10,
              background: textA(0.06),
              fontSize: 13.5,
              color: textA(0.85),
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, color: textA(0.6), marginBottom: 4 }}>
              Réponse{demande.resolved_at ? ` · ${formatDate(demande.resolved_at)}` : ''}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{demande.reponse_admin}</div>
          </div>
        )}

        <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, width: '100%', marginTop: 20 }}>
          Fermer
        </button>
      </div>
    </div>
  );
}

function StatusPill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: radius.pill,
        background: bg,
        color,
        fontSize: 11.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  );
}

function StatutBadge({ statut }: { statut: Demande['statut'] }) {
  const color = statut === 'traitee' ? colors.success : statut === 'en_cours' ? colors.text : colors.accent;
  const bg = statut === 'traitee' ? successA(0.18) : statut === 'en_cours' ? textA(0.1) : accentA(0.18);
  return <StatusPill label={demandeStatutLabel(statut)} color={color} bg={bg} />;
}

/** Même formule visuelle que StatutBadge (dot + pill) — pending reprend le
 * gris neutre déjà utilisé pour 'en_cours', approved/rejected reprennent
 * vert/orange comme traitee/nouvelle : aucune nouvelle couleur introduite. */
function EquipmentStatusBadge({ status }: { status: EquipmentRequestStatus }) {
  const color = status === 'approved' ? colors.success : status === 'rejected' ? colors.accent : colors.text;
  const bg = status === 'approved' ? successA(0.18) : status === 'rejected' ? accentA(0.18) : textA(0.1);
  const label = status === 'approved' ? 'Ajoutée en base' : status === 'rejected' ? 'Refusée' : 'En attente';
  return <StatusPill label={label} color={color} bg={bg} />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
      <span style={{ color: textA(0.65) }}>{label}</span>
      {children}
    </label>
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

const inputStyle: React.CSSProperties = {
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

const primaryButtonStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
};

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
