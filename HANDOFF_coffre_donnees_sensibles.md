# Laydevant — Coffre de données sensibles
## Document de reprise (handoff)

Complète le HANDOFF général du projet. Résume l'état FINAL du coffre (l'ancienne
« étape B ») pour qu'une nouvelle conversation reprenne sans relire tout
l'historique. Le coffre est **terminé, déployé et testé** de bout en bout.
À jour au 30 juillet 2026.

Ce document garde surtout le POURQUOI des décisions — le code dit le comment,
lui seul dit pourquoi c'est ainsi.

---

## 1. Le coffre en bref

Un espace chiffré par dossier client regroupant les secrets d'un site :
mastercodes, mots de passe WiFi, clés KNX, codes d'accès. Chiffrement
**zero-knowledge côté client** (WebCrypto) : Supabase ne voit jamais rien en
clair. Accès réservé, récupération pensée pour une équipe peu disciplinée aux
mots de passe.

Statut : enrôlement (admin/monteur), ouverture (mot de passe ET clé de
récupération), notes distinctes, panneau admin complet (comptes, accès,
révocation, rotation) — tout fonctionne.

---

## 2. Architecture cryptographique — chiffrement par enveloppe

On ne dérive PAS la clé de chiffrement directement du mot de passe. Enveloppe,
pour deux raisons : deux chemins d'ouverture (mot de passe OU clé de
récupération) sur un seul contenu chiffré, et changer le mot de passe sans
re-chiffrer le contenu.

- **DEK** (Data Encryption Key) : une clé AES-256-GCM aléatoire **par dossier**,
  chiffre le contenu. Jamais stockée en clair.
- **Paire RSA-OAEP 2048 par utilisateur** : la clé publique sert à emballer une
  DEK vers quelqu'un (= lui donner accès) ; la privée à la déballer.
- **PBKDF2-SHA256** (600 000 itérations, stockées dans `kdf_iterations`,
  ajustable) protège la clé privée RSA — emballée sous une clé dérivée du mot
  de passe de coffre, et sous une clé dérivée de la clé de récupération.
- **WebCrypto natif uniquement** (`crypto.subtle`). Aucune lib crypto tierce :
  « sous-traiter à une lib éprouvée » = utiliser l'AES/RSA/PBKDF2 du navigateur,
  pas écrire son propre algorithme. Une lib JS externe serait un risque
  supply-chain en plus, pas en moins.

Ce que Supabase stocke, toujours chiffré : contenu + IV ; clé privée emballée
deux fois + sels + IV ; clé publique en clair (publique par nature) ; DEK
emballée vers la clé publique de chaque autorisé. Jamais un mot de passe, une
clé de récupération, une DEK ou une clé privée nue.

---

## 3. Modèle d'accès — trois niveaux

« Avoir accès » = « une DEK est-elle emballée pour toi ? ». Le contrôle d'accès
n'est pas une couche par-dessus la crypto, c'est ce que l'enveloppe produit.

- **Technicien interne — accès complet** : DEK emballée vers sa clé publique sur
  chaque coffre.
- **Apprenti / intérimaire / externe — refus par défaut** : compte complet,
  toute l'appli, tous les dossiers, mais AUCUNE DEK emballée à son nom. Le coffre
  est fermé non par un flag « non », mais parce qu'il n'a pas la clé. Verrouillé
  deux fois : la RLS ne lui sert pas le chiffré, et il ne pourrait pas déchiffrer.
- **Activation manuelle et nominative** : un admin déballe les DEK (il a accès)
  et les ré-emballe vers la clé publique de la personne.

Levier admin : le drapeau `access_enabled` (défaut false). L'accès est **global**
(tous les coffres ou aucun) — c'est le besoin exprimé. Le schéma supporterait un
accès par-dossier, non construit en v1.

---

## 4. Récupération — par admin, via ré-enrôlement (POINT CLÉ)

Contexte terrain décisif : équipe de très bons techniciens mais peu « tech »,
indisciplinés aux mots de passe (mot de passe Outlook à réinitialiser tous les
90 jours). Une clé de récupération individuelle qu'ils devraient imprimer et
garder est une fiction — elle sera perdue.

**Solution retenue : la récupération par l'admin remplace la clé papier
individuelle.** Le mécanisme, plus simple qu'il n'y paraît :

- Les DEK sont emballées vers les **deux admins-récupérateurs**, qui ont donc
  accès à TOUS les coffres.
- Un monteur qui oublie son mot de passe de coffre NE récupère pas son ancienne
  clé : il se **ré-enrôle** (nouvelle paire, nouveau mot de passe), et un admin
  lui **ré-emballe ses accès** (exactement le geste « activer/réparer l'accès »).
  Le monteur peut même initier son propre ré-enrôlement, car son login (Outlook/
  Supabase) et son mot de passe de coffre sont séparés.
- **Zéro clé papier pour les monteurs**, zéro discipline attendue.

> Piège technique qui a écarté l'approche « emballer la clé privée du monteur
> vers l'admin » : RSA ne chiffre que ~190 octets, une clé privée en fait >1000.
> Il aurait fallu un montage hybride, une table de plus, de la crypto à
> re-tester. Le ré-enrôlement réutilise 100 % de la crypto déjà testée.

**Les deux admins-récupérateurs** (drapeau `is_recovery_admin`) : eux, et eux
seuls, ont une **vraie clé de récupération imprimée** au coffre-fort. Ils se
récupèrent mutuellement (tant qu'un des deux garde l'accès, il ré-emballe pour
l'autre). Contrainte d'installation : **les admins s'enrôlent EN PREMIER**,
avant tout monteur (sinon un monteur s'enrôlerait sans que les récupérateurs
aient accès à son futur coffre).

**Prix assumé** : les deux admins peuvent ouvrir tous les coffres. La sécurité
de l'ensemble repose donc sur leurs deux comptes — mots de passe de coffre =
clés maîtresses, longs, uniques, distincts des logins.

---

## 5. Révocation vs rotation

Deux gestes distincts, pour deux besoins.

- **Révocation (douce)** : `access_enabled = false` + DELETE des lignes d'accès.
  Coupe l'accès FUTUR immédiatement. N'efface pas ce qui a été vu, ni une copie
  chiffrée que la personne aurait capturée pendant qu'elle avait accès. Suffit
  pour un départ normal (fin de stage, intérim).
- **Rotation (dure)** : nouvelle DEK, re-chiffrement du contenu, ré-emballage
  vers les restants. Invalide toute ancienne copie capturée. Pour un départ
  sensible. **Par coffre**, depuis l'onglet Rotation (pas globale — voir §6).

Ordre logique : révoquer d'abord, roter ensuite (sinon la nouvelle clé est
ré-emballée vers la personne aussi). L'écran de rotation le rappelle.

---

## 6. Décisions clés et leur pourquoi

- **Online-only en v1** : le hors ligne c'est <5 % du temps, le monteur anticipe
  (note les codes avant de descendre). Schéma agnostique au réseau — ajouter le
  hors ligne plus tard = mettre le blob chiffré en cache IndexedDB, sans
  migration.
- **Mot de passe de coffre ≠ login** : le login part chez Supabase Auth, l'acteur
  même contre qui protège le zero-knowledge. Défense en profondeur.
- **Un mot de passe par utilisateur** (pas de secret d'entreprise partagé).
- **RSA-OAEP plutôt qu'ECDH** : `wrapKey`/`unwrapKey` est le chemin le plus
  direct pour « chiffrer vers une clé publique ».
- **PBKDF2 plutôt qu'Argon2** : natif, zéro dépendance.
- **Notes = blob JSON chiffré unique** (pas une ligne chiffrée par note) : les
  titres restent chiffrés (pas de fuite), zéro changement de schéma/crypto. Le
  contenu déchiffré est `[{id, titre, texte}, …]`. Rétrocompatible : si le parse
  JSON échoue (ancien coffre texte brut), traité comme une note unique.
- **Rotation par coffre, pas globale** : une rotation globale n'est pas atomique
  (peut casser au milieu, pas de rollback) et est excessive. Par coffre = simple,
  sûr, atomique, couvre le vrai besoin. Roter 40 coffres est un cas qui ne
  devrait jamais arriver.
- **Rotation atomique via fonction Postgres** (`rotate_vault_secret`,
  SECURITY DEFINER) : la rotation réécrit le ciphertext ET remplace les lignes
  d'accès — deux écritures. Une fonction les fait dans UNE transaction, éliminant
  la fenêtre où le coffre serait incohérent si le téléphone meurt entre les deux.
  Toute la crypto reste côté client ; la fonction ne reçoit que du déjà-chiffré.

---

## 7. Schéma SQL (4 migrations versionnées dans supabase/migrations/)

- **`vault_user_keys`** (tranche 1) : paire de clés par user. Colonnes :
  `user_id` PK, `public_key`, `wrapped_private_key_pw`,
  `wrapped_private_key_recovery`, `pw_salt`, `recovery_salt`, `pw_iv`,
  `recovery_iv`, `kdf_iterations`, `access_enabled` (défaut false),
  `is_recovery_admin` (ajouté tranche 1-bis), `created_at`, `updated_at`.
- **`vault_secrets`** (tranche 2) : `dossier_id` PK, `ciphertext`, `content_iv`,
  `dek_version`, `updated_by`, timestamps. Un coffre par dossier.
- **`vault_dossier_access`** (tranche 2) : `dossier_id` + `user_id` (PK),
  `wrapped_dek`, `dek_version`, `granted_by`, `granted_at`. **Présence =
  accès.**

Vues : `vault_public_keys` (`user_id`, `public_key` WHERE `access_enabled`) ;
`vault_recovery_admins` (idem WHERE `is_recovery_admin AND access_enabled`).
Les deux sont SECURITY DEFINER (contournent la RLS pour n'exposer que des clés
PUBLIQUES) → Supabase lève une alerte « SECURITY DEFINER view », **faux positif
assumé** (elles n'exposent rien de sensible).

Fonctions : `is_vault_admin()`, `has_vault_access()`,
`has_dossier_vault_access(dossier_id)`, `rotate_vault_secret(...)` — toutes
SECURITY DEFINER, `search_path=public`, grant execute to authenticated, et
`rotate_vault_secret` vérifie `is_vault_admin()` en interne.

Trigger `vault_user_keys_guard` : sur INSERT/UPDATE, si l'appelant n'est pas
admin, force `access_enabled` et `is_recovery_admin` à false/valeur d'origine.
Empêche un utilisateur de s'auto-octroyer l'accès ou le rôle récupérateur.

Migrations, dans l'ordre : `vault_user_keys` → `vault_secrets_access` →
`vault_recovery_admin` → `vault_rotate_secret`.

---

## 8. Le module crypto — src/lib/vault.js

JS ESM pur, WebCrypto natif, **portable navigateur ET Node** (même
`globalThis.crypto`). Compagnon `vault.d.ts` pour les types (sans `allowJs`).
Harnais `test-vault.mjs` : `node test-vault.mjs` → **20 tests**, chemins heureux
ET refus attendus (mauvais mot de passe, non-autorisé, etc.). NE PAS modifier ce
fichier sans relancer le harnais.

Fonctions : `generateRecoveryKey`, `createUserKeys`, `unlockWithPassword(…,
extractable=false)`, `unlockWithRecovery`, `resetPassword`, `wrapDekForUser`,
`unwrapDek(…, extractable=false)`, `generateDek`, `encryptContent`,
`decryptContent`.

> Le paramètre `extractable` de `unwrapDek` a été ajouté pour le ré-emballage /
> la rotation (cf. §11, bug « key is not extractable »). Le 20e test couvre ce
> chemin. Défaut `false` = comportement inchangé partout ailleurs.

---

## 9. Les écrans (tranche 4)

- **Enrôlement** : deux flux selon `profiles.role`. STRICT (admin) — clé de
  récupération affichée + blocage « j'ai imprimé », mot de passe ≥ 16 car.
  LÉGER (monteur) — mot de passe ≥ 12 car., pas de clé affichée (générée puis
  jetée), bloqué si aucun admin-récupérateur n'existe encore.
- **Ouverture / édition du coffre** (depuis la fiche dossier, section « Données
  sensibles ») : déverrouillage par mot de passe OU clé de récupération, session
  déverrouillée valable tant qu'on reste sur un écran « dossier », auto-lock 15
  min + purge en quittant. Notes distinctes (ajouter / consulter / modifier /
  supprimer avec confirmation). Distingue « coffre vide » de « accès non
  autorisé » (pré-check `has_vault_access`).
- **Panneau admin** (`VaultAdminScreen`, réservé `is_vault_admin`), trois
  onglets : **Comptes** (liste, badges enrôlé/accès/récupérateur), **Accès**
  (Activer / Réparer l'accès, Révoquer), **Rotation** (liste des coffres par nom
  de client, rotation par coffre).

---

## 10. Garde-fous non négociables

- Rien en clair ne quitte le client : contenu, mot de passe de coffre, clé de
  récupération. Jamais en localStorage/sessionStorage/IndexedDB, jamais en log.
- Clé de récupération admin affichée une seule fois, imprimée, jamais stockée.
- Clés déverrouillées purgées au verrouillage, en quittant l'écran dossier,
  et à l'auto-lock 15 min.
- AES-GCM avec IV frais à chaque chiffrement.
- Aucun secret dans un prompt LLM (Claude Code travaille sur des placeholders).
- **Limite du modèle, assumée** : le zero-knowledge protège contre Supabase, le
  réseau, un tiers. PAS contre un JS compromis servi depuis Cloudflare (on fait
  confiance au code servi). Acceptable pour un outil interne.

---

## 11. Pièges rencontrés et leçons (utiles pour la suite)

- **« key is not extractable »** : `unwrapDek` créait la DEK en non-extractable,
  or `wrapDekForUser` exige `extractable === true` pour la ré-emballer. Le
  message d'erreur était d'abord masqué (rangé à tort en « pas d'accès admin »).
  Leçon : faire remonter le VRAI message avant de corriger. Fix : paramètre
  `extractable` sur `unwrapDek`.
- **Le trigger `vault_user_keys_guard` mord dans l'éditeur SQL** : en rôle
  `postgres`, `auth.uid()` est null → le trigger prend l'appelant pour un
  non-admin et remet `access_enabled`/`is_recovery_admin` à false. Pour le
  bootstrap admin en SQL : `alter table … disable trigger …` le temps de
  l'`update`, puis réactiver. Depuis l'app (admin connecté), pas de problème.
- **Migration exécutée à la main = non « trackée » par le CLI Supabase** : elle
  EST en base (l'éditeur dit « Success »), mais le registre du CLI l'ignore car
  ce n'est pas lui qui l'a posée. Sans conséquence tant qu'on applique à la main.
  Le fichier versionné suffit pour la reproductibilité. Fait confiance à la base
  (éditeur SQL), pas au registre du CLI.
- **Claude Code réécrit / paraphrase** : il a une fois réécrit `is_vault_admin()`
  en inline au lieu de garder la fonction ; il a aussi affirmé « ce fichier
  n'existe pas » (mauvais environnement). Réflexes : coller le SQL exact +
  interdire toute réécriture + « montre le diff avant commit » ; et vérifier ses
  affirmations avec `ls` / `git` / l'éditeur SQL — la source brute prime toujours
  sur son résumé.

---

## 12. Dettes et points de vigilance

- **Compte « Tech test »** (`7ca64655…`, role monteur, enrôlé) = compte de test.
  À supprimer avant exploitation réelle (Auth + `profiles` + `vault_user_keys`).
- **Pas de geste UI pour gérer `is_recovery_admin`** (donner/retirer le rôle
  récupérateur) : fait en SQL à la main. La révocation refuse un récupérateur et
  renvoie « le retrait du rôle se fait en base ». Acceptable tant que les 2
  récupérateurs sont John.
- **Garde-fou « au moins un récupérateur parmi les destinataires » à la
  rotation** : vit côté app (`VaultRotationSheet`), pas dans la fonction SQL.
  Sans risque tant que les 2 admins ont accès à tout. Ceinture-et-bretelles
  possible côté base si un jour nécessaire.
- **Plan Supabase FREE** : 1 Go de base (surtout un enjeu pour le futur Storage
  photos, pas pour le coffre qui est frugal) ; pause après ~1 semaine
  d'inactivité (non concerné dès que l'app est utilisée par l'équipe).
- **Alerte Supabase « SECURITY DEFINER view »** sur les deux vues de clés
  publiques : faux positif assumé (§7).

---

## 13. État d'installation actuel

- **John Maendly** (`0c658629…`) — compte actif, admin, `access_enabled = true`,
  `is_recovery_admin = true`, enrôlé.
- **Compte de repli** (`d43c8cd2…`, schlagiator@hotmail.fr) — 2e compte de John,
  « dormant » / break-glass, admin, `access_enabled = true`,
  `is_recovery_admin = true`, enrôlé. Sa clé de récupération est imprimée et
  rangée séparément de celle du compte actif.
- Les deux clés papier sont gérées physiquement par John.
- Break-glass testé : le compte de repli ouvre bien les coffres avec SA clé de
  récupération. À re-vérifier ~1×/an (compte non désactivé, clé lisible).

Rappel : mots de passe de coffre des deux comptes DIFFÉRENTS l'un de l'autre et
des logins. Le dormant n'a pas à être mémorisé (il vit sur son papier).

---

## 14. Prochain chantier — carnet non-sensible (hors coffre)

Remarques, photos, infos d'installation partagées par TOUS. **Ne doit PAS passer
par le coffre** : ce n'est pas secret, donc pas chiffré, pas gouverné par la
crypto. Table séparée (`dossier_notes` ou similaire), en clair, RLS « tout
authentifié lit/écrit ». Les photos impliquent Supabase Storage (attention au
1 Go du plan FREE). Chantier indépendant, plus léger, sans crypto.

---

## 15. Méthode de travail (rappelée, elle a bien tenu)

- **Découper** : chaque pièce en tranches testées une à une, base (SQL) validée
  avant écrans, crypto isolée et testée avant branchement UI.
- **Diagnostiquer avant de patcher** : exiger de Claude Code la cause confirmée,
  pas une hypothèse ; refuser « afficher l'erreur » comme substitut à « corriger
  la cause ».
- **La source brute prime** : `ls`, `git log`, l'éditeur SQL, l'écran réel —
  jamais le résumé d'un agent.
- **Ne jamais modifier `vault.js` sans relancer le harnais** (20/20).
- **Le travail n'existe que poussé** : commit + push depuis le terminal
  authentifié de John, pas délégué. Versionner les migrations dans le repo même
  quand on les applique à la main dans l'éditeur.
