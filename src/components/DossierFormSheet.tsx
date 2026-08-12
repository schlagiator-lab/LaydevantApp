import { useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { createDossier, updateDossier, deleteDossierIfEmpty } from '../lib/dossiers';
import type { Dossier } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';
import { ConfirmSheet } from './ConfirmSheet';

export interface DossierFormSheetProps {
  /** Présent = édition d'un dossier existant ; absent = création. */
  dossier?: Dossier;
  /** Édition uniquement : "dossier vide" calculé par le parent à partir des
   * compteurs déjà chargés (aucune requête ici). Absent tant que ces
   * compteurs ne sont pas tous connus — le bouton Supprimer reste alors caché. */
  isEmpty?: boolean;
  /** Libellés des sections encore non vides ("équipements", "photos", ...),
   * affichés dans le message bloquant quand `isEmpty` vaut false. */
  blockingLabels?: string[];
  onClose: () => void;
  onCreated: (dossier: Dossier) => void;
  /** Appelé après suppression réussie côté serveur. */
  onDeleted?: () => void;
}

/** Les erreurs Supabase/PostgREST sont de simples objets `{ message, ... }`,
 * jamais des instances d'Error — point de passage unique avant affichage. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return String(err);
}

const DOSSIER_NON_VIDE_PREFIX = 'DOSSIER_NON_VIDE:';

/** Extrait la liste des sections bloquantes du message d'erreur RPC, ou
 * `null` si ce n'est pas ce type d'erreur (filet de sécurité serveur, en
 * course avec le pré-check client — voir §10 CLAUDE.md). */
function extractDossierNonVideDetail(message: string): string | null {
  const idx = message.indexOf(DOSSIER_NON_VIDE_PREFIX);
  if (idx === -1) return null;
  return message.slice(idx + DOSSIER_NON_VIDE_PREFIX.length).trim();
}

/** Formulaire de création/édition — nom du client requis, adresse et notes optionnelles. */
export function DossierFormSheet({ dossier, isEmpty, blockingLabels, onClose, onCreated, onDeleted }: DossierFormSheetProps) {
  const { session, isOnline } = useAuth();
  const isEdit = !!dossier;

  const [nomClient, setNomClient] = useState(dossier?.nom_client ?? '');
  const [adresse, setAdresse] = useState(dossier?.adresse ?? '');
  const [notes, setNotes] = useState(dossier?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const canSubmit = nomClient.trim().length > 0 && !submitting && !!session?.user.id;
  const canDelete = isEdit && isEmpty === true && isOnline && !deleting;

  const handleSubmit = async () => {
    if (!canSubmit || !session) return;
    setSubmitting(true);
    setError(null);
    try {
      const saved = isEdit
        ? await updateDossier(dossier!.id, {
            nomClient: nomClient.trim(),
            adresse: adresse.trim() || null,
            notes: notes.trim() || null,
          })
        : await createDossier({
            nomClient: nomClient.trim(),
            adresse: adresse.trim() || null,
            notes: notes.trim() || null,
            createdBy: session.user.id,
          });
      onCreated(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Échec de ${isEdit ? 'la modification' : 'la création'}.`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!dossier) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDossierIfEmpty(dossier.id);
      setPendingDelete(false);
      onDeleted?.();
    } catch (err) {
      setPendingDelete(false);
      const msg = errorMessage(err);
      const detail = extractDossierNonVideDetail(msg);
      setError(detail ? `Impossible de supprimer : le dossier contient encore ${detail}. Videz ces sections d'abord.` : msg);
    } finally {
      setDeleting(false);
    }
  };

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

        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>
          {isEdit ? 'Modifier le dossier' : 'Nouveau dossier'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Nom du client">
            <input
              value={nomClient}
              onChange={(e) => setNomClient(e.target.value)}
              placeholder="ex. Résidence Les Tilleuls"
              style={inputStyle}
              autoFocus
            />
          </Field>
          <Field label="Adresse">
            <input
              value={adresse}
              onChange={(e) => setAdresse(e.target.value)}
              placeholder="ex. Rue du Lac 12, 1800 Vevey"
              style={inputStyle}
            />
          </Field>
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              style={{ ...inputStyle, height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }}
            />
          </Field>
        </div>

        {error && <p style={{ fontSize: 13, color: colors.accent, marginTop: 14 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}
          >
            {submitting ? (isEdit ? 'Enregistrement…' : 'Création…') : isEdit ? 'Enregistrer' : 'Créer le dossier'}
          </button>
        </div>

        {isEdit && isEmpty !== undefined && (
          <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${textA(0.12)}` }}>
            {!isEmpty && blockingLabels && blockingLabels.length > 0 && (
              <p style={{ fontSize: 12.5, color: textA(0.6), lineHeight: 1.5, marginBottom: 10 }}>
                Impossible de supprimer : le dossier contient encore {blockingLabels.join(', ')}. Videz ces sections
                d'abord.
              </p>
            )}
            <button
              type="button"
              onClick={() => canDelete && setPendingDelete(true)}
              disabled={!canDelete}
              style={{ ...deleteButtonStyle, opacity: canDelete ? 1 : 0.4, cursor: canDelete ? 'pointer' : 'default' }}
            >
              {deleting ? 'Suppression…' : 'Supprimer ce dossier'}
            </button>
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmSheet
          title="Supprimer définitivement ce dossier ?"
          message="Cette action est irréversible."
          confirmLabel="Supprimer"
          onCancel={() => setPendingDelete(false)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
      <span style={{ color: textA(0.65) }}>{label}</span>
      {children}
    </label>
  );
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

const secondaryButtonStyle: React.CSSProperties = {
  flex: 1,
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
  flex: 1,
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
};

const deleteButtonStyle: React.CSSProperties = {
  width: '100%',
  height: 48,
  borderRadius: 12,
  border: '1px solid #D14343',
  background: 'transparent',
  color: '#E77373',
  fontSize: 15,
  fontWeight: 700,
  boxSizing: 'border-box',
};
