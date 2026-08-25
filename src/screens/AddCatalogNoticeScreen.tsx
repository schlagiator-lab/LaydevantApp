import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { addCatalogNotice } from '../lib/catalogNotice';
import { getLocalDepartments, getLocalSpecialties } from '../lib/db';
import { docTypeLabel, NOTICE_DOC_TYPES } from '../lib/docType';
import type { Department, DocType, Specialty } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

/** Même formule que defaultDirectTitle (EquipmentRequestSheet) — pas
 * partagée entre les deux fichiers (mémoire projet : pas d'abstraction
 * croisée pour un si petit calcul). */
function defaultTitle(marque: string, modele: string, nomFichier: string): string {
  const base = `${marque} ${modele}`.trim();
  if (base) return base;
  return nomFichier.replace(/\.pdf$/i, '');
}

/** Même point de passage unique que EquipmentRequestSheet.errorMessage — les
 * erreurs Supabase/PostgREST sont de simples objets `{ message, ... }`,
 * jamais des instances d'Error. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return String(err);
}

/**
 * Ajout d'une notice à la bibliothèque SANS dossier client (onglet Outils) —
 * même formulaire que le chemin direct de EquipmentRequestSheet (marque,
 * modèle, spécialité, type de doc, PDF), sans jamais toucher à un dossier :
 * pas de dossier_id, pas de request_id, pas de liste d'équipement à
 * recharger. En ligne uniquement (upload + relais n8n).
 */
export function AddCatalogNoticeScreen() {
  const nav = useNavigation();
  const { isOnline } = useAuth();
  const { showToast } = useToast();

  const [marque, setMarque] = useState('');
  const [modele, setModele] = useState('');
  const [titre, setTitre] = useState('');
  const [docType, setDocType] = useState<DocType | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [selectedSpecialtyId, setSelectedSpecialtyId] = useState('');

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

  const canSubmit = marque.trim().length > 0 && selectedSpecialtyId.length > 0 && !!file && isOnline && !submitting;

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

  const resetForm = () => {
    setMarque('');
    setModele('');
    setTitre('');
    setDocType('');
    setFile(null);
    setSelectedSpecialtyId('');
  };

  const handleSubmit = async () => {
    if (!canSubmit || !file) return;

    setSubmitting(true);
    setError(null);
    try {
      const specialty = specialties.find((s) => s.id === selectedSpecialtyId);
      const result = await addCatalogNotice({
        specialtyId: selectedSpecialtyId,
        specialtySlug: specialty?.slug ?? null,
        brand: marque.trim(),
        model: modele.trim() || null,
        docType: (docType || 'autre') as DocType,
        title: titre.trim() || defaultTitle(marque.trim(), modele.trim(), file.name),
        file,
      });
      if (result.failed || !result.product_id) {
        setError(result.message ?? "L'ajout en base a échoué, réessayez.");
        return;
      }
      showToast('Notice ajoutée à la bibliothèque. Elle apparaîtra dans la recherche d\'ici quelques secondes.');
      resetForm();
    } catch (err) {
      setError(errorMessage(err));
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
        <span style={{ fontSize: 18, fontWeight: 700 }}>Ajouter une notice</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!isOnline && (
          <p style={{ fontSize: 13, color: colors.accent, margin: 0 }}>
            Nécessite une connexion — l'ajout d'une notice n'est possible qu'en ligne.
          </p>
        )}

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
        <Field label="Spécialité">
          <select
            value={selectedSpecialtyId}
            onChange={(e) => setSelectedSpecialtyId(e.target.value)}
            style={inputStyle}
          >
            <option value="">Choisir une spécialité…</option>
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
        <Field label="Titre (optionnel)">
          <input
            value={titre}
            onChange={(e) => setTitre(e.target.value)}
            placeholder="Par défaut : marque + modèle"
            style={inputStyle}
          />
        </Field>
        <Field label="Fichier PDF">
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleFileChange}
            style={{ ...inputStyle, height: 'auto', paddingTop: 8, paddingBottom: 8 }}
          />
          {file && <span style={{ fontSize: 12.5, color: textA(0.6), marginTop: 4 }}>{file.name}</span>}
        </Field>

        {error && <p style={{ fontSize: 13, color: colors.accent, margin: 0 }}>{error}</p>}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}
        >
          {submitting ? 'Envoi…' : 'Ajouter à la bibliothèque'}
        </button>
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

const primaryButtonStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
};
