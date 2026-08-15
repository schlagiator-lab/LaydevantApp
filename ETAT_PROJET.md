# Laydevant — État du projet
## Point d'entrée : la photo du présent (pas l'historique)

Ce fichier décrit le projet **tel qu'il est maintenant**. Il est **réécrit** à
chaque avancée (pas complété) : une dette réglée en disparaît, une feature finie
passe en « fonctionne ». Pour le POURQUOI d'une décision, voir les HANDOFF datés
(l'archive). Pour la spec technique de Claude Code, voir `CLAUDE.md` (le repo).

À jour au 16 août 2026.

---

## Le projet en bref

PWA offline-first consultée sur téléphone Android par les techniciens de
Laydevant SA (électricité, télécom, portes automatiques, Genève, ~50 monteurs).
But : retrouver en quelques secondes une notice/un manuel sur chantier, y compris
hors réseau. Construite par John (solo) sur son temps et ses moyens.

**Contraintes structurantes** : parc 100 % Android (aucun iOS) ; offline = la
norme, pas un cas dégradé ; plan Supabase FREE ; normes NIBT/NIN sous licence →
JAMAIS copiées (liens + fiches perso), manuels fabricants librement distribués =
OK en interne.

**Philosophie de la recherche** : le but n'est pas la vitesse, le but est de
trouver l'introuvable — la bonne notice, la bonne référence. Un mini-jeu fait
patienter le monteur pendant que deux moteurs de recherche web cherchent en
parallèle. Corollaire côté recherche INTERNE : où que l'on se trouve dans l'app,
une recherche par texte couvre toute la base et matche marque comme modèle — il
est trop facile de se tromper d'endroit ou de tronquer une référence.

**Où vivent les fichiers (règle d'or depuis la migration R2)** : TOUT le binaire
lourd — les **PDF de la bibliothèque**, les photos du carnet, la galerie, les
plans, les **communications d'entreprise** — vit sur **Cloudflare R2** (10 Go
gratuits, egress zéro). Supabase Storage n'héberge plus aucun PDF de
bibliothèque : son bucket `documents` a été vidé. Supabase reste la base
Postgres, l'Auth, la RLS et les Edge Functions ; la contrainte « 1 Go de
Storage » n'est donc plus le facteur limitant (Database Size ~0,1 Go).

**Où vivent les annotations photo (nouvelle règle)** : les retouches de photo du
carnet ne sont PAS des images. Chaque photo garde son **original R2 intact** ;
les traits/textes/flèches/formes vivent comme un **calque vectoriel JSON** dans
la colonne `dossier_photos.annotations` (jsonb). Rien n'est jamais « cuit » ni
dupliqué — un seul original + son calque. L'image aplatie n'existe qu'à
l'export, à la demande, jamais stockée.

---

## Stack

- **Front** : React + Vite + TypeScript, vite-plugin-pwa (service worker),
  MiniSearch (recherche offline), IndexedDB + Cache API. Navigation par pile en
  mémoire (`NavigationProvider`, synchronisée avec l'History API pour le retour
  Android), **pas de routeur d'URL**. Une spécialité s'affiche selon
  `specialties.display_mode` : `'documents'` (liste de PDF) ou `'galerie'`
  (grille de pastilles photo). L'écran d'un dossier est en **sections accordéon**
  (`CollapsibleSection`).
- **Backend** : Supabase (Postgres, Auth, RLS, Edge Functions). Storage Supabase
  n'héberge plus de PDF. Project ref `iixqfajflyxrnizlqdsn`.
- **Fichiers (documents, photos, galerie, plans, communications)** : Cloudflare
  R2, bucket `laydevant-photos`, via binding natif Worker. Le Worker
  `/api/photos` construit la clé de stockage côté serveur pour les uploads :
  - préfixes liés à une entité — forme `tête/slug` : `dossiers/{id}/{uuid}.{ext}`
    (param `?dossier=`), ou `{prefix}/{uuid}.{ext}` avec `?prefix=` validé par
    `GENERIC_PREFIX_RE` (allowlist `galerie|plans`, exige un second segment) ;
  - préfixes GLOBAUX à segment unique — validés par **égalité stricte** contre
    `GLOBAL_PREFIXES` (aujourd'hui `communications`) : `?prefix=communications`
    seul, clé produite `communications/{uuid}-{name}`.
  La **LECTURE** (`GET /api/photos/<clé>`) est **préfixe-agnostique** (sert
  n'importe quelle clé du bucket avec un JWT valide, y compris `documents/…`).
  Le **DELETE** est **réservé aux admins** : le Worker rejoue le JWT de l'appelant
  sur la RPC `is_vault_admin` avant d'effacer un octet (R2 est la source unique,
  plus de filet Supabase).
- **Bibliothèque PDF sur R2** : `documents.storage_provider` (`'supabase'` |
  `'r2'`, **tous en `'r2'`**) et `documents.file_path` (clé NUE). **Clé R2 =
  `documents/` + `file_path`**.
- **Annotations photo** : colonne `dossier_photos.annotations` (jsonb, nullable),
  exposée par `dossier_photos_view`. Module pivot `src/lib/photoAnnotations.ts`
  (types + helpers de géométrie + moteur de rendu canvas). Pas d'objet R2.
- **Backups** : Cloudflare R2, bucket `laydevant-backups`, écrit par n8n (S3).
- **Hébergement front** : Cloudflare Workers (`laydevant-app`), déploiement auto
  sur push `main`. Le Worker `worker/index.js` (fichiers R2) est intégré à ce
  déploiement → il part au push, pas de déploiement séparé.
- **Ingestion + recherche web** : n8n auto-hébergé (VPS Hostinger).
- **IA / recherche** : API Anthropic (Claude Sonnet 5 + recherche web) ET API
  Perplexity (`sonar-reasoning-pro`), en parallèle. DeepL (traduction).
- **Dépôt** : GitHub `schlagiator-lab/LaydevantApp` (privé), dev en Codespaces.

**Clés API** : Publishable key Supabase (publique) côté front + Worker ; Secret
key (`sb_secret_`) côté `enroll` et n8n. La `service_role` legacy est morte.
Credential R2 S3 (endpoint sans nom de bucket, `Force Path Style: ON`, région
`auto`).

---

## Ce qui existe et fonctionne

- **Bibliothèque de documents (entièrement sur R2)** : navigation département →
  spécialité → docs, recherche plein-texte FR, ouverture PDF, épinglage offline.
  ~1493 documents, tous servis depuis R2. Ouverture en double-lecture branchée
  sur `storage_provider`. Deux modes d'affichage de spécialité (liste ou galerie).
- **Épinglage offline (sur R2)** : capture du blob via le bon backend
  (`pinDocument` branche sur `storage_provider`), Cache API + métadonnées
  IndexedDB. Fonctionne en mode avion.
- **Recherche INTERNE — marque + modèle partout, à trois facettes** :
  - *Champ* : l'index MiniSearch offline indexe `productLabel` (marque + modèle,
    boost 3, au-dessus de `title` à 2, normalisé). Recherche hors ligne par
    marque/modèle même si ces mots ne sont pas dans le PDF.
  - *Portée* : une recherche TEXTE force la portée globale (dès qu'il y a une
    requête, `effectiveDepartmentId`/`effectiveSpecialtyId` forcés à null pour
    les DEUX moteurs via un chokepoint unique dans SearchScreen). Le PARCOURS
    (drill-down sans saisie) reste scopé.
  - *Préfixe* : le RPC `search_documents` matche marque/modèle (poids A) + titre
    (B) + contenu, ET par préfixe (« mtn » retrouve « mtn6725 », CTE `pq` avec
    `regexp_split_to_table` + `:*`) — aligné sur le `prefix:true` de MiniSearch.
- **Recherche web de notices — architecture asynchrone à deux moteurs** (section
  dédiée).
- **Dossiers clients** : rattachement d'ÉQUIPEMENTS, remontée auto des notices
  via `products` (+ « Voie 3 » : docs de marque via `brand` quand
  `product_id is null`). Sections accordéon.
- **Équipement manuel → demande admin** : un monteur déclare dans un dossier un
  équipement ABSENT de la base (marque/modèle/commentaire). Il apparaît tout de
  suite avec un badge « en attente », et une demande remonte dans l'onglet
  Demandes admin. L'admin l'approuve en choisissant une spécialité → le produit
  est créé (ou réutilisé, insensible à la casse) et rattaché, la doc remonte.
  Table `dossier_equipment_requests`, RPC `resolve_dossier_equipment_request`
  (atomique, admin-only).
- **Coffre de données sensibles** : chiffrement par dossier (zero-knowledge,
  WebCrypto). Récupération par ré-enrôlement, deux admins-récupérateurs.
- **Communication d'entreprise** : espace GLOBAL (hors dossier) de diffusion de
  PDF par publisher/admin. Remplace « Toute la documentation » sur l'accueil.
  Section dédiée plus bas.
- **Carnet public** (notes + photos par dossier) : en clair, RLS « tout
  authentifié lit/écrit ». Photos sur R2, compression client avant upload.
- **Annotation de photos du carnet — non destructive** : calque vectoriel
  rééditable et déplaçable, 4 outils, rendu partout, export image. Section
  dédiée plus bas.
- **Galerie photo, Plans de dossier, Onboarding par liste blanche** : inchangés
  (voir HANDOFF).
- **Ingestion n8n (écrit dans R2)** : formulaire, webhook `ingest-from-url`, lot.
- **Backup quotidien** : export JSON n8n vers R2.
- **Soft delete (corbeille)** sur les tables enfant du dossier. **Exception** :
  `dossier_documents` sans `deleted_at`.
- **Mini-jeu Tetris + classement** : section dédiée plus bas.

---

## Annotation de photos du carnet — non destructive (calque vectoriel)

Les photos du carnet s'annotent **sans jamais modifier l'original R2** : les
annotations sont un **calque vectoriel JSON** dans `dossier_photos.annotations`,
superposé à la photo. Rééditable, déplaçable, effaçable — plus aucune image cuite
n'est créée. L'ancien `PhotoAnnotator` (qui aplatissait en JPEG et créait une
nouvelle photo R2) est supprimé.

- **Modèle de données** — `src/lib/photoAnnotations.ts` est le **module pivot** :
  calque `{ v:1, objects:[…] }`, **4 types d'objets** : `path` (trait libre),
  `text` (déplaçable + rééditable), `arrow` (flèche), `shape` (`rect`/`ellipse`).
  **Contrat de normalisation** : positions en 0..1 relatives à l'image ;
  grandeurs scalaires (épaisseur de trait, corps du texte) en fraction de
  `min(largeur,hauteur)` → rendu isotrope, identique à toute échelle. Helpers de
  géométrie PURS partagés : `denormPoint`, `normPoint`, `denormScalar`,
  `normScalar`, `pointsToSvgD`, `makeId`.
- **Sauvegarde** — `updateDossierPhotoAnnotations(photoId, annotations)` : simple
  UPDATE via le SDK (la policy SELECT de `dossier_photos` est `using(true)` → pas
  de piège 42501, pas de RPC). Passer `null` efface le calque, la photo redevient
  nue. Aucun upload, aucun objet R2.
- **Éditeur** — `PhotoAnnotator.tsx`, rendu SVG. Outils : Sélection / Trait /
  Texte / Flèche / Rectangle / Ellipse. Déplacer un objet, rééditer un texte,
  effacer, recolorer (palette rouge/noir/jaune), annuler, tout effacer. Gestes en
  **Pointer Events** sur un `<rect>` transparent de fond : l'`<image>` est inerte
  (`pointer-events:none`), `onContextMenu` bloqué et `touch-action:none` → **plus
  de menu natif Android** au appui long (copier/partager l'image). Flèche et
  formes se tracent en geste « poser-étirer-relâcher » avec aperçu live. Tolérance
  de tap élargie pour sélectionner un trait fin au doigt.
- **Rendu lecture** — `AnnotationOverlay.tsx` : SVG figé, décoratif
  (`pointer-events:none`), même logique de rendu que l'éditeur, superposé à la
  **vignette** ET au **plein écran** du carnet. Les annotations sont donc visibles
  partout, sans entrer dans l'éditeur. Un tap sur la photo ouvre le visualiseur
  comme avant (l'overlay n'intercepte rien).
- **Export image** — moteur canvas `renderAnnotatedImage` dans le module pivot :
  cuit photo + calque en JPEG **à la demande, jamais stocké** (aucun objet R2).
  Bouton **adaptatif** : partage natif (`navigator.share` avec `File`) si
  disponible, repli **téléchargement** sinon. Annulation du partage silencieuse
  (AbortError ignoré). Fidélité au pixel garantie : le canvas dénormalise avec les
  **mêmes helpers/constantes** que le SVG (tête de flèche, ancrage texte
  factorisés, jamais dupliqués). Blob local same-origin → pas de canvas taint.
- **Legacy** : les photos annotées avant la refonte (JPEG cuits) restent de
  simples photos sans calque ; aucune migration.

---

## Communication d'entreprise

Espace de diffusion global, sans lien à un dossier. Mécanique calquée sur Plans
(R2, soft-delete, mime PDF direct — **jamais** le pipeline photo JPEG), avec une
gouvernance d'accès propre.

- **Droit de publier** : drapeau `profiles.is_comms_publisher` (défaut false).
  Trigger `profiles_guard` : un non-admin ne peut modifier ni son
  `is_comms_publisher` ni son `role` (colmate aussi un ancien trou
  d'auto-promotion). Octroi via RPC `set_comms_publisher` (SECURITY DEFINER,
  admin-only), piloté depuis l'onglet **Comptes** de `VaultAdminScreen` (badge
  « Publie » + bouton bascule, sur les lignes monteur uniquement).
- **Table `communications`** : `titre`, `storage_provider`, `storage_key`,
  `mime`, `taille`, `auteur`, `created_at`, `deleted_at`/`deleted_by`. RLS :
  SELECT tout authentifié **avec `deleted_at IS NULL`** ; INSERT publisher OU
  admin (auteur = soi) ; UPDATE publisher OU admin sur n'importe quelle ligne.
  Vue `communications_view` (security_invoker) expose `auteur_nom`.
- **Suppression par RPC** : le soft-delete passe par
  `soft_delete_communication(p_id)` (SECURITY DEFINER), PAS par un UPDATE direct.
  Raison structurelle (voir conventions) : la policy SELECT filtre `deleted_at
  IS NULL`, or PostgREST génère un RETURNING implicite qui repasse cette policy
  sur la ligne soft-deletée → 42501. La RPC exécute l'UPDATE hors RLS en
  revérifiant `is_admin() OR is_comms_publisher()` en interne.
- **Écran** (`CommunicationsScreen`, cran de nav `communications`) : la
  communication la plus récente est mise en avant dans une carte avec un aperçu
  de sa 1re page (PdfViewer, mécanisme DocumentScreen), les anciennes en liste
  texte. L'aperçu est **gaté sur `isOnline`** → hors ligne, placeholder. Ouverture
  d'un PDF = lecteur natif Android (`window.open`). « Publier » et supprimer
  visibles seulement si `canPublishCommunications` (admin OU publisher).
- **Titre & libellé** : au dépôt, `titre = file.name`. Affichage :
  `titre ?? deriveLabel(storage_key)` — `deriveLabel` retire le préfixe UUID via
  un regex ancré sur la forme UUID v4. Fallback pour les comms antérieures.
- **Worker** : préfixe `communications` autorisé au POST via `GLOBAL_PREFIXES`.
  Couche data `communications.ts` : `listCommunications`, `uploadCommunication`,
  `getCommunicationObjectUrl` (object URL, ouverture native), `getCommunicationBlob`
  (Blob PDF pour PdfViewer, via Worker), `softDeleteCommunication` (appelle la
  RPC), `canPublishCommunications`.

---

## Écran dossier — sections accordéon + Plans

### Sections repliables (`CollapsibleSection`)

Ordre : Équipements → Documentation → **Plans** → Carnet → Données sensibles.
`keepMounted=true` sur Données sensibles. Slot `action` rendu HORS du `<button>`.
La section Équipements affiche un badge « N en attente » (demandes d'équipement
manuel) si `> 0`, distinct du compteur d'équipements réels.

### Table `dossier_plans`

R2, soft delete, RLS « tout authentifié lit/écrit » (policy SELECT `using(true)`),
`mime` agnostique. Vue `dossier_plans_view`. `PlansSection` : rendu tri-modal
(image → vignette ; PDF → lecteur natif ; DWG → téléchargeable).

---

## Suppression de dossier — deux chemins selon l'état

1. **Dossier vide → `delete_dossier_if_empty`** (HARD delete si vide, sinon
   `DOSSIER_NON_VIDE:`). `dossier_documents` sans `deleted_at` → décompte non
   filtré pour cette table.
2. **Dossier à coffre → `destroy_dossier_vault`** (admin, atomique) puis chemin 1.
3. **Demande de suppression (non-admin sur dossier à coffre)** : trigger, table
   `dossier_deletion_requests`, RPC `resolve_dossier_deletion_request`. Onglet
   « Demandes » de `VaultAdminScreen` (héberge AUSSI les demandes d'équipement
   manuel, en sous-bloc distinct). Notif email admin = fast-follow via Brevo.

---

## Recherche web à deux moteurs — architecture

Le téléphone crée un job (`web_search_jobs`), un trigger Postgres (`pg_net`)
appelle les deux webhooks n8n (Anthropic + Perplexity), chacun écrit SA colonne,
le téléphone poll toutes les 3 s, attend les deux (ou 180 s), fusionne + dédup
par URL, affiche.

- **Anthropic** (`notices-search`) : Claude Sonnet 5, `web_search max_uses: 1`.
- **Perplexity** (`notices-search-pplx`) : `sonar-reasoning-pro`, format OpenAI,
  `search_domain_filter` bannissant les agrégateurs.
- URLs/secret dans `private_config` (RLS, aucune policy). `is_pdf` décide de
  l'action UI (Ajouter à la bibliothèque vs Ouvrir).

---

## Mini-jeu d'attente + classement

- **Tetris** (`PdfTetris.tsx`). Depuis la **tuile Jeu de l'accueil**, un menu
  « Jouer / Classement » (état local `menu`/`play`) s'ouvre avant le lancement.
  Le lancement depuis l'écran d'attente de la recherche web reste direct. Écran
  démarré en bas, audio `.mp3` pendant la partie.
- **Classement d'équipe branché** : `game_scores` (une ligne/user, meilleur
  score) + vue `game_leaderboard`. Couche `gameScores.ts` réutilisée ; classement
  = cran de nav `gameLeaderboard` (patron `goTools`), réutilisé par le menu ET
  l'écran de fin de partie via `Leaderboard.tsx`.
- **UX d'attente de la recherche** : barre de chargement, messages rotatifs
  (conteneur à hauteur fixe 3 lignes → plus de saccade), Wake Lock, mini-jeu.

---

## Conventions vivantes (à respecter à chaque fois)

- **Bibliothèque PDF sur R2** : `documents.file_path` = clé NUE ; clé R2 =
  `'documents/' + file_path`. Brancher sur `storage_provider` à la lecture.
  **Toujours produire un Blob des deux côtés** (jamais mélanger Blob et object
  URL dans le même état).
- **Calque d'annotation photo** : `dossier_photos.annotations` (jsonb) = source
  de vérité UNIQUE ; l'original R2 n'est JAMAIS touché. Toute la géométrie passe
  par les helpers de `photoAnnotations.ts` (positions 0..1, scalaires en fraction
  de `min(l,h)`) — ne JAMAIS recalculer à la main. Les **trois moteurs** (éditeur
  SVG, overlay lecture, export canvas) partagent ces helpers pour rester au pixel
  identiques ; toute constante commune (tête de flèche, ancrage texte) est
  factorisée, jamais dupliquée. L'export cuit une image **à la demande, jamais
  stockée** (aucun objet R2). Écrire le calque = UPDATE SDK direct (policy SELECT
  `using(true)`, pas de RPC).
- **Worker `/api/photos`** : POST validé par `GENERIC_PREFIX_RE` (préfixes à
  entité, `tête/slug`) OU `GLOBAL_PREFIXES` (égalité stricte, préfixes globaux à
  segment unique — ne JAMAIS rendre le `/slug` optionnel dans le regex). GET
  préfixe-agnostique. DELETE admin-only (rejoue le JWT sur `is_vault_admin`). Le
  Worker ne porte QUE du public + le Bearer de l'appelant — jamais de secret.
- **SOFT-DELETE + policy SELECT `deleted_at IS NULL` = piège 42501** : un UPDATE
  `deleted_at` via PostgREST échoue systématiquement en 42501 « new row violates »
  quand la policy SELECT de la table filtre `deleted_at IS NULL`. Cause :
  PostgREST génère un RETURNING implicite (même avec `Prefer: return=minimal`, qui
  ne touche QUE la sérialisation, pas le RETURNING SQL) → PostgreSQL repasse la
  policy SELECT sur la ligne modifiée, devenue invisible → refus. Indépendant du
  rôle/SDK/apikey (l'UPDATE réussit pourtant en SQL direct). **Fix : une RPC
  SECURITY DEFINER** qui fait l'UPDATE hors RLS en revérifiant les droits en
  interne (cf. `soft_delete_communication`). Les tables dont la policy SELECT est
  `using(true)` (dossier_plans/notes/photos) y échappent. NE JAMAIS écrire de
  fetch manuel vers PostgREST pour contourner ça — passer par le SDK ou une RPC.
- **fetch manuel vers PostgREST/Supabase = à éviter** : le SDK supabase-js place
  l'apikey correctement (query param `?apikey=`) ; un fetch manuel avec l'apikey
  en header peut être refusé (401). Les fetch manuels sont réservés au Worker
  `/api/photos` (qui gère sa clé côté serveur).
- **Recherche interne** : `search_documents` matche marque/modèle/titre/contenu
  ET par préfixe ; MiniSearch offline indexe `productLabel` (boost 3). Recherche
  TEXTE = portée globale forcée pour les deux moteurs ; parcours = scopé.
- **Pipeline photo partagé (carnet + galerie + plans)** : helper
  `uploadPhotoBytes`. `compressImage` sort du JPEG. Les PDF (communications,
  plans) NE passent PAS par la compression : mime conservé.
- **Section accordéon** : slot `action` hors du `<button>` ; `keepMounted=true`
  pour toute section dont l'état ne doit pas mourir au repli (le coffre).
- **Vue qui filtre déjà `deleted_at` = ne pas le refiltrer côté client.**
- **Vue avec nouvelle colonne = DROP + CREATE**, jamais `CREATE OR REPLACE VIEW`.
  Reposer `security_invoker = true` et le `grant select … to authenticated` dans
  la même transaction (le DROP efface options et droits).
- **Soft delete = propagation** : tout endroit qui lit/compte filtre
  `deleted_at is null` — SAUF `dossier_documents`.
- **Déplacer un produit de spécialité = DEUX updates** (`products.specialty_id`
  ET `documents.specialty_id`).
- **« Autres » toujours en dernier = `sort_order = 999`** ; nouvel insert exclut
  le 999 : `coalesce(max(sort_order) filter (where sort_order < 999), 0) + 1`.
- **Nouvelle spécialité = penser au dropdown n8n** (slugs codés en dur). Galerie
  non concernée.
- **Credential R2 S3** : endpoint sans nom de bucket, `Force Path Style: ON`,
  région `auto`.
- **`auth.uid()` est NULL dans le SQL Editor** ; pour simuler un contexte RLS,
  `set_config('request.jwt.claims', '{"sub":"...","role":"authenticated"}', true)`
  DANS UN MÊME RUN transactionnel (`set local` hors transaction est inopérant).
- **Edge Function : le push ne déploie PAS** →
  `npx supabase functions deploy <nom> --project-ref iixqfajflyxrnizlqdsn`. Le
  front ET le Worker `/api/photos` partent au push (Cloudflare auto).
- **Après un push, fermer/rouvrir la PWA avant de juger** (cache SW). Pour un
  changement SW, fermer complètement et rouvrir EN LIGNE une à deux fois. En cas
  de doute qu'un déploiement soit pris, un `git commit --allow-empty` + push
  force un rebuild Cloudflare frais.
- **Signal de lint react-hooks = diagnostiquer avant de patcher.** `exhaustive-deps`
  peut cacher un vrai bug de synchro → corriger réellement (aligner les deps sur
  ce que l'effet lit). `set-state-in-effect` sur un fetch-au-montage / reset
  intentionnel = pattern volontaire → `eslint-disable-next-line` AVEC commentaire
  qui trace le pourquoi, jamais une restructuration qui risque un flash visuel.
- **Secrets** : Publishable/anon = OK en clair ; Secret/tokens = jamais dans
  code/Git/chat.
- **Le travail n'existe que poussé** : commit + push depuis le terminal sur demande; voir le
  diff avant commit; déléguer le push à Claude Code après validation. (Refuser le « auto
  mode » de Claude Code — il dissout ces garde-fous.)

---

## Dettes ouvertes

- **`dossier_documents` sans soft-delete** : seule table enfant sans `deleted_at`.
- **VÉRIF `dossier_produits`** : confirmer que sa policy SELECT n'est PAS
  `deleted_at IS NULL` (sinon `removeDossierEquipment` porterait le même bug
  soft-delete/RETURNING que `communications` avait). Ça fonctionne aujourd'hui
  donc la policy est probablement `using(true)`, mais à confirmer par un audit
  lecture seule.
- **Backup — ajouter les tables récentes** : `web_search_jobs`, `game_scores`,
  `galerie_items`, `galerie_photos`, `dossier_plans`, `dossier_deletion_requests`,
  `dossier_equipment_requests`, `communications` ; activer Schedule + purge.
- **Galerie & Plans — cache offline** : online-only ; répliquer le pattern
  d'épinglage des documents.
- **Annotation photo — cache offline** : l'éditeur et l'overlay dépendent de
  l'object URL de la photo (online). Le calque JSON, lui, voyage avec la ligne
  photo → rendu offline trivial dès que la photo elle-même est cachée (même
  chantier que Galerie & Plans).
- **Communication d'entreprise — aperçu offline** : la vignette de la dernière
  comm est online-only (placeholder hors ligne).
- **Canal email (Brevo)** : non câblé. Débloque notif demandes de suppression +
  d'équipement, confirmation onboarding, alerte suppression en masse.
- **Alerte suppression en masse** : seuil défini (10/10 min/user), dépend de Brevo.
- **Granularité produits — Bticino, Comelit, Swisscom, Burri** : pas éclatées.
- **Compteur de documents plafonné à 1000 pour Portes automatiques**.
- **Recherche web — timeouts définitifs**, écart Anthropic/Perplexity.
- **Débrancher l'ancienne Edge Function `web-search-notices`** une fois l'async
  validé à 100 %.
- **`gol-1-media.bmp`** reste en BMP (non bloquant).
- **`.mp3` du jeu** : vérifier qu'il est dans les `globPatterns` du workbox ;
  confirmer l'autoplay Android.
- **`formatDate` dupliqué localement** (~4-5 copies) : helper partagé à
  factoriser un jour.
- **`planLabel` bugué** (coupe au premier tiret → bout d'UUID pour un plan sans
  titre) : `deriveLabel` correct existe côté communications, à y aligner.
- **Chevrons retour `goHome` vs `goBack`** : à normaliser.
- **Comptes de test à supprimer** avant exploitation.
- **pg_cron** installé mais inutilisé.

---

## Prochain chantier

1. **Vérif `dossier_produits`** (policy SELECT, bug soft-delete latent).
2. **Galerie & Plans — cache offline** (+ annotation photo offline, même pattern).
3. **Stabiliser la recherche à deux moteurs** ; puis débrancher l'ancien chemin.
4. **Canal email (Brevo)** : demandes, onboarding, alerte masse.
5. **Protection des données** : Schedule backup + purge (avec les nouvelles
   tables).
6. **Nettoyage granularité produits** (Bticino, Comelit, Swisscom, Burri).

---

## Où trouver le détail

- **Le pourquoi des décisions** : les HANDOFF datés (archive). L'annotation photo
  non destructive n'a pas encore son HANDOFF daté — à créer pour archiver le
  raisonnement (calque vectoriel, module pivot 3 moteurs, export à la demande).
- **La spec technique + règles Claude Code** : `CLAUDE.md` à la racine du repo.
- **Le comment exact d'un workflow n8n** : le workflow lui-même dans n8n.
