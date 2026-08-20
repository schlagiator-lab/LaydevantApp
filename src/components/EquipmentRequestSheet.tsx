import { useState } from 'react';
import { attachEquipmentRequestNotice, createEquipmentRequest } from '../lib/dossiers';
import { useToast } from '../lib/useToast';
import { docTypeLabel } from '../lib/docType';
import type { DocType } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

export interface EquipmentRequestSheetProps {
  dossierId: string;
  onClose: () => void;
  /** Appelé après création réussie — le parent recharge la liste des demandes. */
  onCreated: () => void;
}

/** Sous-ensemble de DocType proposé à la saisie — même liste que CaptureSheet
 * (recherche web de notices) : schema/fiche_perso n'ont pas de sens pour une
 * notice fabricant jointe à une demande d'équipement. */
const NOTICE_DOC_TYPES: DocType[] = ['notice_installation', 'manuel_programmation', 'fiche_technique', 'autre'];

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

/**
 * Déclare un équipement absent de la base (item 1) : marque obligatoire,
 * modèle et commentaire optionnels. La demande créée est 'pending' — c'est un
 * admin qui la résout plus tard (transformation en produit rattaché).
 */
export function EquipmentRequestSheet({ dossierId, onClose, onCreated }: EquipmentRequestSheetProps) {
  const { showToast } = useToast();
  const [marque, setMarque] = useState('');
  const [modele, setModele] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<DocType | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = marque.trim().length > 0 && !submitting;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!picked) return;
    if (picked.type !== 'application/pdf' && !picked.name.toLowerCase().endsWith('.pdf')) {
      showToast('Seuls les fichiers PDF peuvent être joints.');
      return;
    }
    setFile(picked);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createEquipmentRequest({
        dossierId,
        marque: marque.trim(),
        modele: modele.trim() || undefined,
        commentaire: commentaire.trim() || undefined,
      });
      if (file) {
        try {
          await attachEquipmentRequestNotice(created.id, file, docType || undefined);
        } catch {
          // La déclaration reste valable même si la notice n'a pas pu être jointe —
          // réessayable depuis la carte "en attente" (EquipmentRequestNotices).
          showToast("Équipement déclaré, mais la notice n'a pas pu être jointe — réessayez depuis la demande.");
        }
      }
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} className="no-scrollbar" style={sheetStyle}>
        <div style={grabberStyle} />
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Équipement absent de la base</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Marque">
            <input
              value={marque}
              onChange={(e) => setMarque(e.target.value)}
              placeholder="ex. Bosch"
              style={inputStyle}
              autoFocus
            />
          </Field>
          <Field label="Modèle">
            <input
              value={modele}
              onChange={(e) => setModele(e.target.value)}
              placeholder="ex. EasyControl"
              style={inputStyle}
            />
          </Field>
          <Field label="Commentaire">
            <textarea
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              rows={3}
              style={{ ...inputStyle, height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }}
            />
          </Field>
          <Field label="Joindre la notice (PDF, optionnel)">
            <input
              type="file"
              accept=".pdf,application/pdf"
              onChange={handleFileChange}
              style={{ ...inputStyle, height: 'auto', paddingTop: 8, paddingBottom: 8 }}
            />
            {file && <span style={{ fontSize: 12.5, color: textA(0.6), marginTop: 4 }}>{file.name}</span>}
          </Field>
          {file && (
            <Field label="Type de document (optionnel)">
              <select value={docType} onChange={(e) => setDocType(e.target.value as DocType | '')} style={inputStyle}>
                <option value="">—</option>
                {NOTICE_DOC_TYPES.map((dt) => (
                  <option key={dt} value={dt}>
                    {docTypeLabel(dt)}
                  </option>
                ))}
              </select>
            </Field>
          )}
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
            {submitting ? 'Envoi…' : 'Envoyer la demande'}
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

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'flex-end',
  zIndex: 1200,
};

const sheetStyle: React.CSSProperties = {
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
};

const grabberStyle: React.CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 2,
  background: textA(0.25),
  margin: '0 auto 16px',
};

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
