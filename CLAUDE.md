# Spécification — PWA de documentation technique de terrain

Document de référence du projet. À relire avant chaque étape d'implémentation.
Décrit l'état réel du dépôt, pas son historique — pour le détail complet de la
recherche web de notices, voir `Feature recherche web notices.md`.

---

## 1. Objectif

Une PWA consultée sur téléphone par les techniciens de Laydevant SA (électricité,
télécom, portes automatiques) pour :

- retrouver en quelques secondes la notice ou le manuel de programmation d'un
  produit qu'ils ont sous les yeux sur un chantier (bibliothèque interne,
  consultation hors ligne) ;
- si le produit n'est pas encore documenté, le chercher sur le web par marque +
  modèle et l'ajouter à la bibliothèque en un geste (recherche web de notices,
  en ligne uniquement) ;
- retrouver rapidement, par client, les équipements installés et la
  documentation qui s'y rattache (dossiers clients, en ligne uniquement pour
  l'instant).

**La contrainte structurante pour la bibliothèque : le réseau est souvent
absent.** L'utilisateur est dans un local technique de sous-sol, une gaine,
une cage d'ascenseur. Le mode hors ligne n'est pas un cas dégradé, c'est la
situation nominale pour cette partie de l'app. La recherche web et les
dossiers clients, à l'inverse, sont des fonctionnalités assumées en ligne
uniquement.

---

## 2. Stack

- **React + Vite + TypeScript**
- **vite-plugin-pwa** pour le service worker et le manifest (précache le
  shell applicatif seulement — les PDF sont gérés à la main via Cache API,
  pas par workbox)
- **@supabase/supabase-js** pour la base, le stockage, l'authentification et
  l'appel à l'Edge Function de recherche web
- **pdfjs-dist** pour l'aperçu PDF in-app (chargé en lazy/code-split, ~1 Mo,
  seulement à l'ouverture d'une fiche document)
- **MiniSearch** pour l'index de recherche hors ligne (côté client)
- **idb** pour IndexedDB
- **Cache API** pour le stockage des PDF (pas IndexedDB : mieux adapté aux
  binaires volumineux)
- **Supabase Edge Functions (Deno)** pour la recherche web de notices — seule
  pièce du système qui appelle l'API Anthropic
- **Cloudflare Workers** (static assets) pour l'hébergement

Pas de framework CSS lourd, tout en styles inline avec les tokens de
`src/styles/tokens.ts`. Le design est fourni en HTML/CSS dans `design/`, porté
tel quel en composants.

---

## 3. Schéma Supabase

Le backend Supabase est en place et fonctionnel. **Ne pas modifier le schéma
depuis cette app** — les tables métier (départements → documents) et dossiers
sont gérées en dehors de ce dépôt (workflow n8n, admin Supabase direct) ; seule
`web_search_log` a ses migrations versionnées ici, dans `supabase/migrations/`.

### Bibliothèque de documents

```
departments      id, name, slug, icon, sort_order
specialties      id, department_id, name, slug, sort_order
products         id, specialty_id, brand, model, name
documents        id, specialty_id, product_id, title, doc_type, file_path,
                 file_size, mime_type, content, source_url, retrieved_at,
                 version_label, tags[], created_by, created_at, updated_at
profiles         id, full_name, role ('monteur' | 'admin')
pinned_documents user_id, document_id, pinned_at
```

`documents.content` contient le texte intégral extrait du PDF. C'est ce champ
qui alimente les deux moteurs de recherche (§7).

`doc_type` ∈ `notice_installation`, `manuel_programmation`, `fiche_technique`,
`schema`, `fiche_perso`, `autre`.

### Dossiers clients (étape A)

```
dossiers          id, nom_client, adresse, notes, created_by, created_at
dossier_produits  dossier_id, product_id, note
dossier_documents dossier_id, document_id
```

Un équipement (`dossier_produits`) fait automatiquement remonter dans le
dossier toutes les notices `documents` rattachées à son `product_id`. Un
document peut aussi être rattaché directement (`dossier_documents`), sans
passer par un équipement — les deux voies sont dédupliquées et distinguées par
le champ `origine` (`'equipement' | 'direct'`) de la RPC ci-dessous.

### Recherche web de notices

```
web_search_log   id, user_id, brand, model, created_at
```

Journalise chaque appel à l'Edge Function `web-search-notices` : garde-fou de
coût (plafond quotidien par utilisateur) et traçabilité. Voir §8.

### RPC

**`search_documents(q, p_department_slug, p_specialty_slug, p_limit)`** —
recherche en ligne sur toute la bibliothèque.

```ts
supabase.rpc('search_documents', {
  q: 'pare-feu',
  p_department_slug: 'telecom',  // ou null
  p_specialty_slug: null,
  p_limit: 30,
});
```

Retourne : `id, title, doc_type, file_path, specialty_name, department_name,
product_label, extrait, rank`.

- `product_label` est **souvent null** (documents sans produit rattaché).
- `extrait` est du **HTML** contenant des balises `<b>` autour des termes
  trouvés. Voir §9 pour le traitement obligatoire.
- La fonction exige une requête. Elle ne sert pas au mode parcours (§7).

**`search_dossiers(q)`** — liste/filtre les dossiers clients par nom ou
adresse ; `q` vide renvoie tous les dossiers.

```ts
supabase.rpc('search_dossiers', { q: 'dupont' });
```

Retourne : `id, nom_client, adresse, nb_produits, nb_documents`.

**`dossier_documents_complets(p_dossier_id)`** — toutes les notices d'un
dossier (équipements + rattachements directs), dédupliquées.

```ts
supabase.rpc('dossier_documents_complets', { p_dossier_id: dossierId });
```

Retourne : `id, title, doc_type, file_path, specialty_name, product_label,
origine`. Même convention de nommage que `search_documents` (même schéma
sous-jacent).

### RLS

- Bibliothèque : tout utilisateur authentifié **lit** ; seuls les `admin`
  **écrivent**. Les épingles (`pinned_documents`) sont strictement privées à
  chaque utilisateur.
- `web_search_log` : chaque utilisateur écrit/lit ses propres lignes ; les
  `admin` lisent tout.
- Dossiers : lecture/écriture pour tout utilisateur authentifié (pas de
  restriction par créateur à ce stade).

L'application n'a donc jamais besoin d'écrire ailleurs que dans
`pinned_documents`, `web_search_log`, `dossiers`, `dossier_produits` et
`dossier_documents` — jamais dans `documents`/`products` directement (ça reste
le rôle du pipeline d'ingestion n8n, y compris pour la capture web, §8).

### Stockage

Bucket `documents`, **privé**. Accès uniquement par URL signée :

```ts
supabase.storage.from('documents').createSignedUrl(file_path, 3600);
```

---

## 4. Structure des spécialités — tout à plat

Département → spécialité → documents/produits, deux niveaux, sans hiérarchie
parent/enfant entre spécialités. Rien n'est codé en dur côté front : les
départements et spécialités sont lus depuis la base (`syncReferentiel` dans
`src/lib/referentiel.ts`) et mis en cache dans IndexedDB (§5). Même le style
des tuiles département (`src/lib/departmentStyle.ts`) cycle sur une palette
par position plutôt que par nom, pour rester correct si un département est
ajouté ou renommé côté base sans toucher au code.

---

## 5. Architecture hors ligne (bibliothèque uniquement)

C'est le cœur du projet pour la partie bibliothèque. Trois couches de stockage
local :

| Donnée | Support | Contenu |
|---|---|---|
| Référentiel | IndexedDB | départements, spécialités (petit, toujours synchronisé) |
| Métadonnées + texte | IndexedDB | les documents épinglés, avec leur champ `content` |
| Fichiers PDF | Cache API | les binaires des documents épinglés |
| Derniers documents consultés | IndexedDB | 3 entrées max, locales à l'appareil, jamais synchronisées |

Les dossiers clients n'ont **pas** de repli hors ligne à ce stade (étape A) :
un dossier déjà chargé en mémoire reste affiché si la connexion tombe, mais
tout rechargement ou toute écriture (ajout/retrait d'équipement ou de
document) exige le réseau.

### Épingler un document

1. Obtenir une URL signée
2. `fetch()` le PDF → blob (le type MIME est forcé explicitement plutôt que de
   faire confiance au Content-Type du stockage, qui peut être absent ou faux
   côté objets uploadés par n8n)
3. Stocker le blob dans le Cache API sous une clé stable : `/offline-pdf/{document_id}`
4. Stocker métadonnées + `content` dans IndexedDB
5. Insérer la ligne dans `pinned_documents` (synchronise l'épingle entre appareils)

Retirer = l'inverse, dans l'ordre inverse (`src/lib/pinning.ts`) ; le retrait
côté ligne `pinned_documents` est best-effort si hors ligne (retirer le PDF de
l'appareil reste une action locale légitime sans réseau).

### Piège : épingle ≠ fichier présent

`pinned_documents` est **partagé entre les appareils** de l'utilisateur, mais
le PDF est stocké **par appareil**. Un utilisateur qui épingle sur son
téléphone puis ouvre l'application sur sa tablette verra l'épingle sans avoir
le fichier — trois états gérés explicitement sur la fiche document :
« Enregistrer sur l'appareil » (jamais épinglé), « Télécharger sur cet
appareil » (épinglé sur le compte, absent ici), et « Disponible hors ligne »
(présent ici, sans bouton).

Si le PDF a disparu du Cache API de cet appareil (éviction sous pression
mémoire) alors que la métadonnée IndexedDB dit encore « épinglé », la fiche
document détecte l'incohérence, purge l'enregistrement local et retombe sur le
chemin en ligne plutôt que d'afficher un faux « Disponible hors ligne ».

---

## 6. Authentification

Supabase Auth, email + mot de passe (`src/lib/auth.tsx`). Les comptes sont
créés par un administrateur ; pas d'inscription libre.

**Piège majeur : le rafraîchissement de session échoue hors ligne.** Par
défaut, supabase-js tente de renouveler le token et peut déconnecter
l'utilisateur. Un technicien qui se retrouve éjecté de l'application dans une
cave, sans réseau pour se reconnecter, perd l'accès à des documents pourtant
présents sur son appareil.

L'app détecte l'état réseau via une **sonde de joignabilité active**
(`src/lib/network.ts`) plutôt que le seul `navigator.onLine` : sur Android
réel, basculer le mode avion ne fait bouger ni `navigator.onLine` ni les
événements `online`/`offline` — seul un cycle radio complet (écran éteint puis
rallumé) en produit un. La sonde fait un `fetch` `no-cors` court vers l'URL
Supabase toutes les 5 s, plus un recheck immédiat sur focus/visibilitychange ;
les événements navigateur ne servent que de signal optimiste, jamais de vérité
seule.

`AuthProvider` s'appuie sur ce signal pour piloter `supabase.auth.startAutoRefresh()`
/ `stopAutoRefresh()` : le rafraîchissement n'est tenté qu'au retour en ligne,
jamais pendant une coupure. Résultat :

- pas de tentative de rafraîchissement tant qu'on est hors ligne ;
- le contenu déjà en cache reste consultable même avec une session localement
  expirée ;
- l'authentification n'est redemandée qu'au retour du réseau (et seulement si
  le refresh token s'avère réellement mort).

---

## 7. Bibliothèque de documents — recherche et parcours

### Deux moteurs de recherche

**En ligne** — `search_documents` (§3), couvre tout le corpus.

**Hors ligne** — index MiniSearch (`src/lib/offlineSearch.ts`) construit à la
demande sur le `content` des documents épinglés uniquement (pas d'index
persistant : le nombre de documents épinglés reste petit, reconstruire à
chaque recherche est plus simple qu'un maintien incrémental). Il produit des
extraits surlignés en repassant par la **même fonction** `sanitizeHeadline`
que le moteur en ligne (§9) : les deux moteurs sont donc garantis visuellement
identiques par construction, pas par coïncidence.

L'écran de recherche bascule automatiquement en mode « épinglés uniquement »
dès que l'appareil est hors ligne (ou si l'utilisateur active le filtre
« Épinglés » explicitement), avec un bandeau explicite. Sans cela l'utilisateur
conclurait qu'un document n'existe pas alors qu'il ne l'a simplement pas
embarqué.

### Mode parcours (sans requête)

`search_documents` ne s'applique pas. `listDocuments()` (`src/lib/documents.ts`)
fait une requête directe :

```ts
supabase.from('documents')
  .select('id, title, doc_type, file_path, specialties(name, departments(name)), products(brand, model)')
  .order('title');
```

Les cartes sont alors compactes, sans extrait (`DocumentCard` avec
`excerptHtml={null}`).

### Écrans

1. **Accueil** — tuiles de département, tuile Dossiers, derniers documents
   consultés (3 max), accès aux documents épinglés, accès à toute la
   documentation.
2. **Département** — liste des spécialités avec le nombre de documents.
3. **Résultats / liste** — deux variantes de carte : avec extrait surligné
   (mode recherche), compacte (mode parcours). Filtres par département ; une
   fois un département choisi, les chips basculent sur type de document et
   fabricant (le fabricant n'étant connu que via le mode parcours,
   `products.brand` — les résultats de `search_documents` et les documents
   épinglés ne portent qu'un `product_label` combiné, pas la marque séparée).
4. **Fiche document** — visualiseur PDF in-app (pdf.js, lazy-loadé) avec un
   raccourci « Voir en plein écran » (le même blob rouvert via
   `window.open`/blob URL, pour le lecteur PDF natif d'Android), lien
   « Source fabricant » si `source_url` est renseigné, et les trois états
   d'enregistrement du §5.

Les « derniers documents consultés » sont **locaux à l'appareil** (IndexedDB),
pas synchronisés. Ils restent consultables hors ligne si le document est
épinglé, grisés sinon.

---

## 8. Recherche web de notices et capture

Extension en ligne uniquement, pour les produits absents de la bibliothèque.
Spécification complète : `Feature recherche web notices.md`. Deux chemins
distincts.

### Recherche — Edge Function `web-search-notices`

```
PWA → Edge Function "web-search-notices" → API Anthropic (avec recherche web)
    → réponse triée (JSON) → PWA
```

- Le front (`src/lib/webSearch.ts`) n'appelle **jamais** l'API Anthropic
  directement — la clé serait exposée. Il passe par
  `supabase.functions.invoke('web-search-notices', ...)`.
- `verify_jwt` reste activé sur la fonction : seul un utilisateur authentifié
  l'atteint. La fonction rejoue le JWT de l'appelant sur son propre client
  Supabase (jamais `service_role`) pour la journalisation et le plafond, donc
  les mêmes règles RLS s'appliquent qu'un appel vienne d'elle ou du front.
- Entrée : `brand`, `model` (requis), `department_name`, `specialty_name`,
  `equipment_type` (optionnels, affinent la requête).
- Sortie : `{ results: [{ type, title, url, is_pdf, source, confidence }] }`.
  `type` ∈ `notice_installation`, `manuel_programmation`, `fiche_technique`,
  `autre` (sous-ensemble de `doc_type`, sans `schema`/`fiche_perso`).
- Garde-fous de coût : `web_search_log` sert de plafond quotidien souple par
  utilisateur (`WEB_SEARCH_DAILY_LIMIT`, 50 par défaut, rejeté en 429
  au-delà) ; `WEB_SEARCH_MAX_USES` (3 par défaut) borne le nombre d'essais de
  recherche web par appel ; le prompt système est mis en cache côté Anthropic
  (`cache_control: ephemeral`) car figé d'un appel à l'autre. Ces trois
  réglages sont des secrets de fonction, ajustables sans changement de code.
- Modèle et type d'outil de recherche web (`ANTHROPIC_MODEL`,
  `ANTHROPIC_WEB_SEARCH_TOOL_TYPE`) sont aussi des secrets de fonction — à
  vérifier sur docs.claude.com avant tout redéploiement, ces identifiants
  évoluent.

### Capture vers la bibliothèque — webhook n8n `ingest-from-url`

```
PWA → webhook n8n "ingest-from-url" → télécharge le PDF → mêmes étapes que le
     formulaire d'ingestion existant (extraction texte, upload Storage,
     upsert produit + insert document) → confirmation
```

- Le bouton « Ajouter à la bibliothèque » n'apparaît que si `is_pdf` est true
  côté résultat. L'utilisateur ajuste les métadonnées auto-détectées (marque,
  modèle, spécialité — choisie parmi les spécialités existantes, type de
  document) dans une feuille de confirmation (`CaptureSheet`) avant envoi.
- `src/lib/captureIngest.ts` poste vers `VITE_N8N_INGEST_URL`, avec un header
  `x-webhook-secret: VITE_N8N_INGEST_SECRET`. Le front n'écrit **jamais**
  directement dans Storage ni dans `documents`/`products`.
- Échec honnête : certaines sources fabricant bloquent le téléchargement
  automatique (403, portail, JS) — l'erreur remonte telle quelle, l'utilisateur
  peut alors télécharger le PDF à la main et repasser par le formulaire
  d'ingestion classique (hors de cette app).

### Garde-fou de contenu

La capture ne concerne que la **documentation fabricant librement diffusée**
(notices, manuels, fiches techniques) — pratique standard du métier. Elle ne
doit **jamais** servir à aspirer du contenu sous licence de tiers : normes
payantes type NIN/NIBT, contenus sous licence. Le prompt de l'Edge Function
privilégie déjà les sources fabricant officielles et exclut explicitement
places de marché, revendeurs, forums — mais la responsabilité finale reste
humaine (vérification en `CaptureSheet` avant envoi).

---

## 9. Dossiers clients (étape A)

Écrans en ligne uniquement : `DossiersScreen` (liste/recherche/création),
`DossierScreen` (fiche — équipements, documentation, placeholder données
sensibles). Code dans `src/lib/dossiers.ts`, `src/screens/Dossier*.tsx`,
`src/components/{DossierFormSheet,AddEquipmentSheet,AddDossierDocumentSheet}.tsx`.

- **Liste** — `search_dossiers`, recherche par nom client ou adresse, avec
  création via une feuille (nom client requis, adresse et notes optionnels).
- **Fiche** — deux sections modifiables : équipements rattachés
  (`dossier_produits`, picker sur `products` par marque/modèle/nom) et
  documentation (`dossier_documents_complets` pour l'affichage unifié,
  ajout direct via `dossier_documents`). Un document remonté via un
  équipement affiche « Via équipement » et ne peut être retiré qu'en retirant
  l'équipement ; un document rattaché directement affiche « Retirer du
  dossier ».
- Ouvrir un document depuis une fiche dossier respecte les mêmes règles
  d'accès que la bibliothèque : si le document est épinglé, il s'ouvre même
  hors ligne ; sinon, réseau requis.
- Pas de mode hors ligne pour cette étape : un dossier déjà chargé reste
  affiché si la connexion tombe, mais tout rechargement ou toute écriture
  exige le réseau (bandeau explicite dans les deux écrans).

---

## 10. Ce qui reste à faire

**Étape B — coffre de données sensibles, PAS implémentée.** La fiche dossier
réserve un emplacement visuel désactivé (« Mastercodes, WiFi — à venir
(chiffrement, étape B) »), sans aucune logique derrière. Quand elle sera
construite :

- chiffrement **côté client** (WebCrypto), jamais de secret en clair envoyé au
  backend ;
- **un fichier par dossier** (pas une colonne en clair dans `dossiers`) ;
- le reste de l'architecture (schéma exact, gestion de la clé, RLS associée)
  reste à spécifier — ne rien construire dans cette direction sans une
  spécification dédiée, au même titre que `Feature recherche web notices.md`
  pour la recherche web.

---

## 11. Traitement obligatoire de l'extrait surligné

`ts_headline` (moteur en ligne) renvoie du HTML **non échappé**. Le champ
`content` provient de PDF téléversés : il peut contenir n'importe quoi, y
compris des balises. Injecter `extrait` directement dans le DOM serait une
faille XSS. Le moteur hors ligne (§7) construit son propre extrait en texte
brut mais passe par le **même** traitement avant injection.

Traitement imposé (`sanitizeHeadline`, `src/lib/excerpt.ts`) :

1. Échapper **tout** le HTML de la chaîne reçue
2. Restaurer uniquement `&lt;b&gt;` → `<b>` et `&lt;/b&gt;` → `</b>`
3. Puis seulement injecter

Le surlignage se fait **uniquement par la couleur et la graisse**. Aucune
marge, aucun padding, aucun espacement latéral sur le `<b>` : la coupure se
produit parfois à l'intérieur d'un mot composé (`<b>pare</b>-feu`) et tout
espacement disloque le mot.

---

## 12. Sécurité

- **Seule la clé `anon` figure dans l'application front.** Jamais la clé
  `service_role` : elle contourne la RLS. Elle reste exclusivement dans n8n.
- **`ANTHROPIC_API_KEY` ne vit que dans les secrets de l'Edge Function**
  `web-search-notices`, jamais dans le front ni dans Git.
- `VITE_N8N_INGEST_SECRET` (header `x-webhook-secret` du webhook de capture)
  suit la même règle que le reste des `VITE_*` : figé au build, jamais commité
  (`.env*` est dans `.gitignore`, seul `.env.example` — sans valeurs — est
  versionné).
- La clé `anon` est publique par conception ; c'est la RLS qui protège les
  données.
- Les URL signées expirent (1 h). Ne pas les stocker : les régénérer à la
  demande. Une fois le PDF téléchargé dans le Cache API, il est servi
  localement et l'expiration n'a plus d'effet.
- **Règle de contenu** (§8) : documentation fabricant librement diffusée
  uniquement — jamais de contenu sous licence de tiers (normes NIN/NIBT,
  contenus payants) capturé vers la bibliothèque.

---

## 13. Déploiement

Cloudflare Workers avec static assets (et non Cloudflare Pages, déprécié pour
les nouveaux projets). Build statique (`npm run build` : type-check puis build
Vite), déploiement automatique depuis GitHub à chaque push sur `main`, ou
manuel via `npm run deploy` (`wrangler deploy`, nécessite `wrangler login`).

`wrangler.jsonc` à la racine :

```jsonc
{
  "name": "laydevant-app",
  "compatibility_date": "2026-07-24",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
  },
}
```

Le mode `single-page-application` gère le routage côté client : inutile
d'ajouter un fichier `_redirects`.

Variables d'environnement, toutes préfixées `VITE_` et **figées au moment du
build** (Vite les inscrit en dur, elles ne sont pas lues à l'exécution) — à
configurer dans les paramètres du projet Cloudflare, `.env.local` n'étant pas
versionné :

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_N8N_INGEST_URL`, `VITE_N8N_INGEST_SECRET` (webhook de capture, §8)

Les secrets d'Edge Function (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
`ANTHROPIC_WEB_SEARCH_TOOL_TYPE`, `WEB_SEARCH_MAX_USES`,
`WEB_SEARCH_DAILY_LIMIT`) se configurent côté Supabase, indépendamment du
build front.

HTTPS est fourni automatiquement — indispensable, sans lui pas de service
worker donc pas de PWA.

---

## 14. À tester tôt, avant d'aller loin

Parc d'appareils : Android uniquement (aucun iOS). Chrome implémente
`navigator.storage.persist()` et l'accorde en principe automatiquement aux
PWA installées sur l'écran d'accueil (demandé une fois par session au
démarrage, `src/lib/storagePersistence.ts`).

Vérifier malgré tout sur un appareil réel, via l'écran diagnostic
(`DiagnosticScreen`, accessible hors du parcours principal) : que
`navigator.storage.persisted()` renvoie bien true une fois la PWA installée,
que les tailles de blobs épinglés correspondent à ce qui est attendu, et que
les documents épinglés survivent à plusieurs jours sans ouverture de
l'application.

L'application doit être **installée** sur l'écran d'accueil, pas consultée
dans un onglet : la garantie de persistance en dépend.

---

## 15. Hors périmètre actuel

Ne pas implémenter, même partiellement, sans spécification dédiée au préalable :

- le coffre de données sensibles chiffré (étape B, §10) ;
- photos ;
- résumé automatique, traduction, ou toute réponse générée par IA au-delà du
  tri de résultats de la recherche web de notices (§8) ;
- recherche web en masse ou programmée — une recherche = une action volontaire
  de l'utilisateur devant un équipement ;
- interface générique d'ajout/édition de documents dans le front (l'ingestion
  reste déléguée au workflow n8n existant, y compris pour la capture web,
  qui n'est qu'une nouvelle porte d'entrée vers ce même pipeline).
