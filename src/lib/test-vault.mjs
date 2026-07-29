// Harnais de test autonome du cœur crypto du coffre.
// Lancer : node test-vault.mjs   (aucune dépendance, aucun accès réseau)
//
// Vérifie les chemins heureux ET que les mauvais chemins échouent bien.

import {
  generateRecoveryKey, createUserKeys,
  unlockWithPassword, unlockWithRecovery, resetPassword,
  generateDek, wrapDekForUser, unwrapDek,
  encryptContent, decryptContent,
} from "./vault.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m`); }
}
async function throws(name, fn) {
  try { await fn(); ok(name + " (doit échouer)", false); }
  catch { ok(name + " (échoue bien)", true); }
}

const NOTE = `Mastercode portail: 4729#
WiFi site: SSID=RegieDupont / clef=Zx9!vptR2024
KNX ligne 1.1: mot de passe ETS = koch-bvs-2087
Code alarme local technique: 55-12-08`;

console.log("\n== Coffre — tests crypto ==\n");

// 1) Enrôlement de deux utilisateurs (Alice = tech, Bob = tech).
const aliceRecovery = generateRecoveryKey();
const alice = await createUserKeys("motdepasse-alice-costaud", aliceRecovery);
const bob = await createUserKeys("motdepasse-bob-costaud", generateRecoveryKey());
const carol = await createUserKeys("motdepasse-carol", generateRecoveryKey()); // externe, non autorisé

console.log("Enrôlement");
ok("clé de récup lisible et espacée", /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/.test(aliceRecovery));
ok("public_key produite (spki base64)", typeof alice.public_key === "string" && alice.public_key.length > 100);
ok("clé privée jamais en clair (deux enveloppes distinctes)",
   alice.wrapped_private_key_pw !== alice.wrapped_private_key_recovery);
ok("IV mot de passe ≠ IV récupération", alice.pw_iv !== alice.recovery_iv);

// 2) Création d'un coffre : DEK, chiffrement, emballage vers Alice et Bob.
console.log("\nCréation du coffre + accès");
const dek = await generateDek();
const { ciphertext, content_iv } = await encryptContent(dek, NOTE);
const accessAlice = await wrapDekForUser(dek, alice.public_key);
const accessBob = await wrapDekForUser(dek, bob.public_key);
ok("le ciphertext ne contient pas le clair", !atob(ciphertext).includes("Mastercode"));
ok("DEK emballée différemment pour Alice et Bob (RSA-OAEP randomisé)", accessAlice !== accessBob);

// 3) Alice ouvre avec son mot de passe → déchiffre.
console.log("\nOuverture par mot de passe");
const alicePriv = await unlockWithPassword("motdepasse-alice-costaud", alice);
const aliceDek = await unwrapDek(accessAlice, alicePriv);
const aliceRead = await decryptContent(aliceDek, ciphertext, content_iv);
ok("Alice déchiffre le contenu à l'identique", aliceRead === NOTE);

// 4) Bob (autre destinataire) déchiffre le MÊME coffre via SA propre clé.
const bobPriv = await unlockWithPassword("motdepasse-bob-costaud", bob);
const bobDek = await unwrapDek(accessBob, bobPriv);
ok("Bob déchiffre le même coffre via sa clé", (await decryptContent(bobDek, ciphertext, content_iv)) === NOTE);

// 5) Mauvais mot de passe → refus.
console.log("\nMauvais chemins (doivent échouer)");
await throws("mauvais mot de passe", () => unlockWithPassword("mauvais", alice));

// 6) Carol n'a pas de DEK emballée → elle ne peut pas déchiffrer, même en
//    déverrouillant sa propre clé privée (elle n'est pas destinataire).
const carolPriv = await unlockWithPassword("motdepasse-carol", carol);
await throws("Carol (non autorisée) ne déballe pas la DEK d'Alice",
  () => unwrapDek(accessAlice, carolPriv));

// 7) Ouverture par clé de récupération.
console.log("\nClé de récupération");
const aliceViaRecovery = await unlockWithRecovery(aliceRecovery, alice);
const dekViaRecovery = await unwrapDek(accessAlice, aliceViaRecovery);
ok("Alice ouvre via clé de récupération", (await decryptContent(dekViaRecovery, ciphertext, content_iv)) === NOTE);
await throws("mauvaise clé de récupération", () => unlockWithRecovery("ZZZZ-ZZZZ-ZZZZ", alice));

// 8) Changement de mot de passe : repose sur clé récupérée (extractable),
//    l'ancien mot de passe ne doit plus ouvrir, le nouveau doit ouvrir.
console.log("\nChangement de mot de passe");
const alicePrivExtractable = await unlockWithRecovery(aliceRecovery, alice);
const patch = await resetPassword(alicePrivExtractable, "nouveau-mot-de-passe-alice");
const aliceUpdated = { ...alice, ...patch };
await throws("ancien mot de passe rejeté après changement",
  () => unlockWithPassword("motdepasse-alice-costaud", aliceUpdated));
const alicePrivNew = await unlockWithPassword("nouveau-mot-de-passe-alice", aliceUpdated);
const dekNew = await unwrapDek(accessAlice, alicePrivNew);
ok("nouveau mot de passe ouvre le coffre", (await decryptContent(dekNew, ciphertext, content_iv)) === NOTE);
ok("le contenu et les DEK n'ont pas changé (pas de re-chiffrement)",
   aliceUpdated.wrapped_private_key_recovery === alice.wrapped_private_key_recovery);

// 9) Rotation de DEK (révocation dure) : nouvelle DEK, re-chiffrement.
//    L'ancienne DEK ne doit plus déchiffrer le nouveau ciphertext.
console.log("\nRotation de clé (coupure dure)");
const plain = await decryptContent(aliceDek, ciphertext, content_iv); // Alice a accès, elle re-chiffre
const dek2 = await generateDek();
const rotated = await encryptContent(dek2, plain);
const accessAlice2 = await wrapDekForUser(dek2, alice.public_key); // ré-emballe pour les restants
ok("nouveau ciphertext ≠ ancien", rotated.ciphertext !== ciphertext);
await throws("ancienne DEK ne déchiffre plus après rotation",
  () => decryptContent(aliceDek, rotated.ciphertext, rotated.content_iv));
const aliceDek2 = await unwrapDek(accessAlice2, await unlockWithPassword("nouveau-mot-de-passe-alice", aliceUpdated));
ok("Alice lit le coffre roté avec la nouvelle DEK",
   (await decryptContent(aliceDek2, rotated.ciphertext, rotated.content_iv)) === plain);

// 10) IV frais : deux chiffrements du même clair donnent des ciphertext différents.
console.log("\nHygiène");
const c1 = await encryptContent(dek, NOTE);
const c2 = await encryptContent(dek, NOTE);
ok("IV frais à chaque chiffrement (ciphertext non déterministe)",
   c1.ciphertext !== c2.ciphertext && c1.content_iv !== c2.content_iv);

console.log(`\n== ${pass} réussis, ${fail} échoués ==\n`);
process.exit(fail === 0 ? 0 : 1);
