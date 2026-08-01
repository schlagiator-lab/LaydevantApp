import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useToast } from '../lib/useToast';
import {
  deleteDossierNote,
  deleteDossierPhoto,
  getPhotoObjectUrl,
  uploadDossierPhoto,
} from '../lib/dossiers';
import type { DossierNoteView, DossierPhotoView } from '../types/database';
import { SectionHeader } from './SectionHeader';
import { NoteFormSheet } from './NoteFormSheet';
import { ConfirmSheet } from './ConfirmSheet';
import { colors, textA } from '../styles/tokens';

export interface CarnetSectionProps {
  dossierId: string;
  isOnline: boolean;
  notes: DossierNoteView[] | null;
  photos: DossierPhotoView[] | null;
  onNotesChanged: () => void;
  onPhotosChanged: () => void;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-CH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Carnet public du dossier (notes + photos), partagé en clair entre toute
 * l'équipe — sans rapport avec le coffre (§ chiffré, accès nominatif) ni la
 * documentation produit. En ligne uniquement pour cette v1.
 */
export function CarnetSection({ dossierId, isOnline, notes, photos, onNotesChanged, onPhotosChanged }: CarnetSectionProps) {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [noteSheet, setNoteSheet] = useState<'new' | DossierNoteView | null>(null);
  const [pendingDeleteNote, setPendingDeleteNote] = useState<DossierNoteView | null>(null);
  const [pendingDeletePhoto, setPendingDeletePhoto] = useState<DossierPhotoView | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [viewedPhoto, setViewedPhoto] = useState<DossierPhotoView | null>(null);

  // Les object URLs des vignettes sont chargées ici (octets protégés par JWT,
  // jamais `storage_key` directement dans un src) et révoquées dès que la
  // liste change ou que la section se démonte, pour ne pas fuiter de mémoire.
  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    if (photos) {
      void (async () => {
        setPhotoUrls({});
        for (const photo of photos) {
          try {
            const url = await getPhotoObjectUrl(photo.storage_key);
            if (cancelled) {
              URL.revokeObjectURL(url);
              continue;
            }
            urls[photo.id] = url;
            setPhotoUrls((prev) => ({ ...prev, [photo.id]: url }));
          } catch {
            // Vignette individuelle indisponible : le reste de la grille s'affiche quand même.
          }
        }
      })();
    }
    return () => {
      cancelled = true;
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [photos]);

  const confirmDeleteNote = async () => {
    if (!pendingDeleteNote) return;
    try {
      await deleteDossierNote(pendingDeleteNote.id);
      onNotesChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de la suppression.');
    } finally {
      setPendingDeleteNote(null);
    }
  };

  const confirmDeletePhoto = async () => {
    if (!pendingDeletePhoto) return;
    try {
      await deleteDossierPhoto({ id: pendingDeletePhoto.id, storage_key: pendingDeletePhoto.storage_key });
      onPhotosChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Échec de la suppression.');
    } finally {
      setPendingDeletePhoto(null);
    }
  };

  const handleFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const auteur = session?.user.id;
    if (files.length === 0 || !auteur) return;

    // Envoi séquentiel (pas Promise.all) : une connexion chantier ne supporte
    // pas des uploads en parallèle. Un échec n'interrompt pas les suivants.
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < files.length; i++) {
      setUploadProgress({ current: i + 1, total: files.length });
      try {
        await uploadDossierPhoto(dossierId, files[i], auteur);
        successCount++;
      } catch {
        failCount++;
      }
    }
    setUploadProgress(null);
    onPhotosChanged();
    if (failCount > 0) {
      showToast(
        `${successCount} photo${successCount > 1 ? 's' : ''} ajoutée${successCount > 1 ? 's' : ''}, ${failCount} échec${failCount > 1 ? 's' : ''}`
      );
    }
  };

  return (
    <section>
      <SectionHeader
        title="Notes"
        onAdd={() => setNoteSheet('new')}
        addDisabled={!isOnline || !session?.user.id}
      />
      {notes === null ? (
        <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
      ) : notes.length === 0 ? (
        <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune note pour ce dossier.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {notes.map((note) => (
            <div key={note.id} style={noteCardStyle}>
              {note.titre && <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{note.titre}</div>}
              <div style={{ fontSize: 14, color: textA(0.85), lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{note.texte}</div>
              <div style={{ fontSize: 12, color: textA(0.5), fontWeight: 500, marginTop: 8 }}>
                par {note.auteur_nom || 'inconnu'} le {formatDateTime(note.created_at)}
                {note.updated_at !== note.created_at && (
                  <>
                    <br />
                    modifié par {note.updated_by_nom || 'inconnu'} le {formatDateTime(note.updated_at)}
                  </>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setNoteSheet(note)}
                  disabled={!isOnline}
                  style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                >
                  Modifier
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDeleteNote(note)}
                  disabled={!isOnline}
                  style={{ ...linkButtonStyle, opacity: isOnline ? 1 : 0.4 }}
                >
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '20px 0 10px' }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Photos</span>
        <label style={{ ...addButtonStyle, opacity: !isOnline || uploadProgress ? 0.4 : 1, display: 'inline-flex', alignItems: 'center' }}>
          {uploadProgress ? `Envoi ${uploadProgress.current}/${uploadProgress.total}…` : '+ Ajouter'}
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void handleFilesChange(e)}
            disabled={!isOnline || uploadProgress !== null}
            style={{ display: 'none' }}
          />
        </label>
      </div>
      {photos === null ? (
        <p style={{ fontSize: 14, color: textA(0.5) }}>Chargement…</p>
      ) : photos.length === 0 ? (
        <p style={{ fontSize: 14, color: textA(0.55) }}>Aucune photo pour ce dossier.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
          {photos.map((photo) => (
            <div key={photo.id} style={{ position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'hidden', background: textA(0.08) }}>
              {photoUrls[photo.id] && (
                <button
                  type="button"
                  onClick={() => setViewedPhoto(photo)}
                  aria-label="Voir la photo"
                  style={photoThumbButtonStyle}
                >
                  <img
                    src={photoUrls[photo.id]}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </button>
              )}
              <button
                type="button"
                onClick={() => setPendingDeletePhoto(photo)}
                disabled={!isOnline}
                aria-label="Supprimer la photo"
                style={{ ...deletePhotoButtonStyle, opacity: isOnline ? 1 : 0.4 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {noteSheet && (
        <NoteFormSheet
          dossierId={dossierId}
          auteur={session?.user.id ?? ''}
          note={noteSheet === 'new' ? null : noteSheet}
          onClose={() => setNoteSheet(null)}
          onSaved={() => {
            setNoteSheet(null);
            onNotesChanged();
          }}
        />
      )}

      {pendingDeleteNote && (
        <ConfirmSheet
          title="Supprimer cette note ?"
          message="Cette note sera définitivement supprimée du carnet du dossier."
          confirmLabel="Supprimer"
          onCancel={() => setPendingDeleteNote(null)}
          onConfirm={() => void confirmDeleteNote()}
        />
      )}

      {pendingDeletePhoto && (
        <ConfirmSheet
          title="Supprimer cette photo ?"
          message="Cette photo sera définitivement supprimée du carnet du dossier."
          confirmLabel="Supprimer"
          onCancel={() => setPendingDeletePhoto(null)}
          onConfirm={() => void confirmDeletePhoto()}
        />
      )}

      {viewedPhoto && photoUrls[viewedPhoto.id] && (
        <div onClick={() => setViewedPhoto(null)} style={photoViewerOverlayStyle}>
          <button
            type="button"
            onClick={() => setViewedPhoto(null)}
            aria-label="Fermer"
            style={photoViewerCloseButtonStyle}
          >
            ×
          </button>
          <img
            src={photoUrls[viewedPhoto.id]}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}
          />
        </div>
      )}
    </section>
  );
}

const addButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 32,
  borderRadius: 10,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 12.5,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const noteCardStyle: React.CSSProperties = {
  background: colors.card,
  borderRadius: 12,
  padding: '10px 12px',
};

const linkButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: textA(0.55),
  fontSize: 12,
  fontWeight: 700,
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
};

const photoThumbButtonStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  padding: 0,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
};

const photoViewerOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.9)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  boxSizing: 'border-box',
  zIndex: 1400,
};

const photoViewerCloseButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255, 255, 255, 0.15)',
  color: '#fff',
  fontSize: 20,
  lineHeight: '36px',
  padding: 0,
  cursor: 'pointer',
};

const deletePhotoButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 22,
  height: 22,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(0, 0, 0, 0.6)',
  color: '#fff',
  fontSize: 15,
  lineHeight: '22px',
  padding: 0,
  cursor: 'pointer',
};
