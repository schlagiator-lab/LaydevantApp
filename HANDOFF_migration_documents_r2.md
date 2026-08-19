# Laydevant — Migration de la bibliothèque PDF (Supabase Storage → R2)
## Document de reprise (handoff) — le 5e

Complète les quatre HANDOFF existants (projet général, coffre, carnet/onboarding/
recherche, finitions/navigation/clés/ingestion-lot). Résume la migration complète
des PDF de la bibliothèque depuis Supabase Storage vers Cloudflare R2, menée d'un
bloc dans une session, **terminée et vérifiée de bout en bout**. Garde surtout le
POURQUOI — le code dit le comment, lui seul dit pourquoi c'est ainsi.

À jour au 13 août 2026.

> À lire avec `ETAT_PROJET.md` (l'état présent) : ce HANDOFF est l'archive du
> raisonnement ; l'ETAT dit ce qui EST, ce fichier dit POURQUOI on y est arrivé.

---

## 0. Le déclencheur

Alerte Supabase : quota de Storage dépassé (facture 1,466 Go / 1 Go = 147 %),
période de grâce jusqu'au **12 septembre 2026**, puis Fair Use Policy et requêtes
en **402**. Un 402 sur le Storage aurait cassé le cœur de l'app : ouvrir une
notice.

Diagnostic (lire la source avant de patcher) : le coupable est la **bibliothèque
PDF**, seul locataire du Storage Supabase. Les photos, plans et galerie étaient
déjà sur R2 → hors de cause. Le vrai poids, mesuré dans le bucket lui-même :
**3,5 Go pour 1567 objets** (l'écart avec la facture = décalage de rafraîchissement
+ ingestion de masse poursuivie jusqu'au 12 août). Conséquence directe et prévisible
de la stratégie « ingestion de masse autonome » : gratuite côté API, mais chaque
PDF atterrissait dans le 1 Go Supabase.

---

## 1. Le choix : migrer vers R2 (piste A), pas payer ni faire le ménage

Trois pistes, une seule tient.

- **Upgrade Supabase Pro (25 $/mois, 100 Go)** : trivial mais contredit le principe
  fondateur « l'entreprise ne paie rien ». Économiquement absurde : payer pour
  stocker sur Supabase ce que R2 héberge gratuitement à côté. Écarté (au mieux un
  filet temporaire).
- **Ménage du bucket** : 3,5 Go = 3,5× la limite. Insuffisant seul, et la
  bibliothèque continue de grossir. Écarté comme solution de fond.
- **Migrer vers R2 (retenu)** : cohérent avec l'ADN du projet. **Tout était déjà en
  place** — R2 actif (10 Go gratuits, egress zéro), pattern storage-agnostique déjà
  utilisé pour `dossier_photos`/`dossier_plans`, Worker `/api/photos` sachant déjà
  servir des octets R2 authentifiés, credential S3 R2 déjà monté (backups). Referme
  le problème **définitivement** et gratuitement.

---

## 2. L'architecture : migration à double lecture (dual-read)

Principe directeur : **rendre le front capable de lire les deux backends AVANT de
basculer quoi que ce soit ; basculer ligne par ligne ; ne supprimer les originaux
Supabase qu'à la toute fin.** D'où : zéro coupure, rollback possible à chaque étape,
et on ne touche au 3,5 Go qu'une fois tout prouvé en prod.

Deux invariants qui ont tenu tout du long :

- **Rayon d'impact faible** : la recherche (`search_documents`, `search_vector`) est
  côté base, indépendante du lieu des octets. **Seule l'ouverture d'un PDF change.**
- **Reprise par conception** : chaque ligne passe en `storage_provider='r2'`
  *immédiatement après* la copie réussie de ses octets. Un arrêt en cours de route ne
  perd rien — les lignes déjà faites ne sont pas re-sélectionnées au relancement.
  C'est la même vertu que « INSERT autonome puis UPDATE par id ».

---

## 3. Deux découvertes au moment de l'audit

- **Le schéma agnostique était déjà à moitié posé.** `documents.storage_provider`
  existait déjà (`NOT NULL default 'supabase'`, posé par une session Claude Code
  passée). Pas de colonne `storage_key` : la clé de stockage vit dans **`file_path`**.
  Mieux : `file_path` est **identique au `name` de l'objet** dans le bucket, au
  caractère près. Zéro `file_path` NULL, zéro doublon. → L'étape « schéma » a
  quasiment disparu.
- **Du déchet dans le bucket.** 1567 objets pour 1493 lignes → **74 orphelins**
  (243 Mo) : ingestions ratées, fichiers remplacés, lignes supprimées sans purge de
  l'objet. Non migrés (pas de ligne associée), supprimés au nettoyage final.

---

## 4. La convention de clé (verrouillée)

- **Clé R2 = `documents/` + `file_path`** (ex. `documents/knx/1786…-mtn6215.pdf`),
  dans le bucket R2 **existant** `laydevant-photos` (le Worker y est déjà lié ; le
  free tier 10 Go est global au compte — un bucket séparé n'aurait pas donné plus de
  place). Pas de nouvelle infra.
- **`file_path` reste NU en base et n'est JAMAIS touché** pendant la migration. On
  copie les octets, puis on bascule seulement `storage_provider`. → Rollback trivial
  (`update … 'supabase'`) tant que les originaux Supabase existent.
- Le front dérive la clé R2 en ajoutant `documents/` **une seule fois** (piège du
  double préfixe → 404 : `fetchPdfBlobR2` reçoit `file_path` nu, le préfixe est
  ajouté dans l'appel Worker).

---

## 5. Les 7 étapes (ordre = sûreté)

L'ordre garantit qu'à aucun moment un document n'est « en R2 » sans que le front sache
le lire.

- **0 — Audit (SQL lecture seule)** : noms de colonnes réels, bucket privé/public,
  poids par bucket, orphelins.
- **1 — Autoriser `'r2'`** : la contrainte CHECK sur `storage_provider` n'acceptait
  que `'supabase'`. Un bloc idempotent la remplace par `check in ('supabase','r2')`.
- **2 — Worker : rien à faire.** Inspection Claude Code : la LECTURE
  (`GET /api/photos/<clé>`) est **préfixe-agnostique** (JWT vérifié inconditionnellement,
  clé prise brute de l'URL, aucune allowlist en GET). L'allowlist `GENERIC_PREFIX_RE`
  (`galerie|plans`) ne borne que le POST. Donc `documents/…` était déjà servable.
- **3 — Front en double lecture.** Ajout de `storage_provider` au SELECT
  (`getDocumentDetail`, documentDetail.ts) et au type `DocumentRow` (database.ts).
  Nouveau helper `fetchPdfBlobR2` (documents.ts), **pendant symétrique** de
  `fetchPdfBlob`. **Piège de type évité** : ne PAS injecter l'object URL de
  `getPhotoObjectUrl` dans l'état `pdfBlob` — il faut un **Blob des deux côtés**
  (`fetchPdfBlobR2` renvoie `new Blob([...], {type:'application/pdf'})`), sinon on
  mélange Blob et object URL dans le même état → viewer/révocation cassés. Déployé
  sans bascule (aucune ligne en `'r2'`) → risque nul. Validé par un **test golden**
  (un seul doc basculé à la main).
- **4 — Copie de masse (workflow n8n).** Déclencheur manuel, Config `batchLimit`
  (test à 5 puis tout), SELECT des `'supabase'`, **Loop batchSize 1** (mémoire — des
  PDF à ~10 Mo, 3,5 Go au total : un fichier à la fois), download Supabase → PUT R2
  `documents/{file_path}` → UPDATE ligne en `'r2'`. Reprenable + idempotent
  (`WHERE … AND storage_provider='supabase'`), retry 3× sur les nœuds réseau/DB.
  Résultat : **1493 en `'r2'`, 0 en `'supabase'`**.
- **5 — Ingestion vers R2 (3 workflows).** On transplante le nœud « Upload R2 » déjà
  testé (copier-coller conserve le credential), on change `File Name` en
  `documents/{{ $json.chemin }}`, et on ajoute `storage_provider` (colonne + valeur
  `'r2'` **littérale**) à l'INSERT — aucun paramètre `$N` ajouté (on évite le piège
  du tableau `undefined`).
- **6 — Épinglage offline.** `pinDocument` (pinning.ts) appelait
  `getSignedDocumentUrl` **inconditionnellement** → cassé pour R2, et pas seulement
  hors ligne (masqué online tant que les objets Supabase existaient). Fix : brancher
  sur `storage_provider` comme `fetchOnlineDetail`. Tout l'aval (Cache API
  `pdfCache.ts`, IndexedDB `db.ts`, relecture locale) **inchangé**.
- **7 — Nettoyage.** Audit de complétude R2 (voir §7), puis vidage du bucket Supabase
  `documents` (1568 objets = 1493 migrés + 75 orphelins). Les 3,5 Go tombent.

---

## 6. Le piège d'ingestion (le workflow non publié)

Après bascule des 3 workflows, un contrôle par la base a révélé qu'un document
(SpaceLogic KNX, ingéré par la **capture web**) était resté en `storage_provider =
'supabase'` alors que ses **octets étaient bien en R2**. Cause : le workflow
« Capture par URL » **n'avait pas été publié** après édition de son INSERT — l'ancien
INSERT (sans `storage_provider`) tournait encore.

Vicieux parce que **tout avait l'air de marcher** : le doc s'ouvrait dans l'app…
mais via le fallback Supabase (double-lecture + objet Supabase encore présent).
Au nettoyage, il aurait cassé. Réparé par un `update … 'r2'` (octets déjà en place).
**Leçon : vérifier que l'INSERT de CHAQUE workflow porte réellement
`storage_provider`, et penser à PUBLIER après édition** — « le travail n'existe que
poussé/publié ».

---

## 7. Les pièges outils (la vraie galère de la session)

**Lister R2 s'est révélé étonnamment difficile.** Trois outils tombés l'un après
l'autre :

- **Nœud S3 générique de n8n** : `getAll` renvoie **0 objet sans erreur** (succès +
  « No output data returned »). Première cause trouvée : credential en **région
  `us-east-1`** au lieu de **`auto`** (l'écriture marchait pourtant avec `us-east-1` —
  d'où le piège : *muet au listage mais fonctionnel à l'écriture*). Mais **même
  corrigé en `auto`, le nœud restait à 0** → abandon du nœud n8n pour l'audit.
- **wrangler** : cette version **n'a pas `r2 object list`** (seulement `get`/`put`/
  `delete`). Impasse.
- **Solution : petit script Node `@aws-sdk/client-s3`** (région `auto`, endpoint R2
  sans bucket, `forcePathStyle: true`), pagination `ListObjectsV2`. Pièges rencontrés :
  `npm install --no-save` n'a pas installé le paquet ; un script dans `/tmp` ne
  trouve pas `node_modules` (`ERR_MODULE_NOT_FOUND`) — il doit vivre **dans le repo**.
  Une fois `npm install` (sans `--no-save`) et le script à la racine : **1497 objets**
  listés sous `documents/`.

**L'audit de complétude** (le vrai garde-fou avant l'irréversible) : lister les clés
R2 sous `documents/` → retirer le préfixe → comparer aux `file_path` de la base via
`comm -23 db_keys r2_keys`. Verdict : **0 manquant** → chaque ligne DB a bien son
octet dans R2 → suppression sûre. (Écart 1497 vs 1493 = PDF de test non purgés,
orphelins R2 informationnels, non bloquants.)

**La suppression** : même `@aws-sdk/client-s3`, mais contre l'**endpoint S3 de
Supabase Storage** (identifiants S3 DISTINCTS de ceux de R2, à générer dans Project
Settings → Storage). `DeleteObjects` par lots de 1000, **re-listage frais après
chaque lot** (supprimer en suivant un token de pagination saute des entrées). Dry-run
de listage AVANT (1568 objets confirmés) pour valider les clés et le compte avant tout
geste destructif.

---

## 8. Sécurité — les clés manipulées pendant l'opération

- Les identifiants **R2** et **Supabase S3** ont été mis en **variables
  d'environnement de la session terminal uniquement** — jamais dans un fichier, dans
  Git, ni dans le chat. Les scripts les **lisent depuis l'environnement** (aucune clé
  en dur dans le code). Terminal fermé après l'audit (les variables meurent avec).
- `@aws-sdk/client-s3` a pu s'inscrire dans `package.json`/`package-lock.json` :
  `git checkout` ou `npm uninstall` pour ne pas alourdir le repo (dépendance non
  nécessaire à l'app).
- **Dette de sécurité remontée en priorité** : le **DELETE ouvert du Worker
  `/api/photos`** (tout authentifié peut supprimer n'importe quel objet R2). Toléré
  jusqu'ici, mais **R2 est désormais la source UNIQUE** (plus de filet Supabase) →
  à durcir en admin-only, en incrément séparé. C'est le prochain chantier n°1.

---

## 9. Résultat

- **1493 documents servis exclusivement depuis R2** ; bucket Supabase `documents`
  **vidé** (0 objet vérifié).
- **Ingestion** : les 3 workflows écrivent en R2 (`storage_provider='r2'`) → le
  robinet est fermé, plus rien ne retombe dans Supabase.
- **Offline** : épinglage réparé sur R2 (blob capturé via le bon backend), aperçu PDF
  et logo précachés (voir §10) → l'app fonctionne en avion, sa raison d'être.
- **Storage Supabase** : de ~3,5 Go à ~0,1 Go (Database seule) → menace du 12
  septembre **levée**, bien avant l'échéance.

---

## 10. Deux trous de précache offline corrigés au passage (sans rapport avec R2)

Découverts en testant l'offline, mais **préexistants** (indépendants de la migration) :

- **Aperçu PDF absent en avion** : `pdf.js` charge son worker `pdf.worker.min-*.mjs`
  par requête réseau, or `.mjs` n'était pas dans le `globPatterns` du workbox → jamais
  précaché → échoue hors ligne. Le blob PDF, lui, était bien local ; seul le worker de
  rendu manquait.
- **Logo d'entreprise absent en avion** : `public/branding/logo-laydevant.jpg`, asset
  local same-origin, mais `jpg` absent du `globPatterns`.

Fix commun : élargir `globPatterns` à
`js,css,html,svg,png,ico,woff2,mjs,jpg,jpeg,webp,avif,gif` (on ferme la famille image
d'un coup). **Garde-fou** : ne jamais laisser d'images métier (photos/galerie/plans,
qui sont sur R2) atterrir dans `public/`/`dist/` — elles gonfleraient le précache.
Ces changements touchent le **service worker** → fermer complètement la PWA et la
rouvrir EN LIGNE une à deux fois pour que le nouveau SW précache, AVANT de tester en
avion.

---

## 11. Méthode (elle a encore tenu)

- **Découper** : SQL/base validés avant écrans ; couche données déterministe ; Claude
  Code réduit aux écrans, en « inspecte puis modifie » (a très bien tenu — §2, §3, §6).
- **Prouver, pas supposer, sur l'irréversible** : audit de complétude R2 à **0
  manquant** avant de supprimer le moindre octet Supabase. Le filet de rollback n'est
  retiré qu'en connaissance de cause.
- **Diagnostiquer avant de patcher / lire la source brute** : le bucket réel (3,5 Go,
  pas 1,46) ; la base (le SpaceLogic resté `'supabase'`) ; l'OUTPUT du nœud n8n
  (0 objet) ; `git status` (dépendance parasite). Jamais le résumé d'un agent.
- **Reprise par commit ligne à ligne** : la copie de masse est relançable sans dégât ;
  un arrêt ne perd rien.
- **Le travail n'existe que poussé/publié** : commit + push depuis le terminal
  authentifié (pas Claude Code) ; **publier** les workflows n8n après édition (§6).
- **Secrets** : clés S3 en variables de session uniquement, jamais en fichier/Git/chat ;
  terminal fermé après.
