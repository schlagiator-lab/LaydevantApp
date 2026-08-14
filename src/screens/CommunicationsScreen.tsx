import { useEffect, useState } from 'react';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { listCommunications, getCommunicationObjectUrl } from '../lib/communications';
import type { Communication } from '../types/database';
import { colors, fonts, textA } from '../styles/tokens';

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** Titre affiché : le titre s'il existe, sinon le nom de fichier embarqué
 * dans la clé R2 (communications/<uuid>-<nom>) — même dérivation que
 * planLabel (PlansSection.tsx), dupliquée volontairement (pas de helper
 * partagé entre sections, cf. carnet/plans). */
function communicationLabel(comm: Communication): string {
  if (comm.titre) return comm.titre;
  const slash = comm.storage_key.lastIndexOf('/');
  const filename = slash === -1 ? comm.storage_key : comm.storage_key.slice(slash + 1);
  const dash = filename.indexOf('-');
  return dash === -1 ? filename : filename.slice(dash + 1);
}

/**
 * Communication d'entreprise (item 4) — liste en lecture seule des PDF
 * publiés, espace global (pas de dossier_id, contrairement aux plans/carnet).
 * Publier et supprimer viendront dans un morceau séparé ; ici uniquement
 * lister et ouvrir (lecteur natif Android, comme les plans).
 */
export function CommunicationsScreen() {
  const nav = useNavigation();
  const { showToast } = useToast();
  const [items, setItems] = useState<Communication[] | null | undefined>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listCommunications();
        if (!cancelled) setItems(rows);
      } catch {
        if (!cancelled) setItems(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpen = async (comm: Communication) => {
    if (busyId) return;
    setBusyId(comm.id);
    try {
      const url = await getCommunicationObjectUrl(comm.storage_key);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Échec de l'ouverture du PDF.");
    } finally {
      setBusyId(null);
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
        <span style={{ fontSize: 18, fontWeight: 700 }}>Communication d'entreprise</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {items === null ? (
          <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
        ) : items === undefined ? (
          <p style={{ fontSize: 14, color: colors.accent }}>Impossible de charger les communications.</p>
        ) : items.length === 0 ? (
          <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune communication pour le moment.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((comm) => {
              const isBusy = busyId === comm.id;
              return (
                <button
                  key={comm.id}
                  type="button"
                  onClick={() => void handleOpen(comm)}
                  disabled={isBusy}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    width: '100%',
                    background: colors.card,
                    border: 'none',
                    borderRadius: 12,
                    padding: '12px 16px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    boxSizing: 'border-box',
                    opacity: isBusy ? 0.6 : 1,
                  }}
                >
                  <span style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>
                    {communicationLabel(comm)}
                  </span>
                  <span style={{ fontSize: 12.5, color: textA(0.55), fontWeight: 500 }}>
                    {isBusy
                      ? 'Ouverture…'
                      : `publié par ${comm.auteur_nom ?? 'inconnu'} le ${formatDate(comm.created_at)}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
