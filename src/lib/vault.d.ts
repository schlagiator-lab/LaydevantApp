// Types du cœur crypto du coffre. Compagnon de vault.js : permet à l'app
// TypeScript d'importer le module sans activer allowJs.

/** Ligne stockée dans vault_user_keys (hors user_id/access_enabled/timestamps). */
export interface UserKeyRecord {
  public_key: string;
  wrapped_private_key_pw: string;
  wrapped_private_key_recovery: string;
  pw_salt: string;
  recovery_salt: string;
  pw_iv: string;
  recovery_iv: string;
  kdf_iterations: number;
}

/** Champs à réécrire dans vault_user_keys après un changement de mot de passe. */
export interface PasswordResetPatch {
  wrapped_private_key_pw: string;
  pw_salt: string;
  pw_iv: string;
  kdf_iterations: number;
}

/** Contenu chiffré destiné à vault_secrets. */
export interface EncryptedContent {
  ciphertext: string;
  content_iv: string;
}

/** Clé de récupération lisible, à afficher une seule fois puis oublier. */
export function generateRecoveryKey(): string;

/** Première connexion : crée la paire RSA et emballe la privée deux fois. */
export function createUserKeys(password: string, recoveryKey: string): Promise<UserKeyRecord>;

/** Déverrouille la clé privée RSA via le mot de passe de coffre.
 *  extractable=true uniquement pour un changement de mot de passe. */
export function unlockWithPassword(password: string, rec: UserKeyRecord, extractable?: boolean): Promise<CryptoKey>;

/** Déverrouille la clé privée RSA via la clé de récupération (extractable). */
export function unlockWithRecovery(recoveryKey: string, rec: UserKeyRecord): Promise<CryptoKey>;

/** Repose un nouveau mot de passe à partir d'une clé privée déverrouillée. */
export function resetPassword(privateKeyExtractable: CryptoKey, newPassword: string): Promise<PasswordResetPatch>;

/** Emballe une DEK vers la clé publique d'un destinataire (= donner accès). */
export function wrapDekForUser(dek: CryptoKey, recipientPublicKeyB64: string): Promise<string>;

/** Déballe la DEK d'un dossier avec sa propre clé privée.
 *  extractable=true uniquement pour ré-emballer la DEK vers un autre destinataire. */
export function unwrapDek(wrappedDekB64: string, privateKey: CryptoKey, extractable?: boolean): Promise<CryptoKey>;

/** Nouvelle DEK aléatoire (pour créer un coffre ou faire une rotation). */
export function generateDek(): Promise<CryptoKey>;

/** Chiffre le contenu texte du coffre. */
export function encryptContent(dek: CryptoKey, plaintext: string): Promise<EncryptedContent>;

/** Déchiffre le contenu texte du coffre. */
export function decryptContent(dek: CryptoKey, ciphertextB64: string, ivB64: string): Promise<string>;
