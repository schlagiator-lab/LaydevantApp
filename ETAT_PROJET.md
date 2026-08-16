# Laydevant — État du projet
## Point d'entrée : la photo du présent (pas l'historique)

Ce fichier décrit le projet **tel qu'il est maintenant**. Il est **réécrit** à
chaque avancée (pas complété) : une dette réglée en disparaît, une feature finie
passe en « fonctionne ». Pour le POURQUOI d'une décision, voir les HANDOFF datés
(l'archive). Pour la spec technique de Claude Code, voir `CLAUDE.md` (le repo).

À jour au 16 août 2026.

---

## Le projet en bref

PWA offline-first consultée sur téléphone par les techniciens de Laydevant SA
(électricité, télécom, portes automatiques, Genève, ~50 monteurs). But : retrouver
en quelques secondes une notice/un manuel sur chantier, y compris hors réseau.
Construite par John (solo) sur son temps et ses moyens.

**Parc — majorité Android, poignée d'iOS.** L'essentiel du parc est **Android**
(~50 monteurs et techniciens) ; s'y ajoutent **quelques iPhones** (3 : responsables
d'équipe + direction). Android reste la plateforme de référence et n'est **jamais**
dégradé ; iOS a des **chemins spécifiques** isolés derrière `isIosDevice()`, pour
contourner les limites du WebKit iOS sans toucher au comportement Android.

**Contraintes structurantes** : offline = la norme, pas un cas dégradé ; plan
Supabase FREE ; normes NIBT/NIN sous licence → JAMAIS copiées (liens + fiches
perso), manuels fabricants librement distribués = OK en interne.

**Philosophie de la recherche** : le but n'est pas la vitesse, le but est de
trouver l'introuvable — la bonne notice, la bonne référence. Un mini-jeu fait
patienter le monteur pendant que deux moteurs de recherche web cherchent en
parallèle. Corollaire côté recherche INTERNE : où que l'on se trouve dans l'app,
une recherche par texte couvre toute la base et matche marque comme modèle.

**Où vivent les fichiers (règle d'or depuis la migration R2)** : TOUT le binaire
lourd — **PDF de la bibliothèque**, photos du carnet, galerie, plans,
**communications d'entreprise**, et désormais les **fichiers chiffrés du coffre** —
vit sur **Cloudflare R2** (10 Go gratuits, egress zéro). Supabase Storage n'héberge
plus aucun PDF de bibliothèque. Supabase reste la base Postgres, l'Auth, la RLS et
les Edge Functions (Database Size ~0,1 Go).

**Où vivent les annotations photo** : les retouches de photo du carnet ne sont PAS
des images. Chaque photo garde son **original R2 intact** ; traits/textes/flèches/
formes vivent comme un **calque vectoriel JSON** dans `dossier_photos.annotations`
(jsonb). L'image aplatie n'existe qu'à l'export, à la demande, jamais stockée.

**Où vivent les fichiers du coffre (nouvelle règle)** : un fichier sensible (PDF ou
photo de credentials) est chiffré **côté client** sous une clé propre au fichier
(FEK), ses octets chiffrés vivent sur R2, et **Supabase/R2 ne voient jamais le
clair** — zero-knowledge, comme les notes. Détail en section dédiée.

---

## Stack

- **Front** : React + Vite + TypeScript, vite-plugin-pwa (service worker),
  MiniSearch (recherche offline), IndexedDB + Cache API. Navigation par pile en
  mémoire (`NavigationProvider`, synchronisée avec l'History API pour le retour
  Android), **pas de routeur d'URL**. Une spécialité s'affiche selon
  `specialties.display_mode` : `'documents'` ou `'galerie'`. L'écran d'un dossier
  est en **sections accordéon** (`CollapsibleSection`).
- **Bifurcation plateforme** : `isIosDevice()` (helper, dans `src/lib/pdfMeasure.ts`)
  = `/iPad|iPhone|iPod/.test(userAgent)` OU (`platform === 'MacIntel'` &&
  `maxTouchPoints > 1`). Sert à router les chemins iOS (ouverture PDF, garde-fou
  plans). Android/desktop passent par le chemin nominal.
- **Backend** : Supabase (Postgres, Auth, RLS, Edge Functions). Storage Supabase
  n'héberge plus de PDF. Project ref `iixqfajflyxrnizlqdsn`.
- **Fichiers (documents, photos, galerie, plans, communications, coffre)** :
  Cloudflare R2, bucket `laydevant-photos`, via binding natif Worker
  (`/api/photos`). Le Worker construit la clé côté serveur pour les uploads :
  - préfixes liés à une entité — forme `tête/slug`, validés par
    `GENERIC_PREFIX_RE` (allowlist **`galerie|plans|vault`**, exige un second
    segment) : `?prefix=plans/<dossierId>`, `?prefix=vault/<dossierId>`, ou
    `?dossier=<id>` → `dossiers/{id}/{uuid}` ;
  - préfixes GLOBAUX à segment unique — `GLOBAL_PREFIXES` (`communications`),
    égalité stricte.
  La **LECTURE** (`GET /api/photos/<clé>`) est **préfixe-agnostique** (sert
  n'importe quelle clé avec un JWT valide). Le **DELETE** est **différencié** :
  clés `vault/` → autorisé si `has_dossier_vault_access(dossier_id)` (dossier
  parsé depuis la clé) **OU** `is_vault_admin` ; tous les autres préfixes →
  **admin-only strict** (`is_vault_admin`). Le Worker ne porte QUE du public + le
  Bearer de l'appelant, jamais de secret.
- **Bibliothèque PDF sur R2** : `documents.storage_provider` (tous en `'r2'`) et
  `documents.file_path` (clé NUE). **Clé R2 = `documents/` + file_path**.
- **Fichiers du coffre sur R2** : clé `vault/{dossierId}/{uuid}`, octets chiffrés
  sous la FEK du fichier.
- **Ouverture des PDF (pdf.js)** : `<PdfViewer>` in-app partagé (notices,
  communications, plans iOS, fichiers coffre iOS). pdf.js exige un **polyfill
  `Map`/`WeakMap` `getOrInsert`/`getOrInsertComputed`** chargé au démarrage (le
  WebKit iOS du terrain ne les implémente pas → crash « getOrInsertComputed is not
  a function » sans le polyfill).
- **Backups** : Cloudflare R2, bucket `laydevant-backups`, écrit par n8n (S3).
- **Hébergement front** : Cloudflare Workers (`laydevant-app`), déploiement auto
  sur push `main`. Le Worker `worker/index.js` part au push, pas de déploiement
  séparé.
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
  ~1493 documents servis depuis R2. Deux modes d'affichage de spécialité.
- **Épinglage offline (sur R2)** : capture du blob via le bon backend, Cache API +
  métadonnées IndexedDB. Fonctionne en mode avion.
- **Recherche INTERNE — marque + modèle partout, à trois facettes** (champ,
  portée, préfixe). Recherche TEXTE = portée globale forcée ; parcours = scopé.
- **Recherche web de notices — architecture asynchrone à deux moteurs**.
- **Dossiers clients** : rattachement d'ÉQUIPEMENTS, remontée auto des notices via
  `products` (+ docs de marque via `brand`). Sections accordéon.
- **Équipement manuel → demande admin** : déclaration d'un équipement absent, badge
  « en attente », résolution admin (`resolve_dossier_equipment_request`).
- **Coffre de données sensibles** : chiffrement par dossier (zero-knowledge,
  WebCrypto). Notes ET **fichiers chiffrés** (section dédiée). Récupération par
  ré-enrôlement, deux admins-récupérateurs.
- **Communication d'entreprise** : espace GLOBAL de diffusion de PDF par
  publisher/admin. Ouverture **in-app** (viewer partagé). Section dédiée.
- **Carnet public** (notes + photos par dossier) : en clair, RLS « tout
  authentifié lit/écrit ». Photos sur R2, compression client.
- **Annotation de photos du carnet — non destructive** : calque vectoriel
  rééditable, 4 outils, rendu partout, export image à la demande.
- **Galerie photo, Plans de dossier, Onboarding par liste blanche**.
- **Ingestion n8n (écrit dans R2)** : formulaire, webhook `ingest-from-url`, lot.
- **Backup quotidien** : export JSON n8n vers R2.
- **Soft delete (corbeille)** sur les tables enfant du dossier. **Exceptions** :
  `dossier_documents` (pas de `deleted_at`) et `vault_files` (hard delete assumé,
  voir coffre-fichiers).
- **Mini-jeu Tetris + classement + bruitages** : section dédiée.

---

## Coffre — fichiers chiffrés (modèle enveloppe FEK)

Le coffre par dossier accepte désormais, en plus des notes, des **fichiers**
(PDF/photos de credentials, données d'accès provider…), chiffrés **côté client
zero-knowledge**. R2/Supabase ne voient que du chiffré.

**Le modèle enveloppe, en clair.** Chaque fichier a sa **propre clé FEK**
(AES-256-GCM). Les **octets** sont chiffrés sous la FEK et stockés sur R2. Le
**nom + type** sont chiffrés sous la FEK (pas de fuite par le nom de fichier). La
**FEK est emballée sous la DEK** du dossier — concrètement, on chiffre les 32
octets bruts de la FEK avec la DEK (droit `encrypt`, que la DEK de session
possède ; **pas** `wrapKey`, que la DEK de session n'a pas). Seule la **taille**
reste en clair (affichage UI). Intérêt décisif : à la **rotation**, on ne
re-chiffre QUE les petites FEK, **jamais les octets sur R2**.

**Crypto — `src/lib/vault.js`** (additif, harnais 30/30) : `generateFek`,
`encryptBytes`, `decryptBytes`, `wrapFekForDek`, `unwrapFekWithDek` (paramètre
`extractable` pour la rotation). Métadonnées via `encryptContent`/`decryptContent`
sous la FEK. IV toujours séparé du ciphertext. Déclarations ajoutées à `vault.d.ts`.

**Table `vault_files`** : `id`, `dossier_id` (FK `on delete cascade`),
`storage_key` (R2), `file_iv`, `wrapped_fek` + `fek_wrap_iv`, `meta_ciphertext` +
`meta_iv`, `dek_version`, `taille` (clair), `auteur`, `created_at`. **Hard delete**
(pas de `deleted_at`) — un fichier de credentials ne doit pas traîner en corbeille,
et l'octet R2 doit vraiment partir. RLS calquée sur l'**accès au coffre** (comme
une note, pas comme une destruction) : SELECT/UPDATE/DELETE =
`has_dossier_vault_access(dossier_id) OR is_vault_admin()` ; INSERT =
`has_vault_access() OR is_vault_admin()`.

**Bootstrap partagé** : `bootstrapDossierVault(dossierId)` extrait dans
`vaultSecrets.ts` (crée la DEK + `vault_secrets` + emballe vers tous les
titulaires), appelé par `persistNotes` ET `uploadVaultFile` — un premier fichier
peut donc être déposé dans un coffre encore vierge.

**Couche data — `src/lib/vaultFiles.ts`** : `uploadVaultFile(dossierId, dek|null,
file)` (chiffre octets+méta sous une FEK neuve → emballe la FEK sous la DEK → POST
`vault/<dossierId>` → INSERT ; bootstrappe si `dek` null), `listVaultFiles`
(déchiffre nom+type EN MÉMOIRE, renvoie aussi les champs crypto bruts pour rendre
chaque ligne actionnable), `openVaultFile` (GET → déballe FEK → `decryptBytes` →
Blob clair **éphémère**), `deleteVaultFile` (DELETE ligne puis R2 best-effort),
`renameVaultFile` (ré-chiffre `{name,mime}` sous la **même FEK**, UPDATE
`meta_ciphertext`/`meta_iv` — **ne touche NI aux octets, NI au wrapped_fek**).

**Worker** : préfixe `vault/` per-dossier ajouté à `GENERIC_PREFIX_RE` (POST).
DELETE différencié (voir Stack).

**Rotation — `vaultRotation.ts`** : en plus des notes et des accès, ré-emballe les
FEK — pour chaque fichier, déballe la FEK avec l'**ancienne** DEK (extractable) →
la ré-emballe sous la **nouvelle** DEK → passe la liste à `rotate_vault_secret` via
le paramètre `p_file_rows`. Les octets R2 ne bougent jamais.

**`rotate_vault_secret`** (7 args, `p_file_rows jsonb DEFAULT '[]'`) : ré-emballe
les FEK dans **la même transaction** que le contenu et les accès. **Contrôle
strict** : nombre de FEK fournies == nombre de fichiers réellement en base (sinon
un fichier ajouté entre-temps aurait une FEK oubliée → illisible à la rotation
suivante → on annule). Garde de version, verrou `FOR UPDATE`, UPDATE jamais INSERT
inchangés. `destroy_dossier_vault` purge aussi `vault_files`.

**UI — bloc « Fichiers » dans le sheet du coffre** : visible dès que le coffre est
déverrouillé (`ready`) OU `empty` (pour le premier upload). Dépôt (input
PDF/image, **upload séquentiel**, `touch()` autour pour ne pas se faire couper par
l'auto-lock), liste (nom déchiffré + `formatBytes` + date + icône selon mime),
**titre éditable** (calqué sur le carnet, `renameVaultFile`), **ouverture « en
grand »** (image → viewer image in-app ; PDF → viewer in-app sur iOS / lecteur
natif sur non-iOS), **partage** en action secondaire, **suppression** (confirmation
inline calquée sur les notes). Le clair ne vit qu'en mémoire (object URL éphémère,
révoqué).

---

## Ouverture des PDF — règle de plateforme

Cross-cutting, à respecter partout où on ouvre un PDF :

- **Sur iOS, `window.open` appelé APRÈS un `await` est bloqué** (geste consommé) →
  un PDF récupéré via fetch R2 (donc après `await`) doit s'ouvrir **in-app** dans
  `<PdfViewer>`. Sur **non-iOS**, on ouvre dans le **lecteur natif**
  (`createObjectURL` → `window.open('_blank','noopener')` → `revoke` différé 60 s),
  qui re-rastérise au zoom (détail net). **Ne JAMAIS** faire de pré-ouverture
  synchrone `window.open('','_blank','noopener')` : `noopener` renvoie toujours
  `null`, ce qui casse la détection et déclenche à tort un téléchargement.
- **Notices** (`DocumentScreen`) : rendu in-app `<PdfViewer>`. Le bouton « Voir en
  plein écran » fait un `window.open` sur un Blob **déjà chargé** (pas d'`await`
  avant) → OK même sur iOS.
- **Communications** : ouverture in-app (`getCommunicationBlob` → `<PdfViewer>`).
- **Plans** : bifurcation `isIosDevice()`. Non-iOS → lecteur natif. iOS → mesure du
  plan + garde-fou « trop détaillé » (ci-dessous), sinon `<PdfViewer>` in-app.
- **Fichiers du coffre** : image → viewer image in-app ; PDF → `<PdfViewer>` in-app
  sur iOS, lecteur natif sur non-iOS.

**pdf.js — polyfill obligatoire** : les versions récentes utilisent
`Map.prototype.getOrInsertComputed`, absent du WebKit iOS du terrain (présent sur
Android/Chrome) → crash de l'aperçu. Un polyfill `Map`/`WeakMap`
`getOrInsert`/`getOrInsertComputed`, feature-détecté, est chargé au démarrage avant
toute utilisation de pdf.js.

**Garde-fou « plan trop détaillé » (iOS uniquement)** : certains plans sont des
**PDF-image** (une seule JPEG géante — cas mesuré : 13141×9420 ≈ **124 Mpx**).
pdf.js **et** le lecteur natif iOS crashent le process WebKit en décodant une telle
image (~0,5 Go), quel que soit le poids du fichier (un 20 Mo vectoriel passe, ce
124 Mpx non). Mesure **décode-free** via `pdfImageMegapixels` (`src/lib/pdfMeasure.ts`,
lit `/Width` `/Height` dans les octets, sans décoder). Sur iOS, si
`mpx > IOS_MAX_PLAN_MEGAPIXELS` (=30, constante ajustable) → **carte de repli**
(« Plan trop détaillé pour iPhone, consultable sur Android ou ordinateur ») +
bouton **partage de l'original**, au lieu de rendre. Android : jamais mesuré,
original plein détail. Le garde-fou n'est PAS (encore) appliqué aux fichiers PDF du
coffre (supposés légers) — à ajouter si un PDF-image lourd y crashe iOS.

---

## Communication d'entreprise

Espace de diffusion global, sans lien à un dossier. Mécanique calquée sur Plans
(R2, soft-delete, mime PDF direct), gouvernance d'accès propre.

- **Droit de publier** : `profiles.is_comms_publisher` (défaut false), trigger
  `profiles_guard`, octroi via RPC `set_comms_publisher` (admin-only), piloté depuis
  l'onglet Comptes de `VaultAdminScreen`.
- **Table `communications`** + vue `communications_view` (security_invoker). RLS :
  SELECT tout authentifié avec `deleted_at IS NULL` ; INSERT/UPDATE publisher OU
  admin. **Suppression par RPC** `soft_delete_communication` (SECURITY DEFINER),
  PAS un UPDATE direct (piège 42501, voir conventions).
- **Écran** (`CommunicationsScreen`) : la comm la plus récente en avant (aperçu 1re
  page via `<PdfViewer>`, gaté `isOnline`), les anciennes en liste. **Ouverture
  d'un PDF = viewer in-app** (`getCommunicationBlob` → `<PdfViewer>`), plus de
  `window.open`.

---

## Écran dossier — sections accordéon, Plans, coffre

### Sections repliables (`CollapsibleSection`)
Ordre : Équipements → Documentation → Plans → Carnet → Données sensibles.
`keepMounted=true` sur Données sensibles (protège la session déverrouillée du
coffre). La section Équipements affiche un badge « N en attente » si `> 0`.

### Table `dossier_plans`
R2, soft delete, RLS « tout authentifié lit/écrit », `mime` agnostique. Vue
`dossier_plans_view`. `PlansSection` : rendu tri-modal (image → vignette ; PDF →
ouverture selon la règle de plateforme ci-dessus ; DWG → téléchargeable).

### Sheet du coffre — ergonomie des gestes destructeurs
« Détruire le coffre de ce dossier » est replié dans une `CollapsibleSection`
**« Zone de danger » (fermée par défaut)** — plus atteignable sans déplier
délibérément. Dans le détail d'une note, « Supprimer cette note » est **séparé** de
« Retour »/« Modifier » (séparateur + espace) pour éviter les taps accidentels.
Purement visuel ; la crypto, la session et l'auto-lock sont intacts.

---

## Suppression de dossier — deux chemins selon l'état

1. **Dossier vide → `delete_dossier_if_empty`** (HARD delete si vide, sinon
   `DOSSIER_NON_VIDE:`). `dossier_documents` sans `deleted_at` → décompte non filtré.
2. **Dossier à coffre → `destroy_dossier_vault`** (admin, atomique : purge
   `vault_files` + accès + secret) puis chemin 1.
3. **Demande de suppression (non-admin sur dossier à coffre)** : trigger, table
   `dossier_deletion_requests`, RPC `resolve_dossier_deletion_request`. Onglet
   « Demandes » de `VaultAdminScreen`. Notif email admin = fast-follow via Brevo.

---

## Recherche web à deux moteurs — architecture

Le téléphone crée un job (`web_search_jobs`), un trigger Postgres (`pg_net`)
appelle les deux webhooks n8n (Anthropic + Perplexity), chacun écrit SA colonne,
le téléphone poll toutes les 3 s, attend les deux (ou 180 s), fusionne + dédup par
URL, affiche.

- **Anthropic** (`notices-search`) : Claude Sonnet 5, `web_search max_uses: 1`.
- **Perplexity** (`notices-search-pplx`) : `sonar-reasoning-pro`, format OpenAI,
  `search_domain_filter` bannissant les agrégateurs.
- URLs/secret dans `private_config` (RLS, aucune policy). `is_pdf` décide de
  l'action UI.

---

## Mini-jeu d'attente + classement + bruitages

- **Tetris** (`PdfTetris.tsx`). Depuis la tuile Jeu de l'accueil, menu « Jouer /
  Classement » ; lancement direct depuis l'écran d'attente de la recherche.
- **Contrôle et cadre écran** : la vue de jeu est enveloppée dans une **couche de
  capture plein écran** — les gestes (glisser/taper) sont captés **partout**, y
  compris la bande inutilisée du bas ; **verrou anti-overscroll iOS** (listener
  `touchmove` **non-passif** `preventDefault`, actif **pendant la partie
  uniquement**, + verrou du scroll du body) ; `user-select`/`touch-callout`/
  `touch-action` neutralisés (plus de menu natif « copier/traduire » à l'appui long).
- **Bruitages (SFX)** : gestionnaire à **préchargement one-shot** (map nom→Audio),
  clones pour les sons rapprochés, volume sous la musique. Câblage : rotation
  (`rotatePiece`, si aboutie), hard drop (`hardDrop`), effacements 1/2/3/4 lignes
  (`Single`/`Double`/`Triple`/`SpecialTetris`, dans `applyClears`), **lock**
  (`lockAndClear`, `SFX_SpecialLineBEndFallTouch` — à chaque pièce qui se fige),
  game over (`useEffect` sur `over`). Pas de son de T-spin (non détecté).
- **Cache offline des sons** : `'mp3'` est dans les `globPatterns` → les **SFX
  (petits) sont précachés** (jouent hors ligne). La **musique** `tetris_audio.mp3`
  (6,87 Mo, > limite 2 Mo du précache) n'est **pas** précachée mais servie par une
  **règle de cache runtime** workbox (CacheFirst, `cacheName` dédié) → disponible
  hors ligne **après une première écoute en ligne**.
- **Classement d'équipe** : `game_scores` + vue `game_leaderboard`, couche
  `gameScores.ts`, écran `Leaderboard.tsx`.

---

## Conventions vivantes (à respecter à chaque fois)

- **Ouverture PDF = règle de plateforme** (section dédiée) : jamais de
  `window.open` après un `await` sur iOS → viewer in-app ; non-iOS → natif ; jamais
  de pré-ouverture synchrone `window.open('','_blank','noopener')`.
- **pdf.js** : le polyfill `Map`/`WeakMap` `getOrInsert(Computed)` doit rester
  chargé au démarrage (WebKit iOS ne l'a pas).
- **Coffre — enveloppe FEK** : fichier chiffré sous une FEK ; FEK emballée en la
  **chiffrant** avec la DEK (pas `wrapKey`) ; nom+mime chiffrés sous la FEK ; octets
  sur R2 sous `vault/{dossierId}/{uuid}`. La rotation ré-emballe **uniquement** les
  FEK (jamais les octets R2), dans la transaction de `rotate_vault_secret`
  (contrôle strict FEK == fichiers). `renameVaultFile` ré-chiffre les métadonnées
  sous la MÊME FEK, ne touche pas aux octets ni au `wrapped_fek`. Ne JAMAIS modifier
  `vault.js` sans relancer le harnais (30/30).
- **Bibliothèque PDF sur R2** : `file_path` = clé NUE ; clé R2 = `'documents/' +
  file_path`. Toujours un Blob des deux côtés (jamais mélanger Blob et object URL).
- **Calque d'annotation photo** : `dossier_photos.annotations` (jsonb) = source de
  vérité UNIQUE ; original R2 jamais touché ; géométrie via les helpers de
  `photoAnnotations.ts` ; export à la demande, jamais stocké.
- **Worker `/api/photos`** : POST validé par `GENERIC_PREFIX_RE`
  (`galerie|plans|vault`, `tête/slug`) OU `GLOBAL_PREFIXES` (égalité stricte). GET
  préfixe-agnostique. DELETE **différencié** : `vault/` → `has_dossier_vault_access`
  (dossier parsé de la clé) OU `is_vault_admin` ; autres préfixes → admin-only. Le
  Worker ne porte QUE du public + le Bearer de l'appelant.
- **SOFT-DELETE + policy SELECT `deleted_at IS NULL` = piège 42501** : un UPDATE
  `deleted_at` via PostgREST échoue en 42501 (RETURNING implicite qui repasse la
  policy SELECT). **Fix : RPC SECURITY DEFINER** (cf. `soft_delete_communication`).
  Les tables dont la policy SELECT est `using(true)` (dossier_plans/notes/photos) y
  échappent, ainsi que `vault_files` (SELECT sur `has_dossier_vault_access`, pas de
  filtre `deleted_at` — d'où le hard delete sans piège). NE JAMAIS écrire de fetch
  manuel vers PostgREST pour contourner ça.
- **fetch manuel vers PostgREST = à éviter** (l'apikey en header peut être refusée
  401 ; le SDK la place en query param). Réservé au Worker `/api/photos`.
- **Recherche interne** : `search_documents` matche marque/modèle/titre/contenu ET
  par préfixe ; MiniSearch offline indexe `productLabel` (boost 3). Recherche TEXTE
  = portée globale forcée ; parcours = scopé.
- **Pipeline photo partagé (carnet + galerie + plans)** : helper `uploadPhotoBytes`,
  `compressImage` sort du JPEG. Les PDF (communications, plans, **fichiers coffre
  chiffrés**) NE passent PAS par la compression : `application/octet-stream` /
  `application/pdf`, octets conservés.
- **Section accordéon** : slot `action` hors du `<button>` ; `keepMounted=true` pour
  toute section dont l'état ne doit pas mourir au repli (le coffre).
- **Vue qui filtre déjà `deleted_at` = ne pas le refiltrer côté client.**
- **Vue avec nouvelle colonne = DROP + CREATE** ; reposer `security_invoker=true` et
  le grant dans la même transaction.
- **Soft delete = propagation** : tout endroit qui lit/compte filtre
  `deleted_at is null` — SAUF `dossier_documents` et `vault_files`.
- **Déplacer un produit de spécialité = DEUX updates** (`products.specialty_id` ET
  `documents.specialty_id`).
- **« Autres » toujours en dernier = `sort_order = 999`** ; nouvel insert exclut le
  999 : `coalesce(max(sort_order) filter (where sort_order < 999), 0) + 1`.
- **Nouvelle spécialité = penser au dropdown n8n** (slugs codés en dur).
- **Credential R2 S3** : endpoint sans nom de bucket, `Force Path Style: ON`,
  région `auto`.
- **`auth.uid()` est NULL dans le SQL Editor** ; simuler un contexte RLS via
  `set_config('request.jwt.claims', …, true)` DANS UN MÊME RUN transactionnel.
- **Signature de fonction = nom + types d'args** : ajouter un paramètre crée une
  SURCHARGE, pas un remplacement. Pour étendre (ex. `rotate_vault_secret`),
  `drop function if exists …(ancienne signature)` puis `create` puis **re-`grant
  execute`** (le drop l'efface).
- **Edge Function : le push ne déploie PAS** → `npx supabase functions deploy <nom>
  --project-ref iixqfajflyxrnizlqdsn`. Le front ET le Worker partent au push.
- **Après un push, fermer/rouvrir la PWA avant de juger** (cache SW). Pour un
  changement SW (globPatterns, runtime cache), fermer complètement et rouvrir EN
  LIGNE une à deux fois. Remplacer un asset **sous le même nom** (ex. un `.mp3`)
  exige impérativement ce rituel, sinon l'ancien octet précaché est servi.
- **Signal de lint react-hooks = diagnostiquer avant de patcher.**
- **Secrets** : Publishable/anon = OK en clair ; Secret/tokens = jamais dans
  code/Git/chat.
- **Le travail n'existe que poussé** : commit + push depuis le terminal sur demande ;
  voir le diff avant commit ; déléguer le push à Claude Code après validation.
  (Refuser le « auto mode » de Claude Code.)

---

## Dettes ouvertes

- **`dossier_documents` sans soft-delete** : seule table enfant (hors coffre) sans
  `deleted_at`.
- **VÉRIF `dossier_produits`** : confirmer que sa policy SELECT n'est PAS
  `deleted_at IS NULL` (sinon `removeDossierEquipment` porterait le bug
  soft-delete/RETURNING). Fonctionne aujourd'hui, mais à confirmer par audit.
- **Backup — ajouter les tables récentes** : `web_search_jobs`, `game_scores`,
  `galerie_items`, `galerie_photos`, `dossier_plans`, `dossier_deletion_requests`,
  `dossier_equipment_requests`, `communications`, **`vault_files`** (lignes = du
  chiffré, sans risque à exporter) ; activer Schedule + purge.
- **Cache offline — Galerie, Plans, fichiers du coffre, annotation photo** :
  online-only ; répliquer le pattern d'épinglage des documents. Le calque
  d'annotation voyage déjà avec la ligne photo → offline trivial dès que la photo
  est cachée.
- **Communication d'entreprise — aperçu offline** : la vignette de la dernière comm
  est online-only (placeholder hors ligne).
- **Garde-fou « PDF trop détaillé » sur les fichiers du coffre** : non appliqué
  (fichiers supposés légers) — à ajouter si un PDF-image lourd crashe iOS.
- **Canal email (Brevo)** : non câblé. Débloque notif demandes de suppression +
  d'équipement, confirmation onboarding, alerte suppression en masse.
- **Alerte suppression en masse** : seuil défini (10/10 min/user), dépend de Brevo.
- **Granularité produits — Bticino, Comelit, Swisscom, Burri** : pas éclatées.
- **Compteur de documents plafonné à 1000 pour Portes automatiques**.
- **Recherche web — timeouts définitifs**, écart Anthropic/Perplexity.
- **Débrancher l'ancienne Edge Function `web-search-notices`** une fois l'async
  validé à 100 %.
- **`gol-1-media.bmp`** reste en BMP (non bloquant).
- **`formatDate` dupliqué localement** (~4-5 copies) : helper partagé à factoriser.
- **`planLabel` bugué** (coupe au premier tiret) : aligner sur `deriveLabel`
  (correct, côté communications).
- **Chevrons retour `goHome` vs `goBack`** : à normaliser.
- **Comptes de test à supprimer** avant exploitation.
- **pg_cron** installé mais inutilisé.

---

## Prochain chantier

1. **Canal email (Brevo)** : débloque en cascade demandes de suppression/équipement,
   confirmation onboarding, alerte suppression en masse. Le blocage le plus rentable
   à lever.
2. **Vérif `dossier_produits`** (policy SELECT, bug soft-delete latent).
3. **Cache offline** — Galerie, Plans, fichiers du coffre, annotation photo (même
   pattern d'épinglage).
4. **Protection des données** : Schedule backup + purge, avec toutes les tables
   récentes (`vault_files` incluse).
5. **Stabiliser la recherche à deux moteurs** ; puis débrancher l'ancien chemin.
6. **Nettoyage granularité produits** (Bticino, Comelit, Swisscom, Burri).

---

## Où trouver le détail

- **Le pourquoi des décisions** : les HANDOFF datés (archive). **À créer** : un
  HANDOFF dédié aux **fichiers chiffrés du coffre** (modèle enveloppe FEK, rotation
  qui ne touche pas R2, les 5 tranches crypto→SQL→Worker→data→UI) et aux
  **correctifs iOS** (règle d'ouverture PDF, polyfill pdf.js, garde-fou plans
  « trop détaillé »).
- **La spec technique + règles Claude Code** : `CLAUDE.md` à la racine du repo.
- **Le comment exact d'un workflow n8n** : le workflow lui-même dans n8n.
