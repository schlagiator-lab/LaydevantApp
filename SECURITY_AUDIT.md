# Audit de sécurité — LaydevantApp

- **Date :** 2026-10-02
- **Commit audité :** `01a4444` (branche `main`)
- **Mode :** lecture seule. Aucun fichier de code modifié, aucune installation
  ni mise à jour de paquets. Seules commandes avec effet : `npm run build`
  (écrit dans `dist/`, ignoré par git) et `npm audit` (lecture).
- **Hors périmètre, faute d'accès :** dashboard Supabase (état réel de
  `verify_jwt`, policies en base), workflows n8n, réglages Cloudflare.
  Les points qui en dépendent sont marqués **« à vérifier »**.

Résultat : **aucun point Critique**, 2 Élevés, 7 Moyens, 8 Faibles.

---

## Critique

Aucun.

---

## Élevé

### E1 — XSS sur l'origine de l'app : blob ouvert avec un type MIME choisi par l'utilisateur

**Où :**
- `src/lib/vaultFiles.ts:85` — à l'upload, le type stocké est `file.type`,
  c'est-à-dire celui que le navigateur de l'uploadeur déclare.
- `src/lib/vaultFiles.ts:157` — au déchiffrement, le blob est recréé avec ce
  type : `new Blob([plainBytes], { type: meta.mime })`.
- `src/components/VaultSheet.tsx:588-596` — tout fichier qui n'est pas une
  image est ouvert hors iOS par `window.open(URL.createObjectURL(blob))`.
- `src/components/VaultSheet.tsx:1067` — le filtre
  `accept="application/pdf,image/*"` n'existe que dans l'interface.

**Pourquoi c'est grave :** une URL `blob:` hérite de l'origine de la page qui
la crée, donc de l'app.

**Scénario :** un utilisateur ayant accès au coffre d'un dossier y dépose un
fichier `text/html`. Il passe par « Tous les fichiers » du sélecteur, ou par
un appel direct (l'encodage se fait côté client). Quand un collègue ou un
admin ouvre ce fichier sur Android, le HTML s'exécute sur l'origine de l'app.

**Ce qui est exposé :**
- la session Supabase stockée dans `localStorage` (access et refresh token) ;
- IndexedDB et le Cache API ;
- la possibilité d'appeler l'API au nom de la victime, y compris les RPC
  admin si la victime est admin.

**Même motif, côté bibliothèque :**
- `src/lib/documents.ts:83` et `:100` — `type: mimeType || 'application/pdf'`
  ;
- `src/screens/DocumentScreen.tsx:165-166` — ouverture en `window.open`.

`documents.mime_type` est écrit par n8n, dont le webhook de capture est
appelable par n'importe qui (voir M4). **À vérifier :** le workflow n8n
peut-il recopier un `Content-Type` `text/html` depuis la source téléchargée ?
CLAUDE.md §5 dit que le type MIME est « forcé explicitement », mais le code
préfère `mime_type` dès qu'il est renseigné.

À noter : `src/lib/dossiers.ts:271` et `:784` (plans, notices de demande)
forcent déjà `application/pdf`. Ils sont corrects.

**Recommandation :**
- Avant tout `window.open` d'un blob, forcer un type sûr : `application/pdf`
  si c'est un PDF, sinon `application/octet-stream`.
- Ne jamais réutiliser un type fourni par l'utilisateur ou par la base pour
  un blob ouvert dans un onglet.
- À la lecture, n'accepter qu'une liste blanche de types (`application/pdf`,
  `image/png|jpeg|webp|gif`). Refuser `image/svg+xml` en dehors de `<img>`.
- En complément, ajouter une CSP (voir M2).

**Statut : RÉSOLU côté client (2026-10-08).** Helper unique `safeMimeForOpen` (`src/lib/safeOpen.ts`) : liste blanche stricte `application/pdf`, `image/jpeg|png|webp|gif`, tout le reste (SVG, HTML, texte, vide, inconnu) devient `application/octet-stream`. Appliqué à `vaultFiles.ts` (`openVaultFile`), `VaultSheet.tsx` (le branchement d'ouverture se fait sur le type filtré ; un type hors liste part en téléchargement, jamais en `window.open` ; `File` du partage re-typé), `documents.ts` (`fetchPdfBlob`, `fetchPdfBlobR2`), `pdfCache.ts` (à l'écriture et à la lecture, pour les entrées déjà en cache) et `dossiers.ts` (`getPhotoObjectUrl` : photos du carnet, galerie, plans image et téléchargements DWG, dont le type venait du `Content-Type` renvoyé par le Worker). Plans PDF, notices de demande et communications forçaient déjà `application/pdf` : inchangés. Côté envoi, le sélecteur du coffre est restreint à la liste blanche et tout fichier hors liste est refusé avec un message ; les demandes d'équipement étaient déjà limitées au PDF. Reste ouvert : le `Content-Type` stocké par le Worker (M3) et la CSP (M2).

### E2 — `delete-account` identifie l'appelant à partir d'un JWT non vérifié

**Où :**
- `supabase/functions/delete-account/index.ts:27-38` —
  `userIdFromAuthHeader` lit le `sub` du JWT par simple décodage base64,
  sans vérifier la signature.
- `:46` — ce `sub` sert d'identité à l'appelant.
- `:66-72` — le contrôle « appelant admin » est fait en service_role sur ce
  `sub`.

**Ce qui dépend de quoi :** toute la sécurité de la fonction repose sur le
`verify_jwt` de la plateforme Supabase. Or il n'y a **aucun
`supabase/config.toml`** dans le dépôt : l'état de `verify_jwt` n'est ni
versionné ni vérifiable ici.

**Scénario :** si la fonction est un jour redéployée sans `verify_jwt`
(oubli, `--no-verify-jwt` copié depuis `enroll`), un visiteur forge un JWT
non signé avec le `sub` d'un admin. Il peut alors supprimer n'importe quel
compte monteur dont l'accès coffre est révoqué. Le passage aux clés de
signature JWT asymétriques de Supabase est aussi à surveiller sur ce point.

`supabase/functions/web-search-notices/index.ts:297` suit le même motif,
avec un impact moindre.

**Recommandation :**
- Vérifier l'appelant dans le code avec `auth.getUser(token)`, comme le font
  déjà `add-catalog-notice` et `add-dossier-equipment-notice`.
- Versionner un `supabase/config.toml` qui fixe `verify_jwt` pour chaque
  fonction.
- **À vérifier tout de suite dans le dashboard :** `verify_jwt = true` sur
  `delete-account`.

**Statut : RÉSOLU (2026-10-02).** `delete-account` identifie désormais son appelant par `auth.getUser(jwt)` côté serveur (401 sinon, avant toute autre opération), `userIdFromAuthHeader` est supprimé, et `verify_jwt` des six fonctions est versionné dans `supabase/config.toml` avec les valeurs relevées dans le dashboard.

---

## Moyen

### M1 — URL de la recherche web ouverte sans filtre de schéma

**Où :** `src/screens/WebSearchScreen.tsx:209` —
`window.open(result.url, '_blank', 'noopener')`.

**Pourquoi :** `result.url` vient de `web_search_jobs.final_results`. Ce champ
est produit par n8n (juge LLM nourri de contenu web, ou repli mécanique).
Aucun contrôle côté client n'impose `http:`/`https:`. Une URL `javascript:`
ou `data:` injectée (prompt injection dans un snippet, workflow compromis)
serait ouverte telle quelle. Le comportement exact dépend du navigateur.

La même valeur part aussi vers n8n comme `pdf_url`/`source_url`
(`src/components/CaptureSheet.tsx:83,89`). Elle ressort ensuite dans
`href={doc.source_url}` (`src/screens/DocumentScreen.tsx:445`). React 19.2.8
neutralise `javascript:` dans `href`, mais pas les autres schémas.

**Recommandation :**
- Un helper `safeExternalUrl(u)` : `new URL(u)`, puis
  `protocol ∈ {'http:','https:'}`, sinon le lien n'est pas rendu.
- L'appliquer à `window.open`, au `href` de `source_url` et avant l'envoi de
  `CaptureSheet`.

**Statut : RÉSOLU (2026-10-08).** Helper `safeExternalUrl` (`src/lib/safeOpen.ts`) : `new URL()` puis `http:`/`https:` uniquement, sinon `null`. Appliqué dans `WebSearchScreen.tsx` (une URL rejetée n'affiche ni « Consulter » ni « Ajouter à la bibliothèque », seulement « Lien invalide » ; `window.open` en `noopener,noreferrer`), `CaptureSheet.tsx` (refus avant envoi à n8n) et `DocumentScreen.tsx` (lien « Source fabricant » non rendu si rejeté, `rel="noopener noreferrer"`). Les communications et les notes n'affichent aucune URL issue des données.

### M2 — Aucun en-tête de sécurité HTTP

**Où :**
- `worker/index.js:116-122` et `:110` : les réponses `/api/photos` ne portent
  que `Content-Type` et `Cache-Control`.
- `worker/index.js:168` : les assets sont servis par `env.ASSETS.fetch` sans
  en-têtes ajoutés.
- Pas de fichier `public/_headers`.
- Pas de `<meta http-equiv="Content-Security-Policy">` dans `index.html`.

**En-têtes absents :**
- `Content-Security-Policy` (dont `frame-ancestors`) ;
- `X-Content-Type-Options: nosniff` ;
- `Referrer-Policy` ;
- `X-Frame-Options` ;
- `Permissions-Policy`.

**Pourquoi :** sans CSP, toute XSS (voir E1) a les mains libres, notamment
pour exfiltrer vers un domaine tiers. Sans `frame-ancestors`, l'app peut être
encadrée par un autre site (clickjacking).

**Recommandation :**
- Ajouter les en-têtes dans le Worker, sur toutes les réponses : assets et
  API.
- CSP de départ : `default-src 'self'` ; `connect-src 'self' https://<projet>.supabase.co <n8n>` ;
  `img-src 'self' blob: data:` ; `worker-src 'self' blob:` ;
  `object-src 'none'` ; `frame-ancestors 'none'` ; `base-uri 'self'`.
- Sur `/api/photos` GET : `nosniff` et
  `Content-Security-Policy: sandbox; default-src 'none'`.

### M3 — Worker POST : aucune autorisation par préfixe, aucune limite de taille

**Où :** `worker/index.js:83-110`.

**Pourquoi :** une fois authentifié, n'importe quel utilisateur peut écrire
sous :
- `communications` (réservé en base aux admin/publishers) ;
- `vault/<n'importe quel dossier>` sans avoir accès à ce coffre ;
- `dossiers/<id>`, `plans/<id>`, `galerie/<id>`.

Le `Content-Type` stocké est celui que l'appelant envoie (`:96`), et il est
renvoyé tel quel au GET (`:119`). La lecture des lignes reste protégée par la
RLS, mais un utilisateur peut remplir le bucket : coût, objets orphelins,
déni de stockage. Aucune limite de taille sur `request.arrayBuffer()`.

**Recommandation :**
- Reprendre pour POST les contrôles déjà faits pour DELETE :
  `has_dossier_vault_access` pour `vault/`, admin ou publisher pour
  `communications`.
- Plafonner la taille (`Content-Length` + vérification de `bytes.byteLength`).
- N'accepter qu'une liste blanche de `Content-Type`.

### M4 — `VITE_N8N_INGEST_SECRET` est inscrit dans le bundle

**Où :** `src/lib/captureIngest.ts:20,27`.

**Pourquoi :** risque déjà documenté et accepté (CLAUDE.md §13). Comme toute
variable `VITE_*`, le secret est lisible dans le JS public. Le webhook
d'ingestion est donc appelable sans compte : pollution de la bibliothèque,
coûts n8n. Il peut aussi devenir un vecteur de E1 si `mime_type` n'est pas
forcé côté n8n.

**Recommandation :** faire passer la capture par une Edge Function avec
`verify_jwt` (même modèle que `add-catalog-notice`), qui garde le secret n8n
côté serveur. Retirer ensuite `VITE_N8N_INGEST_SECRET`.

### M5 — `enroll` : l'invitation est réclamable par quiconque connaît l'email, sans limite de débit

**Où :** `supabase/functions/enroll/index.ts:53-63`. `verify_jwt` est
désactivé par conception.

**Pourquoi :**
- La fonction ne prouve pas que la personne possède l'email : quiconque
  connaît une adresse invitée et encore « pending » crée le compte à sa place,
  avec le rôle de l'invitation, admin compris.
- Aucune limite de débit.
- Le message est identique qu'un email soit invité ou non (bien), mais rien
  n'empêche un attaquant de multiplier les essais.

**Recommandation :**
- Raccourcir la durée de vie des invitations (expiration), surtout pour le
  rôle `admin`.
- Ajouter une limite de débit par IP ou par email.
- Option : un code d'invitation à usage unique transmis hors bande, vérifié
  par la fonction.

### M6 — Vulnérabilités hautes dans les dépendances de développement

`npm audit --omit=dev` : **0 vulnérabilité** dans le code livré.

`npm audit` (dev compris) : 7 hautes, 1 modérée, toutes dans l'outillage
(rien n'arrive dans `dist/`) :

| Paquet | Gravité | Chemin | Touche |
|---|---|---|---|
| `wrangler` ≤ 4.130.0 (direct) | haute | → `miniflare` → `undici`, `sharp` | outil de déploiement et dev local |
| `miniflare`, `undici` 7.0–7.29, `sharp` < 0.35.4 | haute | via `wrangler` | dev local et `wrangler deploy` |
| `brace-expansion`, `fast-uri`, `nanoid` < 3.3.18 | haute | transitives (eslint/vite/workbox-build) | build et lint |
| `postcss` ≤ 8.5.22 | modérée | via vite | build |

Correctifs disponibles (`fixAvailable: true`), sans saut de version majeure
signalé.

**Recommandation :** mettre `wrangler` à jour en premier (il tourne avec les
identifiants Cloudflare), puis `npm audit fix` dans un cycle dédié.

### M7 — L'Edge Function `web-search-notices` est toujours présente

**Où :** `supabase/functions/web-search-notices/index.ts`.

**Pourquoi :** le front ne l'appelle plus (CLAUDE.md §9 et `ETAT_PROJET.md`,
« Dettes ouvertes »). Si elle est encore déployée, elle reste appelable par
tout utilisateur authentifié et consomme `ANTHROPIC_API_KEY` (plafond
`DAILY_LIMIT` = 50 par jour et par utilisateur). Elle repose aussi sur le
décodage non vérifié vu en E2 (`:297`).

**Recommandation :** `supabase functions delete web-search-notices`,
supprimer le secret `ANTHROPIC_API_KEY` côté Supabase s'il n'a plus d'usage,
puis retirer le dossier du dépôt.

**Statut : RÉSOLU (2026-10-02).** La fonction n'est plus déployée côté Supabase et son dossier `supabase/functions/web-search-notices/` a été supprimé du dépôt, ainsi que ses mentions dans CLAUDE.md ; elle ne figure pas dans `config.toml`.

---

## Faible

### F1 — `.gitignore` ne couvre pas `.dev.vars`

**Où :** `.gitignore`. Il couvre déjà `.env`, `.env.*` (sauf `.env.example`),
`*.local` et `supabase/.temp/`.

**Pourquoi :** `.dev.vars` est le fichier de secrets local de Wrangler. Aucun
fichier de ce nom n'existe aujourd'hui.

**Recommandation :** ajouter `.dev.vars` et `.dev.vars.*`.

**Statut : RÉSOLU (2026-10-02).** `.dev.vars` et `.dev.vars.*` ajoutés au `.gitignore`.

### F2 — Clé `anon` legacy (JWT) dans l'historique git

**Type :** JWT Supabase, `role: anon`. Clé publique par conception.

**Où on la trouve :**
- `.env.local` : ajouté par le commit `9668fb5` (2026-07-24), retiré par
  `6b0e7bf`.
- `wrangler.jsonc` : présente aux commits `afa70e5` et `a454514`, remplacée
  depuis par la Publishable key `sb_publishable_…`.

**Pourquoi c'est faible :** aucun accès au-delà de la RLS.

**Recommandation :** si les clés legacy ne sont pas encore désactivées dans
Supabase (API Keys → « Legacy »), les désactiver. Réécrire l'historique n'est
pas nécessaire.

### F3 — Clé service_role legacy (fuite d'août, révoquée) : non retrouvée dans git

**Recherche faite** dans `git log --all -p` (253 commits) : `sb_secret_`,
JWT (`eyJ…`), `sk-ant-`, `AIza`, `pplx-`, `AKIA`, chaînes hex de 32 et
64 caractères, `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `x-api-key`
en dur.

**Résultat :**
- Le seul JWT présent est la clé anon (F2).
- Les mentions `sb_secret_`, `CLOUDFLARE_API_TOKEN` et
  `SUPABASE_ACCESS_TOKEN` ne sont que des noms dans la documentation, sans
  valeur.

La fuite d'août est donc passée hors de ce dépôt (chat, n8n, autre canal).
Révoquée : rien à faire ici.

### F4 — CORS `Access-Control-Allow-Origin: *` sur toutes les Edge Functions

**Où :**
- `add-catalog-notice:38` ;
- `add-dossier-equipment-notice:43` ;
- `delete-account:22` ;
- `enroll:18` ;
- `promote-equipment-notice:40` ;
- `send-push:23` ;
- `web-search-notices:45`.

**Pourquoi c'est faible :** l'authentification passe par un bearer explicite,
sans cookie. Le joker ne permet donc pas d'agir au nom d'un utilisateur. Il
ouvre en revanche `enroll` (anonyme) à n'importe quel site.

**Recommandation :** restreindre à l'origine de l'app.

### F5 — Le Worker lit tout le bucket (GET indépendant du préfixe)

**Où :** `worker/index.js:113-122`.

**Pourquoi :** tout utilisateur authentifié lit n'importe quelle clé R2 :
`vault/` (chiffré, donc sans fuite en clair), `communications/` (même
supprimées en soft-delete, la RLS ne s'appliquant pas au R2), `documents/`.
C'est assumé (CLAUDE.md §13), mais à garder en tête.

**Recommandation :** aucune action immédiate. Si le modèle de permissions
évolue, borner GET comme DELETE.

### F6 — `decodeURIComponent` sans `try` dans le Worker

**Où :** `worker/index.js:114` et `:133`.

**Pourquoi :** une clé avec un `%` mal formé lève une `URIError`, d'où une
erreur 500 non gérée (Cloudflare 1101). L'échec reste un refus, sans fuite.

**Recommandation :** entourer d'un `try` et renvoyer 400.

### F7 — `send-push` compare son secret avec `!==`

**Où :** `supabase/functions/send-push/index.ts:66`.

**Pourquoi :** la comparaison n'est pas en temps constant. Exploitation
théorique à travers le réseau.

**Recommandation :** comparer en temps constant
(`crypto.subtle.timingSafeEqual` ou équivalent).

### F8 — Contrôle du bundle non concluant dans ce Codespace

**Ce qui a été fait :** `npm run build` a réussi. La recherche des motifs du
point 1 dans `dist/` ne trouve **aucun secret**.

**Limite :** ce Codespace n'a pas de `.env.local`, donc toutes les `VITE_*`
étaient vides au build. Le bundle de production en contient davantage.

**Analyse par le code des variables lues par le front :**

| Variable | Contenu | Acceptable |
|---|---|---|
| `VITE_SUPABASE_URL` | URL du projet | oui |
| `VITE_SUPABASE_ANON_KEY` | Publishable key | oui |
| `VITE_VAPID_PUBLIC_KEY` | clé publique VAPID | oui |
| `VITE_N8N_INGEST_URL` | URL du webhook n8n | oui (publique) |
| `VITE_N8N_INGEST_SECRET` | secret du webhook | **non** (voir M4) |

**Recommandation :** refaire la recherche des motifs sur le bundle déployé
(Cloudflare) ou sur un build fait avec les vraies variables.

---

## OK (vérifié, conforme)

### Secrets
- Aucune clé service_role, `sb_secret_`, clé Anthropic, Gemini, Perplexity ou
  R2 dans l'arbre de travail ni dans l'historique.
- `.env.example` ne contient aucune valeur.
- `wrangler.jsonc` ne contient que l'URL et la Publishable key.
- Toutes les Edge Functions lisent leurs secrets exclusivement via
  `Deno.env.get`.

### Extraits de recherche (XSS)
- Seul usage de `dangerouslySetInnerHTML` : `src/components/Excerpt.tsx:8`.
- Il n'est alimenté que par `sanitizeHeadline` (`src/screens/SearchScreen.tsx:146`,
  `src/lib/offlineSearch.ts:61,71`).
- Le traitement est conforme à CLAUDE.md §12 : tout le HTML est échappé, seuls
  `<b>` et `</b>` sont restaurés.
- Aucun `innerHTML`, `eval` ni `new Function` dans `src/` et `worker/`.

### Liens externes
- `window.open` est toujours appelé avec `'noopener'`.
- Le seul `<a target="_blank">` (`DocumentScreen.tsx:445`) porte
  `rel="noreferrer"`, ce qui implique `noopener`.
- Communications, notes du carnet et `prix_articles` ne produisent aucun lien
  ni `href` à partir de leurs données.

### Worker
- Toute requête `/api/photos` passe d'abord par `getUser`
  (`worker/index.js:80`), sinon 401.
- Les échecs réseau vers Supabase lèvent une exception, donc 500 :
  l'accès est refusé.
- `checkIsAdmin` et `checkHasDossierVaultAccess` exigent `res.ok && === true` :
  en cas de doute, c'est un refus.
- Aucun en-tête CORS : même origine seulement.
- Pas de sortie de préfixe possible : R2 est un espace de clés plat sans
  normalisation de `..`. Le POST n'accepte que des préfixes en liste blanche
  (`GENERIC_PREFIX_RE`, `GLOBAL_PREFIXES`) et `NAME_RE` interdit `/`. Une
  clé contenant `..` ou `%2e%2e` reste une clé littérale.

### Service worker
- `src/sw.ts` ne fait que le précache des assets du build, une
  `NavigationRoute` vers `index.html` et un `CacheFirst` sur
  `tetris_audio.mp3`.
- Aucune route runtime vers `/auth/v1/`, `/rest/v1/` ni `/api/photos` : aucune
  réponse contenant un token n'est mise en cache.

### Journalisation
- Aucun `console.*` du front, du Worker ou des fonctions n'affiche de token,
  de mot de passe, de clé de coffre, de DEK ou de FEK.
- `webSearch.ts` ne journalise que des identifiants de job et des statuts.
- Les fonctions journalisent des objets d'erreur Supabase et des statuts HTTP.
- `web-search-notices` journalise la marque et le modèle recherchés.

### Rôle anon
- Durcissement appliqué et consigné
  (`supabase/migrations/20261002120000_durcissement_droits_anon.sql`).
- Le seul accès anon légitime est la sonde `HEAD /rest/v1/departments`, sans
  données exposées (policies `TO authenticated`).

### `verify_jwt` des Edge Functions (selon les commentaires du code)

| Fonction | `verify_jwt` | Contrôle | État |
|---|---|---|---|
| `enroll` | false (voulu) | liste blanche service_role | OK, avec la réserve M5 |
| `send-push` | false (voulu) | header `x-push-secret` (`PUSH_HOOK_SECRET`) | OK, avec la réserve F7 |
| `add-catalog-notice` | true | en plus `caller.auth.getUser()` dans le code | OK |
| `add-dossier-equipment-notice` | true | en plus `caller.auth.getUser()` dans le code | OK |
| `promote-equipment-notice` | true | en plus `is_vault_admin` rejoué avec le JWT | OK |
| `delete-account` | true | décodage non vérifié | voir E2 |
| `web-search-notices` | true | décodage non vérifié | voir E2 / M7 |

Il n'y a pas de `config.toml` : ces valeurs sont **à vérifier** dans le
dashboard.

### Dépendances et chaîne de build
- `package-lock.json` est commité.
- Paquets avec scripts d'installation : `esbuild`, `fsevents` (optionnel,
  macOS) et `workerd`. Tous trois en dev uniquement, éditeurs connus.
- Dépendances apparemment inutilisées : aucune.
  - `prettier` sert au script `format` ;
  - `@types/node` est utilisé par `tsconfig.node.json` ;
  - tous les paquets `workbox-*` sont importés par `src/sw.ts` ;
  - les polices `@fontsource` sont importées.
- **À vérifier :** la commande de build du projet Cloudflare. Le `README`
  documente `npm install`. Sans réglage explicite, le système de build
  Cloudflare installe en général avec `npm ci` quand un lockfile est présent.
  Le confirmer dans Workers & Pages → Settings → Build, et forcer
  `npm ci && npm run build` si besoin.
