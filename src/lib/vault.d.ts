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

/** Octets chiffrés en binaire (pas base64) + IV en base64, pour un fichier. */
export interface EncryptedBytes {
  ciphertext: Uint8Array;
  iv: string;
}

/** Emballage d'une FEK sous la DEK du dossier (chiffrement symétrique, pas wrapKey). */
export interface WrappedFek {
  wrapped_fek: string;
  wrap_iv: string;
}

/** Nouvelle FEK aléatoire (extractable), une par fichier. */
export function generateFek(): Promise<CryptoKey>;

/** Chiffre des octets bruts (fichier) sous n'importe quelle clé AES-GCM. */
export function encryptBytes(key: CryptoKey, bytes: ArrayBuffer | Uint8Array): Promise<EncryptedBytes>;

/** Déchiffre des octets bruts (fichier). */
export function decryptBytes(key: CryptoKey, ciphertext: ArrayBuffer | Uint8Array, ivB64: string): Promise<ArrayBuffer>;

/** Emballe une FEK sous la DEK du dossier (export raw + encryptBytes). */
export function wrapFekForDek(fek: CryptoKey, dek: CryptoKey): Promise<WrappedFek>;

/** Déballe une FEK emballée sous la DEK du dossier.
 *  extractable=true uniquement pour ré-emballer la FEK vers une autre DEK (rotation). */
export function unwrapFekWithDek(
  wrappedFekB64: string,
  wrapIvB64: string,
  dek: CryptoKey,
  extractable?: boolean,
): Promise<CryptoKey>;
