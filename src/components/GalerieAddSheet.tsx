import { useState } from 'react';
import type { GalerieItem, Specialty } from '../types/database';
import { createGalerieItem, uploadGaleriePhoto, addGaleriePhotoRow, normalize } from '../lib/galerie';
import { colors, fonts, textA } from '../styles/tokens';

export interface GalerieAddSheetProps {
  specialty: Specialty;
  /** Items déjà chargés de la spécialité — pré-check d'unicité côté client avant tout upload. */
  items: GalerieItem[];
  createdBy: string;
  onClose: () => void;
  /** Appelé dès que l'item (et si possible ses photos) sont enregistrés — déclenche le rechargement de la grille. */
  onAdded: () => void;
}

interface PendingPhoto {
  file: File;
  libelle: string;
}

/** Formulaire d'ajout d'un produit à la galerie — ouvert à tout monteur connecté (pas de gating admin). */
export function GalerieAddSheet({ specialty, items, createdBy, onClose, onAdded }: GalerieAddSheetProps) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedNames, setFailedNames] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  const trimmedName = name.trim();
  const isDuplicate = trimmedName.length > 0 && items.some((it) => normalize(it.name) === normalize(trimmedName));
  const canSubmit = trimmedName.length > 0 && !isDuplicate && !submitting;

  const handleFilesChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = Array.from(e.target.files ?? []);
    setPhotos(files.map((file) => ({ file, libelle: '' })));
  };

  const updateLibelle = (index: number, libelle: string) => {
    setPhotos((prev) => prev.map((p, i) => (i === index ? { ...p, libelle } : p)));
  };

  const removePhoto = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setFailedNames([]);
    try {
      const itemId = await createGalerieItem({
        specialtyId: specialty.id,
        name: trimmedName,
        brand: brand.trim() || null,
        notes: notes.trim() || null,
        createdBy,
      });

      const failures: string[] = [];
      for (let i = 0; i < photos.length; i++) {
        setProgress({ done: i, total: photos.length });
        const { file, libelle } = photos[i];
        try {
          const uploaded = await uploadGaleriePhoto(file, specialty.slug);
          await addGaleriePhotoRow(itemId, {
            storage_key: uploaded.storage_key,
            mime: uploaded.mime,
            libelle: libelle.trim() || null,
            largeur: uploaded.largeur,
            hauteur: uploaded.hauteur,
            taille: uploaded.taille,
            sort_order: i,
          });
        } catch {
          failures.push(file.name);
        }
      }
      setProgress(null);
      onAdded();

      if (failures.length > 0) {
        setFailedNames(failures);
        setDone(true);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de la création.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div onClick={submitting ? undefined : onClose} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} className="no-scrollbar" style={sheetStyle}>
        <div style={grabberStyle} />
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Ajouter une télécommande</div>

        {done ? (
          <>
            <p style={{ fontSize: 14, color: colors.text, marginBottom: 4 }}>Produit créé.</p>
            <p style={{ fontSize: 13.5, color: colors.accent }}>
              Échec de l'envoi de {failedNames.length} photo{failedNames.length > 1 ? 's' : ''} : {failedNames.join(', ')}.
            </p>
            <button type="button" onClick={onClose} style={{ ...primaryButtonStyle, marginTop: 18 }}>
              Fermer
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Nom du modèle">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ex. S476"
                  style={inputStyle}
                  autoFocus
                  disabled={submitting}
                />
              </Field>
              {isDuplicate && (
                <p style={{ fontSize: 13, color: colors.accent, margin: 0 }}>
                  Un produit porte déjà ce nom dans cette spécialité.
                </p>
              )}
              <Field label="Marque (optionnel)">
                <input
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="ex. Somfy"
                  style={inputStyle}
                  disabled={submitting}
                />
              </Field>
              <Field label="Notes (optionnel)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  style={{ ...inputStyle, height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }}
                  disabled={submitting}
                />
              </Field>
              <Field label="Photos">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFilesChange}
                  disabled={submitting}
                  style={{ fontSize: 13, color: colors.text }}
                />
              </Field>

              {photos.length === 1 && (
                <p style={{ fontSize: 12.5, color: textA(0.6), margin: 0 }}>1 photo sélectionnée : {photos[0].file.name}</p>
              )}

              {photos.length > 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {photos.map((p, i) => (
                    <div key={i} style={photoRowStyle}>
                      <span style={{ fontSize: 12.5, fontWeight: 700, flex: 'none', width: 16 }}>{i + 1}.</span>
                      <span
                        style={{
                          fontSize: 12,
                          flex: 'none',
                          maxWidth: 90,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: textA(0.7),
                        }}
                      >
                        {p.file.name}
                      </span>
                      <input
                        value={p.libelle}
                        onChange={(e) => updateLibelle(i, e.target.value)}
                        placeholder="Libellé (optionnel)"
                        disabled={submitting}
                        style={{ ...inputStyle, height: 34, fontSize: 12.5, flex: 1 }}
                      />
                      <button
                        type="button"
                        onClick={() => removePhoto(i)}
                        disabled={submitting}
                        aria-label="Retirer cette photo"
                        style={removeButtonStyle}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p style={{ fontSize: 13, color: colors.accent, marginTop: 14 }}>{error}</p>}
            {progress && (
              <p style={{ fontSize: 13, color: textA(0.65), marginTop: 14 }}>
                Envoi des photos… {progress.done + 1}/{progress.total}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={onClose} disabled={submitting} style={secondaryButtonStyle}>
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}
              >
                {submitting ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </>
        )}
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

const photoRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const removeButtonStyle: React.CSSProperties = {
  flex: 'none',
  width: 26,
  height: 26,
  borderRadius: '50%',
  border: 'none',
  background: textA(0.15),
  color: colors.text,
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
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
