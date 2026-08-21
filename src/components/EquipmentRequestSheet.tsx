import { useEffect, useMemo, useState } from 'react';
import { createEquipmentRequest, addDossierEquipmentWithNotice } from '../lib/dossiers';
import { getLocalDepartments, getLocalSpecialties } from '../lib/db';
import { useToast } from '../lib/useToast';
import { docTypeLabel, NOTICE_DOC_TYPES } from '../lib/docType';
import type { Department, DocType, Specialty } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

export interface EquipmentRequestSheetProps {
  dossierId: string;
  onClose: () => void;
  /** Appelé après création d'une DEMANDE (pas de notice jointe) — le parent
   * recharge la liste des demandes. */
  onCreated: () => void;
  /** Appelé après un ajout DIRECT réussi (notice + spécialité fournies dès
   * la déclaration, pas de demande créée) — le parent recharge la liste des
   * équipements, même contrat que AddEquipmentSheet.onAdded. */
  onAddedDirect: () => void;
}

/** Titre par défaut du chemin direct : marque + modèle si non vide, sinon le
 * nom de fichier sans l'extension .pdf — même formule que
 * defaultPromoteTitle (EquipmentRequestNotices.tsx), pas partagée entre les
 * deux fichiers (mémoire projet : pas d'abstraction croisée pour un si petit
 * calcul). */
function defaultDirectTitle(marque: string, modele: string, nomFichier: string): string {
  const base = `${marque} ${modele}`.trim();
  if (base) return base;
  return nomFichier.replace(/\.pdf$/i, '');
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

/**
 * Déclare un équipement absent de la base (item 1) : marque obligatoire,
 * modèle et commentaire optionnels. La demande créée est 'pending' — c'est un
 * admin qui la résout plus tard (transformation en produit rattaché).
 */
export function EquipmentRequestSheet({ dossierId, onClose, onCreated, onAddedDirect }: EquipmentRequestSheetProps) {
  const { showToast } = useToast();
  const [marque, setMarque] = useState('');
  const [modele, setModele] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<DocType | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Référentiel spécialités — même source que le select admin
  // (VaultAdminScreen, EquipmentRequestsSection), porté ici à l'identique.
  // N'est utile que si une notice est jointe (chemin direct) : chargé
  // inconditionnellement (petit, déjà en IndexedDB, CLAUDE.md §4), affiché
  // seulement dans ce cas.
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

    // Bifurcation (Étape 3) : dès qu'une notice est jointe, la spécialité
    // devient requise et l'ajout est DIRECT — plus de demande créée, plus de
    // validation admin. Message doux, pas de soumission tant qu'elle manque.
    if (file && !selectedSpecialtyId) {
      setError('Choisis une spécialité pour ajouter directement.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (file) {
        const specialty = specialties.find((s) => s.id === selectedSpecialtyId);
        const result = await addDossierEquipmentWithNotice({
          dossierId,
          specialtyId: selectedSpecialtyId,
          specialtySlug: specialty?.slug ?? null,
          brand: marque.trim(),
          model: modele.trim() || null,
          docType: (docType || 'autre') as DocType,
          title: defaultDirectTitle(marque.trim(), modele.trim(), file.name),
          file,
        });
        if (result.failed || !result.product_id) {
          setError(result.message ?? "L'ajout en base a échoué, réessayez.");
          return;
        }
        onAddedDirect();
        return;
      }

      // Aucun fichier joint : comportement inchangé — demande en attente.
      await createEquipmentRequest({
        dossierId,
        marque: marque.trim(),
        modele: modele.trim() || undefined,
        commentaire: commentaire.trim() || undefined,
      });
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
          {file && (
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
              <span style={{ fontSize: 12, color: textA(0.55), marginTop: 4 }}>
                Notice jointe = ajout direct, sans validation admin.
              </span>
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
