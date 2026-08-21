# Laydevant — État du projet
## Point d'entrée : la photo du présent (pas l'historique)

Ce fichier décrit le projet **tel qu'il est maintenant**. Il est **réécrit** à
chaque avancée (pas complété) : une dette réglée en disparaît, une feature finie
passe en « fonctionne ». Pour le POURQUOI d'une décision, voir les HANDOFF datés
(l'archive). Pour la spec technique de Claude Code, voir `CLAUDE.md` (le repo).

À jour au 22 août 2026.

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
(`sb_secret_`) côté `enroll` et n8n. Credential R2 S3 (endpoint sans nom de bucket,
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
- **Équipement manuel → demande admin** : déclaration d'un équipement absent, badge
  « en attente », résolution admin (`resolve_dossier_equipment_request`).
- **Coffre de données sensibles** : chiffrement par dossier (zero-knowledge,
  WebCrypto). Notes ET **fichiers chiffrés**. Récupération par ré-enrôlement, deux
  admins-récupérateurs.
- **Communication d'entreprise** : espace GLOBAL de diffusion de PDF par
  publisher/admin. Ouverture in-app (viewer partagé).
- **Carnet public** (notes + photos par dossier) : en clair, RLS « tout authentifié
  lit/écrit ». Photos sur R2, compression client.
- **Annotation de photos du carnet — non destructive** : calque vectoriel
  rééditable, 4 outils, rendu partout, export image à la demande.
- **Galerie photo, Plans de dossier, Onboarding par liste blanche**.
- **Pas de canal email (décision prise)** : onboarding géré au cas par cas (petit
  groupe, pas de round-trip email) ; alerte de suppression en masse gérée IN-APP
  (redflag + annonces dans le coffre admin), pas de dépendance à un fournisseur
  externe type Brevo.
- **Ingestion n8n (écrit dans R2)** : formulaire, webhook `ingest-from-url`, lot.
- **Backup quotidien AUTO-RECENSANT vers R2** : le workflow n8n interroge
  lui-même `pg_tables` au moment de tourner, toute nouvelle table est
  sauvegardée par défaut, il n'y a plus de liste blanche à maintenir.
  Exclusions : `private_config` (config reconstructible, évite le
  secret-au-repos) et les colonnes GÉNÉRÉES (`documents.search_vector`, qui
  se recalcule à l'import). Une table = un fichier JSON sous `daily/AAAA-MM-JJ/`,
  plus un `_manifest.json` listant les tables et leur nombre de lignes (preuve
  de complétude — on ne valide jamais sur un nœud vert). Rétention 30 jours
  par règle de cycle de vie R2, pas par purge codée. Run de référence :
  29 tables, 30 objets.
- **Schéma versionné dans Git** (`supabase/_schema_snapshot.sql`, instantané
  de récupération, PAS une migration — ne jamais le rejouer). Modèle de
  sauvegarde complet : les DONNÉES par n8n vers R2, le SCHÉMA par Git.
- **Soft delete (corbeille)** sur les tables enfant du dossier. **Exceptions** :
  `dossier_documents` et `vault_files` (hard delete assumé).
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

- **Recherche web — validation AVANT le juge** : le juge choisit parmi des URL
  **vérifiées** (`link_ok`/`content_type`) et **corroborées** (`engine_count`) ; il
  n'invente/ne modifie JAMAIS une URL ; `content_type` fait autorité sur `is_pdf`.
  Les vidéos doivent être **incluses explicitement** dans la shortlist (elles ne
  passent pas le filtre « document »).
- **Recherche web — grossistes suisses légitimes** (ottofischer/flextron/feller/
  sonepar/eldas), pas des revendeurs à exclure. `link_ok:false` = avertissement doux.
- **n8n — credential recréé = re-sélectionner sur chaque nœud** (piège de l'id
  fantôme, silencieux jusqu'à l'exécution). Diagnostiquer par le vrai `error.message`
  du nœud, pas par le bandeau « Couldn't connect » du credential (faux positif).
- **n8n — nœud Anthropic en Header Auth** (`x-api-key` + `anthropic-version` +
  `content-type`), pas le credential natif `anthropicApi`.
- **n8n — nœud Code sandbox** : `URL` **non exposé** (extraire le domaine par regex) ;
  `this.helpers.httpRequest` disponible (utilisé pour la validation parallèle) ;
  `Prefer: return=minimal` → 204 → « no items on branch » = **succès**, pas un échec.
- **Gemini** : `thinkingBudget:0` obligatoire (sinon réponse sans `candidates`) ;
  URL de grounding = redirections `vertexaisearch` à résoudre.
- **Ouverture PDF = règle de plateforme** ; **pdf.js** = polyfill au démarrage.
- **Coffre — enveloppe FEK** ; ne jamais modifier `vault.js` sans le harnais (30/30).
- **Bibliothèque PDF sur R2** : `file_path` = clé NUE ; clé R2 = `'documents/' +
  file_path` ; toujours un Blob des deux côtés.
- **Calque d'annotation photo** : `dossier_photos.annotations` = source unique ;
  original R2 jamais touché ; export à la demande, jamais stocké.
- **Worker `/api/photos`** : POST validé par `GENERIC_PREFIX_RE`/`GLOBAL_PREFIXES` ;
  GET préfixe-agnostique ; DELETE différencié (`vault/` → accès dossier OU admin ;
  autres → admin-only).
- **SOFT-DELETE + policy SELECT `deleted_at IS NULL` = piège 42501** → RPC SECURITY
  DEFINER. `fetch` manuel vers PostgREST à éviter (apikey en header refusée).
- **Vue avec nouvelle colonne = DROP + CREATE** (+ `security_invoker`, + grant).
- **Signature de fonction = nom + types d'args** : étendre = drop+create+re-grant.
- **Déplacer un produit de spécialité = DEUX updates** ; « Autres » = `sort_order 999`
  (nouvel insert exclut le 999) ; nouvelle spécialité = penser au dropdown n8n.
- **Credential R2 S3** : endpoint sans bucket, `Force Path Style: ON`, région `auto`.
- **`auth.uid()` NULL dans le SQL Editor** ; simuler via `set_config('request.jwt.
  claims', …, true)` dans un même run.
- **Edge Function : le push ne déploie PAS** → `npx supabase functions deploy`.
- **Après un push, fermer/rouvrir la PWA** (cache SW) ; changement SW → rouvrir EN
  LIGNE 1-2×.
- **Secrets** : Publishable/anon OK en clair ; Secret/tokens jamais dans code/Git/chat.
- **Le travail n'existe que poussé/publié** : commit + push depuis le terminal ; voir
  le diff avant commit ; **publier** les workflows n8n après édition.

---

## Dettes ouvertes

- **Recherche web — contexte du job souvent vide** (`equipment_type`/`department`/
  `specialty`) : c'est le signal le plus fort du juge contre les homonymes. Vérifier
  que l'appli remplit et envoie ces champs à l'INSERT. **Meilleur levier qualité restant.**
- **Recherche web — badge « Vidéo » côté front** : marquage visuel distinct des
  vidéos (prompt Claude Code fourni), à confirmer déployé.
- **Recherche web — nettoyage** : supprimer les colonnes par moteur obsolètes de
  `web_search_jobs`, supprimer les anciens workflows Anthropic/Perplexity et la clé
  `private_config.n8n_webhook_url_pplx` orpheline.
- **VÉRIF `dossier_produits`** : confirmer que sa policy SELECT n'est PAS
  `deleted_at IS NULL` (sinon bug soft-delete/RETURNING latent).
- **`dossier_documents` sans soft-delete** : seule table enfant (hors coffre) sans
  `deleted_at`.
- **Volumétrie backup à surveiller** : ~65 Mo/jour (dont `documents.content`), soit
  ~1,9 Go à 30 jours sur 10 Go R2 partagés avec `laydevant-photos`. Levier si ça
  serre : cesser de sauvegarder `documents.content` (ré-extractible depuis les PDF).
- **Cache offline — Galerie, Plans, fichiers du coffre, annotation photo** : online-only.
- **Communication d'entreprise — aperçu offline** : online-only (placeholder).
- **Garde-fou « PDF trop détaillé » sur les fichiers du coffre** : non appliqué.
- **Granularité produits — Bticino, Comelit, Swisscom, Burri** : pas éclatées.
- **Compteur de documents plafonné à 1000 pour Portes automatiques**.
- **`gol-1-media.bmp`** reste en BMP (non bloquant).
- **`formatDate` dupliqué** (~4-5 copies) ; **`planLabel` bugué** (coupe au 1er tiret) ;
  **chevrons `goHome` vs `goBack`** à normaliser.
- **`pg_cron`** installé mais inutilisé.

---

## Prochain chantier

1. **Recherche web — remplir le contexte du job** (`equipment_type`/`department`/
   `specialty`) côté front : meilleur levier qualité restant contre les homonymes.
2. **Recherche web — nettoyage staging** : supprimer les colonnes par moteur
   obsolètes de `web_search_jobs`, les anciens workflows n8n Anthropic/Perplexity,
   et la clé `private_config.n8n_webhook_url_pplx` orpheline.
3. **Cache offline** — Galerie, Plans, fichiers du coffre, annotation photo.
4. **Nettoyage granularité produits** (Bticino, Comelit, Swisscom, Burri).

---

## Apprentissages

- **Un backup à LISTE BLANCHE dérive fatalement** (`web_search_log` avait été
  oubliée sans que personne le voie). Un backup AUTO-RECENSANT inverse le mode
  d'échec : oublier de toucher la liste veut dire « sauvegardé par défaut », pas
  « perdu silencieusement ».
- **`chr(0)` est REFUSÉ par Postgres à la construction** (erreur `54000` « null
  character not permitted ») : un `select chr(0)` échoue seul. Une colonne
  text/varchar ne PEUT donc pas contenir de NUL — tout assainissement anti-NUL en
  lecture est inutile et provoque lui-même l'erreur qu'il prétend éviter. (À ne
  pas confondre avec le `08P01` côté ÉCRITURE, quand des octets viennent d'un
  pipeline externe.)
- **Vérifier l'INPUT réel d'un nœud n8n avant de conclure** : un nœud vert peut
  servir un résultat épinglé/en cache et masquer que la correction n'a pas pris.

---

## Où trouver le détail

- **Le pourquoi des décisions** : les HANDOFF datés (archive). Le plus récent :
  **`HANDOFF_recherche_web_ensemble_juge.md`** (Ensemble Search : 3 moteurs + juge +
  validation-avant-juge, et le bêtisier — hallucination Gemini, `thinkingBudget:0`,
  binding Anthropic fantôme, vidéos filtrées avant le juge).
- **La spec technique + règles Claude Code** : `CLAUDE.md` à la racine du repo.
- **Le comment exact d'un workflow n8n** : le workflow lui-même dans n8n.
