import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useVaultSession } from '../lib/useVaultSession';
import {
  getVaultSecret,
  getOwnDossierAccess,
  getVaultPublicKeys,
  getOwnVaultKeyRecord,
  insertVaultSecret,
  updateVaultSecret,
  insertDossierAccessRows,
  destroyDossierVault,
  hasVaultAccess,
  type VaultDossierAccessRow,
} from '../lib/vaultSecrets';
import { isVaultAdmin } from '../lib/vaultAdmin';
import { unwrapDek, decryptContent, generateDek, encryptContent, wrapDekForUser } from '../lib/vault.js';
import { ConfirmSheet } from './ConfirmSheet';
import { CollapsibleSection } from './CollapsibleSection';
import { colors, fonts, textA } from '../styles/tokens';

export interface VaultSheetProps {
  dossierId: string;
  onClose: () => void;
  /** Compte réel de notes déchiffrées — jamais connu avant déverrouillage, donc
   * jamais appelé avant que `notes` reflète un contenu effectivement lu. */
  onNotesCountChange?: (count: number) => void;
  /** Appelé après destruction réussie du coffre (bouton admin) — permet au
   * parent (DossierScreen) de repasser son indicateur "Chiffré" de
   * "configuré" à "vide" sans nouvel aller-retour réseau. */
  onDestroyed?: () => void;
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

interface VaultNote {
  id: string;
  titre: string;
  texte: string;
}

type ContentPhase =
  | { kind: 'loading' }
  | { kind: 'blocked' }
  | { kind: 'empty' }
  | { kind: 'ready'; dek: CryptoKey }
  | { kind: 'error'; message: string };

type NoteScreen =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'view'; id: string }
  | { kind: 'edit'; id: string };

/**
 * Le blob déchiffré du coffre est aujourd'hui un JSON `VaultNote[]`. Un
 * coffre créé avant l'introduction des notes multiples contient du texte
 * brut (pas du JSON) : dans ce cas précis, on ne perd jamais ce contenu, on
 * le fait apparaître comme une note unique déjà existante.
 */
function isVaultNote(n: unknown): n is VaultNote {
  if (!n || typeof n !== 'object') return false;
  const r = n as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.titre === 'string' && typeof r.texte === 'string';
}

function parseNotes(plaintext: string): VaultNote[] {
  if (!plaintext) return [];
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (Array.isArray(parsed) && parsed.every(isVaultNote)) return parsed;
    throw new Error('format inattendu');
  } catch {
    return [{ id: crypto.randomUUID(), titre: 'Note', texte: plaintext }];
  }
}

/**
 * Ouverture/édition du coffre de données sensibles d'un dossier (Feature
 * coffre données sensibles.md, tranche 4). UI seule : toute la crypto vit
 * dans src/lib/vault.js (testé, 19/19), ce composant l'appelle sans y
 * toucher. Le déverrouillage (clé privée) est partagé entre dossiers via
 * VaultSessionProvider (src/lib/vaultSession.tsx) ; les notes en clair, elles,
 * sont strictement locales à ce composant et à ce dossier — le coffre reste
 * un seul blob chiffré par dossier (`vault_secrets`), les notes ne sont
 * qu'une structure JSON à l'intérieur de ce blob.
 */
export function VaultSheet({ dossierId, onClose, onNotesCountChange, onDestroyed }: VaultSheetProps) {
  const { session, isOnline } = useAuth();
  const nav = useNavigation();
  const userId = session?.user.id ?? null;
  const {
    privateKey,
    unlocked,
    unlocking,
    error: unlockError,
    unlock,
    unlockWithRecoveryKey,
    lock,
    touch,
  } = useVaultSession();

  const [unlockMode, setUnlockMode] = useState<'password' | 'recovery'>('password');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [content, setContent] = useState<ContentPhase>({ kind: 'loading' });
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [screen, setScreen] = useState<NoteScreen>({ kind: 'list' });
  const [formTitre, setFormTitre] = useState('');
  const [formTexte, setFormTexte] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Un monteur qui n'a jamais fait son propre enrôlement coffre (pas de
  // ligne vault_user_keys) n'a par définition aucun mot de passe de coffre à
  // taper — lui montrer le formulaire de déverrouillage le mènerait droit à
  // un faux "mot de passe incorrect". Vérifié une fois à l'ouverture de la
  // feuille, indépendamment du flux de déverrouillage lui-même.
  const [enrollmentPhase, setEnrollmentPhase] = useState<'checking' | 'enrolled' | 'not-enrolled' | 'error'>(
    'checking',
  );

  // Section "Détruire le coffre" (admin uniquement) : réutilise le même
  // gating que VaultAdminScreen (is_vault_admin), pas un nouveau check de
  // rôle. Indépendant du déverrouillage — la destruction ne déchiffre rien,
  // elle supprime les lignes vault_secrets/vault_dossier_access côté serveur.
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingDestroy, setPendingDestroy] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    void (async () => {
      try {
        const admin = await isVaultAdmin();
        if (!cancelled) setIsAdmin(admin);
      } catch {
        // Échec réseau ponctuel sur ce seul check : reste non-admin par
        // défaut, jamais de repli permissif sur une action irréversible.
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  async function handleDestroyVault() {
    if (destroying) return;
    setDestroying(true);
    setDestroyError(null);
    try {
      await destroyDossierVault(dossierId);
      setPendingDestroy(false);
      onDestroyed?.();
      onClose();
    } catch (err) {
      setPendingDestroy(false);
      const msg = errorMessage(err);
      setDestroyError(msg.includes('NON_AUTORISE') ? 'Action réservée aux administrateurs.' : msg);
    } finally {
      setDestroying(false);
    }
  }

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const record = await getOwnVaultKeyRecord(userId);
        if (!cancelled) setEnrollmentPhase(record ? 'enrolled' : 'not-enrolled');
      } catch {
        // Panne réseau ponctuelle sur cette seule vérification : ne bloque
        // pas l'accès, le formulaire de déverrouillage habituel reste la
        // meilleure option de repli (même comportement qu'avant ce garde-fou).
        if (!cancelled) setEnrollmentPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!unlocked || !userId) return;
    let cancelled = false;
    void (async () => {
      setContent({ kind: 'loading' });
      try {
        const allowed = await hasVaultAccess();
        if (cancelled) return;
        if (!allowed) {
          setContent({ kind: 'blocked' });
          return;
        }

        const secret = await getVaultSecret(dossierId);
        if (cancelled) return;
        if (!secret) {
          setNotes([]);
          onNotesCountChange?.(0);
          setContent({ kind: 'empty' });
          return;
        }

        const access = await getOwnDossierAccess(dossierId, userId);
        if (cancelled) return;
        if (!access) {
          setContent({
            kind: 'error',
            message: "Coffre existant mais aucun accès ne t'a été emballé — contacte un administrateur.",
          });
          return;
        }

        if (!privateKey) throw new Error('Clé privée indisponible.');
        const dek = await unwrapDek(access.wrapped_dek, privateKey);
        const plaintext = await decryptContent(dek, secret.ciphertext, secret.content_iv);
        if (cancelled) return;
        const parsed = parseNotes(plaintext);
        setNotes(parsed);
        onNotesCountChange?.(parsed.length);
        setContent({ kind: 'ready', dek });
      } catch (err) {
        if (!cancelled) {
          setContent({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    // Cleanup, pas le corps de l'effet : se déclenche au verrouillage (bouton,
    // inactivité, sortie de la zone dossier — unlocked passe à false) et au
    // démontage du composant (fermeture de la feuille, changement de
    // dossier). Les notes en clair ne doivent jamais survivre à la clé
    // privée qui les a produites.
    return () => {
      cancelled = true;
      setContent({ kind: 'loading' });
      setNotes([]);
      setScreen({ kind: 'list' });
      setFormTitre('');
      setFormTexte('');
      setPendingDeleteId(null);
      setSaveError(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, dossierId, userId]);

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (unlocking) return;
    if (unlockMode === 'password') {
      if (!password) return;
      await unlock(password);
      setPassword('');
    } else {
      if (!recoveryKey) return;
      await unlockWithRecoveryKey(recoveryKey);
      setRecoveryKey('');
    }
  }

  function toggleUnlockMode() {
    setUnlockMode((m) => (m === 'password' ? 'recovery' : 'password'));
    setPassword('');
    setRecoveryKey('');
  }

  /** Re-chiffre et écrit le tableau de notes complet — un seul blob par dossier, inchangé. */
  async function persistNotes(nextNotes: VaultNote[]) {
    if (!userId || saving || (content.kind !== 'ready' && content.kind !== 'empty')) return false;
    setSaving(true);
    setSaveError(null);
    touch();
    try {
      const serialized = JSON.stringify(nextNotes);
      if (content.kind === 'ready') {
        const encrypted = await encryptContent(content.dek, serialized);
        await updateVaultSecret(dossierId, encrypted);
      } else {
        const dek = await generateDek();
        const encrypted = await encryptContent(dek, serialized);
        await insertVaultSecret(dossierId, encrypted);

        const recipients = await getVaultPublicKeys();
        const rows: VaultDossierAccessRow[] = await Promise.all(
          recipients.map(async (r) => ({
            dossier_id: dossierId,
            user_id: r.user_id,
            wrapped_dek: await wrapDekForUser(dek, r.public_key),
            dek_version: 1,
          })),
        );
        try {
          await insertDossierAccessRows(rows);
        } catch (accessErr) {
          throw new Error(
            `Le contenu a été enregistré mais l'octroi des accès a échoué (${
              accessErr instanceof Error ? accessErr.message : String(accessErr)
            }). Contacte un administrateur pour réparer les accès de ce dossier.`,
            { cause: accessErr },
          );
        }
        setContent({ kind: 'ready', dek });
      }
      setNotes(nextNotes);
      onNotesCountChange?.(nextNotes.length);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function openList() {
    setScreen({ kind: 'list' });
    setSaveError(null);
  }

  function openAdd() {
    setFormTitre('');
    setFormTexte('');
    setSaveError(null);
    setScreen({ kind: 'add' });
  }

  function openView(id: string) {
    setSaveError(null);
    setScreen({ kind: 'view', id });
  }

  function openEdit(note: VaultNote) {
    setFormTitre(note.titre);
    setFormTexte(note.texte);
    setSaveError(null);
    setScreen({ kind: 'edit', id: note.id });
  }

  async function handleAddNote() {
    if (!formTitre.trim()) return;
    const nextNote: VaultNote = { id: crypto.randomUUID(), titre: formTitre.trim(), texte: formTexte };
    const ok = await persistNotes([...notes, nextNote]);
    if (ok) openList();
  }

  async function handleEditNote(id: string) {
    if (!formTitre.trim()) return;
    const nextNotes = notes.map((n) => (n.id === id ? { ...n, titre: formTitre.trim(), texte: formTexte } : n));
    const ok = await persistNotes(nextNotes);
    if (ok) openView(id);
  }

  async function handleConfirmDelete() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    const nextNotes = notes.filter((n) => n.id !== id);
    const ok = await persistNotes(nextNotes);
    setPendingDeleteId(null);
    if (ok) openList();
  }

  const viewedNote = screen.kind === 'view' || screen.kind === 'edit' ? notes.find((n) => n.id === screen.id) : undefined;

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          touch();
        }}
        className="no-scrollbar"
        style={sheetStyle}
      >
        <div style={grabberStyle} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Données sensibles</span>
          {unlocked && (
            <button type="button" onClick={lock} style={lockButtonStyle}>
              Verrouiller
            </button>
          )}
        </div>

        {!isOnline && (
          <div style={{ ...offlineBannerStyle, marginTop: 12 }}>
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.accent }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
              Connexion réseau requise pour ouvrir le coffre.
            </span>
          </div>
        )}

        {isOnline && !unlocked && enrollmentPhase === 'checking' && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>Vérification…</p>
        )}

        {isOnline && !unlocked && enrollmentPhase === 'not-enrolled' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 13.5, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
              Tu n'as pas encore configuré ton coffre — il faut d'abord choisir un mot de passe de coffre avant de
              pouvoir l'ouvrir.
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                nav.goVaultEnroll();
              }}
              style={primaryButtonStyle}
            >
              Configurer le coffre
            </button>
          </div>
        )}

        {isOnline && !unlocked && (enrollmentPhase === 'enrolled' || enrollmentPhase === 'error') && (
          <form onSubmit={(e) => void handleUnlockSubmit(e)} style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
              {unlockMode === 'password'
                ? 'Mot de passe de coffre — distinct de ton mot de passe de connexion.'
                : 'Clé de récupération remise à la création du coffre.'}
            </p>
            {unlockMode === 'password' ? (
              <input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mot de passe du coffre"
                style={inputStyle}
                autoFocus
              />
            ) : (
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                style={inputStyle}
                autoFocus
              />
            )}
            {unlockError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{unlockError}</span>}
            <button
              type="submit"
              disabled={unlocking || (unlockMode === 'password' ? !password : !recoveryKey)}
              style={{
                ...primaryButtonStyle,
                opacity: unlocking || (unlockMode === 'password' ? !password : !recoveryKey) ? 0.5 : 1,
              }}
            >
              {unlocking ? 'Déverrouillage…' : 'Déverrouiller'}
            </button>
            <button type="button" onClick={toggleUnlockMode} style={switchModeLinkStyle}>
              {unlockMode === 'password'
                ? 'Mot de passe oublié ? Utiliser ma clé de récupération'
                : 'Utiliser mon mot de passe'}
            </button>
          </form>
        )}

        {isOnline && unlocked && content.kind === 'loading' && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>Chargement…</p>
        )}

        {isOnline && unlocked && content.kind === 'blocked' && (
          <p style={{ fontSize: 13.5, color: textA(0.6), lineHeight: 1.5, marginTop: 16 }}>
            Tu n'as pas accès au coffre de données sensibles. Contacte un administrateur pour l'activer.
          </p>
        )}

        {isOnline && unlocked && content.kind === 'error' && (
          <p style={{ fontSize: 13.5, color: colors.accent, lineHeight: 1.5, marginTop: 16 }}>{content.message}</p>
        )}

        {isOnline && unlocked && (content.kind === 'empty' || content.kind === 'ready') && screen.kind === 'list' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {notes.length === 0 && (
              <p style={{ fontSize: 13, color: textA(0.55), margin: 0 }}>
                Coffre vide — mastercodes, WiFi, codes d'accès du site.
              </p>
            )}
            {notes.map((n) => (
              <button key={n.id} type="button" onClick={() => openView(n.id)} style={noteRowStyle}>
                <span style={{ fontSize: 14.5, fontWeight: 600 }}>{n.titre}</span>
                <span style={{ fontSize: 15, color: textA(0.4) }}>›</span>
              </button>
            ))}
            {saveError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{saveError}</span>}
            <button type="button" onClick={openAdd} style={primaryButtonStyle}>
              Ajouter une note
            </button>
          </div>
        )}

        {isOnline && unlocked && (content.kind === 'empty' || content.kind === 'ready') && (screen.kind === 'add' || screen.kind === 'edit') && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              type="text"
              autoComplete="off"
              value={formTitre}
              onChange={(e) => {
                setFormTitre(e.target.value);
                touch();
              }}
              placeholder="Titre de la note"
              style={inputStyle}
              autoFocus
            />
            <textarea
              value={formTexte}
              onChange={(e) => {
                setFormTexte(e.target.value);
                touch();
              }}
              rows={6}
              placeholder="Mastercodes, mot de passe WiFi, codes d'accès…"
              style={textareaStyle}
            />
            {saveError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{saveError}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => (screen.kind === 'edit' ? openView(screen.id) : openList())}
                style={{ ...secondaryButtonStyle, flex: 1 }}
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void (screen.kind === 'edit' ? handleEditNote(screen.id) : handleAddNote())}
                disabled={saving || !formTitre.trim()}
                style={{ ...primaryButtonStyle, flex: 1, opacity: saving || !formTitre.trim() ? 0.6 : 1 }}
              >
                {saving ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </div>
        )}

        {isOnline && unlocked && (content.kind === 'empty' || content.kind === 'ready') && screen.kind === 'view' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!viewedNote ? (
              <p style={{ fontSize: 13.5, color: textA(0.6) }}>Cette note n'existe plus.</p>
            ) : (
              <>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{viewedNote.titre}</span>
                <p style={{ fontSize: 14.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0 }}>{viewedNote.texte}</p>
              </>
            )}
            {saveError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{saveError}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={openList} style={{ ...secondaryButtonStyle, flex: 1 }}>
                Retour
              </button>
              {viewedNote && (
                <button type="button" onClick={() => openEdit(viewedNote)} style={{ ...secondaryButtonStyle, flex: 1 }}>
                  Modifier cette note
                </button>
              )}
            </div>
            {viewedNote && (
              <div style={{ marginTop: 10, paddingTop: 14, borderTop: `1px solid ${textA(0.12)}` }}>
                <button type="button" onClick={() => setPendingDeleteId(viewedNote.id)} style={dangerLinkStyle}>
                  Supprimer cette note
                </button>
              </div>
            )}
          </div>
        )}

        {isOnline && isAdmin && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${textA(0.12)}` }}>
            <CollapsibleSection title="Zone de danger">
              <p style={{ fontSize: 12, color: textA(0.5), lineHeight: 1.5, margin: '0 0 10px' }}>
                Efface définitivement toutes les données sensibles de ce dossier. Irréversible.
              </p>
              {destroyError && (
                <p style={{ fontSize: 13, color: colors.accent, fontWeight: 600, margin: '0 0 10px' }}>{destroyError}</p>
              )}
              <button
                type="button"
                onClick={() => setPendingDestroy(true)}
                disabled={destroying}
                style={{ ...destroyButtonStyle, opacity: destroying ? 0.5 : 1, cursor: destroying ? 'default' : 'pointer' }}
              >
                {destroying ? 'Destruction…' : 'Détruire le coffre de ce dossier'}
              </button>
            </CollapsibleSection>
          </div>
        )}

        {pendingDestroy && (
          <ConfirmSheet
            title="Détruire définitivement le coffre de ce dossier ?"
            message="Toutes les données sensibles (notes, mots de passe, codes) seront perdues et irrécupérables."
            confirmLabel="Détruire"
            danger
            onCancel={() => setPendingDestroy(false)}
            onConfirm={() => void handleDestroyVault()}
          />
        )}

        {pendingDeleteId && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={confirmOverlayStyle}
          >
            <div style={confirmBoxStyle}>
              <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 16px' }}>
                Supprimer définitivement cette note du coffre ?
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setPendingDeleteId(null)}
                  disabled={saving}
                  style={{ ...secondaryButtonStyle, flex: 1 }}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmDelete()}
                  disabled={saving}
                  style={{ ...primaryButtonStyle, flex: 1, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? 'Suppression…' : 'Supprimer'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'flex-end',
  zIndex: 1200,
};

const sheetStyle: CSSProperties = {
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
  position: 'relative',
};

const grabberStyle: CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 2,
  background: textA(0.25),
  margin: '0 auto 16px',
};

const lockButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${textA(0.3)}`,
  borderRadius: 10,
  color: colors.text,
  fontSize: 12.5,
  fontWeight: 700,
  padding: '6px 12px',
  cursor: 'pointer',
};

const offlineBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(222, 122, 34, 0.15)',
  border: '1px solid rgba(222, 122, 34, 0.4)',
  borderRadius: 10,
  padding: '9px 12px',
};

const inputStyle: CSSProperties = {
  width: '100%',
  height: 48,
  background: textA(0.08),
  border: 'none',
  borderRadius: 12,
  padding: '0 14px',
  color: colors.text,
  fontSize: 15,
  fontFamily: fonts.sans,
  outline: 'none',
  boxSizing: 'border-box',
};

const textareaStyle: CSSProperties = {
  width: '100%',
  background: textA(0.08),
  border: 'none',
  borderRadius: 12,
  padding: '12px 14px',
  color: colors.text,
  fontSize: 14.5,
  fontFamily: fonts.sans,
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
  lineHeight: 1.5,
};

const switchModeLinkStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: textA(0.55),
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: 'underline',
  textAlign: 'left',
  alignSelf: 'flex-start',
  cursor: 'pointer',
};

const primaryButtonStyle: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: `1px solid ${textA(0.25)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

const noteRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  height: 48,
  background: textA(0.08),
  border: 'none',
  borderRadius: 12,
  padding: '0 14px',
  color: colors.text,
  fontFamily: fonts.sans,
  cursor: 'pointer',
  textAlign: 'left',
};

const dangerLinkStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  marginTop: 2,
  color: colors.accent,
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'left',
  alignSelf: 'flex-start',
  cursor: 'pointer',
};

const destroyButtonStyle: CSSProperties = {
  width: '100%',
  height: 44,
  borderRadius: 12,
  border: '1px solid #D14343',
  background: 'transparent',
  color: '#E77373',
  fontSize: 14,
  fontWeight: 700,
  fontFamily: fonts.sans,
  boxSizing: 'border-box',
};

const confirmOverlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 20,
  padding: 24,
  boxSizing: 'border-box',
};

const confirmBoxStyle: CSSProperties = {
  width: '100%',
  maxWidth: 360,
  background: colors.bg,
  border: `1px solid ${textA(0.15)}`,
  borderRadius: 14,
  padding: 18,
  boxSizing: 'border-box',
  fontFamily: fonts.sans,
  color: colors.text,
};
