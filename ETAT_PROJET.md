# Laydevant — État du projet
## Point d'entrée : la photo du présent (pas l'historique)

Ce fichier décrit le projet **tel qu'il est maintenant**. Il est **réécrit** à
chaque avancée (pas complété) : une dette réglée en disparaît, une feature finie
passe en « fonctionne ». Pour le POURQUOI d'une décision, voir les HANDOFF datés
(l'archive). Pour la spec technique de Claude Code, voir `CLAUDE.md` (le repo).

À jour au 1er septembre 2026.

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
patienter le monteur pendant que **trois moteurs de recherche web** cherchent en
parallèle et qu'un **juge LLM** tranche. Corollaire côté recherche INTERNE : où que
l'on se trouve dans l'app, une recherche par texte couvre toute la base et matche
marque comme modèle.

**Philosophie de l'enrichissement** : un monteur est jugé compétent pour décider
qu'une notice mérite d'entrer en base. Il le fait déjà seul depuis la recherche web
(capture → base, sans admin). Corollaire appliqué à la notice terrain : **s'il a
déjà la doc en main, il l'ajoute directement** ; l'admin n'intervient que quand la
doc manque — c.-à-d. quand il faut **trouver l'introuvable**, sa vraie valeur.

**Où vivent les fichiers (règle d'or depuis la migration R2)** : TOUT le binaire
lourd — **PDF de la bibliothèque**, photos du carnet, galerie, plans,
**communications d'entreprise**, et les **fichiers chiffrés du coffre** — vit sur
**Cloudflare R2** (10 Go gratuits, egress zéro). Supabase Storage n'héberge plus
aucun PDF de bibliothèque. Supabase reste la base Postgres, l'Auth, la RLS et les
Edge Functions (Database Size ~0,1 Go).

**Où vivent les annotations photo** : les retouches de photo du carnet ne sont PAS
des images. Chaque photo garde son **original R2 intact** ; traits/textes/flèches/
formes vivent comme un **calque vectoriel JSON** dans `dossier_photos.annotations`
(jsonb). L'image aplatie n'existe qu'à l'export, à la demande, jamais stockée.

**Où vivent les fichiers du coffre** : un fichier sensible (PDF ou photo de
credentials) est chiffré **côté client** sous une clé propre au fichier (FEK), ses
octets chiffrés vivent sur R2, et **Supabase/R2 ne voient jamais le clair** —
zero-knowledge, comme les notes. Détail en section dédiée.

---

## Stack

- **Front** : React + Vite + TypeScript, vite-plugin-pwa (service worker),
  MiniSearch (recherche offline), IndexedDB + Cache API. Navigation par pile en
  mémoire (`NavigationProvider`, synchronisée avec l'History API pour le retour
  Android), **pas de routeur d'URL**. Une spécialité s'affiche selon
  `specialties.display_mode` : `'documents'` ou `'galerie'`. L'écran d'un dossier
  est en **sections accordéon** (`CollapsibleSection`).
- **Service worker — `injectManifest` (`src/sw.ts` + `tsconfig.sw.json`)** : depuis
  l'ajout des notifications push, le SW est **écrit à la main** (plus `generateSW`).
  On est donc **auteur** du précache (`precacheAndRoute(self.__WB_MANIFEST)`) ET du
  runtime caching (routes `registerRoute`/`CacheFirst` recopiées à l'identique lors
  de la bascule). Contient aussi les handlers `push` / `notificationclick`.
- **Bifurcation plateforme** : `isIosDevice()` (helper, dans `src/lib/pdfMeasure.ts`).
- **Backend** : Supabase (Postgres, Auth, RLS, Edge Functions). Storage Supabase
  n'héberge plus de PDF. Project ref `iixqfajflyxrnizlqdsn`.
- **Fichiers (documents, photos, galerie, plans, communications, coffre)** :
  Cloudflare R2, bucket `laydevant-photos`, via binding natif Worker (`/api/photos`).
- **Bibliothèque PDF sur R2** : `documents.storage_provider` (tous en `'r2'`) et
  `documents.file_path` (clé NUE). **Clé R2 = `documents/` + file_path**.
- **Ouverture des PDF (pdf.js, `pdfjs-dist` 6.3.x)** : `<PdfViewer>` in-app partagé.
  Polyfill `Map`/`WeakMap` `getOrInsert`/`getOrInsertComputed` obligatoire au démarrage.
- **Notifications push (Web Push / VAPID)** : `send-push` (Edge Function) + trigger
  SQL `notify_new_communication` via `pg_net`. Section dédiée.
- **Backups** : Cloudflare R2, bucket `laydevant-backups`, écrit par n8n (S3).
- **Hébergement front** : Cloudflare Workers (`laydevant-app`), déploiement auto sur
  push `main`. Le Worker `worker/index.js` part au push, pas de déploiement séparé.
- **Ingestion + recherche web** : n8n auto-hébergé (VPS Hostinger).
- **IA / recherche web** : **3 moteurs en parallèle** — **Serper** (SERP Google
  brut, 2 requêtes dont `filetype:pdf`), **Gemini Flash + Grounding**, **Perplexity
  `sonar-pro`** — suivis d'un **juge LLM Claude Haiku 4.5** qui déduplique, vérifie
  et sélectionne (voir section dédiée). DeepL (traduction).
- **Dépôt** : GitHub `schlagiator-lab/LaydevantApp` (privé), dev en Codespaces.

**Clés API** : Publishable key Supabase (publique) côté front + Worker ; Secret key
(`sb_secret_`) côté Edge Functions et n8n. Credential R2 S3 (endpoint sans nom de bucket,
`Force Path Style: ON`, région `auto`). Côté recherche web : Serper, Gemini, Perplexity
et Anthropic vivent en credentials n8n (Header Auth ou natif), jamais dans les exports.
**VAPID** : clé publique dans `VITE_VAPID_PUBLIC_KEY` (front, publique par conception,
**variable de build du Worker** `laydevant-app`, Settings → Build + `.env`) ; clé privée +
`VAPID_SUBJECT` + `PUSH_HOOK_SECRET` en **secrets Supabase** (Edge Function), jamais dans
le front/Git/chat.

---

## Ce qui existe et fonctionne

- **Bibliothèque de documents (entièrement sur R2)** : navigation département →
  spécialité → docs, recherche plein-texte FR, ouverture PDF, épinglage offline.
  ~1493 documents servis depuis R2. Deux modes d'affichage de spécialité.
- **Épinglage offline (sur R2)** : capture du blob via le bon backend, Cache API +
  métadonnées IndexedDB. Fonctionne en mode avion.
- **Recherche INTERNE — marque + modèle partout, à trois facettes** (champ,
  portée, préfixe). Recherche TEXTE = portée globale forcée ; parcours = scopé.
- **Recherche web de notices — Ensemble Search (3 moteurs + juge LLM +
  validation-avant-juge)** : architecture asynchrone à un seul webhook. Section dédiée.
- **Dossiers clients** : rattachement d'ÉQUIPEMENTS, remontée auto des notices via
  `products` (+ docs de marque via `brand`). Sections accordéon.
- **Notice terrain — deux chemins (direct vs demande)** : à la déclaration d'un
  équipement absent, si le monteur **joint la doc + choisit une spécialité**, l'ajout
  en base est **DIRECT** (produit créé + notice ingérée, sans admin) ; **sans doc**,
  c'est une **demande admin** (badge « en attente »), l'admin trouve la notice puis la
  **promeut**. Section dédiée.
- **Ajouter une notice hors dossier (catalogue)** : sous-menu de l'onglet Outils. Le
  monteur retrouve le même formulaire que « équipement absent » (marque, modèle,
  spécialité, type, PDF **obligatoire**) mais **sans rattachement à un dossier** : la
  notice entre dans `documents` via le produit et **remonte partout** où un dossier
  porte ce produit. Section dédiée.
- **Mes demandes (feedback + équipement) & flag « Outils »** : l'onglet Outils →
  « Mes demandes » regroupe deux canaux (retours d'amélioration/bug + suivi des
  demandes d'équipement/document), et l'entrée « Outils » porte un **flag de couleur**
  (orange « en cours » / vert « traitée ») qui s'efface à la consultation. Section dédiée.
- **Coffre de données sensibles** : chiffrement par dossier (zero-knowledge,
  WebCrypto). Notes ET **fichiers chiffrés**. **Récupération par ré-enrôlement**
  (le monteur repart d'une paire neuve en **libre-service**, un admin **répare
  l'accès**), deux admins-récupérateurs. Section dédiée.
- **Communication d'entreprise** : espace GLOBAL de diffusion de PDF par
  publisher/admin. Ouverture in-app (viewer partagé). **Notifications push** à chaque
  nouvelle communication (section dédiée).
- **Notifications push d'entreprise (Web Push, 5 briques — FONCTIONNE)** : la
  secrétaire poste une communication → une **notification** tombe sur les téléphones
  abonnés + une **pastille** sur l'icône, **sans aucune intervention**. Section dédiée.
- **Carnet public** (notes + photos par dossier) : en clair, RLS « tout authentifié
  lit/écrit ». Photos sur R2, compression client.
- **Annotation de photos du carnet — non destructive** : calque vectoriel
  rééditable, 4 outils, rendu partout, export image à la demande.
- **Galerie photo, Plans de dossier, Onboarding par liste blanche**.
- **Connexion / enregistrement — UX** : composant partagé **`PasswordInput`** (bouton
  afficher/masquer, bascule `type=password`/`text`) sur le mot de passe de `LoginScreen` et
  les deux champs (mot de passe + confirmation) d'`EnrollScreen` ; l'erreur Supabase
  générique `Invalid login credentials` est traduite en « **Mot de passe invalide.** » dans
  `auth.tsx`. **Vocabulaire affiché = « enregistrement »** (le code garde « enroll »).
- **Ingestion n8n (écrit dans R2)** : formulaire, webhook `ingest-from-url`, lot,
  **promotion de notice de staging** (`promote-equipment-notice`, section dédiée).
- **Backup quotidien** : export JSON n8n vers R2.
- **Soft delete (corbeille)** sur les tables enfant du dossier. **Exceptions** :
  `dossier_documents`, `vault_files`, `dossier_equipment_request_files` (hard delete
  assumé — staging).
- **Mini-jeu Tetris + classement + bruitages + mode duo en ligne** : sections dédiées.

---

## Notifications push d'entreprise (Web Push, 5 briques)

**Objectif** : signaler « nouvelle communication » sur le téléphone du monteur, même
appli fermée. Le besoin d'origine était la **pastille sur l'icône** ; la bannière est
un **bonus imposé par la plateforme** (voir contraintes). Décomposé et validé
brique par brique.

**Contraintes plateforme (structurantes, à connaître) :**
- **Une pastille silencieuse seule est impossible appli fermée** : le seul canal qui
  réveille une PWA fermée est **Web Push**, et `userVisibleOnly` (obligatoire sur
  Chrome/Android **et** iOS) **impose une notification visible**. On a donc toujours
  **bannière + pastille**, jamais pastille seule.
- **Pastille d'icône (`setAppBadge`) = bonus selon le launcher Android** : certains
  lanceurs n'affichent pas le badge d'une PWA installée. La bannière + la pastille
  orange in-app (brique 1) portent l'essentiel ; le badge d'icône est un plus.
- **iOS** : push seulement pour une PWA **installée à l'écran d'accueil** (iOS 16.4+).
  Le bouton d'activation le détecte (`isIosDevice()` + `display-mode: standalone`) et
  affiche sinon « ajoutez l'app à l'écran d'accueil ».
- **Les abonnements meurent** à chaque redéploiement du SW (révocation → `410`).
  D'où l'**auto-purge** côté Edge Function (voir brique 4).

**Brique 1 — pastille orange in-app (front only, pas d'infra).** Sur la tuile
« Communication d'entreprise » de l'accueil, une pastille orange si une communication
non lue existe. État = `localStorage['comm_last_seen_at']` (par appareil, assumé).
Au montage/retour accueil : compare le `created_at` de la dernière communication non
supprimée (SDK, `is('deleted_at', null)`) à `comm_last_seen_at`. Écriture de
`comm_last_seen_at` au montage de `CommunicationsScreen.tsx` (+ `clearAppBadge()`).

**Brique 2 — table `push_subscriptions` + RPC d'écriture.**
- Colonnes : `id`, `user_id` (FK auth.users), `endpoint` (**unique**, = jeton de
  capacité), `p256dh`, `auth`, `user_agent`, `created_at`, `updated_at`.
- **RLS activée, ZÉRO policy** (accès direct interdit) ; `REVOKE ALL ... FROM anon,
  authenticated`. Écriture **par RPC uniquement**, lecture **par Edge Function
  service_role** (contourne la RLS par design).
- RPC `upsert_push_subscription(endpoint,p256dh,auth,user_agent)` et
  `delete_push_subscription(endpoint)` — **SECURITY DEFINER**, bornées `auth.uid()`,
  `on conflict (endpoint)` pour gérer le **hand-off d'appareil** (un iPhone prêté).
- **Piège Supabase corrigé** : les default privileges accordent `EXECUTE` à `anon`
  malgré `revoke ... from public` → **`revoke execute ... from anon` explicite** en plus.

**Brique 3a — migration SW `generateSW → injectManifest`.** Précache **et** runtime
caching (dont la route musique CacheFirst) réécrits à la main dans `src/sw.ts`.
Validée par **test offline mode avion sur vrai téléphone** (app se lance, PDF servis,
recherche interne OK). *(A exhumé une dette préexistante sur la musique Tetris, voir
Dettes.)*

**Brique 3b — handlers push + bouton d'activation.**
- SW : handler `push` → `showNotification({title,body,tag:'comm'})` **+**
  `setAppBadge()` ; handler `notificationclick` → `focus`/`openWindow('/')`.
- Bouton « Activer les notifications » : garde iOS (installé + standalone),
  `Notification.requestPermission()` dans le **geste utilisateur** (requis iOS),
  `pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:
  urlBase64ToUint8Array(VITE_VAPID_PUBLIC_KEY) })`, puis RPC `upsert_push_subscription`.
  Bouton « Désactiver » → `unsubscribe()` + RPC `delete_push_subscription`.

**Brique 4 — Edge Function `send-push`.**
- Lit `push_subscriptions` en **service_role**, `setVapidDetails`, envoie à tous
  (`Promise.allSettled`).
- **Protégée par header `x-push-secret` = `PUSH_HOOK_SECRET`** (401 fail-closed si
  absent/faux, y compris si le secret n'est pas configuré).
- **Auto-purge** : tout endpoint répondant `404`/`410` est supprimé de la base.
- **Filtre de test** : champ optionnel `test_user_id` (uuid) → n'envoie qu'à cet
  utilisateur ; absent → envoi à **tous** (comportement prod). Réservé aux tests.
- **Double format d'entrée** : `{title,body}` (tests manuels) OU `{record}` (trigger).
  En format `record`, `body` = `record.titre` **nettoyé** (extension retirée, `_`/`-`
  → espaces, tronqué ~120, fallback « Une nouvelle communication est disponible »),
  `title` fixe « Nouvelle communication ». Ignore si `record.deleted_at` non null.
- Secrets Supabase : `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`,
  `PUSH_HOOK_SECRET`. Déployée en **`--no-verify-jwt`** (l'appelant est le trigger,
  pas un utilisateur ; la garde est le header).

**Brique 5 — déclencheur : trigger SQL maison (PAS le webhook natif).** Le Database
Webhook natif du dashboard est **indisponible sur ce projet** (`schema
"supabase_functions" does not exist`). Remplacé par notre propre mécanique, plus
maîtrisable et versionnable :
- **`create extension if not exists pg_net;`** (moteur des appels HTTP sortants).
- Schéma **`private`** + table **`private.config`** (`send_push_url`,
  `push_hook_secret`) — non exposée par PostgREST, le secret n'est jamais lisible côté
  client.
- Fonction **`notify_new_communication()`** (SECURITY DEFINER) : lit la config, garde
  soft-delete (`new.deleted_at is null`), appelle **`net.http_post`** vers `send-push`
  avec le header `x-push-secret` et un payload `{type,table,record:{titre,deleted_at}}`.
  Appel **asynchrone** → n'échoue jamais l'INSERT de la communication.
- Trigger **`trg_notify_new_communication` AFTER INSERT ON communications**.

**Test grandeur nature validé** : ajout d'une communication depuis l'appli →
notification (titre de fichier nettoyé) sur le téléphone, sans terminal.
**Garde-fou** : le trigger envoie à **tous** les abonnés (plus de `test_user_id`) —
vérifier `push_subscriptions` avant un test si des monteurs sont abonnés.

**Fichiers/objets clés** : `supabase/functions/send-push/index.ts`, `src/sw.ts`,
bouton d'activation (écran Communication / réglages), table `push_subscriptions`,
`private.config`, trigger `trg_notify_new_communication`. SQL archivé sous
`notifications_push_subscriptions.sql` (+ correctif anon) et
`notifications_push_trigger_communication.sql`.

---

## Recherche web — Ensemble Search (3 moteurs + juge + validation-avant-juge)

Le téléphone crée un job (`web_search_jobs`, `status='pending'`), le trigger
`notify_n8n_web_search` (SECURITY DEFINER, `AFTER INSERT`) appelle **UN seul**
webhook n8n (`notices-search`) via `net.http_post`, le workflow exécute tout le
pipeline et écrit le résultat FINAL sur le job, le téléphone poll `status_final` /
`final_results`. **Un seul workflow, un seul webhook, couche async fine.**

Pipeline (workflow n8n `notices-search`) :
1. **3 moteurs** (en séquence, dégradation gracieuse par Continue On Fail) :
   **Serper** (2 requêtes : normale + `filetype:pdf`, `gl:'ch'`/`hl:'fr'`),
   **Gemini Flash + Grounding** (`gemini-3.5-flash`, `google_search`,
   **`thinkingBudget:0`**, timeout 90 s, URL directes du texte + redirections
   vertexaisearch en filet), **Perplexity `sonar-pro`**.
2. **Collecte** : pool dédupliqué avec **accord inter-moteurs** (`engine_count`).
3. **Valider pool (AVANT le juge)** : validation HTTP **parallèle** (`Promise.all`
   dans un nœud Code) d'une shortlist (docs ≤15 + vidéos ≤3) — HEAD puis GET Range,
   suit les redirections, résout vertexaisearch ; `content_type` fait autorité sur
   `is_pdf`. Le juge reçoit des candidats **vérifiés + corroborés**.
4. **Juge** : **Claude Haiku 4.5** (`api.anthropic.com/v1/messages`, **Header Auth**),
   JSON strict, `cache_control`. Consignes : URL **verbatim** (interdit d'inventer),
   préférer corroboré (≥2 moteurs) + `link_ok:true`, priorité PDF fabricant >
   grossiste suisse (ottofischer/flextron/feller/sonepar/eldas, **sources
   légitimes**) > page officielle ; rejeter homonymes/revendeurs étrangers/forums ;
   langue FR sinon DE/EN complet. **Jusqu'à 5 documents pertinents** (jamais gonflés
   au hors-sujet) **+ 1 vidéo** d'installation en dernier si elle existe (Option A).
5. **Parser juge** → forme front `{type,title,url,is_pdf,source,confidence,link_ok,
   http_status,content_type}`, reporte les flags de validation ; **repli mécanique**
   si le juge échoue. **Ecrire journal** puis **Ecrire final**.

Modèle de données :
- **`web_search_jobs`** : `status_final` (`processing`/`done`), `final_results`
  (jsonb, déjà trié/dédupliqué par le juge), `done_at_final`. (Anciennes colonnes par
  moteur obsolètes, laissées le temps du nettoyage.)
- **`web_search_results`** (table enfant) : **journal d'observabilité**, une ligne par
  moteur par job + une ligne `juge`. **RLS activée, ZÉRO policy** (service-only) : le
  téléphone ne la lit jamais. Ajouter un moteur = une ligne, pas de migration.

Front : poll `status_final`/`final_results`, arrêt sur `'done'`, plus de fusion
client (le juge trie), plus de reveal 90 s ; `HARD_LIMIT_MS` ~300 s conservé en
filet. `link_ok:false` = **avertissement doux** (« lien non vérifié », pas « mort »).
Vidéos (`type:'video'`) affichées **en bas**, ouverture externe, **non capturables**.

---

## Notice terrain — deux chemins (direct vs demande)

Point d'entrée unique : la déclaration d'un **équipement absent** de la base depuis
la fiche dossier (`EquipmentRequestSheet.tsx`). À partir de là, **bifurcation selon
qu'une doc est jointe** — le seul apport que l'admin fournissait dans le flux demande
était la spécialité, donc dès que le monteur la donne, l'admin n'a plus de valeur.

**Chemin DIRECT (doc en main + spécialité) — pas d'admin, comme une capture web.**
Le monteur joint un PDF, choisit un **type de doc** et une **spécialité** (select porté
du côté admin, même référentiel `getLocalDepartments`/`getLocalSpecialties` en IndexedDB,
`optgroup` par département). Le PDF est uploadé en **staging** R2 (`equipment-requests/`),
puis :
1. **RPC `upsert_dossier_product(dossier_id, specialty_id, brand, model) → product_id`**
   (SECURITY DEFINER, gate = **authentifié**) : crée/réutilise le produit (anti-doublon
   `lower(brand)/lower(model)`) et le rattache au dossier (résurrection soft-delete).
   Elle contourne la RLS car **`products` est admin-only en écriture** — c'est
   exactement ce que fait n8n pour le flux web. L'équipement apparaît **tout de suite**
   (même contrat `onAdded → loadEquipments`, refetch complet).
2. **Edge Function `add-dossier-equipment-notice`** (gate = authentifié) : appelle la
   RPC (client scopé utilisateur), puis relaie le **workflow n8n de promotion** ; si un
   `request_id` est fourni (doc jointe à une demande déjà ouverte), **ferme la demande**
   (service_role : `status='approved'`, `resolved_product_id`). La notice remonte
   quelques secondes après, via `product_id`. **Aucune demande créée** dans le cas nominal.

**Chemin DEMANDE (pas de doc) — l'admin trouve l'introuvable, puis promeut.**
`dossier_equipment_requests` (badge « en attente »), résolue par
**`resolve_dossier_equipment_request(request_id, specialty_id, approve)`** (SECURITY
DEFINER, admin) : crée/réutilise le produit + le rattache + pose `resolved_product_id`.
Des **notices peuvent être jointes** à une demande (`dossier_equipment_request_files`,
staging R2, consultables tout de suite via `<PdfViewer>`). L'admin **promeut** une
notice jointe via **Edge Function `promote-equipment-notice`** (gate = **admin**),
qui relaie le même workflow n8n et écrit l'ancre d'idempotence `promoted_document_id`.

**Le workflow n8n de promotion est PARTAGÉ** (`promote-equipment-notice`, Header Auth) :
télécharge le PDF depuis R2 `equipment-requests/` → extrait le texte → **re-upload vers
`documents/`** → insert `documents` lié au `product_id`. (Le download est imposé par
l'extraction du texte ; une fois les octets en main, le re-upload clone le nœud d'upload
de `ingest-from-url` — pas de CopyObject séparé.) `documents.search_vector` étant
**générée** (`documents_tsv(title, tags, content)`), n8n n'insère que `content` — le
plein-texte se calcule seul. `documents` porte `brand` mais **pas** `model` (le modèle
vit sur `products`), et le lien de remontée est **`product_id`** (jamais un match texte).

Modèle de données :
- **`dossier_equipment_requests`** : la demande (marque, modèle, commentaire, status,
  `resolved_product_id`, `specialty_id`, `seen_by_requester_at`). RLS : SELECT `true`,
  INSERT `requested_by = auth.uid()` ; seul le RPC écrit le reste.
- **`dossier_equipment_request_files`** (enfant) : notices jointes en staging
  (`storage_provider 'r2'`, `storage_key`, `nom_fichier`, `mime`, `taille`,
  `doc_type_suggere`, `auteur`, `promoted_document_id`). RLS : SELECT `true`,
  INSERT `auteur = auth.uid()`, DELETE `auteur OR is_vault_admin()`. **Hard delete**.

Deux Edge Functions sœurs, deux gates distincts (pas de mode unique surchargé) :
`promote-equipment-notice` (admin) pour le chemin demande, `add-dossier-equipment-notice`
(authentifié) pour le direct. Toutes deux relaient le même webhook n8n via
`N8N_PROMOTE_URL`/`N8N_HEADER_AUTH_*`.

**Chemin CATALOGUE (hors dossier) — sous-menu « Ajouter une notice » de l'onglet Outils.**
Même formulaire que le direct, mais **aucun dossier** : le seul rôle du dossier dans le
direct était le rattachement `dossier_produits` ; tout le reste (staging
`equipment-requests/`, workflow n8n de promotion, insert `documents` lié par
`product_id`) est déjà dossier-agnostique. On retire donc juste le rattachement.
- **RPC `upsert_product_standalone(specialty_id, brand, model) → product_id`** (SECURITY
  DEFINER, gate authentifié) : clone `upsert_dossier_product` **sans** l'INSERT
  `dossier_produits`. `products` n'a pas de `deleted_at` → aucune résurrection à gérer,
  RPC plus simple. Anti-doublon `(specialty_id, lower(brand), lower(model))`.
- **Edge Function `add-catalog-notice`** (gate authentifié, sœur de
  `add-dossier-equipment-notice`) : appelle la RPC (client scopé user), relaie le **même**
  webhook n8n de promotion, **même payload**. Pas de `service_role`, pas de demande à
  fermer. **Fichier obligatoire** (le fallback « demande admin » n'a pas de sens hors dossier).
- Le PDF transite par le **même staging `equipment-requests/`** (contrainte de préfixe
  conservée = garde-fou contre un `storage_key` arbitraire). n8n et Worker **inchangés**.
La notice ajoutée remonte dans la recherche et dans tout dossier futur portant le produit.

---

## Mes demandes & flag « Outils » (feedback + équipement)

L'onglet Outils → **« Mes demandes »** regroupe **deux canaux distincts** derrière des
onglets qui agissent comme un **mode** (pas comme un simple filtre) :

- **Feedback** (table **`demandes`**) : formulaire d'envoi libre + fil « Mes demandes »,
  filtré par `type` (Proposition d'amélioration / Remonter un bug / Autre). Statut
  `nouvelle`/`en_cours`/`traitee`, réponse admin dans `reponse_admin`, `auteur = user`.
  Côté admin : « Remontées terrain » (prise en charge + réponse).
- **Demande d'équipement** (4ᵉ onglet) : **source différente** `dossier_equipment_requests`
  (**pas** un 4ᵉ `type` de `demandes`), en **lecture seule** — ces demandes naissent d'un
  dossier, pas de ce formulaire. Liste **mes** demandes tous dossiers confondus, statut
  `pending`/`approved`/`rejected`. En ce mode, le **formulaire d'envoi est masqué**.

**Le flag « Outils »** est un **état dérivé**, recalculé à l'affichage à partir de mes
demandes — **pas une notification stockée/routée**. Mapping :
- **Feedback** : une demande `traitee` non-vue → **vert** ; sinon `en_cours` non-vue →
  **orange** ; `nouvelle` ignorée (l'admin n'a rien produit).
- **Équipement** : une demande `approved`/`rejected` non-vue → **vert** ; `pending` ignorée.
- **Entrée « Outils »** : agrège les deux canaux, **vert > orange** (l'actionnable
  d'abord). Aucun élément non-vu → **pas de flag**, l'onglet redevient normal.

**Acquittement — par canal, à l'ouverture de la vue** (le flag « disparaît une fois la
réponse consultée ») :
- `acknowledge_my_feedback()` (SECURITY DEFINER) : pose `seen_by_requester_at = now()`
  sur **mes** demandes `en_cours`/`traitee`. **Ré-armable** : une transition ultérieure
  bumpe `updated_at` (trigger `trg_demande_updated`), et le flag se recalcule sur
  `seen_by_requester_at IS NULL OR seen_by_requester_at < updated_at` — un nouveau
  passage `en_cours → traitee` ré-allume donc le vert.
- `acknowledge_my_equipment_requests()` (SECURITY DEFINER) : pose `seen_by_requester_at`
  sur **mes** demandes résolues. **Terminal** (pas de ré-armement : `seen IS NULL`).

Les deux RPC sont `SECURITY DEFINER` bornées à l'auteur (`auteur`/`requested_by =
auth.uid()`) car l'**UPDATE de ces tables est admin-only en RLS** — le monteur ne pose
pas lui-même sa marque de « vu ». Colonne `seen_by_requester_at` (timestamptz, nullable)
ajoutée sur `demandes` **et** `dossier_equipment_requests`. Le hook front lit la **même
source** que les cartes « En cours »/« Traitée » déjà affichées : zéro divergence.

---

## Coffre — récupération par ré-enrôlement (libre-service)

Le contenu d'un coffre n'est **jamais chiffré pour le seul monteur** : chaque DEK est
aussi emballée vers les **deux admins-récupérateurs**. Un monteur qui perd son mot de
passe **et** sa clé de récupération ne perd donc que **son chemin d'accès** (sa clé
privée RSA), jamais le contenu.

**Un « reset de mot de passe » classique est impossible** — et c'est voulu : changer le
mot de passe d'une clé privée existante exige de la **déverrouiller** d'abord (mot de
passe OU clé de récup), ce que le monteur n'a plus. La primitive correcte est le
**ré-enrôlement** : repartir d'une **paire neuve** + un **nouveau mot de passe**
(l'ancienne paire est jetée, elle ne sert plus), puis un admin **répare l'accès** (geste
existant : ré-emballe les DEK vers la nouvelle clé publique).

Mécanisme (accessible en **libre-service** depuis l'écran de déverrouillage, lien
« Mot de passe et clé de récupération perdus ? ») :
- **RPC `reenroll_vault_user(...8 params crypto...)`** (SECURITY DEFINER) : **remplace
  la paire** dans `vault_user_keys` (sans toucher `access_enabled`, gelé par le trigger
  `vault_user_keys_guard` pour un non-admin) et **purge les lignes `vault_dossier_access`**
  du monteur (les DEK emballées vers l'ancienne clé, devenues illisibles). Elle **refuse
  un `is_recovery_admin`**. Réutilise 100 % de la crypto de l'enrôlement monteur
  (`createUserKeys`) ; persiste via la RPC, **jamais** via `submitVaultEnrollment`
  (INSERT → conflit PK).
- Le ré-enrôlé retombe alors dans l'état **« apprenti sans accès »** — un état que l'UI
  gère déjà. Puis « Réparer l'accès » (`upsertDossierAccessRow`, upsert PK
  `(dossier_id, user_id)`) ré-octroie sur la nouvelle clé. Les **FEK** des fichiers,
  emballées sous la DEK (pas sous la clé du monteur), redeviennent lisibles sans autre
  geste.

**Garde récupérateur à deux niveaux** : la RPC refuse un récupérateur (base) **et** le
lien est masqué pour lui côté UI (`vault?.is_recovery_admin`, comme `AccountsTab`). Un
récupérateur qui s'auto-ré-enrôlerait invaliderait sa clé papier et pourrait casser la
récupération globale ; sa voie reste le **break-glass mutuel**.

**Sonde d'existence — `dossier_has_vault(dossier_id) → boolean`** (SECURITY DEFINER) :
le pré-check d'ouverture (`VaultSheet`) distinguait mal « coffre absent » de « coffre
présent mais masqué faute d'accès » — les deux rendent `null` via la RLS SELECT de
`vault_secrets` (`has_dossier_vault_access(...)`). La sonde répond à l'**existence** sans
exiger l'accès (jamais un octet de contenu). Le pré-check est désormais à **4 étages** :
`hasVaultAccess` (global) → **`dossierHasVault`** (existence) → `getOwnDossierAccess`
(ma ligne) → `getVaultSecret` (déverrouillage). Un ré-enrôlé sans accès voit le message
actionnable « contacte un administrateur », plus jamais « coffre vide ».

---

## Coffre — fichiers chiffrés (modèle enveloppe FEK)

[inchangé — voir HANDOFF_coffre_fichiers_chiffres.md]
Chaque fichier a sa **FEK** (AES-256-GCM) ; octets chiffrés sur R2 sous
`vault/{dossierId}/{uuid}` ; nom+type chiffrés sous la FEK ; FEK emballée sous la DEK
du dossier (chiffrement des octets bruts, pas `wrapKey`). Rotation ne ré-emballe que
les FEK (jamais les octets R2), dans la transaction de `rotate_vault_secret`. Table
`vault_files`, **hard delete**. Harnais `vault.js` : 30/30. Ne jamais modifier
`vault.js` sans relancer le harnais.

---

## Ouverture des PDF — règle de plateforme

Sur iOS, `window.open` après un `await` est bloqué → viewer in-app `<PdfViewer>`. Sur
non-iOS → lecteur natif. Jamais de pré-ouverture synchrone
`window.open('','_blank','noopener')`. Polyfill pdf.js obligatoire (WebKit iOS).
**`pdfjs-dist` en 6.3.289** (bump de sécurité, GHSA-hq66-cqwq-w95j — exécution JS à
l'ouverture d'un PDF malveillant, vecteur réaliste = notice tierce téléchargée par la
recherche web ; même majeure que 6.1, API stable).

**Garde-fou « plan trop détaillé »** (iOS, `pdfImageMegapixels`, seuil 30 Mpx, dans
`src/lib/pdfMeasure.ts`) : au-delà du seuil, le plan n'est **PAS** monté dans `<PdfViewer>`
(risque de crash canvas WebKit) — `PlanTooDetailedCard` s'affiche à la place (bouton de
partage, pas d'aperçu). Le garde-fou protège du **crash**, pas du **flou**.

**Plans/schémas grand format sur iOS — porte de sortie native (FONCTIONNE).** Un rendu
pdf.js sur un **seul canvas** ne peut pas afficher un très grand plan à la fois net ET sans
crasher iOS. Sous le seuil de 30 Mpx, `<PdfViewer>` rend **une fois à échelle fixe** (sans
`devicePixelRatio`) puis laisse le CSS zoomer → aperçu **flou**, pire au zoom. La correction
n'est pas de rendre l'aperçu in-app plus net, mais de **passer le plan au visionneur natif
iOS** (Fichiers / Aperçu), qui rend **tuilé à la demande**, net à tout niveau de zoom.
L'overlay plein écran des plans (`PlansSection.tsx`) expose donc sur iOS **deux boutons** :
**« Ouvrir »** (ouvre le PDF directement dans le visionneur natif) et **« Partager »**
(feuille de partage → Fichiers/Livres/Aperçu). Les deux réutilisent le **blob déjà en
mémoire** — **aucun `await` avant** `window.open`/`navigator.share`, sinon le geste
utilisateur est cassé sur Safari (exactement pourquoi la bibliothèque restait nette : elle
échappait déjà en synchrone vers le natif). Le flou de l'aperçu in-app est **assumé** : sur
du très grand format, la sortie native EST la réponse, pas un pis-aller. *(Le chemin > 30 Mpx
via `PlanTooDetailedCard.handleShare` reste inchangé et testé ; le nouveau handler de
l'overlay est autonome, pas une extraction du chemin testé.)*

---

## Écran dossier, Communication, Suppression de dossier, Mini-jeu

[inchangés — voir ETAT précédent et HANDOFF dédiés] Sections accordéon (ordre
Équipements → Documentation → Plans → Carnet → Données sensibles, `keepMounted` sur
le coffre). Communication d'entreprise (R2, soft-delete, RPC
`soft_delete_communication`) — désormais **déclencheur des notifications push**
(trigger `notify_new_communication`). Suppression de dossier en deux chemins
(`delete_dossier_if_empty` / `destroy_dossier_vault`). Tetris solo + classement +
bruitages + **mode duo en ligne** (table `duo_matches` + 5 RPC, compteur d'attaques
cumulatif, seed partagé).

---

## Conventions vivantes (à respecter à chaque fois)

- **Notice terrain — bifurcation** : **doc jointe + spécialité → ajout DIRECT**
  (RPC `upsert_dossier_product` + Edge Function `add-dossier-equipment-notice`, gate
  authentifié) ; **sans doc → demande admin**. La spécialité devient **obligatoire dès
  qu'une doc est jointe** (le seul apport de l'admin dans ce cas).
- **`products` est admin-only en écriture (RLS)** : un monteur crée un produit
  UNIQUEMENT via RPC SECURITY DEFINER (`upsert_dossier_product` / `upsert_product_standalone`),
  jamais en direct. `dossier_produits` est en revanche `ALL using(true)` (tout authentifié
  rattache).
- **Bibliothèque — la notice remonte via `product_id`** (`dossier_documents_complets`,
  chemin `equipement`), jamais par un match texte marque/modèle. `documents` porte
  `brand` mais **pas** `model`. `documents.search_vector` est **générée**
  (`documents_tsv(title, tags, content)`) → n'insérer que `content`/`title`/`tags`.
- **Promotion de notice — le workflow n8n est partagé** (staging `equipment-requests/`
  → extract → `documents/` → insert). Download imposé par l'extraction ; pas de
  CopyObject. `promoted_document_id` = ancre d'idempotence (2e promotion refusée 409).
- **Flag « Outils » = état dérivé, pas une notif** : recalculé à l'affichage depuis mes
  demandes (feedback `demandes` + équipement `dossier_equipment_requests`). Acquittement
  **par canal**, à l'ouverture de la vue, via RPC SECURITY DEFINER (`acknowledge_my_feedback`
  / `acknowledge_my_equipment_requests`, bornées à l'auteur — UPDATE admin-only en RLS).
  Feedback **ré-armable** via `updated_at` (`seen < updated_at`) ; équipement **terminal**
  (`seen IS NULL`). Agrégation **vert (réponse) > orange (en cours)** ; `nouvelle`/`pending`
  ignorés.
- **4ᵉ onglet « Demande d'équipement » = source distincte, pas un `type` de `demandes`** :
  mode lecture seule sur `dossier_equipment_requests` (les demandes naissent d'un dossier),
  formulaire d'envoi masqué en ce mode.
- **Coffre — pas de reset de mot de passe** (zero-knowledge) : la récupération, c'est le
  **ré-enrôlement** (`reenroll_vault_user`, paire neuve + purge accès), suivi de
  « Réparer l'accès ». Ne jamais persister un ré-enrôlement via `submitVaultEnrollment`
  (INSERT → conflit PK). Un **récupérateur est exclu** du libre-service (RPC + UI).
- **Coffre — `dossier_has_vault` distingue « absent » de « masqué »** : pré-check
  d'ouverture à 4 étages, sinon un ré-enrôlé sans accès voit à tort « coffre vide ».
- **Notifications push — `userVisibleOnly` impose une bannière** (Android + iOS) : pas
  de pastille silencieuse appli fermée. Le **badge d'icône** (`setAppBadge`) dépend du
  **launcher** (bonus). iOS = PWA **installée** requise. Les abonnements **meurent au
  redéploiement SW** (`410`) → `send-push` **auto-purge** ; toute RPC/fonction push
  reste **RPC-only + service_role**, jamais d'accès client direct à `push_subscriptions`.
- **RPC `authenticated`-only sous Supabase** : `revoke ... from public` **ne suffit
  pas** — les default privileges accordent `EXECUTE` à `anon`. Toujours ajouter
  **`revoke execute ... from anon` explicite**.
- **Database Webhook natif indisponible sur ce projet** (`schema supabase_functions`
  absent) : pour déclencher une Edge Function sur un INSERT, utiliser un **trigger SQL +
  `pg_net`** (`net.http_post`, appel **async**), avec URL + secret rangés dans
  **`private.config`** (jamais en dur, jamais exposé PostgREST).
- **Un seul Codespace actif** : Claude Code dans un terminal, **tes manips (git, SQL,
  `supabase deploy`) dans un SECOND terminal du MÊME Codespace** — jamais deux
  Codespaces (désync `git pull`, fonction « introuvable » car non déployée là où tu es).
- **Recherche web — validation AVANT le juge** : le juge choisit parmi des URL
  **vérifiées** (`link_ok`/`content_type`) et **corroborées** (`engine_count`) ; il
  n'invente/ne modifie JAMAIS une URL ; `content_type` fait autorité sur `is_pdf`.
  Les vidéos doivent être **incluses explicitement** dans la shortlist.
- **Recherche web — grossistes suisses légitimes** (ottofischer/flextron/feller/
  sonepar/eldas), pas des revendeurs à exclure. `link_ok:false` = avertissement doux.
- **n8n — credential recréé = re-sélectionner sur chaque nœud** (piège de l'id
  fantôme, silencieux jusqu'à l'exécution). Diagnostiquer par le vrai `error.message`
  du nœud, pas par le bandeau « Couldn't connect » du credential (faux positif).
- **n8n — nœud Anthropic en Header Auth** (`x-api-key` + `anthropic-version` +
  `content-type`), pas le credential natif `anthropicApi`.
- **n8n — S3 sur R2** : upload OK ; **listing** exige région `auto` (sinon 0 objet
  silencieux) ; download par clé connue fiable, sinon repli `@aws-sdk/client-s3`
  GetObject. Nettoyer un `undefined` dans un array de `queryReplacement` (`$N` désaligné) ;
  filtrer l'octet NUL `\u0000` avant Postgres (08P01).
- **n8n — nœud Code sandbox** : `URL` **non exposé** (extraire le domaine par regex) ;
  `this.helpers.httpRequest` disponible ; `Prefer: return=minimal` → 204 → « no items on
  branch » = **succès**.
- **Gemini** : `thinkingBudget:0` obligatoire (sinon réponse sans `candidates`) ;
  URL de grounding = redirections `vertexaisearch` à résoudre.
- **Ouverture PDF = règle de plateforme** ; **pdf.js** = polyfill au démarrage.
- **Plans grand format sur iOS = sortie native** (« Ouvrir » / « Partager » depuis
  l'overlay `PlansSection`, sur le **blob déjà en mémoire**, **aucun `await` avant**
  `window.open`/`navigator.share` — sinon le geste utilisateur est cassé sur Safari). Le
  flou de l'aperçu in-app est **assumé** ; on ne re-render pas dans l'app.
- **Tout `VITE_*` est PUBLIC** (inliné dans le bundle livré) : n'y mettre QUE des valeurs
  publiques (URL Supabase, clé publishable, VAPID publique). `VITE_N8N_INGEST_SECRET` viole
  cette règle (dette). Un vrai secret ne transite JAMAIS par le front.
- **Preview de branche Cloudflare Workers = inutilisable ici** : les builds de branches
  **hors-production ne reçoivent PAS les `VITE_*`** de build (limitation produit, pas un bug
  de config) → l'app crashe `Missing VITE_SUPABASE_URL`. Pour tester une branche :
  **atelier local** (`.env.local` de `VITE_*` publiques + `npm run preview -- --host`, port
  forwardé) OU **merge-et-test-prod avec `git revert` prêt** (retenu pour les changements à
  faible risque, ex. bump de dépendance : pdf.js lazy-loaded, revert = un commit).
- **Vocabulaire affiché = « enregistrement », code = « enroll »** : les libellés UI disent
  « (ré-)enregistrement » (`EnrollScreen`, `VaultEnrollScreen`, `VaultAdminScreen`,
  `ToolsScreen`, `onboarding.ts`, **message de l'Edge Function `enroll`**) ; les
  **identifiants de code restent inchangés** (`EnrollScreen.tsx`, `vaultEnroll.ts`,
  `enroll()`, RPC `reenroll_vault_user`, `submitVaultEnrollment`, préfixe R2, etc.). Ne PAS
  renommer le code pour « suivre » le libellé (refactor large hors périmètre).
- **Erreur de connexion** : `auth.tsx` traduit le message Supabase générique
  `Invalid login credentials` (renvoyé indifféremment pour email OU mot de passe erroné) en
  « Mot de passe invalide. » ; les autres erreurs Supabase (compte désactivé, trop de
  tentatives…) restent affichées **telles quelles**, jamais masquées sous ce message.
- **`PasswordInput` = composant partagé** (afficher/masquer) : réutiliser sur tout champ mot
  de passe (LoginScreen, EnrollScreen) plutôt qu'un `<input type=password>` nu.
- **Lint = 0 erreur** : `npm run lint` doit rester propre. 1 warning
  `react-refresh/only-export-components` sur `AnnotationOverlay.tsx` **assumé** (Fast Refresh
  dev only). Ne pas lancer `--fix` en aveugle ; une règle hooks (`set-state-in-effect`,
  `exhaustive-deps`) se corrige **après inspection**, jamais par réflexe.
- **Coffre — enveloppe FEK** ; ne jamais modifier `vault.js` sans le harnais (30/30).
- **Bibliothèque PDF sur R2** : `file_path` = clé NUE ; clé R2 = `'documents/' +
  file_path` ; toujours un Blob des deux côtés.
- **Calque d'annotation photo** : `dossier_photos.annotations` = source unique ;
  original R2 jamais touché ; export à la demande, jamais stocké.
- **Worker `/api/photos`** : POST validé par `GENERIC_PREFIX_RE`/`GLOBAL_PREFIXES`
  (dont **`equipment-requests/`**) ; GET préfixe-agnostique ; DELETE différencié
  (`vault/` → accès dossier OU admin ; `equipment-requests/` et autres → admin-only).
- **SOFT-DELETE + policy SELECT `deleted_at IS NULL` = piège 42501** → RPC SECURITY
  DEFINER. `fetch` manuel vers PostgREST à éviter (apikey en header refusée).
- **Vue avec nouvelle colonne = DROP + CREATE** (+ `security_invoker`, + grant).
- **Signature de fonction = nom + types d'args** : étendre = drop+create+re-grant.
- **Déplacer un produit de spécialité = DEUX updates** ; « Autres » = `sort_order 999`
  (nouvel insert exclut le 999) ; nouvelle spécialité = penser au dropdown n8n.
- **Credential R2 S3** : endpoint sans bucket, `Force Path Style: ON`, région `auto`.
- **`auth.uid()` NULL dans le SQL Editor** ; simuler via `set_config('request.jwt.
  claims', …, true)` dans un même run (utile pour tester une RPC SECURITY DEFINER
  en `begin; … rollback;`). Une RPC qui **écrit** (ex. `acknowledge_my_*`,
  `reenroll_vault_user`, `upsert_push_subscription`) ne se lance PAS à blanc dans
  l'éditeur — c'est l'app qui l'appelle ; on ne teste que sa **création** (harnais).
- **Edge Function : le push ne déploie PAS** → `npx supabase functions deploy` (et
  `--no-verify-jwt` si l'appelant n'est pas un utilisateur authentifié — ex. `send-push`).
- **Après un push, fermer/rouvrir la PWA** (cache SW) ; changement SW → rouvrir EN
  LIGNE 1-2×.
- **Secrets** : Publishable/anon OK en clair ; Secret/tokens/VAPID privée jamais dans
  code/Git/chat.
- **Le travail n'existe que poussé/publié** : commit + push depuis le terminal ; voir
  le diff avant commit ; **publier** les workflows n8n après édition.

---

## Dettes ouvertes

- **Musique Tetris hors-ligne (confort de jeu, non bloquant)** : `/tetris_audio.mp3`
  (~6,9 Mo, same-origin, joué via `new Audio()` → **requêtes Range 206**) ne se sert en
  avion QUE tant que la page n'est pas rechargée (buffer RAM). Route CacheFirst
  `tetris-music` dans `src/sw.ts`, fichier **exclu du précache** (trop gros). Correctif
  tenté (`CacheableResponsePlugin [0,200,206]` + `RangeRequestsPlugin`) **insuffisant** :
  RangeRequests sait DÉCOUPER une entrée complète, pas en FABRIQUER une ; or rien ne
  dépose jamais le fichier ENTIER (que du 206). **Défaut préexistant** à la migration
  injectManifest (déjà absent en generateSW, commit `07fe286`), pas une régression.
  **Correctif prévu (brique isolée)** : amorcer un `fetch('/tetris_audio.mp3')` **sans
  Range** (→ 200 complet) via `primeMusicAudio()` pour déposer l'entrée pleine ; les
  Range se serviront ensuite depuis elle. Alternative écartée : précacher (impose 6,9 Mo
  à tous, y compris non-joueurs).
- **`npm audit` — 7 vulns résiduelles, toutes build/CLI (non corrigées volontairement)** :
  `postcss` (moderate) + `undici`→`miniflare`→`wrangler` (high). Aucune n'atteint le bundle
  livré (front statique, pas de process Node exposé côté utilisateur) → correctif sans
  bénéfice runtime, et bumper `wrangler`/PostCSS casserait la toolchain. **Ne PAS
  `npm audit fix --force`.** La seule vuln **runtime** (`pdfjs-dist`) a été corrigée (bump
  6.3.289). Test décisif : `npm audit --omit=dev` doit rester à **0**.
- **Secret d'ingestion n8n exposé dans le bundle** : `VITE_N8N_INGEST_SECRET` est préfixé
  `VITE_` → **inliné en clair** dans le JS livré (tout `VITE_*` l'est). Le webhook
  d'ingestion n8n n'est donc **pas réellement protégé** par ce secret (lisible dans les
  DevTools de n'importe quel utilisateur). À reprendre à froid : protéger le webhook
  autrement (côté n8n), sans secret transitant par le front.
- **Aperçu in-app des plans grand format sur iOS = flou (assumé, non bloquant)** : la sortie
  native (« Ouvrir » / « Partager » de l'overlay `PlansSection`) est la réponse retenue. Le
  net **sans quitter l'app** exigerait un re-rendu pdf.js au zoom (`devicePixelRatio` +
  `page.render()` au niveau demandé) dans `<PdfViewer>` — composant partagé par 5 écrans,
  surface de test large. À décider à froid seulement si le besoin apparaît.
- **Clic notification → écran Communication (hors périmètre voulu)** : le clic rouvre
  l'appli sur l'**accueil** (`focus`/`openWindow('/')`), pas sur Communication.
  NON VOULU au départ (objectif = pastille ; bannière = bonus). App **sans router**
  (navigation état React), donc pas de deep-link direct. Solution si un jour souhaité :
  `focus` + `postMessage({type:'navigate',screen:'communications'})` (appli ouverte) +
  `openWindow('/?screen=communications')` lu au boot (cold-start). Diagnostic fait.
- **Nettoyage staging `equipment-requests/`** : après copie vers `documents/`, l'objet
  de staging reste orphelin. Le cleanup DOIT se faire côté **n8n** (DeleteObject R2
  best-effort en fin du workflow de promotion) — l'Edge Function ne peut pas (DELETE
  `equipment-requests/` est admin-only côté Worker). Brique dédiée à faire ; négligeable
  en attendant (R2 10 Go, PDF de notice).
- **Convergence `resolve_dossier_equipment_request` ↔ `upsert_dossier_product`** : la
  résolution admin contient une copie inline des étapes produit (créer/réutiliser +
  rattacher). Refactorer `resolve` pour appeler la RPC, dans une brique isolée avec son
  test (ne pas mêler risque-sur-du-testé et feature).
- **Recherche web — contexte du job souvent vide** (`equipment_type`/`department`/
  `specialty`) : signal le plus fort du juge contre les homonymes. **Meilleur levier
  qualité restant.**
- **Recherche web — badge « Vidéo » côté front** : à confirmer déployé.
- **Recherche web — nettoyage** : supprimer les colonnes par moteur obsolètes de
  `web_search_jobs`, débrancher l'ancienne Edge Function `web-search-notices`,
  supprimer les anciens workflows Anthropic/Perplexity et la clé
  `private_config.n8n_webhook_url_pplx` orpheline.
- **Canal email (Brevo)** : non câblé. Débloque notif demandes de suppression +
  d'équipement, confirmation onboarding, alerte suppression en masse.
- **Alerte suppression en masse** : seuil défini (10/10 min/user), dépend de Brevo.
- **`dossier_documents` sans soft-delete** : seule table enfant (hors coffre/staging)
  sans `deleted_at`.
- **Backup — ajouter les tables récentes** : `web_search_jobs`, **`web_search_results`**,
  `game_scores`, `duo_matches`, `galerie_items`, `galerie_photos`, `dossier_plans`,
  `dossier_deletion_requests`, `dossier_equipment_requests`,
  **`dossier_equipment_request_files`**, **`demandes`**, `communications`, `vault_files` ;
  activer Schedule + purge. **EXCLURE `push_subscriptions`** (jetons éphémères régénérés
  par le client — comme `documents.content`) ; **`private.config`** contient un secret
  (à traiter avec précaution si un jour inclus).
- **Cache offline — Galerie, Plans, fichiers du coffre, annotation photo** : online-only.
- **Communication d'entreprise — aperçu offline** : online-only (placeholder).
- **Garde-fou « PDF trop détaillé » sur les fichiers du coffre** : non appliqué.
- **Granularité produits — Bticino, Comelit, Swisscom, Burri** : pas éclatées.
- **Compteur de documents plafonné à 1000 pour Portes automatiques**.
- **`gol-1-media.bmp`** reste en BMP (non bloquant).
- **`formatDate` dupliqué** (~4-5 copies) ; **`planLabel` bugué** (coupe au 1er tiret) ;
  **chevrons `goHome` vs `goBack`** à normaliser.
- **Patron de partage `navigator.share` + repli `<a download>` dupliqué ~4×**
  (`PlanTooDetailedCard.handleShare`, overlay plans « Ouvrir »/« Partager »,
  `VaultSheet.handleShareFile`, `CarnetSection.handleExportPhoto`) — extraire en helper
  partagé dans une **brique isolée** (ne pas mêler à une feature ; le chemin testé reste
  intact tant qu'on ne l'a pas fait).
- **Lint — propre (1 warning assumé)** : `npm run lint` = **0 erreur**. Reste **1 warning**
  `react-refresh/only-export-components` sur `AnnotationOverlay.tsx` (Fast Refresh dev
  uniquement, zéro impact prod) — **assumé**, non corrigé (le fix déplacerait une constante
  hors d'un fichier qui marche).
- **Comptes de test à supprimer** avant exploitation. **pg_cron** installé mais inutilisé.

---

## Prochain chantier

1. **Notifications push — finitions optionnelles** : (a) confirmer la **pastille
   d'icône** sur un vrai Android du parc (dépend du launcher) ; (b) si voulu, le **clic
   → écran Communication** (postMessage + query param, cf. dette) ; (c) éventuel
   **compteur** de non-lus (brique 5 initiale) plutôt qu'une pastille simple.
2. **Musique Tetris offline** : `primeMusicAudio()` (fetch sans Range → entrée pleine
   en cache), brique isolée testée en avion.
3. **Nettoyage staging + convergence `resolve`** : DeleteObject n8n best-effort dans le
   workflow de promotion, puis refactor de `resolve_dossier_equipment_request` sur
   `upsert_dossier_product` (brique isolée, testée).
4. **Recherche web — remplir le contexte du job** (equipment_type…) côté front, puis
   **nettoyer** l'ancien chemin (colonnes, Edge Function, workflows, clé orpheline).
5. **Canal email (Brevo)** : débloque demandes de suppression/équipement, confirmation
   onboarding, alerte suppression en masse. Le blocage le plus rentable à lever.
6. **Cache offline** — Galerie, Plans, fichiers du coffre, annotation photo.
7. **Protection des données** : Schedule backup + purge, avec toutes les tables
   récentes (`web_search_results`, `vault_files`, `dossier_equipment_request_files`,
   `demandes`, `communications`, `duo_matches` inclus), **`push_subscriptions` exclue**.
8. **Nettoyage granularité produits** (Bticino, Comelit, Swisscom, Burri).

---

## Où trouver le détail

- **Le pourquoi des décisions** : les HANDOFF datés (archive). Les plus récents :
  - **`HANDOFF_notice_terrain_demande_vs_direct.md`** (notice terrain : staging R2,
    promotion admin, puis bascule vers le direct — le pourquoi de « doc en main →
    pas d'admin », `products` admin-only → RPC, workflow n8n partagé, `search_vector`
    générée, `documents` sans `model`).
  - **`HANDOFF_coffre_reenrolement_recuperation.md`** (coffre : reset impossible →
    ré-enrôlement, purge = état apprenti, garde récupérateur à deux niveaux, sonde
    `dossier_has_vault` et pré-check à 4 étages).
  - **`HANDOFF_recherche_web_ensemble_juge.md`** (Ensemble Search : 3 moteurs + juge +
    validation-avant-juge, et le bêtisier).
- **Les notifications push** : tout est dans la section « Notifications push
  d'entreprise » ci-dessus (5 briques, contraintes plateforme, trigger SQL maison en
  remplacement du webhook natif). SQL archivé : `notifications_push_subscriptions.sql`
  (+ correctif anon), `notifications_push_trigger_communication.sql`. Pas de HANDOFF
  dédié — la section de cet ETAT fait foi.
- **Le flag « Outils » + le canal équipement de « Mes demandes »** : briques légères
  (colonnes `seen_by_requester_at` + RPC `acknowledge_my_*`, flag dérivé, 4ᵉ onglet) —
  pas de HANDOFF dédié, tout est dans la section « Mes demandes & flag Outils » ci-dessus.
- **La spec technique + règles Claude Code** : `CLAUDE.md` à la racine du repo.
- **Le comment exact d'un workflow n8n** : le workflow lui-même dans n8n.
