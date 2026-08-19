import { useEffect, useMemo, useState } from 'react';
import type { Department, Specialty } from '../types/database';
import type { WebSearchResult, WebSearchResultType } from '../types/webSearch';
import { getLocalDepartments, getLocalSpecialties } from '../lib/db';
import { submitIngestFromUrl } from '../lib/captureIngest';
import { useToast } from '../lib/useToast';
import { docTypeLabel } from '../lib/docType';
import { colors, fonts, textA } from '../styles/tokens';

const DOC_TYPES: Exclude<WebSearchResultType, 'video'>[] = [
  'notice_installation',
  'manuel_programmation',
  'fiche_technique',
  'autre',
];

export interface CaptureSheetProps {
  result: WebSearchResult;
  brand: string;
  model: string;
  onClose: () => void;
  /** Capture réussie — le parent ferme la feuille et rafraîchit si besoin. */
  onCaptured: () => void;
}

/**
 * Feuille de confirmation avant capture vers la bibliothèque (Feature
 * recherche web notices.md, §5) : les métadonnées auto-détectées par la
 * recherche web ne sont pas fiables à 100 %, tout reste éditable, et la
 * spécialité doit être choisie parmi celles de la base (CLAUDE.md §3).
 */
export function CaptureSheet({ result, brand, model, onClose, onCaptured }: CaptureSheetProps) {
  const { showToast } = useToast();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [title, setTitle] = useState(result.title);
  const [brandField, setBrandField] = useState(brand);
  const [modelField, setModelField] = useState(model);
  const [specialtyId, setSpecialtyId] = useState('');
  const [docType, setDocType] = useState<WebSearchResultType>(result.type);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [depts, specs] = await Promise.all([getLocalDepartments(), getLocalSpecialties()]);
      if (cancelled) return;
      setDepartments(depts);
      setSpecialties(specs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const specialtiesByDepartment = useMemo(() => {
    const map = new Map<string, Specialty[]>();
    for (const s of specialties) {
      const list = map.get(s.department_id) ?? [];
      list.push(s);
      map.set(s.department_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [specialties]);

  const canSubmit = title.trim().length > 0 && brandField.trim().length > 0 && specialtyId !== '' && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const specialty = specialties.find((s) => s.id === specialtyId);
    if (!specialty) return;

    setSubmitting(true);
    setError(null);
    try {
      await submitIngestFromUrl({
        pdf_url: result.url,
        brand: brandField.trim(),
        model: modelField.trim(),
        specialty_slug: specialty.slug,
        doc_type: docType,
        title: title.trim(),
        source_url: result.url,
      });
      showToast('Document ajouté à la bibliothèque.');
      onCaptured();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'ajout.");
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

        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Ajouter à la bibliothèque</div>
        <div style={{ fontSize: 13, color: textA(0.6), marginBottom: 18, lineHeight: 1.5 }}>
          Vérifiez ces informations avant l'envoi — elles sont détectées automatiquement.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Titre">
            <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
          </Field>

          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Marque" style={{ flex: 1 }}>
              <input value={brandField} onChange={(e) => setBrandField(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Modèle" style={{ flex: 1 }}>
              <input value={modelField} onChange={(e) => setModelField(e.target.value)} style={inputStyle} />
            </Field>
          </div>

          <Field label="Spécialité">
            <select value={specialtyId} onChange={(e) => setSpecialtyId(e.target.value)} style={inputStyle}>
              <option value="">Choisir…</option>
              {departments.map((dept) => {
                const deptSpecialties = specialtiesByDepartment.get(dept.id) ?? [];
                if (deptSpecialties.length === 0) return null;
                return (
                  <optgroup key={dept.id} label={dept.name}>
                    {deptSpecialties.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </Field>

          <Field label="Type de document">
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as WebSearchResultType)}
              style={inputStyle}
            >
              {DOC_TYPES.map((dt) => (
                <option key={dt} value={dt}>
                  {docTypeLabel(dt)}
                </option>
              ))}
            </select>
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
            {submitting ? 'Envoi…' : 'Ajouter'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600, ...style }}>
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
