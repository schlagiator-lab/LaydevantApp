import { useState } from 'react';
import { createDossierNote, updateDossierNote } from '../lib/dossiers';
import type { DossierNoteView } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

export interface NoteFormSheetProps {
  dossierId: string;
  auteur: string;
  /** Note à modifier, ou null pour une création. */
  note: DossierNoteView | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Ajout ou édition d'une note du carnet — titre optionnel, texte requis. */
export function NoteFormSheet({ dossierId, auteur, note, onClose, onSaved }: NoteFormSheetProps) {
  const [titre, setTitre] = useState(note?.titre ?? '');
  const [texte, setTexte] = useState(note?.texte ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = texte.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (note) {
        await updateDossierNote(note.id, { titre: titre.trim() || null, texte: texte.trim() });
      } else {
        await createDossierNote({ dossierId, titre: titre.trim() || null, texte: texte.trim(), auteur });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de l’enregistrement.');
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
          {note ? 'Modifier la note' : 'Nouvelle note'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Titre (optionnel)">
            <input
              value={titre}
              onChange={(e) => setTitre(e.target.value)}
              placeholder="ex. Accès local technique"
              style={inputStyle}
              autoFocus
            />
          </Field>
          <Field label="Texte">
            <textarea
              value={texte}
              onChange={(e) => setTexte(e.target.value)}
              rows={5}
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
            {submitting ? 'Enregistrement…' : note ? 'Enregistrer' : 'Ajouter la note'}
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
