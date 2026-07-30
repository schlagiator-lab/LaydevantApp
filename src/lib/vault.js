// @ts-check
/**
 * Coffre de données sensibles — cœur cryptographique.
 *
 * WebCrypto natif uniquement (globalThis.crypto.subtle) : identique en
 * navigateur et en Node 20+. Aucune dépendance, aucun algorithme "maison".
 *
 * Modèle (voir "Feature coffre données sensibles.md") :
 *   - une DEK AES-256-GCM aléatoire par dossier chiffre le contenu ;
 *   - chaque utilisateur a une paire RSA-OAEP ; la DEK est emballée vers sa
 *     clé publique (= accès) ;
 *   - la clé privée RSA est elle-même emballée deux fois : sous une clé
 *     dérivée du mot de passe de coffre (PBKDF2) et sous une clé dérivée de
 *     la clé de récupération.
 *
 * Rien en clair ne sort d'ici : le module rend des chaînes base64
 * (contenu chiffré, clés emballées, sels, IV) destinées à Supabase, et des
 * CryptoKey non exportables destinées à rester en mémoire de session.
 */

const SUBTLE = globalThis.crypto.subtle;

// --- Paramètres. PBKDF2_ITERATIONS : revérifier la reco OWASP au moment
// --- d'implémenter (ordre de grandeur 2026 élevé). Stocké en base par ligne
// --- (kdf_iterations) pour rester ajustable sans re-chiffrer.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;
const IV_BYTES = 12; // standard AES-GCM
const RSA_MODULUS = 2048;

// ------------------------------------------------------------------ helpers

/** @param {ArrayBuffer|Uint8Array} buf @returns {string} */
function bufToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** @param {string} b64 @returns {Uint8Array} */
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** @param {number} n @returns {Uint8Array} */
function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Dérive une clé AES-GCM d'emballage à partir d'un secret texte (mot de
 * passe de coffre ou clé de récupération) via PBKDF2.
 * @param {string} secret
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Promise<CryptoKey>}
 */
async function deriveWrappingKey(secret, salt, iterations) {
  const base = await SUBTLE.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return SUBTLE.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: PBKDF2_HASH },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

// ------------------------------------------------------- clé de récupération

/**
 * Génère une clé de récupération lisible (128 bits d'entropie), à afficher
 * UNE fois et imprimer. Jamais stockée par l'app.
 * Format : 8 groupes de 4 caractères base32 (Crockford), ex "A3F2-9B1C-...".
 * @returns {string}
 */
export function generateRecoveryKey() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (sans I,L,O,U)
  const bytes = randomBytes(20); // 160 bits -> 32 chars base32
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] & 31];
  return (out.match(/.{1,4}/g) || []).join("-");
}

// --------------------------------------------------- enrôlement utilisateur

/**
 * @typedef {Object} UserKeyRecord
 * @property {string} public_key
 * @property {string} wrapped_private_key_pw
 * @property {string} wrapped_private_key_recovery
 * @property {string} pw_salt
 * @property {string} recovery_salt
 * @property {string} pw_iv
 * @property {string} recovery_iv
 * @property {number} kdf_iterations
 */

/**
 * Première connexion : crée la paire RSA de l'utilisateur et emballe sa clé
 * privée sous le mot de passe ET sous la clé de récupération.
 * @param {string} password
 * @param {string} recoveryKey
 * @returns {Promise<UserKeyRecord>}
 */
export async function createUserKeys(password, recoveryKey) {
  const pair = await SUBTLE.generateKey(
    { name: "RSA-OAEP", modulusLength: RSA_MODULUS, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, // extractable : la privée doit pouvoir être emballée
    ["wrapKey", "unwrapKey"]
  );

  const spki = await SUBTLE.exportKey("spki", pair.publicKey);
  const pkcs8 = await SUBTLE.exportKey("pkcs8", pair.privateKey);

  const pwSalt = randomBytes(SALT_BYTES);
  const recSalt = randomBytes(SALT_BYTES);
  const pwIv = randomBytes(IV_BYTES);
  const recIv = randomBytes(IV_BYTES);

  const pwKey = await deriveWrappingKey(password, pwSalt, PBKDF2_ITERATIONS);
  const recKey = await deriveWrappingKey(recoveryKey, recSalt, PBKDF2_ITERATIONS);

  // Import éphémère de la privée en tant que "clé à emballer" pour chaque enveloppe.
  const privForWrap = await SUBTLE.importKey(
    "pkcs8", pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true, ["unwrapKey"]
  );

  const wrappedPw = await SUBTLE.wrapKey("pkcs8", privForWrap, pwKey, { name: "AES-GCM", iv: pwIv });
  const wrappedRec = await SUBTLE.wrapKey("pkcs8", privForWrap, recKey, { name: "AES-GCM", iv: recIv });

  return {
    public_key: bufToB64(spki),
    wrapped_private_key_pw: bufToB64(wrappedPw),
    wrapped_private_key_recovery: bufToB64(wrappedRec),
    pw_salt: bufToB64(pwSalt),
    recovery_salt: bufToB64(recSalt),
    pw_iv: bufToB64(pwIv),
    recovery_iv: bufToB64(recIv),
    kdf_iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Déverrouille la clé privée RSA à partir du mot de passe de coffre.
 * @param {string} password
 * @param {UserKeyRecord} rec
 * @param {boolean} [extractable=false] true seulement pour changer le mot de passe
 * @returns {Promise<CryptoKey>}
 */
export async function unlockWithPassword(password, rec, extractable = false) {
  const key = await deriveWrappingKey(password, b64ToBuf(rec.pw_salt), rec.kdf_iterations);
  return SUBTLE.unwrapKey(
    "pkcs8", b64ToBuf(rec.wrapped_private_key_pw), key,
    { name: "AES-GCM", iv: b64ToBuf(rec.pw_iv) },
    { name: "RSA-OAEP", hash: "SHA-256" },
    extractable, ["unwrapKey"]
  );
}

/**
 * Déverrouille la clé privée RSA via la clé de récupération (extractable,
 * car ce chemin sert à reposer un mot de passe).
 * @param {string} recoveryKey
 * @param {UserKeyRecord} rec
 * @returns {Promise<CryptoKey>}
 */
export async function unlockWithRecovery(recoveryKey, rec) {
  const key = await deriveWrappingKey(recoveryKey, b64ToBuf(rec.recovery_salt), rec.kdf_iterations);
  return SUBTLE.unwrapKey(
    "pkcs8", b64ToBuf(rec.wrapped_private_key_recovery), key,
    { name: "AES-GCM", iv: b64ToBuf(rec.recovery_iv) },
    { name: "RSA-OAEP", hash: "SHA-256" },
    true, ["unwrapKey"]
  );
}

/**
 * Repose un nouveau mot de passe de coffre à partir d'une clé privée déjà
 * déverrouillée (extractable). Ne touche ni le contenu ni les DEK.
 * @param {CryptoKey} privateKeyExtractable
 * @returns {Promise<{wrapped_private_key_pw:string, pw_salt:string, pw_iv:string, kdf_iterations:number}>}
 */
export async function resetPassword(privateKeyExtractable, newPassword) {
  const pwSalt = randomBytes(SALT_BYTES);
  const pwIv = randomBytes(IV_BYTES);
  const pwKey = await deriveWrappingKey(newPassword, pwSalt, PBKDF2_ITERATIONS);
  const wrapped = await SUBTLE.wrapKey("pkcs8", privateKeyExtractable, pwKey, { name: "AES-GCM", iv: pwIv });
  return {
    wrapped_private_key_pw: bufToB64(wrapped),
    pw_salt: bufToB64(pwSalt),
    pw_iv: bufToB64(pwIv),
    kdf_iterations: PBKDF2_ITERATIONS,
  };
}

// ------------------------------------------------------------- DEK / contenu

/**
 * Emballe une DEK vers la clé publique RSA d'un destinataire (= lui donner
 * accès). @param {CryptoKey} dek @param {string} recipientPublicKeyB64
 * @returns {Promise<string>} wrapped_dek base64
 */
export async function wrapDekForUser(dek, recipientPublicKeyB64) {
  const pub = await SUBTLE.importKey(
    "spki", b64ToBuf(recipientPublicKeyB64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false, ["wrapKey"]
  );
  const wrapped = await SUBTLE.wrapKey("raw", dek, pub, { name: "RSA-OAEP" });
  return bufToB64(wrapped);
}

/**
 * Déballe la DEK d'un dossier avec sa propre clé privée RSA.
 * @param {string} wrappedDekB64 @param {CryptoKey} privateKey
 * @param {boolean} [extractable=false] true seulement pour ré-emballer la DEK
 *   vers un autre destinataire (wrapKey exige une clé extractable)
 * @returns {Promise<CryptoKey>}
 */
export async function unwrapDek(wrappedDekB64, privateKey, extractable = false) {
  return SUBTLE.unwrapKey(
    "raw", b64ToBuf(wrappedDekB64), privateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    extractable, ["encrypt", "decrypt"]
  );
}

/** @returns {Promise<CryptoKey>} nouvelle DEK aléatoire (extractable pour emballage) */
export async function generateDek() {
  return SUBTLE.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/**
 * Chiffre le contenu texte du coffre.
 * @param {CryptoKey} dek @param {string} plaintext
 * @returns {Promise<{ciphertext:string, content_iv:string}>}
 */
export async function encryptContent(dek, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ct = await SUBTLE.encrypt({ name: "AES-GCM", iv }, dek, enc.encode(plaintext));
  return { ciphertext: bufToB64(ct), content_iv: bufToB64(iv) };
}

/**
 * Déchiffre le contenu texte du coffre.
 * @param {CryptoKey} dek @param {string} ciphertextB64 @param {string} ivB64
 * @returns {Promise<string>}
 */
export async function decryptContent(dek, ciphertextB64, ivB64) {
  const pt = await SUBTLE.decrypt(
    { name: "AES-GCM", iv: b64ToBuf(ivB64) }, dek, b64ToBuf(ciphertextB64)
  );
  return dec.decode(pt);
}
