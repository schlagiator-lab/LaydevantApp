# Laydevant — État du projet
## Point d'entrée : la photo du présent (pas l'historique)

Ce fichier décrit le projet **tel qu'il est maintenant**. Il est **réécrit** à
chaque avancée (pas complété) : une dette réglée en disparaît, une feature finie
passe en « fonctionne ». Pour le POURQUOI d'une décision, voir les HANDOFF datés
(l'archive). Pour la spec technique de Claude Code, voir `CLAUDE.md` (le repo).

À jour au 26 août 2026.

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
- **Bifurcation plateforme** : `isIosDevice()` (helper, dans `src/lib/pdfMeasure.ts`).
- **Backend** : Supabase (Postgres, Auth, RLS, Edge Functions). Storage Supabase
  n'héberge plus de PDF. Project ref `iixqfajflyxrnizlqdsn`.
- **Fichiers (documents, photos, galerie, plans, communications, coffre)** :
  Cloudflare R2, bucket `laydevant-photos`, via binding natif Worker (`/api/photos`).
- **Bibliothèque PDF sur R2** : `documents.storage_provider` (tous en `'r2'`) et
  `documents.file_path` (clé NUE). **Clé R2 = `documents/` + file_path**.
- **Ouverture des PDF (pdf.js)** : `<PdfViewer>` in-app partagé. Polyfill
  `Map`/`WeakMap` `getOrInsert`/`getOrInsertComputed` obligatoire au démarrage.
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
  publisher/admin. Ouverture in-app (viewer partagé).
- **Carnet public** (notes + photos par dossier) : en clair, RLS « tout authentifié
  lit/écrit ». Photos sur R2, compression client.
- **Annotation de photos du carnet — non destructive** : calque vectoriel
  rééditable, 4 outils, rendu partout, export image à la demande.
- **Galerie photo, Plans de dossier, Onboarding par liste blanche**.
- **Ingestion n8n (écrit dans R2)** : formulaire, webhook `ingest-from-url`, lot,
  **promotion de notice de staging** (`promote-equipment-notice`, section dédiée).
- **Backup quotidien** : export JSON n8n vers R2.
- **Soft delete (corbeille)** sur les tables enfant du dossier. **Exceptions** :
  `dossier_documents`, `vault_files`, `dossier_equipment_request_files` (hard delete
  assumé — staging).
- **Mini-jeu Tetris + classement + bruitages + mode duo en ligne** : sections dédiées.

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

[inchangé] Sur iOS, `window.open` après un `await` est bloqué → viewer in-app
`<PdfViewer>`. Sur non-iOS → lecteur natif. Jamais de pré-ouverture synchrone
`window.open('','_blank','noopener')`. Polyfill pdf.js obligatoire (WebKit iOS).
Garde-fou « plan trop détaillé » (iOS, `pdfImageMegapixels`, seuil 30 Mpx).

---

## Écran dossier, Communication, Suppression de dossier, Mini-jeu

[inchangés — voir ETAT précédent et HANDOFF dédiés] Sections accordéon (ordre
Équipements → Documentation → Plans → Carnet → Données sensibles, `keepMounted` sur
le coffre). Communication d'entreprise (R2, soft-delete, RPC
`soft_delete_communication`). Suppression de dossier en deux chemins
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
  `reenroll_vault_user`) ne se lance PAS à blanc dans l'éditeur — c'est l'app qui
  l'appelle ; on ne teste que sa **création** (harnais) et son comportement via l'app.
- **Edge Function : le push ne déploie PAS** → `npx supabase functions deploy`.
- **Après un push, fermer/rouvrir la PWA** (cache SW) ; changement SW → rouvrir EN
  LIGNE 1-2×.
- **Secrets** : Publishable/anon OK en clair ; Secret/tokens jamais dans code/Git/chat.
- **Le travail n'existe que poussé/publié** : commit + push depuis le terminal ; voir
  le diff avant commit ; **publier** les workflows n8n après édition.

---

## Dettes ouvertes

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
  activer Schedule + purge.
- **Cache offline — Galerie, Plans, fichiers du coffre, annotation photo** : online-only.
- **Communication d'entreprise — aperçu offline** : online-only (placeholder).
- **Garde-fou « PDF trop détaillé » sur les fichiers du coffre** : non appliqué.
- **Granularité produits — Bticino, Comelit, Swisscom, Burri** : pas éclatées.
- **Compteur de documents plafonné à 1000 pour Portes automatiques**.
- **`gol-1-media.bmp`** reste en BMP (non bloquant).
- **`formatDate` dupliqué** (~4-5 copies) ; **`planLabel` bugué** (coupe au 1er tiret) ;
  **chevrons `goHome` vs `goBack`** à normaliser.
- **Comptes de test à supprimer** avant exploitation. **pg_cron** installé mais inutilisé.

---

## Prochain chantier

1. **Nettoyage staging + convergence `resolve`** : DeleteObject n8n best-effort dans le
   workflow de promotion, puis refactor de `resolve_dossier_equipment_request` sur
   `upsert_dossier_product` (brique isolée, testée).
2. **Recherche web — remplir le contexte du job** (equipment_type…) côté front, puis
   **nettoyer** l'ancien chemin (colonnes, Edge Function, workflows, clé orpheline).
3. **Canal email (Brevo)** : débloque demandes de suppression/équipement, confirmation
   onboarding, alerte suppression en masse. Le blocage le plus rentable à lever.
4. **Cache offline** — Galerie, Plans, fichiers du coffre, annotation photo.
5. **Protection des données** : Schedule backup + purge, avec toutes les tables
   récentes (`web_search_results`, `vault_files`, `dossier_equipment_request_files`,
   `demandes`, `duo_matches` inclus).
6. **Nettoyage granularité produits** (Bticino, Comelit, Swisscom, Burri).

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
- **Le flag « Outils » + le canal équipement de « Mes demandes »** : briques légères
  (colonnes `seen_by_requester_at` + RPC `acknowledge_my_*`, flag dérivé, 4ᵉ onglet) —
  pas de HANDOFF dédié, tout est dans la section « Mes demandes & flag Outils » ci-dessus.
- **La spec technique + règles Claude Code** : `CLAUDE.md` à la racine du repo.
- **Le comment exact d'un workflow n8n** : le workflow lui-même dans n8n.
