import { useState } from 'react';
import { createPrixArticle, updatePrixArticle } from '../lib/prixArticles';
import type { PrixArticle } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

export interface PrixArticleFormSheetProps {
  specialtyId: string;
  /** Article à modifier, ou null pour une création. */
  article: PrixArticle | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Convertit une saisie prix (virgule ou point) en nombre, ou null si vide. */
function parsePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Ajout ou édition d'un article de la liste de prix — nom requis, remarque et prix optionnels. */
export function PrixArticleFormSheet({ specialtyId, article, onClose, onSaved }: PrixArticleFormSheetProps) {
  const [nom, setNom] = useState(article?.nom ?? '');
  const [remarque, setRemarque] = useState(article?.remarque ?? '');
  const [prix, setPrix] = useState(article?.prix_vente_ht != null ? String(article.prix_vente_ht) : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = nom.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        nom: nom.trim(),
        remarque: remarque.trim() || null,
        prix_vente_ht: parsePrice(prix),
      };
      if (article) {
        await updatePrixArticle(article.id, payload);
      } else {
        await createPrixArticle({ specialty_id: specialtyId, ...payload });
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
          {article ? 'Modifier l’article' : 'Nouvel article'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Nom">
            <input
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              placeholder="ex. Moteur de portail 24V"
              style={inputStyle}
              autoFocus
            />
          </Field>
          <Field label="Remarque (optionnel)">
            <textarea
              value={remarque}
              onChange={(e) => setRemarque(e.target.value)}
              rows={3}
              style={{ ...inputStyle, height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }}
            />
          </Field>
          <Field label="Prix de vente HT (optionnel)">
            <input
              value={prix}
              onChange={(e) => setPrix(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              style={inputStyle}
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
            {submitting ? 'Enregistrement…' : article ? 'Enregistrer' : 'Ajouter l’article'}
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
