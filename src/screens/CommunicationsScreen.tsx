import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import {
  canPublishCommunications,
  getCommunicationObjectUrl,
  listCommunications,
  uploadCommunication,
} from '../lib/communications';
import type { Communication } from '../types/database';
import { colors, fonts, radius, textA } from '../styles/tokens';

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
  const { session, isOnline } = useAuth();
  const { showToast } = useToast();
  const [items, setItems] = useState<Communication[] | null | undefined>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  const reload = async () => {
    try {
      const rows = await listCommunications();
      setItems(rows);
    } catch {
      setItems(undefined);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await canPublishCommunications();
        if (!cancelled) setCanPublish(value);
      } catch {
        // Reste caché en cas d'échec — pas d'entrée "Publier" affichée à tort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < files.length; i++) {
      setUploadProgress({ current: i + 1, total: files.length });
      try {
        await uploadCommunication({ file: files[i] });
        successCount++;
      } catch {
        failCount++;
      }
    }
    setUploadProgress(null);
    void reload();
    if (failCount > 0) {
      showToast(
        `${successCount} communication${successCount > 1 ? 's' : ''} ajoutée${successCount > 1 ? 's' : ''}, ${failCount} échec${failCount > 1 ? 's' : ''}`
      );
    }
  };

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
        <span style={{ flex: 1, fontSize: 18, fontWeight: 700 }}>Communication d'entreprise</span>

        {canPublish && (
          <label
            style={{
              flex: 'none',
              height: 32,
              borderRadius: radius.md,
              border: 'none',
              background: colors.accent,
              color: '#132146',
              fontSize: 12.5,
              fontWeight: 700,
              padding: '0 12px',
              display: 'inline-flex',
              alignItems: 'center',
              opacity: !isOnline || uploadProgress ? 0.4 : 1,
              cursor: !isOnline || uploadProgress ? 'default' : 'pointer',
            }}
          >
            {uploadProgress ? `${uploadProgress.current}/${uploadProgress.total}` : '+ Publier'}
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => void handleFilesChange(e)}
              disabled={!isOnline || uploadProgress !== null || !session?.user.id}
              style={{ display: 'none' }}
            />
          </label>
        )}
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
