# Laydevant — Fichiers chiffrés dans le coffre (modèle enveloppe FEK)
## Document de reprise (handoff) — le 6e

Complète les cinq HANDOFF existants (projet général, coffre de données sensibles,
carnet/onboarding/recherche, finitions/navigation/clés/ingestion-lot, migration
documents R2). Résume le chantier « fichiers chiffrés dans le coffre », mené d'un
bout à l'autre dans une session en 5 tranches testées une à une, **terminé,
déployé et testé** (dépôt, ouverture, titre, suppression, rotation). Garde surtout
le POURQUOI — le code dit le comment, lui seul dit pourquoi c'est ainsi.

À jour au 16 août 2026.

> À lire avec `ETAT_PROJET.md` (l'état présent) : ce HANDOFF est l'archive du
> raisonnement ; l'ETAT dit ce qui EST, ce fichier dit POURQUOI on y est arrivé.
> Le contrat crypto d'origine du coffre est dans `HANDOFF_coffre_donnees_sensibles.md` ;
> ce chantier s'y appuie sans le modifier.

---

## 0. Le besoin

Pouvoir déposer dans le coffre par dossier, en plus des notes texte, des
**fichiers** : PDF ou photos de credentials, données d'accès provider (IP, login,
mot de passe d'une box domotique, etc.). Contrainte non négociable : **rester
zero-knowledge**. Supabase et R2 ne doivent jamais voir le clair — ni les octets,
ni même le nom du fichier.

Le coffre ne gérait jusqu'ici que du texte (le blob JSON des notes, chiffré sous la
DEK du dossier). Un fichier binaire lourd change trois choses : où stocker les
octets, comment les chiffrer sans casser la rotation, et comment ne pas fuiter par
le nom de fichier.

---

## 1. Le coffre-fichiers en bref

Chaque fichier a sa **propre clé (FEK, File Encryption Key)**. Les **octets** sont
chiffrés sous la FEK et stockés sur **R2**. Le **nom + type** sont chiffrés sous la
FEK. La **FEK est emballée sous la DEK** du dossier. Seule la **taille** reste en
clair (affichage UI). R2/Supabase ne voient que du chiffré.

Statut : dépôt (multi-fichiers séquentiel, bootstrap d'un coffre vierge), liste
(nom déchiffré en mémoire), ouverture « en grand » (image in-app / PDF selon
plateforme), titre éditable, partage, suppression, et **rotation** qui préserve les
fichiers — tout fonctionne.

---

## 2. Décision d'architecture n°1 — l'enveloppe FEK, pas le chiffrement direct DEK

C'est LE choix qui commande tout le reste, et il se décide sur un seul mot : la
**rotation**.

La rotation d'un coffre change sa DEK, dans une transaction Postgres **atomique**
(le contenu re-chiffré et les accès ré-emballés basculent d'un coup ; si le
téléphone meurt au milieu, rien n'est incohérent). Deux modèles étaient possibles :

- **Chiffrement direct DEK** (rejeté) : les octets d'un fichier chiffrés
  directement avec la DEK. À chaque rotation, il faudrait **re-télécharger,
  déchiffrer, re-chiffrer et re-uploader chaque PDF** sur R2. Impossible à mettre
  dans une transaction Postgres → **fin de l'atomicité** : un plantage en cours de
  route laisserait des fichiers illisibles.
- **Enveloppe FEK** (retenu) : chaque fichier chiffré par sa propre FEK (32 octets),
  et **seule cette petite clé est emballée par la DEK**. Roter ne ré-emballe que les
  FEK, dans la transaction ; **les gros fichiers sur R2 ne bougent jamais**. La
  rotation reste instantanée et atomique, exactement comme pour les notes.

C'est **le même principe d'enveloppe** que le coffre d'origine (« la DEK emballée
vers chaque utilisateur »), appliqué d'un cran plus bas (« la FEK emballée sous la
DEK »). Réutilise 100 % de la philosophie déjà éprouvée.

---

## 3. Décision d'architecture n°2 — stockage R2, pas en base

Les octets chiffrés d'un PDF sont lourds → Postgres FREE (1 Go) est exclu, c'est
précisément l'anti-pattern qu'on a fui à la migration documents. R2 (10 Go, egress
zéro) a déjà le Worker qui déplace des octets authentifiés, et le zero-knowledge
tient : **le Worker ne voit que du chiffré**, jamais le clair. Clé R2 :
`vault/{dossierId}/{uuid}`. Les métadonnées crypto (petites) vont en base, dans
`vault_files`.

---

## 4. Décision d'architecture n°3 — chiffrer aussi le nom + le type

Un nom de fichier en clair (« swisscom-routeur-admin.pdf ») trahirait le contenu.
Comme les **titres** de notes sont déjà chiffrés, on chiffre aussi le **nom + le
type** du fichier. Il ne reste en clair qu'une clé de stockage aléatoire, la taille,
et la FEK emballée — rien de parlant.

**Sous quelle clé ?** Sous la **FEK**, pas sous la DEK. Raison : si on chiffrait les
métadonnées sous la DEK, la rotation devrait les re-chiffrer à chaque fois. Sous la
FEK (qui ne change jamais), la rotation ne touche vraiment **que** l'emballage de la
FEK — nom, type ET octets restent intacts. On réutilise `encryptContent`/
`decryptContent` (génériques) avec la FEK, aucune nouvelle fonction pour ça.

---

## 5. Le détail crypto décisif — « emballer la FEK » = la chiffrer avec la DEK

Piège que l'inspection du code a permis d'éviter. Instinct premier : utiliser
`SubtleCrypto.wrapKey`/`unwrapKey` pour emballer la FEK vers la DEK. **Impossible
sans casser l'existant** : la DEK, telle qu'elle vit en session (reconstituée par
`unwrapDek`), a les droits `encrypt`/`decrypt`, **pas** `wrapKey`/`unwrapKey`.
Utiliser `wrapKey` aurait obligé à modifier `generateDek`/`unwrapDek` — de la crypto
déjà testée qu'on ne veut surtout pas toucher.

**La parade** : « emballer la FEK » = **exporter la FEK en `raw` (32 octets) puis
chiffrer ces octets avec la DEK** (droit `encrypt`, déjà présent). Sécurité
identique, zéro modification de l'existant. C'est ce qui rend toute la tranche crypto
**purement additive**.

Fonctions ajoutées à `src/lib/vault.js` (sous le marqueur `// --- fichiers`, aucune
fonction existante touchée) :
`generateFek`, `encryptBytes(key, bytes) → {ciphertext:Uint8Array, iv}`,
`decryptBytes(key, ciphertext, ivB64) → ArrayBuffer`,
`wrapFekForDek(fek, dek) → {wrapped_fek, wrap_iv}`,
`unwrapFekWithDek(wrappedFekB64, wrapIvB64, dek, extractable=false) → CryptoKey`.
IV toujours **séparé** du ciphertext (cohérent avec le reste du fichier). Les
octets sont renvoyés en **binaire** (Uint8Array), pas en base64 (destinés à R2).

Le paramètre `extractable` d'`unwrapFekWithDek` existe pour la rotation : une FEK
déballée non-extractable ne peut pas être ré-emballée (export impossible) — le
harnais teste explicitement ce refus.

**Harnais** (`test-vault.mjs`) : passé de 20 à **30 assertions** (10 nouvelles).
Couvre round-trip octets, round-trip métadonnées sous FEK, emballage/déballage FEK,
mauvaise DEK (échec attendu), IV frais, et surtout une section « Rotation avec
fichiers » : ré-emballage FEK sous nouvelle DEK, vérification que l'ancien emballage
ne vaut plus, que le ciphertext des octets et des métadonnées est **inchangé** après
rotation, et la discipline `extractable`. **Règle inchangée : on ne modifie pas
`vault.js` sans relancer le harnais (30/30).**

---

## 6. Le schéma — `vault_files`

Colonnes : `id` (uuid, `gen_random_uuid()`), `dossier_id` (FK
`dossiers on delete cascade`), `storage_key` (clé R2), `file_iv` (IV des octets),
`wrapped_fek` + `fek_wrap_iv` (la FEK emballée sous la DEK), `meta_ciphertext` +
`meta_iv` (nom+type chiffrés sous la FEK), `dek_version` (suivi de rotation, aligné
sur `vault_secrets`/`vault_dossier_access`), `taille` (bigint, **en clair**),
`auteur`, `created_at`. Index sur `dossier_id`.

**RLS calquée sur l'ACCÈS au coffre** (comme `vault_secrets`) :
- SELECT/UPDATE : `has_dossier_vault_access(dossier_id) OR is_vault_admin()`
- INSERT (`with check`) : `has_vault_access() OR is_vault_admin()`
- DELETE : `has_dossier_vault_access(dossier_id) OR is_vault_admin()`

> **Correction assumée (piège évité).** La policy DELETE a d'abord été posée en
> `is_vault_admin()` seul, par mauvais calque sur `vault_secrets`. **Erreur** :
> `vault_secrets` = le coffre ENTIER (une ligne = tout le contenu d'un dossier),
> alors qu'un fichier est un **élément de contenu**, comme une note. Or « avoir
> accès au coffre = gérer son contenu » : quiconque peut supprimer une note doit
> pouvoir supprimer un fichier. Seul le geste **structurel** (détruire le coffre
> configuré) reste admin. La policy DELETE a donc été corrigée en
> `has_dossier_vault_access(...) OR is_vault_admin()`. Leçon : ne pas confondre
> « la ligne du coffre » et « un élément de contenu ».

---

## 7. Pourquoi le hard delete (pas de soft delete)

`vault_files` n'a **pas** de `deleted_at`, à contre-courant des autres tables enfant
du dossier (notes/photos/plans en corbeille). Deux raisons, assumées :

- **Un fichier de credentials ne doit pas traîner en corbeille**, et l'octet R2 doit
  vraiment partir (un chiffré résiduel n'est pas lisible sans la FEK, mais l'esprit
  du coffre veut la disparition réelle).
- **Éviter le piège 42501** : un soft delete sur une table dont la policy SELECT
  filtrerait `deleted_at IS NULL` rejoue la policy SELECT au RETURNING implicite de
  PostgREST → 42501. La policy SELECT de `vault_files` est
  `has_dossier_vault_access(...)` (pas un filtre `deleted_at`), donc pas de piège
  aujourd'hui — et on ne l'introduit pas.

Suppression côté data : **ligne DB d'abord** (source de vérité UI, via SDK, RLS
l'autorise), **puis octet R2 best-effort** (un orphelin R2 est silencieux et sans
gravité, et c'est du chiffré illisible). Même discipline que `deleteDossierPhoto`,
mais en hard delete assumé.

---

## 8. La rotation étendue — `rotate_vault_secret` (la pièce délicate)

La fonction la plus sensible du coffre a été **étendue, pas réécrite** : toute la
logique d'origine (autorisation admin, garde de version, verrou `FOR UPDATE`,
garde-fou destinataires, comptage accès mis à jour vs attendu, UPDATE jamais INSERT,
mise à jour du contenu) est **intacte**. On a ajouté :

- Un **7e paramètre** `p_file_rows jsonb DEFAULT '[]'` (liste des FEK ré-emballées :
  `{id, wrapped_fek, fek_wrap_iv}` par fichier). Le défaut `'[]'` permet à l'ancien
  appel front de continuer à tourner pendant le chantier (rotation d'un coffre sans
  fichier = strictement identique à avant).
- Un **bloc fichiers** avant le contenu, transposition littérale du contrôle des
  accès : il lit le **nombre réel** de fichiers du dossier, exige que `p_file_rows`
  ait la même longueur (sinon un fichier a été ajouté/supprimé entre la préparation
  et l'exécution → **annulation**), puis UPDATE chaque ligne `vault_files` avec sa
  nouvelle FEK emballée + `dek_version`, et **recompte** (chaque `id` fourni doit
  correspondre à un fichier réel du dossier).

Tout dans **une seule transaction** : contenu, accès ET FEK basculent ensemble ou
pas du tout. Jamais d'instant où les accès sont sur la nouvelle DEK pendant qu'une
FEK de fichier reste sous l'ancienne. **Les octets R2 ne sont jamais touchés.**

`destroy_dossier_vault` a reçu une ligne : `delete from vault_files` (en plus des
accès et du secret), dans sa transaction. Note : détruire le coffre ≠ supprimer le
dossier — la cascade FK ne joue que si le dossier disparaît, donc le DELETE explicite
est nécessaire.

> **Piège de signature (à connaître pour toute extension de fonction).** Postgres
> identifie une fonction par nom + **types d'arguments**. Ajouter un paramètre crée
> une **surcharge** à côté de l'ancienne, pas un remplacement — on se retrouverait
> avec deux `rotate_vault_secret`, et le front pourrait appeler l'ancienne (sans le
> bloc fichiers). Ordre correct exécuté : `drop function if exists
> rotate_vault_secret(uuid,text,text,integer,integer,jsonb)` (l'ancienne signature à
> 6 args) → `create or replace` (7 args) → **re-`grant execute`** (le drop l'efface).
> Vérifié ensuite via `pg_proc` qu'il ne reste **qu'une seule** fonction à 7 args.

Côté front (`vaultRotation.ts`) : après avoir l'ancienne DEK (extractable) ET la
nouvelle DEK, pour chaque fichier — déballer la FEK avec l'ancienne DEK
(`unwrapFekWithDek(..., extractable=true)`) → la ré-emballer sous la nouvelle DEK
(`wrapFekForDek`) → pousser `{id, wrapped_fek, fek_wrap_iv}` dans `fileRows`, passé
à la RPC. La liste des fichiers est lue **dans la même passe** que la préparation, en
cohérence avec le contrôle strict SQL.

---

## 9. Le Worker — préfixe `vault/` et DELETE différencié

- **POST** : `'vault'` ajouté à `GENERIC_PREFIX_RE`
  (`/^(galerie|plans|vault)\/[a-z0-9-]+$/`), appelé via `?prefix=vault/<dossierId>`.
  Clé produite `vault/{dossierId}/{uuid}`. C'était le point d'extension prévu (même
  mécanisme que `plans`). Le Worker ne dépose que du **chiffré**.
- **DELETE différencié** : les clés `vault/` sont autorisées si
  `has_dossier_vault_access(dossierId) OR is_vault_admin()` ; **tous les autres
  préfixes restent admin-only strict** (aucun relâchement ailleurs).
- **Le `dossier_id` est parsé depuis la CLÉ** (2e segment de `vault/{id}/...`), pas
  depuis un query param `?dossier=`. Raison : la clé est la source de vérité (l'objet
  supprimé EST à ce chemin) — un appelant ne peut pas mentir sur le dossier.
- **La porte admin est gardée EN PLUS de la porte accès** (`OR is_vault_admin()`),
  pour rester cohérent avec la policy DELETE de `vault_files` (un admin doit pouvoir
  supprimer même sans accès nominatif au coffre). Ordre : tester
  `has_dossier_vault_access` d'abord (cas nominal), ne rejouer `is_vault_admin` que
  s'il est faux (évite un appel inutile).
- Nouveau helper `checkHasDossierVaultAccess(request, env, dossierId)`, calqué sur
  `checkIsAdmin` : rejeu du `Authorization` de l'appelant sur
  `/rest/v1/rpc/has_dossier_vault_access`, body `{"p_dossier_id": dossierId}`, apikey
  anon, retour booléen strict `=== true`. Jamais de secret côté Worker.
- **GET inchangé** (déjà préfixe-agnostique) : `vault/` était déjà lisible.

---

## 10. La couche data — `src/lib/vaultFiles.ts`

- `uploadVaultFile(dossierId, dek|null, file)` : `generateFek` → `encryptBytes`
  (octets) → `encryptContent` (métadonnées `{name,mime}`) → `wrapFekForDek` → POST du
  chiffré vers `?prefix=vault/<dossierId>` (`application/octet-stream`, calqué sur
  `uploadPhotoBytes`) → INSERT `vault_files`. **Accepte `dek = null`** : si le coffre
  n'a pas encore de `vault_secrets` (aucune note jamais créée), il **bootstrappe**
  d'abord (cf. §11), puis chiffre sous la DEK obtenue.
- `listVaultFiles(dossierId, dek)` : SELECT → pour chaque ligne, déballe la FEK et
  déchiffre `{name,mime}` **en mémoire**. Renvoie nom/type/taille/date **ET les
  champs crypto bruts** (`storage_key`, `wrapped_fek`, `fek_wrap_iv`, `file_iv`) pour
  rendre chaque ligne directement actionnable (ouverture/suppression/rename sans 2e
  aller-retour DB).
- `openVaultFile(row, dek)` : GET les octets chiffrés (calqué sur
  `getDossierPlanBlob`) → déballe la FEK → `decryptBytes` → **Blob clair éphémère**
  (object URL révoqué, jamais persisté).
- `deleteVaultFile(row)` : DELETE ligne (SDK) puis DELETE R2 best-effort (fetch
  Worker, `getAccessToken` + Bearer, catch avalé). Nouveau helper assumé —
  `deleteDossierPhoto` était un **soft** delete sans appel R2, donc rien à réutiliser
  littéralement.
- `renameVaultFile(row, dek, newName)` : déballe la FEK → ré-chiffre
  `{name:newName, mime}` sous la **MÊME FEK** → UPDATE `meta_ciphertext`/`meta_iv`.
  **Ne touche NI aux octets R2, NI au `wrapped_fek`, NI au `file_iv`, NI à la
  taille.** La FEK ne change pas → aucun impact sur la rotation.

`vault.d.ts` complété des 5 nouvelles fonctions (c'était la première consommation
TypeScript de la crypto fichiers).

---

## 11. Le bootstrap partagé — `bootstrapDossierVault`

Un fichier peut être déposé dans un coffre **jamais initialisé** (aucune note). La
séquence de création (`generateDek` → `insertVaultSecret` → `getVaultPublicKeys` →
`wrapDekForUser` vers chaque titulaire → `insertDossierAccessRows` → renvoyer la DEK)
existait mais **inline dans `VaultSheet.tsx`** — donc non réutilisable telle quelle.

Elle a été **extraite** en `bootstrapDossierVault(dossierId): Promise<CryptoKey>`
dans `vaultSecrets.ts` (sa place logique, à côté du CRUD `vault_secrets`), et
`persistNotes` **comme** `uploadVaultFile` pointent dessus — **une seule source** de
bootstrap crypto (l'option « petite duplication locale » a été écartée : deux chemins
de bootstrap pourraient diverger sur la partie la plus sensible). L'édition de
`VaultSheet.tsx` s'est limitée à un **remplacement mécanique** (appel de la fonction
extraite), sans changement de comportement — vigilance de revue : `persistNotes` crée
les coffres en prod, une régression y aurait cassé la création de notes.

Côté UI, après le premier upload dans un coffre `empty`, on bascule `content` en
`ready` avec la DEK obtenue, pour enchaîner (notes, autres fichiers) sans
re-déverrouiller.

---

## 12. L'UI — bloc « Fichiers » dans le sheet du coffre

Visible dès que le coffre est `ready` OU `empty` (pour permettre le premier upload).
Dépôt (input PDF/image, **upload séquentiel** `for…of`+`await`, jamais `Promise.all`
— une connexion chantier ne supporte pas le parallèle ; progression n/N ; échec par
fichier non bloquant). Liste (nom déchiffré + `formatBytes` réutilisé de
`storagePersistence.ts` + date + icône selon mime). **Titre éditable** calqué sur le
carnet (`renameVaultFile`). **Ouverture « en grand »** : image → viewer image in-app ;
PDF → `<PdfViewer>` in-app sur iOS / lecteur natif sur non-iOS (cf. règle de plateforme
PDF dans l'ETAT). **Partage** en action secondaire (`navigator.share`). **Suppression**
via l'overlay de confirmation **inline** existant des notes (pattern `pendingDeleteId`,
pas `ConfirmSheet`).

**Auto-lock** : `touch()` (de `useVaultSession`) appelé explicitement **au début de
l'upload et à chaque itération** de la boucle — un upload long (compression +
chiffrement + POST R2) ne doit jamais être coupé par l'auto-lock 15 min, qui purgerait
la DEK au milieu de l'opération. Le clair ne vit qu'en mémoire (object URL éphémère,
révoqué) ; on ne POST que du chiffré ; jamais d'objet chiffré dans une `<img>` nue.

---

## 13. La méthode — 5 tranches testées une à une

Ordre suivi (base et crypto validées avant les écrans, comme le coffre d'origine) :

1. **Crypto dans `vault.js` + harnais** — 30/30 vert **avant** tout branchement.
2. **SQL** — table `vault_files` + RLS (additif, testé seul), puis `destroy` et
   `rotate` étendus (blocs séparés, la table validée avant les fonctions).
3. **Worker** — préfixe `vault/` au POST + DELETE différencié.
4. **Couche data** — `vaultFiles.ts` + bootstrap extrait + `vault.d.ts`.
5. **UI + rotation front** — bloc « Fichiers » puis ré-emballage des FEK dans la
   rotation (les deux ensemble : dès qu'un fichier existe, la rotation doit savoir le
   gérer, sinon le contrôle strict la refuse).

Chaque tranche : inspection (Claude Code lit la source, ne modifie rien) → diff
validé → commit/push depuis le terminal de John.

---

## 14. Pièges rencontrés et leçons (utiles pour la suite)

- **RLS DELETE mal calquée** (§6) : `is_vault_admin()` d'abord, corrigé en
  `has_dossier_vault_access`. Un fichier est du **contenu** (comme une note), pas la
  ligne du coffre. Corollaire : le Worker DELETE a suivi la même règle (Option B),
  aligné sur la policy de table pour éviter l'asymétrie ligne/octet.
- **`wrapKey` inaccessible** (§5) : la DEK de session n'a que `encrypt`/`decrypt`.
  « Emballer » = chiffrer les octets bruts de la FEK. Vérifier les **droits d'une
  CryptoKey** avant de supposer qu'une opération est disponible.
- **Surcharge de signature** (§8) : ajouter un paramètre crée une surcharge. `drop`
  l'ancienne signature exacte → `create` → **re-`grant`** → vérifier via `pg_proc`
  qu'il n'en reste qu'une.
- **Bootstrap inline non réutilisable** (§11) : ce qui « existe » n'est pas forcément
  « appelable » — extraire en fonction partagée plutôt que dupliquer, surtout sur la
  crypto.
- **Contrôle strict = rotation sensible aux ajouts concurrents** (§8) : accepté et
  voulu (mieux vaut refuser une rotation que laisser une FEK oubliée). Même rigueur
  que le garde-fou destinataires d'origine.
- **Discipline `extractable`** : une FEK doit être déballée `extractable=true` pour
  être ré-emballée à la rotation ; `false` partout ailleurs. Le harnais couvre le
  refus attendu.
- **`persistNotes` est du code de prod** : l'extraction du bootstrap ne devait rien
  changer à son comportement. Revue de diff ciblée sur la non-régression de la
  création de coffre.

---

## 15. Dettes & points de vigilance propres à ce chantier

- **Garde-fou « PDF trop détaillé » non appliqué aux fichiers du coffre** : les
  fichiers de credentials sont supposés légers. Si un PDF-image lourd y est déposé et
  crashe iOS au rendu, répliquer la mesure `pdfImageMegapixels` (cf. règle de
  plateforme PDF) sur l'ouverture des fichiers coffre.
- **Fichiers du coffre offline** : online-only (comme le reste du coffre en v1). Le
  hors ligne = mettre le blob chiffré en cache IndexedDB, sans migration de schéma.
- **`vault_files` dans le backup** : à ajouter à l'export n8n (lignes = du chiffré,
  sans risque à exporter) quand on activera Schedule + purge.
- **Rotation d'un coffre à nombreux fichiers** : chaque fichier = un déballage +
  ré-emballage de FEK côté client (petites clés, rapide), mais le contrôle strict
  impose qu'aucun fichier ne soit ajouté pendant la préparation. Cas normal ; roter un
  coffre à très nombreux fichiers reste un cas rare.

---

## 16. Méthode (elle a encore tenu)

- **Découper** : crypto isolée et prouvée au harnais (30/30) AVANT tout branchement ;
  SQL/base validés avant écrans ; couche data déterministe écrite à la main ; Claude
  Code réduit aux écrans en « inspecte puis modifie ».
- **La source brute prime** : l'audit SQL des fonctions/RLS réelles (pas le résumé),
  l'inspection du code réel de `vault.js`/`vaultSecrets.ts`/Worker — c'est elle qui a
  révélé `wrapKey` indisponible, le bootstrap inline, et les vrais points d'extension.
- **Diagnostiquer avant de patcher** : la correction de la RLS DELETE est venue d'un
  raisonnement sur le modèle (« un fichier est du contenu »), pas d'un patch réflexe.
- **Ne jamais modifier `vault.js` sans relancer le harnais** (30/30).
- **Le travail n'existe que poussé** : commit + push depuis le terminal authentifié
  de John, diff validé avant chaque commit, jamais de push délégué à l'aveugle.
