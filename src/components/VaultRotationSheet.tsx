import { useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../lib/useAuth';
import { getOwnVaultKeyRecord, getVaultSecret, getOwnDossierAccess } from '../lib/vaultSecrets';
import { getDossierAccessRows, getVaultUserKeyInfo, rotateVaultSecretRpc } from '../lib/vaultRotation';
import { unlockWithPassword, unwrapDek, decryptContent, generateDek, encryptContent, wrapDekForUser } from '../lib/vault.js';
import { colors, fonts, textA } from '../styles/tokens';

export interface VaultRotationSheetProps {
  dossierId: string;
  dossierName: string;
  onClose: () => void;
}

type Phase =
  | { kind: 'password' }
  | { kind: 'confirm'; freshPrivateKey: CryptoKey }
  | { kind: 'running' }
  /** Échec avant ou pendant l'écriture — la fonction Postgres rotate_vault_secret
   * est une transaction unique (voir la migration) : soit tout est écrit, soit
   * rien ne l'est. Un échec ici, quelle qu'en soit l'étape, veut dire coffre
   * intact, jamais un état à moitié fait. */
  | { kind: 'failed'; message: string }
  | { kind: 'done'; recipientCount: number }
  | { kind: 'verifyFailed'; recipientCount: number };

/**
 * Rotation de la clé du coffre d'UN dossier (tranche 6) : régénère la DEK,
 * re-chiffre le contenu, ré-emballe vers les mêmes destinataires. Seul
 * geste qui réécrit le ciphertext — traité à part de VaultSheet et
 * volontairement DÉCOUPLÉ de la session de coffre partagée
 * (VaultSessionProvider) : la consigne exige de re-saisir le mot de passe
 * même si une session est déjà déverrouillée, donc cette feuille dérive sa
 * propre clé privée fraîche via unlockWithPassword plutôt que de réutiliser
 * useVaultSession.
 */
export function VaultRotationSheet({ dossierId, dossierName, onClose }: VaultRotationSheetProps) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [phase, setPhase] = useState<Phase>({ kind: 'password' });
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (unlocking || !password || !userId) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const record = await getOwnVaultKeyRecord(userId);
      if (!record) throw new Error('no-record');
      const freshPrivateKey = await unlockWithPassword(password, record);
      setPassword('');
      setPhase({ kind: 'confirm', freshPrivateKey });
    } catch {
      setUnlockError('Mot de passe incorrect.');
    } finally {
      setUnlocking(false);
    }
  }

  async function handleConfirmRotate() {
    if (phase.kind !== 'confirm' || !userId) return;
    const { freshPrivateKey } = phase;
    setPhase({ kind: 'running' });
    try {
      // --- 4a-4b : ancien contenu en clair, via MA ligne d'accès actuelle ---
      const secret = await getVaultSecret(dossierId);
      if (!secret) throw new Error('Ce coffre n’existe plus.');
      const ownAccess = await getOwnDossierAccess(dossierId, userId);
      if (!ownAccess) {
        throw new Error(
          'Vous n’avez pas vous-même accès à ce coffre — impossible de lire l’ancien contenu pour le faire tourner.',
        );
      }
      const oldDek = await unwrapDek(ownAccess.wrapped_dek, freshPrivateKey, true);
      const plaintext = await decryptContent(oldDek, secret.ciphertext, secret.content_iv);

      // --- 4c-4d : nouvelle DEK, nouveau ciphertext ---
      const newDek = await generateDek();
      const newContent = await encryptContent(newDek, plaintext);

      // --- 4e : destinataires ACTUELS de ce coffre ---
      const currentRows = await getDossierAccessRows(dossierId);
      if (currentRows.length === 0) {
        throw new Error('Ce coffre n’a plus aucun destinataire — rotation impossible, rien n’a été écrit.');
      }
      const recipientIds = currentRows.map((r) => r.user_id);
      const keyInfos = await getVaultUserKeyInfo(recipientIds);
      const keyInfoByUser = new Map(keyInfos.map((k) => [k.user_id, k]));

      const missing = recipientIds.filter((id) => !keyInfoByUser.has(id));
      if (missing.length > 0) {
        throw new Error(
          `Clé publique introuvable pour ${missing.length} destinataire${missing.length > 1 ? 's' : ''} — rotation annulée, rien n’a été écrit.`,
        );
      }

      // --- 4f : garde-fou — jamais de coffre sans récupérateur ---
      const hasRecoveryAdmin = recipientIds.some((id) => keyInfoByUser.get(id)?.is_recovery_admin === true);
      if (!hasRecoveryAdmin) {
        throw new Error(
          'Ce coffre perdrait son dernier récupérateur — rotation refusée pour ne pas le rendre irrécupérable. Rien n’a été écrit.',
        );
      }

      const accessRows = await Promise.all(
        recipientIds.map(async (id) => {
          const info = keyInfoByUser.get(id);
          if (!info) throw new Error(`Clé publique introuvable pour ${id}.`);
          return { user_id: id, wrapped_dek: await wrapDekForUser(newDek, info.public_key) };
        }),
      );

      const newDekVersion = secret.dek_version + 1;

      // --- 5 : écriture atomique (une seule transaction côté Postgres) ---
      await rotateVaultSecretRpc({
        dossierId,
        ciphertext: newContent.ciphertext,
        contentIv: newContent.content_iv,
        expectedDekVersion: secret.dek_version,
        newDekVersion,
        accessRows,
      });

      // --- 6 : vérification post-écriture, re-lu depuis la base ---
      try {
        const verifySecret = await getVaultSecret(dossierId);
        const verifyAccess = await getOwnDossierAccess(dossierId, userId);
        if (!verifySecret || !verifyAccess) throw new Error('Lignes introuvables après écriture.');
        const verifyDek = await unwrapDek(verifyAccess.wrapped_dek, freshPrivateKey);
        const reread = await decryptContent(verifyDek, verifySecret.ciphertext, verifySecret.content_iv);
        if (reread !== plaintext) throw new Error('Contenu relu différent du contenu attendu.');
        setPhase({ kind: 'done', recipientCount: accessRows.length });
      } catch {
        setPhase({ kind: 'verifyFailed', recipientCount: accessRows.length });
      }
    } catch (err) {
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const canCloseByBackdrop = phase.kind !== 'running';

  return (
    <div onClick={() => canCloseByBackdrop && onClose()} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} className="no-scrollbar" style={sheetStyle}>
        <div style={grabberStyle} />
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Rotation de la clé du coffre</div>
        <div style={{ fontSize: 13, color: textA(0.55), fontWeight: 600, marginBottom: 14 }}>{dossierName}</div>

        {phase.kind === 'password' && (
          <form onSubmit={(e) => void handleUnlockSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13, color: textA(0.6), lineHeight: 1.5, margin: 0 }}>
              Confirme ton mot de passe de coffre pour continuer — re-saisie obligatoire pour ce geste, même si le
              coffre est déjà déverrouillé ailleurs.
            </p>
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mot de passe du coffre"
              style={inputStyle}
              autoFocus
            />
            {unlockError && <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>{unlockError}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, flex: 1 }}>
                Annuler
              </button>
              <button
                type="submit"
                disabled={unlocking || !password}
                style={{ ...primaryButtonStyle, flex: 1, opacity: unlocking || !password ? 0.5 : 1 }}
              >
                {unlocking ? 'Vérification…' : 'Continuer'}
              </button>
            </div>
          </form>
        )}

        {phase.kind === 'confirm' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: 0, color: colors.accent, fontWeight: 600 }}>
              Cette opération régénère la clé du coffre et re-chiffre son contenu. Elle rend inutilisable toute
              ancienne copie chiffrée. Elle n’a d’intérêt que si la personne à écarter a DÉJÀ été révoquée — sinon la
              nouvelle clé lui sera ré-emballée. Son accès a-t-il bien été révoqué ?
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, flex: 1 }}>
                Annuler
              </button>
              <button type="button" onClick={() => void handleConfirmRotate()} style={{ ...primaryButtonStyle, flex: 1 }}>
                Confirmer
              </button>
            </div>
          </div>
        )}

        {phase.kind === 'running' && (
          <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 24 }}>
            Rotation en cours… ne fermez pas cette fenêtre.
          </p>
        )}

        {phase.kind === 'failed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: 0, color: colors.accent, fontWeight: 600 }}>
              Rotation annulée — le coffre reste intact. {phase.message}
            </p>
            <button type="button" onClick={onClose} style={secondaryButtonStyle}>
              Fermer
            </button>
          </div>
        )}

        {phase.kind === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: 0 }}>
              Clé du coffre « {dossierName} » renouvelée. {phase.recipientCount} destinataire
              {phase.recipientCount > 1 ? 's' : ''} ré-autorisé{phase.recipientCount > 1 ? 's' : ''}. Relecture OK.
            </p>
            <button type="button" onClick={onClose} style={primaryButtonStyle}>
              Fermer
            </button>
          </div>
        )}

        {phase.kind === 'verifyFailed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0, color: colors.accent, fontWeight: 700 }}>
              ATTENTION : rotation écrite mais relecture échouée sur ce coffre. La clé a été renouvelée en base (
              {phase.recipientCount} destinataire{phase.recipientCount > 1 ? 's' : ''}) mais la relecture de
              vérification après écriture n’a pas produit le contenu attendu. Vérifiez ce coffre avant de faire
              confiance à son contenu.
            </p>
            <button type="button" onClick={onClose} style={secondaryButtonStyle}>
              Fermer
            </button>
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
