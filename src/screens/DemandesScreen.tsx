import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { createDemande, demandeStatutLabel, demandeTypeLabel, listMesDemandes } from '../lib/demandes';
import type { Demande, DemandeType } from '../types/database';
import { colors, fonts, radius, textA } from '../styles/tokens';

const TYPE_OPTIONS: DemandeType[] = ['amelioration', 'bug', 'autre'];

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

  const [type, setType] = useState<DemandeType>('amelioration');
  const [titre, setTitre] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [demandes, setDemandes] = useState<Demande[] | null | undefined>(null);

  const reload = async () => {
    try {
      const rows = await listMesDemandes();
      setDemandes(rows);
    } catch {
      setDemandes(undefined);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, []);

  const canSubmit = message.trim().length > 0 && !submitting && !!session?.user.id;

  const handleSubmit = async () => {
    if (!canSubmit || !session?.user.id) return;
    setSubmitting(true);
    setError(null);
    try {
      await createDemande({ type, titre: titre.trim() || null, message: message.trim(), auteur: session.user.id });
      showToast('Demande envoyée.');
      setType('amelioration');
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
              <button key={t} type="button" onClick={() => setType(t)} style={chipStyle(type === t)}>
                {demandeTypeLabel(t)}
              </button>
            ))}
          </div>

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
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: textA(0.65) }}>Mes demandes</span>

          {demandes === null ? (
            <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
          ) : demandes === undefined ? (
            <p style={{ fontSize: 14, color: colors.accent }}>Impossible de charger tes demandes.</p>
          ) : demandes.length === 0 ? (
            <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune demande pour l'instant.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {demandes.map((d) => (
                <DemandeRow key={d.id} demande={d} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DemandeRow({ demande }: { demande: Demande }) {
  const label = demande.titre ?? demande.message.slice(0, 80) + (demande.message.length > 80 ? '…' : '');
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: colors.card,
        borderRadius: 12,
        padding: '10px 12px',
        boxSizing: 'border-box',
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
    </div>
  );
}

function StatutBadge({ statut }: { statut: Demande['statut'] }) {
  const color = statut === 'traitee' ? colors.success : statut === 'en_cours' ? colors.text : colors.accent;
  const bg = statut === 'traitee' ? 'rgba(131, 163, 60, 0.18)' : statut === 'en_cours' ? textA(0.1) : 'rgba(222, 122, 34, 0.18)';
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
      {demandeStatutLabel(statut)}
    </span>
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
