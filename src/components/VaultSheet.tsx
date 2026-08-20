import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useVaultSession } from '../lib/useVaultSession';
import {
  getVaultSecret,
  getOwnDossierAccess,
  getOwnVaultKeyRecord,
  updateVaultSecret,
  destroyDossierVault,
  hasVaultAccess,
  dossierHasVault,
  bootstrapDossierVault,
} from '../lib/vaultSecrets';
import {
  uploadVaultFile,
  listVaultFiles,
  openVaultFile,
  deleteVaultFile,
  renameVaultFile,
  type VaultFileListItem,
} from '../lib/vaultFiles';
import { isVaultAdmin } from '../lib/vaultAdmin';
import { isOwnRecoveryAdmin, reenrollVaultUser } from '../lib/vaultEnroll';
import { unwrapDek, decryptContent, encryptContent } from '../lib/vault.js';
import { formatBytes } from '../lib/storagePersistence';
import { isIosDevice } from '../lib/pdfMeasure';
import { ConfirmSheet } from './ConfirmSheet';
import { CollapsibleSection } from './CollapsibleSection';
import { colors, fonts, textA } from '../styles/tokens';

// pdf.js (~1 Mo avec son worker) : lazy-loadé, seulement à l'ouverture d'un
// fichier PDF du coffre — même motif que PlansSection/DocumentScreen.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));

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

/** Fichier ouvert en grand : image → object URL (révoquée à la fermeture),
 * PDF → Blob passé tel quel à `<PdfViewer>` (pas d'object URL à sa charge). */
type ViewedFile =
  | { kind: 'image'; row: VaultFileListItem; url: string }
  | { kind: 'pdf'; row: VaultFileListItem; blob: Blob };

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

  // Bloc "Fichiers" (tranche 5) : état strictement local à ce composant, en
  // miroir du bloc notes ci-dessus — même discipline zero-knowledge (rien de
  // déchiffré ne survit hors de ce state, purgé quand `content` quitte 'ready').
  const [files, setFiles] = useState<VaultFileListItem[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [openingFileId, setOpeningFileId] = useState<string | null>(null);
  const [sharingFileId, setSharingFileId] = useState<string | null>(null);
  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(null);
  const [deletingFile, setDeletingFile] = useState(false);
  const [editingFileTitleId, setEditingFileTitleId] = useState<string | null>(null);
  const [fileTitleDraft, setFileTitleDraft] = useState('');
  const [savingFileTitle, setSavingFileTitle] = useState(false);
  const [viewedFile, setViewedFile] = useState<ViewedFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Un monteur qui n'a jamais fait son propre enrôlement coffre (pas de
  // ligne vault_user_keys) n'a par définition aucun mot de passe de coffre à
  // taper — lui montrer le formulaire de déverrouillage le mènerait droit à
  // un faux "mot de passe incorrect". Vérifié une fois à l'ouverture de la
  // feuille, indépendamment du flux de déverrouillage lui-même.
  const [enrollmentPhase, setEnrollmentPhase] = useState<'checking' | 'enrolled' | 'not-enrolled' | 'error'>(
    'checking',
  );

  // Ré-enrôlement (perte du mot de passe ET de la clé de récupération, voir
  // reenrollVaultUser dans vaultEnroll.ts). isRecoveryAdmin cache le point
  // d'entrée : leur voie de secours est le break-glass mutuel entre
  // récupérateurs, jamais ce flux — la RPC le refuse de toute façon
  // (ceinture + bretelles, message d'erreur remonté tel quel si ça se
  // déclenche malgré le masquage).
  const [isRecoveryAdmin, setIsRecoveryAdmin] = useState(false);
  const [reenrollScreen, setReenrollScreen] = useState<'none' | 'confirm' | 'form' | 'success'>('none');
  const [reenrollPassword, setReenrollPassword] = useState('');
  const [reenrollConfirmPassword, setReenrollConfirmPassword] = useState('');
  const [reenrolling, setReenrolling] = useState(false);
  const [reenrollError, setReenrollError] = useState<string | null>(null);

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
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const recoveryAdmin = await isOwnRecoveryAdmin(userId);
        if (!cancelled) setIsRecoveryAdmin(recoveryAdmin);
      } catch {
        // Échec réseau ponctuel : reste false par défaut — jamais de repli
        // permissif qui afficherait le lien à tort à un récupérateur.
        if (!cancelled) setIsRecoveryAdmin(false);
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

        // Sonde d'existence AVANT l'accès : getVaultSecret ne peut pas servir
        // de sonde (sa RLS masque le ciphertext sans accès, donc un coffre
        // existant-mais-inaccessible remonterait null — indiscernable d'un
        // coffre réellement absent). dossier_has_vault tranche sans exiger
        // l'accès ni révéler de contenu.
        const exists = await dossierHasVault(dossierId);
        if (cancelled) return;
        if (!exists) {
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

        const secret = await getVaultSecret(dossierId);
        if (cancelled) return;
        if (!secret) {
          // Incohérence : dossier_has_vault a dit "existe" et l'accès est
          // là, mais le secret manque quand même. Ne devrait jamais arriver
          // — fallback défensif plutôt qu'un crash sur unwrapDek(undefined).
          setContent({ kind: 'error', message: 'Coffre introuvable malgré un accès valide — réessaie plus tard.' });
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
      // Le fichier ouvert en grand (image/PDF déchiffrés) ne doit pas non plus
      // survivre à la clé privée — verrouillage ou changement de dossier.
      setViewedFile((prev) => {
        if (prev?.kind === 'image') URL.revokeObjectURL(prev.url);
        return null;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, dossierId, userId]);

  /** Déchiffre nom/type de chaque ligne `vault_files` via sa FEK — jamais les
   * octets ici (liste seulement). Appelée à l'ouverture du coffre (effet
   * ci-dessous) et explicitement après chaque upload/suppression, la DEK ne
   * changeant pas d'identité entre deux fichiers d'une même session. */
  async function reloadVaultFiles(dek: CryptoKey) {
    try {
      const rows = await listVaultFiles(dossierId, dek);
      setFiles(rows);
      setFilesError(null);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : String(err));
    }
  }

  // Se déclenche à l'ouverture du coffre ET juste après le bootstrap déclenché
  // par le tout premier fichier d'un coffre vide (content.dek change alors
  // d'identité, null -> CryptoKey) : pas de rechargement manuel nécessaire
  // dans ce cas précis, seulement après les uploads/suppressions suivants
  // (mêmes octets de DEK, l'effet ne se redéclenche pas tout seul).
  useEffect(() => {
    if (content.kind !== 'ready') return;
    const dek = content.dek;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listVaultFiles(dossierId, dek);
        if (!cancelled) {
          setFiles(rows);
          setFilesError(null);
        }
      } catch (err) {
        if (!cancelled) setFilesError(err instanceof Error ? err.message : String(err));
      }
    })();
    // Cleanup, pas le corps de l'effet (même motif que l'effet de chargement
    // des notes ci-dessus) : purge les fichiers déchiffrés dès que la DEK
    // change d'identité (verrouillage, changement de dossier).
    return () => {
      cancelled = true;
      setFiles([]);
      setFilesError(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.kind === 'ready' ? content.dek : null, dossierId]);

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

  // Même minimum que le flux léger d'enrôlement (VaultEnrollScreen,
  // MIN_LENGTH.light) — pas d'import croisé pour une seule constante, mais
  // à faire évoluer ensemble si ce seuil change un jour.
  const REENROLL_MIN_LENGTH = 12;
  const reenrollLengthOk = reenrollPassword.length >= REENROLL_MIN_LENGTH;
  const reenrollMatchOk = reenrollPassword.length > 0 && reenrollPassword === reenrollConfirmPassword;
  const reenrollCanSubmit = reenrollLengthOk && reenrollMatchOk && !reenrolling;

  function cancelReenroll() {
    setReenrollScreen('none');
    setReenrollPassword('');
    setReenrollConfirmPassword('');
    setReenrollError(null);
  }

  async function handleReenrollSubmit() {
    if (!reenrollCanSubmit) return;
    setReenrolling(true);
    setReenrollError(null);
    try {
      await reenrollVaultUser(reenrollPassword);
      // Purge défensive de toute session déverrouillée en mémoire — la
      // nouvelle paire de clés rend l'ancienne privateKey (si une existait
      // encore, ex. déverrouillée sur un autre dossier plus tôt dans la
      // session) inutilisable de toute façon.
      lock();
      setReenrollPassword('');
      setReenrollConfirmPassword('');
      setReenrollScreen('success');
    } catch (err) {
      setReenrollError(errorMessage(err));
    } finally {
      setReenrolling(false);
    }
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
        const dek = await bootstrapDossierVault(dossierId, serialized);
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

  /**
   * Chiffre et dépose 1..N fichiers, séquentiellement (jamais Promise.all —
   * une connexion chantier ne supporte pas le parallèle, même motif que le
   * carnet). `touch()` est appelé au tout début ET à chaque itération : un
   * upload lent (gros PDF, réseau chantier) ne doit jamais être interrompu
   * par l'auto-lock 15 min faute de clic pendant l'attente.
   */
  async function handleFilesUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    if (!userId || uploading || (content.kind !== 'ready' && content.kind !== 'empty')) return;
    const filesToUpload = Array.from(fileList);
    setUploading(true);
    setUploadError(null);
    setUploadProgress({ done: 0, total: filesToUpload.length });
    touch();

    let activeDek: CryptoKey | null = content.kind === 'ready' ? content.dek : null;
    const errors: string[] = [];
    for (let i = 0; i < filesToUpload.length; i++) {
      touch();
      const file = filesToUpload[i];
      try {
        await uploadVaultFile(dossierId, activeDek, file);
        if (!activeDek) {
          // Ce premier upload vient d'amorcer le coffre (bootstrapDossierVault,
          // côté uploadVaultFile) : on récupère notre propre ligne d'accès
          // fraîchement écrite pour obtenir la DEK sans redéverrouiller, et on
          // bascule 'empty' -> 'ready' pour que le reste du sheet (notes,
          // fichiers suivants) en profite immédiatement.
          const access = await getOwnDossierAccess(dossierId, userId);
          if (access && privateKey) {
            activeDek = await unwrapDek(access.wrapped_dek, privateKey);
            setContent({ kind: 'ready', dek: activeDek });
          }
        }
      } catch (err) {
        errors.push(`${file.name} : ${err instanceof Error ? err.message : String(err)}`);
      }
      setUploadProgress({ done: i + 1, total: filesToUpload.length });
    }

    if (activeDek) await reloadVaultFiles(activeDek);
    setUploadError(errors.length > 0 ? errors.join(' — ') : null);
    setUploading(false);
    setUploadProgress(null);
  }

  /**
   * Tap = ouvrir en grand, jamais le partage. Déchiffre les octets une seule
   * fois puis bifurque selon le mime :
   * - image/* -> visualiseur plein écran in-app (object URL révoquée à la fermeture) ;
   * - PDF sur iOS -> <PdfViewer> in-app (window.open('blob:…') échoue sur iOS
   *   après un await, même motif que PlansSection.handleOpenPdf) ;
   * - PDF ailleurs (Android/desktop) -> lecteur natif, calqué EXACTEMENT sur
   *   PlansSection.handleOpenPdfNative : pas de pré-ouverture synchrone, pas
   *   de fallback download, window.open direct après l'await, revoke différé.
   */
  async function handleOpenFile(row: VaultFileListItem) {
    if (content.kind !== 'ready' || openingFileId) return;
    setOpeningFileId(row.id);
    touch();
    try {
      const blob = await openVaultFile(row, content.dek);
      if (row.mime.startsWith('image/')) {
        setViewedFile({ kind: 'image', row, url: URL.createObjectURL(blob) });
      } else if (isIosDevice()) {
        setViewedFile({ kind: 'pdf', row, blob });
      } else {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener');
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningFileId(null);
    }
  }

  function closeViewedFile() {
    setViewedFile((prev) => {
      if (prev?.kind === 'image') URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  /** Action secondaire (bouton "Partager" par fichier) — même pattern
   * navigator.share/téléchargement que CarnetSection/PlansSection, séparé du
   * tap qui ouvre désormais en grand. */
  async function handleShareFile(row: VaultFileListItem) {
    if (content.kind !== 'ready' || sharingFileId) return;
    setSharingFileId(row.id);
    touch();
    try {
      const blob = await openVaultFile(row, content.dek);
      const file = new File([blob], row.name, { type: row.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: row.name });
      } else {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = row.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }
    } catch (err) {
      // Annulation volontaire du partage natif : comportement normal, pas une erreur.
      if (err instanceof Error && err.name === 'AbortError') return;
      setFilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharingFileId(null);
    }
  }

  function startEditFileTitle(row: VaultFileListItem) {
    setEditingFileTitleId(row.id);
    setFileTitleDraft(row.name);
  }

  /** Calqué sur CarnetSection.handleSaveTitle — hormis qu'un nom de fichier ne
   * peut jamais être vidé (contrairement au titre optionnel d'une photo) :
   * une saisie vide referme simplement l'édition sans écrire. */
  async function handleSaveFileTitle(row: VaultFileListItem) {
    if (content.kind !== 'ready') return;
    const trimmed = fileTitleDraft.trim();
    if (!trimmed) {
      setEditingFileTitleId(null);
      return;
    }
    setSavingFileTitle(true);
    touch();
    try {
      await renameVaultFile(row, content.dek, trimmed, row.mime);
      setFiles((prev) => prev.map((f) => (f.id === row.id ? { ...f, name: trimmed } : f)));
      setEditingFileTitleId(null);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFileTitle(false);
    }
  }

  async function handleConfirmDeleteFile() {
    if (!pendingDeleteFileId) return;
    const row = files.find((f) => f.id === pendingDeleteFileId);
    if (!row) {
      setPendingDeleteFileId(null);
      return;
    }
    setDeletingFile(true);
    touch();
    try {
      await deleteVaultFile(row);
      setFiles((prev) => prev.filter((f) => f.id !== row.id));
      setPendingDeleteFileId(null);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingFile(false);
    }
  }

  const viewedNote = screen.kind === 'view' || screen.kind === 'edit' ? notes.find((n) => n.id === screen.id) : undefined;

  return (
    <>
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

        {isOnline &&
          !unlocked &&
          (enrollmentPhase === 'enrolled' || enrollmentPhase === 'error') &&
          reenrollScreen === 'none' && (
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
              {!isRecoveryAdmin && (
                <button type="button" onClick={() => setReenrollScreen('confirm')} style={switchModeLinkStyle}>
                  Mot de passe et clé de récupération perdus ?
                </button>
              )}
            </form>
          )}

        {reenrollScreen === 'confirm' && (
          <ConfirmSheet
            title="Repartir de zéro ?"
            message="Tu vas créer un NOUVEAU mot de passe de coffre. L'ancien et ta clé de récupération sont définitivement abandonnés. Le CONTENU des coffres n'est PAS affecté. Après ça, un administrateur devra rétablir tes accès — préviens-en un."
            confirmLabel="Continuer"
            danger
            onCancel={cancelReenroll}
            onConfirm={() => setReenrollScreen('form')}
          />
        )}

        {isOnline && !unlocked && reenrollScreen === 'form' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
              Choisis un nouveau mot de passe de coffre. Distinct de ton mot de passe de connexion, comme le
              précédent.
            </p>
            <input
              type="password"
              autoComplete="new-password"
              value={reenrollPassword}
              onChange={(e) => setReenrollPassword(e.target.value)}
              placeholder="Nouveau mot de passe du coffre"
              style={inputStyle}
              autoFocus
            />
            <span style={{ fontSize: 12, color: reenrollLengthOk ? textA(0.45) : colors.accent }}>
              Minimum {REENROLL_MIN_LENGTH} caractères.
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={reenrollConfirmPassword}
              onChange={(e) => setReenrollConfirmPassword(e.target.value)}
              placeholder="Confirmer le mot de passe"
              style={inputStyle}
            />
            {reenrollConfirmPassword.length > 0 && !reenrollMatchOk && (
              <span style={{ fontSize: 12, color: colors.accent }}>Les mots de passe ne correspondent pas.</span>
            )}
            {reenrollError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{reenrollError}</span>}
            <button
              type="button"
              disabled={!reenrollCanSubmit}
              onClick={() => void handleReenrollSubmit()}
              style={{ ...primaryButtonStyle, opacity: reenrollCanSubmit ? 1 : 0.5 }}
            >
              {reenrolling ? 'Réinitialisation…' : 'Créer le nouveau mot de passe'}
            </button>
            <button type="button" onClick={cancelReenroll} style={switchModeLinkStyle}>
              Annuler
            </button>
          </div>
        )}

        {isOnline && !unlocked && reenrollScreen === 'success' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13.5, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
              Coffre réinitialisé. Tes accès seront rétablis par un administrateur. Le contenu des coffres n'est pas
              affecté.
            </p>
            <button type="button" onClick={onClose} style={primaryButtonStyle}>
              Fermer
            </button>
          </div>
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

        {isOnline && unlocked && (content.kind === 'empty' || content.kind === 'ready') && (
          <div
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTop: `1px solid ${textA(0.12)}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 700 }}>Fichiers</span>
            {files.length === 0 && !uploading && (
              <p style={{ fontSize: 13, color: textA(0.55), margin: 0 }}>
                Aucun fichier — PDF ou photo de credentials.
              </p>
            )}
            {files.map((f) => (
              <div key={f.id} style={fileRowStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={fileIconWrapStyle}>
                    <VaultFileIcon mime={f.mime} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingFileTitleId === f.id ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          autoFocus
                          value={fileTitleDraft}
                          onChange={(e) => setFileTitleDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveFileTitle(f);
                            if (e.key === 'Escape') setEditingFileTitleId(null);
                          }}
                          disabled={savingFileTitle}
                          style={fileTitleInputStyle}
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveFileTitle(f)}
                          disabled={savingFileTitle}
                          style={fileTitleSaveButtonStyle}
                        >
                          {savingFileTitle ? '…' : 'OK'}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleOpenFile(f)}
                        disabled={openingFileId === f.id}
                        style={{ ...fileTitleButtonStyle, opacity: openingFileId === f.id ? 0.5 : 1 }}
                      >
                        {f.name}
                      </button>
                    )}
                    <span style={fileMetaStyle}>
                      {openingFileId === f.id
                        ? 'Ouverture…'
                        : `${formatBytes(f.taille)} · ${new Date(f.created_at).toLocaleDateString('fr-CH')}`}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 14, paddingLeft: 42 }}>
                  <button type="button" onClick={() => startEditFileTitle(f)} style={switchModeLinkStyle}>
                    Renommer
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleShareFile(f)}
                    disabled={sharingFileId === f.id}
                    style={switchModeLinkStyle}
                  >
                    {sharingFileId === f.id ? 'Partage…' : 'Partager'}
                  </button>
                  <button type="button" onClick={() => setPendingDeleteFileId(f.id)} style={dangerLinkStyle}>
                    Supprimer
                  </button>
                </div>
              </div>
            ))}
            {filesError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{filesError}</span>}
            {uploadError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{uploadError}</span>}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*"
              multiple
              onChange={(e) => {
                void handleFilesUpload(e.target.files);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{ ...primaryButtonStyle, opacity: uploading ? 0.6 : 1 }}
            >
              {uploading
                ? uploadProgress
                  ? `Envoi… (${uploadProgress.done}/${uploadProgress.total})`
                  : 'Envoi…'
                : 'Ajouter un fichier'}
            </button>
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

        {pendingDeleteFileId && (
          <div onClick={(e) => e.stopPropagation()} style={confirmOverlayStyle}>
            <div style={confirmBoxStyle}>
              <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 16px' }}>
                Supprimer définitivement ce fichier du coffre ?
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setPendingDeleteFileId(null)}
                  disabled={deletingFile}
                  style={{ ...secondaryButtonStyle, flex: 1 }}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmDeleteFile()}
                  disabled={deletingFile}
                  style={{ ...primaryButtonStyle, flex: 1, opacity: deletingFile ? 0.6 : 1 }}
                >
                  {deletingFile ? 'Suppression…' : 'Supprimer'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>

    {viewedFile && (
      <div onClick={(e) => e.stopPropagation()} style={fileViewerOverlayStyle}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <button type="button" onClick={closeViewedFile} aria-label="Fermer" style={fileViewerCloseButtonStyle}>
            ‹
          </button>
          <span style={fileViewerTitleStyle}>{viewedFile.row.name}</span>
        </div>
        <div style={fileViewerBodyStyle}>
          {viewedFile.kind === 'image' ? (
            <img
              src={viewedFile.url}
              alt=""
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            <Suspense
              fallback={
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: textA(0.55) }}>
                  Chargement de l'aperçu…
                </span>
              }
            >
              <PdfViewer blob={viewedFile.blob} />
            </Suspense>
          )}
        </div>
      </div>
    )}
    </>
  );
}

function VaultFileIcon({ mime }: { mime: string }) {
  if (mime === 'application/pdf') {
    return (
      <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M5 2.5h7l3 3v12a1 1 0 01-1 1H5a1 1 0 01-1-1v-14a1 1 0 011-1z"
          fill="none"
          stroke={colors.accent}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M12 2.5v3h3" fill="none" stroke={colors.accent} strokeWidth="1.5" strokeLinejoin="round" />
        <text x="10" y="14.5" textAnchor="middle" fontSize="5.5" fontWeight="700" fill={colors.accent}>
          PDF
        </text>
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M5 2.5h7l3 3v12a1 1 0 01-1 1H5a1 1 0 01-1-1v-14a1 1 0 011-1z"
        fill="none"
        stroke={textA(0.45)}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 2.5v3h3" fill="none" stroke={textA(0.45)} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
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

const fileRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  background: textA(0.08),
  borderRadius: 12,
  padding: '8px 10px',
};

const fileIconWrapStyle: CSSProperties = {
  flex: 'none',
  width: 32,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

/** Titre cliquable pour entrer en édition — même UX que
 * CarnetSection.titleDisplayButtonStyle ("+ Ajouter un titre"), sans le cas
 * vide : un nom de fichier n'est jamais optionnel. */
const fileTitleButtonStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  textAlign: 'left',
  cursor: 'pointer',
  color: colors.text,
  fontFamily: fonts.sans,
  fontSize: 14.5,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const fileTitleInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 34,
  background: textA(0.1),
  border: 'none',
  borderRadius: 8,
  padding: '0 10px',
  color: colors.text,
  fontSize: 14,
  fontFamily: fonts.sans,
  outline: 'none',
  boxSizing: 'border-box',
};

const fileTitleSaveButtonStyle: CSSProperties = {
  flex: 'none',
  height: 34,
  padding: '0 14px',
  borderRadius: 8,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

const fileMetaStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: textA(0.55),
  fontWeight: 500,
  marginTop: 2,
};

// Viewer plein écran in-app (image ou PDF) — même motif que
// PlansSection.pdfViewerOverlayStyle (zIndex 1400, au-dessus du sheet coffre
// à 1200) ; rendu en Fragment sibling de l'overlay du sheet, pas imbriqué
// dedans, pour ne pas hériter du contexte d'empilement local créé par son
// z-index.
const fileViewerOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: colors.bg,
  color: colors.text,
  zIndex: 1400,
  display: 'flex',
  flexDirection: 'column',
  padding: 16,
  boxSizing: 'border-box',
};

const fileViewerCloseButtonStyle: CSSProperties = {
  flex: 'none',
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: textA(0.1),
  border: 'none',
  color: colors.text,
  fontSize: 17,
  cursor: 'pointer',
};

const fileViewerTitleStyle: CSSProperties = {
  flex: 1,
  fontSize: 16,
  fontWeight: 700,
  color: colors.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const fileViewerBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: 14,
  background: colors.bgDark,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
};
