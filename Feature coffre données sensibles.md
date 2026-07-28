# Feature — Coffre de données sensibles (étape B)

Spécification dédiée. À relire avant toute implémentation de cette pièce.
Même statut que `Feature recherche web notices.md` : rien ne se construit dans
cette direction sans passer par ce document d'abord.

État : **conçu, pas encore implémenté.** La fiche dossier réserve déjà un
emplacement visuel désactivé (§10 du CLAUDE.md).

---

## 1. Objectif et périmètre

Un espace chiffré par dossier client regroupant les secrets d'un site :
mastercodes, mots de passe WiFi, clés KNX, codes d'accès. UN contenu sensible
par dossier (pas un champ par secret).

**En ligne uniquement pour v1.** Décision assumée : le hors ligne représente
moins de 5 % du temps terrain, et dans ces cas le monteur anticipe (il note les
codes utiles avant de descendre). Reproduire ici l'accès hors ligne de la
bibliothèque n'apporterait pas assez pour justifier le cache de contenu chiffré
et la réconciliation multi-appareils qui vont avec. Le schéma reste malgré tout
agnostique au réseau : ajouter le hors ligne plus tard = mettre le blob chiffré
en cache IndexedDB et déchiffrer localement, un ajout localisé sans migration.

Conséquence honnête de l'online-only : dans le sliver de 5 %, les codes notés à
la main vivent brièvement hors du coffre (papier, notes du téléphone). C'est le
compromis accepté, pas un défaut à corriger en v1.

---

## 2. Modèle cryptographique — chiffrement par enveloppe

On ne dérive **pas** la clé de chiffrement directement du mot de passe. On passe
par une enveloppe, pour deux raisons : offrir deux chemins d'ouverture (mot de
passe **ou** clé de récupération) sur un seul contenu chiffré, et permettre de
changer le mot de passe sans re-chiffrer le contenu.

**Primitives : WebCrypto natif (`crypto.subtle`) uniquement.** Aucune lib crypto
tierce. « Sous-traiter à une lib éprouvée » = utiliser l'AES/RSA/PBKDF2 du
navigateur, pas écrire son propre algorithme. Une lib JS externe serait ici un
risque supply-chain en plus, pas en moins.

### Les clés en jeu

- **DEK (Data Encryption Key)** — une clé AES-256-GCM aléatoire **par dossier**.
  C'est elle qui chiffre le contenu sensible. Générée côté client, jamais
  stockée en clair.
- **Paire RSA-OAEP par utilisateur** (2048 bits) — publiée à la première
  connexion. La clé **publique** sert à emballer une DEK vers cet utilisateur ;
  la clé **privée** sert à la déballer.
- **Clé dérivée du mot de passe de coffre** — PBKDF2-SHA256 (voir §3), protège
  la clé privée RSA de l'utilisateur.
- **Clé dérivée de la clé de récupération** — même rôle, chemin de secours.

### Ce que Supabase stocke (jamais rien en clair)

Contenu chiffré + IV ; clé privée RSA emballée deux fois (sous mot de passe et
sous clé de récupération) + sels + IV ; clé publique RSA en clair (elle est
publique par nature) ; DEK emballée vers la clé publique de chaque autorisé.
Jamais le mot de passe, jamais la clé de récupération, jamais une DEK ou une clé
privée nue.

### Les opérations, en clair

- **Chiffrer le contenu** : `AES-GCM(DEK, IV_frais, texte)`.
- **Donner accès à un utilisateur** : `wrapKey(DEK, sa_clé_publique_RSA)` →
  une ligne « DEK emballée pour lui ». **La présence de cette ligne EST
  l'accès.**
- **Ouvrir le coffre** (l'utilisateur tape son mot de passe de coffre) :
  dériver la clé PBKDF2 → déballer sa clé privée RSA → déballer la DEK du
  dossier → déchiffrer le contenu.
- **Changer de mot de passe** : déballer la clé privée RSA avec l'ancien, la
  ré-emballer avec le nouveau. Le contenu et les DEK emballées ne bougent pas.
- **Récupérer** (mot de passe perdu) : déballer la clé privée RSA via la clé de
  récupération, puis reposer un nouveau mot de passe. Ne touche que l'enveloppe
  « mot de passe » de cet utilisateur.

Alternative envisagée puis écartée pour v1 : ECDH au lieu de RSA-OAEP pour
l'emballage vers destinataire. Plus moderne, mais RSA-OAEP `wrapKey`/`unwrapKey`
est le chemin le plus direct pour « chiffrer vers une clé publique » et suffit
largement à l'échelle du projet.

---

## 3. Dérivation de clé — PBKDF2

PBKDF2-SHA256, natif WebCrypto. Nombre d'itérations stocké dans la table
(`kdf_iterations`) pour être ajustable sans migration. Valeur de départ à fixer
sur la recommandation OWASP **au moment d'implémenter** (l'ordre de grandeur
2026 est élevé, à revérifier — ne pas figer un chiffre ici qui serait périmé).
Sel aléatoire distinct pour l'enveloppe mot de passe et pour l'enveloppe
récupération.

---

## 4. Mot de passe de coffre — distinct du login, par utilisateur

**Le mot de passe du coffre n'est PAS le mot de passe de login, et ne peut pas
l'être.** Le login part chez Supabase Auth : Supabase reçoit ce mot de passe
pour le vérifier. Or Supabase est exactement la partie contre laquelle le
zero-knowledge protège. Si la clé du coffre dérivait du login, on tendrait la
clé au seul acteur qu'on voulait tenir dehors. Le mot de passe de coffre doit
être un secret que Supabase ne voit **jamais**.

Bénéfice de séparation en profondeur : un dump de base contient le hash bcrypt
du login **et** le contenu chiffré ; les garder indépendants évite qu'un login
faible cassé donne aussi le coffre.

**Un mot de passe par utilisateur** (pas un secret d'entreprise partagé) :
révocation nominative propre, pas de secret unique qui finit par fuiter. UX
terrain à soigner : une phrase de passe mémorisable, tapée seulement à
l'ouverture du coffre (pas à chaque session), distincte du login.

---

## 5. Modèle d'accès — trois niveaux

Le contrôle d'accès n'est pas une couche par-dessus la crypto : c'est ce que
l'enveloppe produit nativement. « Avoir accès » = « une DEK est-elle emballée
pour toi ? ».

- **Technicien interne — accès complet.** Chaque DEK est emballée vers sa clé
  publique. Il ouvre le coffre de tous les dossiers.
- **Apprenti / intérimaire / externe — refus par défaut.** Compte complet,
  toute l'appli, tous les dossiers clients — mais **aucune** DEK emballée à son
  nom. Le coffre lui est fermé non par un flag « non », mais parce qu'il n'a
  littéralement pas la clé. Verrouillé deux fois : la RLS ne lui sert pas le
  contenu chiffré, et même si elle lâchait il ne peut rien déchiffrer.
- **Activation manuelle et nominative.** Toi (qui as accès, donc peux déballer
  les DEK) : pour chaque dossier, déballe la DEK et ré-emballe-la vers la clé
  publique de la personne → insertion des lignes d'accès. Nominatif par
  construction.

Le levier admin est le drapeau `access_enabled` par utilisateur (défaut
`false` = externe = fermé). Le passer à `true` s'accompagne de l'emballage des
DEK ; à la création d'un dossier, sa DEK est emballée pour tous les utilisateurs
`access_enabled = true`.

L'accès est **global** (tous les dossiers ou aucun), ce qui correspond au besoin
exprimé. Le schéma supporterait un accès par-dossier plus fin (« quelles lignes
existent »), mais on ne construit pas cette granularité en v1.

---

## 6. Révocation — ce qu'elle garantit, et ce qu'elle ne garantit pas

Deux niveaux, à choisir selon le contexte du départ.

**Révocation douce (défaut).** Supprimer les lignes d'accès de la personne +
`access_enabled = false`. Coupe l'accès **futur** immédiatement : la RLS ne lui
sert plus le chiffré, elle n'a plus de chemin vers la DEK. Suffit pour le cas
courant (fin de stage, intérim qui se termine normalement).

Ce qu'elle ne fait pas : effacer ce qui a déjà été vu (les codes lus en clair
restent connus — irréversible), ni empêcher le déchiffrement d'une **ancienne
copie** que la personne aurait capturée (chiffré + sa clé privée) pendant
qu'elle avait accès.

**Rotation de clé (coupure dure, documentée).** Générer une nouvelle DEK,
re-chiffrer le contenu, ré-emballer pour ceux qui restent, supprimer les
anciennes lignes d'accès. L'ancienne copie capturée devient inutile. À réserver
aux départs sensibles.

L'online-only aide : rien n'étant mis en cache hors ligne, personne n'accumule
tranquillement du chiffré sur son appareil. Le résiduel (capture manuelle via
les outils dev pendant l'accès) est faible pour un outil interne — mais autant
savoir précisément ce que « révoquer » veut dire.

---

## 7. Garde-fous non négociables

- Rien en clair ne quitte jamais le client : ni le contenu, ni le mot de passe
  de coffre, ni la clé de récupération.
- Mot de passe de coffre et clé de récupération stockés **nulle part** par
  l'app : ni localStorage, ni IndexedDB, ni Supabase. En mémoire uniquement
  pendant la session, purgés au verrouillage et à la déconnexion.
- Clé de récupération générée côté client à la création, forte, affichée **une
  seule fois**, à imprimer et mettre au coffre physique. L'app ne la stocke
  pas ; elle fait confirmer « je l'ai notée » avant de continuer. Perte du mot
  de passe **et** de la clé de récupération = données irrécupérables, par
  conception.
- Verrouillage auto : clés dérivées purgées de la mémoire après inactivité.
- AES-GCM avec IV aléatoire frais à chaque chiffrement, jamais réutilisé avec
  la même clé.
- Aucun secret dans un prompt LLM (y compris les prompts Claude Code, qui
  travaillent sur des placeholders), ni dans les logs, ni dans Git.

**Limite du modèle, dite franchement.** Le zero-knowledge protège contre
Supabase, le réseau et un tiers. Il ne protège **pas** contre un JS compromis
livré depuis Cloudflare — la crypto navigateur suppose qu'on fait confiance au
code servi. Acceptable pour un outil interne, mais ce n'est pas le modèle de
menace d'un coffre natif.

---

## 8. Schéma SQL

Domaine coffre **auto-contenu** : ses propres tables, ses migrations versionnées
dans `supabase/migrations/` (comme `web_search_log`, pas comme les tables
métier gérées via n8n). Rien n'est alimenté par n8n ici.

### `vault_user_keys` — la paire de clés de chaque utilisateur (tranche 1)

```
user_id                        PK, FK auth.users
public_key                     clé publique RSA (spki, base64) — en clair
wrapped_private_key_pw         clé privée RSA emballée sous la clé PBKDF2 du mot de passe
wrapped_private_key_recovery   clé privée RSA emballée sous la clé PBKDF2 de récupération
pw_salt, recovery_salt         sels PBKDF2 distincts
pw_iv, recovery_iv             IV AES-GCM de chaque emballage
kdf_iterations                 int, ajustable
access_enabled                 bool, défaut false (levier admin, §5)
created_at, updated_at
```

### `vault_secrets` — le contenu chiffré, un par dossier (tranche 2)

```
dossier_id     PK, FK dossiers
ciphertext     contenu chiffré (AES-GCM)
content_iv     IV AES-GCM du contenu
dek_version    int, pour la rotation (§6)
updated_by, created_at, updated_at
```

### `vault_dossier_access` — les DEK emballées : présence = accès (tranche 2)

```
dossier_id     FK dossiers
user_id        FK auth.users
wrapped_dek    DEK emballée vers la clé publique RSA de cet utilisateur
dek_version    correspond à vault_secrets.dek_version
granted_by, granted_at
PK (dossier_id, user_id)
```

### RLS (principe)

- `vault_user_keys` : chacun lit/écrit **sa** ligne ; les clés **publiques** de
  tous sont lisibles (nécessaire pour emballer vers autrui) — exposées via une
  vue `vault_public_keys(user_id, public_key, access_enabled)`. Seul un `admin`
  change `access_enabled`.
- `vault_secrets` / `vault_dossier_access` : un utilisateur ne lit une ligne que
  s'il possède une ligne d'accès correspondante ; l'écriture (octroi,
  révocation, rotation) est réservée aux `admin`. À détailler en tranche 2.

---

## 9. Découpage d'implémentation (base d'abord, écrans ensuite)

1. **Tranche 1 — `vault_user_keys` + RLS + vue publique.** Testable en
   isolation : créer une ligne factice, vérifier qu'on lit la sienne, qu'un
   autre utilisateur ne modifie pas son `access_enabled`, que les clés publiques
   sont lisibles via la vue. Aucun écran. ← **étape courante**
2. **Tranche 2 — `vault_secrets` + `vault_dossier_access` + RLS.** Test base :
   simuler un octroi/révocation à la main.
3. **Tranche 3 — module crypto isolé** (`src/lib/vault.ts`) : génération de
   paire, dérivation PBKDF2, emballage/déballage, chiffrement/déchiffrement.
   Testé seul (aller-retour chiffrer→déchiffrer, récupération, changement de mot
   de passe) avant tout branchement UI.
4. **Tranche 4 — écrans** : première connexion (création de la paire + clé de
   récupération affichée une fois), ouverture/verrouillage du coffre, édition du
   contenu, panneau admin (activer/révoquer/roter).

---

## 10. Hors périmètre v1

- Accès au coffre par-dossier (granularité fine) — global suffit.
- Accès hors ligne au coffre (voir §1).
- Argon2 (PBKDF2 suffit ; à envisager si durcissement voulu).
- Historique/versions du contenu sensible.
