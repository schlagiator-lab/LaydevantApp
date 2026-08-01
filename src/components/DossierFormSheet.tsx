import { useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { createDossier, updateDossier } from '../lib/dossiers';
import type { Dossier } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

export interface DossierFormSheetProps {
  /** Présent = édition d'un dossier existant ; absent = création. */
  dossier?: Dossier;
  onClose: () => void;
  onCreated: (dossier: Dossier) => void;
}

/** Formulaire de création/édition — nom du client requis, adresse et notes optionnelles. */
export function DossierFormSheet({ dossier, onClose, onCreated }: DossierFormSheetProps) {
  const { session } = useAuth();
  const isEdit = !!dossier;

  const [nomClient, setNomClient] = useState(dossier?.nom_client ?? '');
  const [adresse, setAdresse] = useState(dossier?.adresse ?? '');
  const [notes, setNotes] = useState(dossier?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = nomClient.trim().length > 0 && !submitting && !!session?.user.id;

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
      </div>
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
