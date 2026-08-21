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
  pas par workbox). Le `globPatterns` du workbox (`vite.config.ts`) doit
  couvrir tout format d'asset local précaché — actuellement
  `js,css,html,svg,png,ico,woff2,mjs,jpg,jpeg,webp,avif,gif` ; un format
  manquant devient invisible en avion prolongé. Ne jamais laisser une image
  métier (photos carnet, galerie, plans — sur R2) atterrir dans `public/`
  ou `dist/` : seul le shell applicatif doit être précaché.
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
- **Cloudflare Workers** (static assets) pour l'hébergement, avec une route
  API (`/api/photos`, `worker/index.js`) qui sert de proxy authentifié vers
  le bucket **Cloudflare R2** `laydevant-photos` (binding `PHOTOS_BUCKET`) —
  il sert à la fois les PDF de la bibliothèque de documents (préfixe
  `documents/`, §3) et les photos du carnet client (§10). Le Worker valide
  le bearer token en le rejouant sur `GET /auth/v1/user` de l'API Supabase
  Auth avant tout accès ; pas de signed URL, pas de RLS ici, la vérification
  est entièrement côté Worker

Pas de framework CSS lourd, tout en styles inline avec les tokens de
`src/styles/tokens.ts`. Le design est fourni en HTML/CSS dans `design/`, porté
tel quel en composants.

---

## 3. Schéma Supabase

Le backend Supabase est en place et fonctionnel. **Ne pas modifier le schéma
depuis cette app** — les tables métier (départements → documents) et dossiers
sont gérées en dehors de ce dépôt (workflow n8n, admin Supabase direct) ; seules
`web_search_log`, `onboarding_invitations` et l'ajout `dossier_photos.titre`
ont leurs migrations versionnées ici, dans `supabase/migrations/`. Les tables
`dossier_notes`/`dossier_photos` (carnet, §10) ont elles aussi été créées hors
dépôt — seule leur évolution ultérieure (`titre`) est versionnée. Même chose
pour `dossier_equipment_requests` (§10/§11), `communications` (§17) et
`game_scores`/`game_leaderboard` (§18) : créées directement côté Supabase,
aucune migration versionnée ici pour elles non plus.

### Bibliothèque de documents

```
departments      id, name, slug, icon, sort_order
specialties      id, department_id, name, slug, sort_order
products         id, specialty_id, brand, model, name
documents        id, specialty_id, product_id, title, doc_type,
                 storage_provider, file_path, file_size, mime_type, content,
                 source_url, retrieved_at, version_label, tags[], created_by,
                 created_at, updated_at
profiles         id, full_name, role ('monteur' | 'admin')
pinned_documents user_id, document_id, pinned_at
```

`documents.content` contient le texte intégral extrait du PDF. C'est ce champ
qui alimente les deux moteurs de recherche (§8).

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

```
dossier_equipment_requests  id, dossier_id, requested_by, marque, modele,
                            commentaire, specialty_id, status, created_at,
                            resolved_by, resolved_at, resolved_product_id
```

Demande d'équipement manuel absent de la base (§10/§11) : un monteur qui ne
trouve pas son produit dans le picker `dossier_produits` décrit marque
(obligatoire) + modèle + commentaire au lieu de bloquer sur le terrain.
`status` ∈ `pending`/`approved`/`rejected`. Résolue par un admin via la RPC
`resolve_dossier_equipment_request` (section RPC plus bas), jamais par
écriture directe sur `products`.

### Carnet public du dossier (notes + photos)

```
dossier_notes    id, dossier_id, titre, texte, auteur, updated_by,
                 created_at, updated_at
dossier_photos   id, dossier_id, note_id, storage_provider, storage_key,
                 mime, taille, largeur, hauteur, auteur, created_at, titre
```

Partagé en clair entre toute l'équipe, sans rapport avec le coffre (§11) —
voir §10 pour le détail fonctionnel. `dossier_photos.storage_provider` vaut
toujours `'r2'` : les octets vivent dans le bucket Cloudflare R2 `PHOTOS_BUCKET`
(§2), pas dans le Storage Supabase — `storage_key` est la clé R2
(`dossiers/{dossier_id}/{uuid}.{ext}`), jamais une clé du bucket `documents`.
`titre` est un simple champ texte éditable/supprimable sur la photo
existante (aucune copie créée pour ce cas, contrairement à l'annotation par
dessin, §10).

Lues via des vues qui joignent `profiles` pour exposer le nom de l'auteur :
`dossier_notes_view` (+ `updated_by_nom`), `dossier_photos_view` (+
`auteur_nom`). Même piège qu'ailleurs sur les vues : `CREATE OR REPLACE VIEW`
n'autorise pas de réordonner/insérer une colonne existante, seulement d'en
ajouter une en fin de liste — voir la migration `titre` en exemple.

### Recherche web de notices

```
web_search_log   id, user_id, brand, model, created_at
```

Journalise chaque appel à l'Edge Function `web-search-notices` : garde-fou de
coût (plafond quotidien par utilisateur) et traçabilité. Voir §9.

### Onboarding (allowlist)

```
onboarding_invitations  email (PK), role, note, created_by, created_at,
                        consumed_at, consumed_by
```

Liste blanche d'emails autorisés à créer un compte applicatif. RLS
admin-only ; consultée uniquement par l'Edge Function `enroll` en
service_role. Voir §7.

### Communications d'entreprise

```
communications  id, titre, storage_provider, storage_key, mime, taille,
                auteur, deleted_at, deleted_by, created_at
```

Espace global, sans `dossier_id` — voir §17. Lue via la vue
`communications_view` (`security_invoker`, joint `profiles` pour
`auteur_nom`, même convention que les vues du carnet §3/§10).
`profiles.is_comms_publisher` (booléen) porte le droit de publier, en plus du
rôle `admin`.

### Mini-jeu (PdfTetris) et classement

```
game_scores  user_id, best_score, best_lines, updated_at
```

Une ligne par utilisateur (`user_id` PK), ne garde que le meilleur score —
voir §18. Lu via la vue `game_leaderboard` (déjà triée), qui expose `joueur`
(nom joint depuis `profiles`).

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
  trouvés. Voir §12 pour le traitement obligatoire.
- La fonction exige une requête. Elle ne sert pas au mode parcours (§8).
- Matche `title`/`content` mais aussi marque/modèle (`products.brand`,
  `products.model`) — et par **préfixe** sur chaque terme (CTE `pq`,
  `regexp_split_to_table` + `:*` côté `tsquery`), pas seulement par mot
  entier : une requête partielle sur un modèle en cours de frappe remonte
  déjà des résultats.

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

**`resolve_dossier_equipment_request(request_id, specialty_id, approve)`** —
approuve ou rejette une demande d'équipement manuel (§3/§10/§11). `SECURITY
DEFINER`, admin-only (`is_vault_admin`, même prédicat que le reste des
actions admin du coffre, pas une notion propre aux communications). Si
`approve`, crée ou réutilise le produit (recherche insensible à la casse sur
marque/modèle) et le rattache au dossier de la demande, atomiquement.

```ts
supabase.rpc('resolve_dossier_equipment_request', {
  p_request_id: requestId,
  p_specialty_id: specialtyId,  // requis si approve
  p_approve: true,
});
```

**`soft_delete_communication(p_id)`** — supprime (soft) une communication.
`SECURITY DEFINER`, admin/publisher (revérifié en interne). Existe
spécifiquement pour contourner un piège RETURNING/RLS documenté juste après
la section RLS ci-dessous — jamais un `.update()` direct sur `communications`.

```ts
supabase.rpc('soft_delete_communication', { p_id: id });
```

**`set_comms_publisher(p_user_id, p_enabled)`** — active/révoque le droit de
publier une communication pour un monteur. `SECURITY DEFINER`, admin-only.
Voir §17 pour le trigger anti-auto-octroi côté `profiles`.

```ts
supabase.rpc('set_comms_publisher', { p_user_id: userId, p_enabled: true });
```

### RLS

- Bibliothèque : tout utilisateur authentifié **lit** ; seuls les `admin`
  **écrivent**. Les épingles (`pinned_documents`) sont strictement privées à
  chaque utilisateur.
- `web_search_log` : chaque utilisateur écrit/lit ses propres lignes ; les
  `admin` lisent tout.
- Dossiers (y compris `dossier_notes`/`dossier_photos`, carnet §10) :
  lecture/écriture pour tout utilisateur authentifié (pas de restriction par
  créateur à ce stade) — `updateDossierNote`/`updateDossierPhotoTitre`
  écrivent directement sur la table, jamais via la vue.
- `onboarding_invitations` : admin-only (lecture et écriture). L'anon n'a
  aucune policy — le front n'y accède jamais, seule l'Edge Function `enroll`
  la consulte en service_role (§7).
- `dossier_equipment_requests` : `select` tout utilisateur authentifié
  (nécessaire à `listPendingEquipmentRequests`, garde-fou admin côté requête
  plutôt que RLS — §11), `insert` réservé à sa propre ligne
  (`requested_by = auth.uid()`). Résolution (`status`, `resolved_*`)
  exclusivement via la RPC `resolve_dossier_equipment_request` (admin-only,
  `SECURITY DEFINER`) — jamais d'`update` direct côté client.
- `communications` : `select` tout utilisateur authentifié avec
  `deleted_at IS NULL` ; `insert` admin/publisher, sur sa propre ligne
  (`auteur = auth.uid()`) ; `update` admin/publisher, sur toute ligne. Voir
  le piège RETURNING ci-dessous — la suppression passe par une RPC, jamais
  par un `update` direct malgré la policy `UPDATE` existante.
- `game_scores`/`game_leaderboard` : chacun écrit/lit sa propre ligne de
  score ; le classement (vue) est lisible par tout utilisateur authentifié.

L'application n'a donc jamais besoin d'écrire ailleurs que dans
`pinned_documents`, `web_search_log`, `dossiers`, `dossier_produits`,
`dossier_documents`, `dossier_notes`, `dossier_photos`,
`dossier_equipment_requests` et `game_scores` — jamais dans
`documents`/`products` directement (ça reste le rôle du pipeline d'ingestion
n8n, y compris pour la capture web, §9), ni dans `communications` en écriture
de suppression (RPC, cf. piège ci-dessous).

**Piège — soft-delete et policy SELECT restrictive.** Un `UPDATE` posant
`deleted_at` via PostgREST échoue en `42501` (« new row violates row-level
security policy ») dès que la policy `SELECT` de la table filtre
`deleted_at IS NULL` — confirmé dans les logs Postgres : PostgREST génère un
`RETURNING` implicite sur l'`UPDATE` **même en `Prefer: return=minimal`** (qui
ne contrôle que la sérialisation de la réponse, pas la présence du
`RETURNING` côté SQL), et Postgres re-vérifie la ligne modifiée contre la
policy `SELECT` à cause de ce `RETURNING` — même `RETURNING 1`, une
constante. L'`UPDATE` réussit pourtant en SQL direct (sans `RETURNING`), ce
qui peut faire croire à tort à un problème de rôle/JWT. Indépendant du
SDK/fetch manuel/header `Prefer` : aucun contournement côté client ne
fonctionne. **Fix** : RPC `SECURITY DEFINER` qui fait l'`UPDATE` hors RLS en
revérifiant les droits en interne (`soft_delete_communication`, ci-dessus).
Les tables à policy `SELECT` `using(true)` (`dossier_plans`/`dossier_notes`/
`dossier_photos`) y échappent structurellement — pas de conflit possible.
`dossier_equipment_requests` n'a pas été vérifiée pour ce piège précis.

### Stockage

Les PDF de la bibliothèque vivent dans le bucket **Cloudflare R2**
`laydevant-photos` (même bucket que les photos du carnet, §10), sous le
préfixe `documents/` — la clé R2 complète est `'documents/' + file_path`.
`documents.storage_provider` (`'supabase' | 'r2'`) distingue le backend ligne
par ligne ; **toutes les lignes valent aujourd'hui `'r2'`** depuis la
migration qui a vidé le bucket Supabase `documents`.

Lecture d'un PDF — double-lecture branchée sur `storage_provider` dans
`fetchOnlineDetail` (`src/screens/DocumentScreen.tsx`) :

- `'r2'` → `fetchPdfBlobR2` (`src/lib/documents.ts`), qui récupère les octets
  via le Worker `/api/photos` (§2) et renvoie un `Blob`. `file_path` lui est
  transmis **nu** (sans le préfixe `documents/`, ajouté côté Worker/R2).
- sinon (repli `'supabase'`, chemin conservé dans le code mais plus jamais
  emprunté par les données actuelles) → `fetchPdfBlob`, URL signée Supabase
  Storage :
  ```ts
  supabase.storage.from('documents').createSignedUrl(file_path, 3600);
  ```

Dans les deux cas le résultat est **toujours un `Blob`** — ne jamais mélanger
`Blob` et object URL entre les deux branches. `getDocumentDetail`
(`src/lib/documentDetail.ts`) inclut `storage_provider` dans son `SELECT` ;
`DocumentRow` (`src/types/database.ts`) porte `storage_provider`, `file_path`,
`mime_type`.

Les photos du carnet client (§10) partagent le même bucket R2, sous un
préfixe différent (`dossiers/{dossier_id}/{uuid}.{ext}`) — RLS Postgres non
applicable à ces octets ni aux PDF R2 ; la vérification d'accès est
entièrement côté Worker (bearer token rejoué sur Supabase Auth, §2).

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

C'est le cœur du projet pour la partie bibliothèque. Quatre couches de stockage
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

1. Récupérer le PDF en `Blob`, backend branché sur `storage_provider` — même
   motif que l'ouverture (§3) : `'r2'` via le Worker `/api/photos`, repli
   `'supabase'` via URL signée + `fetch()`. Le type MIME est forcé
   explicitement plutôt que de faire confiance au Content-Type du stockage,
   qui peut être absent ou faux côté objets uploadés par n8n.
2. Stocker le blob dans le Cache API (`pdfCache.ts`, cache
   `laydevant-offline-pdfs`) sous une clé stable : `/offline-pdf/{document_id}`
3. Stocker métadonnées + `content` dans IndexedDB (`db.ts`, base
   `laydevant-docs`, store `pinnedDocuments`)
4. Insérer la ligne dans `pinned_documents` (synchronise l'épingle entre appareils)

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

## 7. Onboarding — enrôlement par liste blanche (allowlist)

**Implémenté.** Migration, Edge Function `enroll`, écran d'auto-enrôlement
(`EnrollScreen`, bascule sans routeur depuis `LoginScreen` via `AuthGate`,
`src/App.tsx`) et onglet "Onboarding" du panneau admin du coffre
(`VaultAdminScreen`, gestion des invitations). Restent à faire côté
exploitation : déployer `enroll` avec `--no-verify-jwt`, puis couper les
inscriptions publiques Supabase (voir séquencement plus bas).

Création de compte contrôlée : pas d'inscription publique. Un admin "invite"
un email, la personne s'auto-enrôle à l'URL de l'app (email connu + mot de
passe qu'elle choisit + nom). Choisi pour une équipe peu à l'aise avec l'email
(Outlook réinitialisé tous les 90 jours) : zéro round-trip email, zéro SMTP,
mot de passe choisi par l'utilisateur.

**Le verrou est CÔTÉ SERVEUR, jamais l'URL ni le client.** L'URL de l'app
n'est pas secrète et la clé anon est publique : l'obscurité ne protège rien.
Deux mesures indissociables :
- **Inscriptions publiques Supabase désactivées** (sinon `signUp()` anon
  contourne toute la liste — elle deviendrait décorative).
- **Edge Function `enroll` (service_role)** : vérifie que l'email est bien
  pending et non consommé AVANT de créer le compte. Même pattern que
  `web-search-notices` (§9) : une fonction serveur tient le secret et fait le
  contrôle.

Flux : admin ajoute email + rôle (monteur/admin) → personne saisit email +
mot de passe + nom → `enroll` valide le pending, `auth.admin.createUser(...,
email_confirm: true)` (pas d'email de confirmation, connexion immédiate), crée
le profil (nom + rôle de l'invitation), marque l'invitation consommée → login.

**Table `onboarding_invitations`** (`supabase/migrations/20260731090000_onboarding_invitations.sql`) :
`email` PK (normalisé lower+trim par trigger), `role`, `note`, `created_by`,
`created_at`, `consumed_at` (null = pending), `consumed_by`. RLS **admin-only**
(une policy `for all`) : l'anon n'a AUCUNE policy, la page d'enrôlement ne lit
donc jamais la liste des emails invités (sinon fuite). Seule l'Edge Function
la consulte, en service_role.

**Ne pas confondre avec l'enrôlement du coffre.** Ici on crée le COMPTE
APPLICATIF (login Supabase + profil : accès documents, dossiers, carnet).
L'enrôlement du COFFRE (paire RSA + mot de passe de coffre, §11) reste une
étape séparée, dans l'app, après login — c'est là que vit la règle
"récupérateurs d'abord", inchangée. Un monteur onboardé utilise toute l'app ;
son coffre reste verrouillé tant qu'il n'a pas fait son enrôlement coffre ET
qu'un admin ne lui a pas donné accès.

**Deux mots de passe distincts** : le mot de passe créé à l'onboarding est le
LOGIN Supabase. Il ne doit être ni confondu ni réutilisé avec le mot de passe
de COFFRE (défense en profondeur : le login part chez Supabase Auth, l'acteur
même contre qui protège le zero-knowledge du coffre).

**Séquencement du déploiement** : couper les inscriptions publiques Supabase
seulement APRÈS que `enroll` est déployée et testée — jamais avant, sinon
fenêtre où plus aucun compte ne peut être créé.

### Suppression de compte — Edge Function `delete-account`

Pendant symétrique de `enroll`, dans l'onglet "Comptes" du panneau admin du
coffre : bouton "Supprimer le compte", **monteur uniquement, jamais admin**,
**et seulement si l'accès coffre de la cible est déjà révoqué** (onglet
"Accès" au préalable) et qu'elle n'est pas récupérateur. Contrairement à
`enroll`, `verify_jwt` reste **activé** — l'appelant est déjà authentifié. La
fonction revérifie tout côté serveur (appelant admin, cible non-admin, accès
coffre non actif, pas récupérateur) via `service_role` avant d'appeler
`auth.admin.deleteUser` : les mêmes garde-fous que l'UI, jamais la seule
protection réelle.

`src/lib/vaultAdmin.ts` expose `listAllProfiles()` (tous les profils, pas
seulement les enrôlés au coffre — un monteur qui n'a jamais touché au coffre
doit rester supprimable) et `deleteAccount(userId)`.

Piège connu, assumé pour l'instant : si le compte cible a de l'historique
dans des tables gérées hors de ce dépôt sans `ON DELETE CASCADE` vers
`auth.users` (`dossiers.created_by`, `dossier_notes.auteur`, etc.),
`auth.admin.deleteUser` échoue avec une contrainte de clé étrangère — l'erreur
réelle remonte telle quelle (échec honnête, §9) plutôt qu'un message
trompeur ; pas de tentative de réattribution/suppression automatique de ce
contenu, qui reste une décision produit à trancher séparément.

---

## 8. Bibliothèque de documents — recherche et parcours

### Deux moteurs de recherche

**En ligne** — `search_documents` (§3), couvre tout le corpus.

**Hors ligne** — index MiniSearch (`src/lib/offlineSearch.ts`) construit à la
demande sur le `content` des documents épinglés uniquement (pas d'index
persistant : le nombre de documents épinglés reste petit, reconstruire à
chaque recherche est plus simple qu'un maintien incrémental). Il produit des
extraits surlignés en repassant par la **même fonction** `sanitizeHeadline`
que le moteur en ligne (§12) : les deux moteurs sont donc garantis visuellement
identiques par construction, pas par coïncidence. L'index indexe aussi
`productLabel` (marque + modèle, dénormalisé au moment de l'épinglage, §5) en
plus de `title`/`content`, avec un boost supérieur (`3`, contre `2` pour
`title`) : la marque/le modèle est le signal d'identité le plus fort pour un
technicien qui tape ce qu'il a sous les yeux sur l'équipement.

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
   Dès qu'une requête texte est saisie, la portée département/spécialité est
   forcée à `null` (`effectiveDepartmentId`/`effectiveSpecialtyId`, chokepoint
   unique dans `SearchScreen`) : chercher un texte cherche **toujours** sur
   toute la bibliothèque, même si l'utilisateur a navigué jusqu'ici via un
   département précis — seul le parcours sans saisie (drill-down par tuiles)
   reste scopé à la sélection courante.
4. **Fiche document** — visualiseur PDF in-app (pdf.js, lazy-loadé) avec un
   raccourci « Voir en plein écran » (le même blob rouvert via
   `window.open`/blob URL, pour le lecteur PDF natif d'Android), lien
   « Source fabricant » si `source_url` est renseigné, et les trois états
   d'enregistrement du §5.

Les « derniers documents consultés » sont **locaux à l'appareil** (IndexedDB),
pas synchronisés. Ils restent consultables hors ligne si le document est
épinglé, grisés sinon.

---

## 9. Recherche web de notices et capture

Extension en ligne uniquement, pour les produits absents de la bibliothèque.
Deux chemins distincts : la recherche elle-même (pipeline back-end détaillé
ci-dessous) et la capture d'un résultat vers la bibliothèque (webhook n8n
`ingest-from-url`, inchangée). Le pourquoi de l'architecture ci-dessous —
refonte complète, terminée et déployée — est dans
`HANDOFF_recherche_web_ensemble_juge.md` ; état courant résumé dans
`ETAT_PROJET.md`. Ce document remplace l'ancienne architecture à 2 moteurs
(Anthropic + Perplexity, chacun sa colonne) et l'ancienne Edge Function
`web-search-notices` (Anthropic direct, sync) — les deux **abandonnées**.

### Recherche — pipeline back-end (3 moteurs + juge LLM)

```
PWA → INSERT web_search_jobs (status='pending')
    → trigger notify_n8n_web_search() → webhook n8n "notices-search"
    → 3 moteurs (Serper, Gemini Flash + Grounding, Perplexity sonar-pro)
    → validation HTTP du pool (AVANT le juge) → juge Claude Haiku 4.5
    → écrit web_search_jobs.final_results / status_final → PWA poll
```

- Le front (`src/lib/webSearch.ts`) n'appelle **plus aucune Edge Function ni
  l'API Anthropic** : il fait un simple `INSERT` dans `web_search_jobs`
  (`brand`, `model` requis, `equipment_type`/`department_name`/
  `specialty_name` optionnels) puis poll `status_final`/`final_results` sur
  la même table jusqu'à `'done'` (ou `'error'`), avec un filet de timeout
  client (`HARD_LIMIT_MS` ~300 s → `WebSearchTimeoutError`, « recherche
  interrompue »). L'ancienne Edge Function `web-search-notices` n'est plus
  appelée par le front (débranchement effectif côté code applicatif —
  dépôt/redéploiement Supabase à confirmer séparément).
- Le trigger Postgres `notify_n8n_web_search()` (`SECURITY DEFINER`,
  `AFTER INSERT WHEN status='pending'`) appelle **un seul** webhook n8n
  (`notices-search`, `net.http_post`, header
  `rechercheweb-webhook-secret`, body `{job_id}`) — garde-fou : si l'URL ou
  le secret sont `null` en base (`private_config`), il `return NEW` sans
  jamais casser l'`INSERT` du job.
- Le workflow n8n unique lance **3 moteurs en séquence** (n8n ne parallélise
  pas les branches fannées ; dégradation gracieuse, `Continue On Fail` par
  nœud) : **Serper** (2 requêtes — normale + `filetype:pdf`, `gl:'ch'`/
  `hl:'fr'`, rappel pur), **Gemini Flash + Grounding** (`gemini-3.5-flash`,
  `google_search`, `thinkingBudget:0` obligatoire sous peine de réponse sans
  `candidates`, timeout 90 s), **Perplexity `sonar-pro`**. Chaque moteur
  maximise le **rappel** ; c'est le juge qui fait la **précision** en aval —
  pré-filtrer avant le juge lui cacherait des candidats valides.
- **Validation AVANT le juge** (la correction clé de la refonte, contre les
  hallucinations d'URL de Gemini) : une shortlist (documents ≤15 + vidéos
  ≤3, pool dédupliqué avec un compte d'accord inter-moteurs `engine_count`)
  est validée en HTTP **en parallèle** (nœud Code, `Promise.all`, HEAD puis
  GET Range, suit les redirections y compris `vertexaisearch`) — le juge ne
  voit que des candidats dont `link_ok`/`content_type`/`is_pdf` sont
  **vérifiés**, jamais supposés depuis un snippet. `content_type` fait
  autorité sur `is_pdf` (un `text/html` écrase un `is_pdf:true` supposé) ;
  `link_ok:false` reste un avertissement doux, jamais « lien mort ».
- **Le juge** : Claude Haiku 4.5, appelé directement par le nœud n8n
  (`api.anthropic.com/v1/messages`, Header Auth `x-api-key` +
  `anthropic-version` — **plus aucune Edge Function Supabase dans la
  boucle**), déduplique/priorise/écarte le hors-sujet parmi les candidats
  validés ; URL **verbatim** obligatoires (jamais inventées/modifiées),
  préférence au corroboré (≥2 moteurs) + `link_ok:true`, aux grossistes
  suisses légitimes (ottofischer/flextron/feller/sonepar/eldas — sources
  documentaires reconnues, pas des revendeurs à exclure), langue FR sinon
  DE/EN complet. **Repli mécanique** (tri par type/confiance, sans juge) si
  l'appel échoue ou rend un JSON invalide — l'utilisateur n'est jamais
  bloqué. Jusqu'à 5 documents pertinents (jamais gonflés à 5 avec du
  hors-sujet) + 1 vidéo d'installation/paramétrage en dernier si pertinente
  (6 résultats max).
- Sortie (`WebSearchResult`, `src/types/webSearch.ts`) :
  `{ type, title, url, is_pdf, source, confidence, link_ok?, http_status?,
  content_type? }[]`. `type` ∈ `notice_installation`, `manuel_programmation`,
  `fiche_technique`, `autre` (sous-ensemble de `doc_type`, sans
  `schema`/`fiche_perso`) **+ `video`** — jamais capturable vers la
  bibliothèque (`is_pdf` toujours faux), ouverture externe (`window.open`)
  uniquement, affichée en dernier dans la liste.
- Modèle de données : `web_search_jobs` porte désormais `status_final`
  (`'processing'`/`'done'`/`'error'`) et `final_results` (jsonb, déjà
  trié/dédupliqué par le juge) et `done_at_final`. Les anciennes colonnes
  par moteur (`results_anthropic`/`_perplexity`, `status_*`, `done_at_*`)
  sont **obsolètes mais encore en place** (nettoyage différé, pas encore
  fait). Nouvelle table enfant `web_search_results` : journal
  d'observabilité, une ligne par moteur par job + une ligne `juge` —
  **RLS activée, zéro policy** (service-only) : le front ne la lit jamais,
  il poll uniquement `web_search_jobs`.
- Dette connue (voir `ETAT_PROJET.md`, « Dettes ouvertes ») : nettoyer les
  colonnes par moteur obsolètes de `web_search_jobs`, supprimer/débrancher
  pour de bon l'Edge Function `web-search-notices` et les anciens workflows
  n8n Anthropic/Perplexity, purger la clé orpheline
  `private_config.n8n_webhook_url_pplx`. Le contexte du job
  (`equipment_type`/`department_name`/`specialty_name`) est le signal le
  plus fort du juge contre les homonymes (ex. « ALADIN » récepteur radio vs
  théâtre) — vérifier qu'il est bien rempli côté front à chaque recherche.

### Capture vers la bibliothèque — webhook n8n `ingest-from-url`

```
PWA → webhook n8n "ingest-from-url" → télécharge le PDF → mêmes étapes que le
     formulaire d'ingestion existant (extraction texte, upload R2, upsert
     produit + insert document) → confirmation
```

- Le bouton « Ajouter à la bibliothèque » n'apparaît que si `is_pdf` est true
  côté résultat. L'utilisateur ajuste les métadonnées auto-détectées (marque,
  modèle, spécialité — choisie parmi les spécialités existantes, type de
  document) dans une feuille de confirmation (`CaptureSheet`) avant envoi.
- `src/lib/captureIngest.ts` poste vers `VITE_N8N_INGEST_URL`, avec un header
  `x-webhook-secret: VITE_N8N_INGEST_SECRET`. Le front n'écrit **jamais**
  directement dans R2 ni dans `documents`/`products`.
- Les 3 workflows d'ingestion n8n (formulaire, capture URL, lot) écrivent
  l'octet en R2 (`documents/{file_path}`) et insèrent la ligne avec
  `storage_provider = 'r2'` (littéral dans l'`INSERT`, aucun paramètre `$N`
  ajouté).
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

## 10. Dossiers clients (étape A)

Écrans en ligne uniquement : `DossiersScreen` (liste/recherche/création),
`DossierScreen` (fiche — équipements, documentation, ouverture du coffre de
données sensibles — §11, `Feature coffre données sensibles.md`). Code dans
`src/lib/dossiers.ts`, `src/screens/Dossier*.tsx`,
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
- **Équipement absent du picker** — un monteur qui ne trouve pas son produit
  décrit marque/modèle/commentaire (`createEquipmentRequest`,
  `dossier_equipment_requests`, §3) au lieu de bloquer sur le chantier ; la
  section liste ses demandes `pending` en attente
  (`listDossierEquipmentRequests`). Résolution admin-only, dans l'onglet
  "Demandes" de `VaultAdminScreen` (§11) — jamais dans cet écran.
- Ouvrir un document depuis une fiche dossier respecte les mêmes règles
  d'accès que la bibliothèque : si le document est épinglé, il s'ouvre même
  hors ligne ; sinon, réseau requis.
- Pas de mode hors ligne pour cette étape : un dossier déjà chargé reste
  affiché si la connexion tombe, mais tout rechargement ou toute écriture
  exige le réseau (bandeau explicite dans les deux écrans).

### Carnet public du dossier (notes + photos)

`CarnetSection.tsx`, rendu dans `DossierScreen`. Partagé en clair entre toute
l'équipe (pas de chiffrement, pas de zero-knowledge) — à distinguer nettement
du coffre de données sensibles (§11) : compte-rendu de visite, photos
d'installation, repères utiles au reste de l'équipe. Table Supabase séparée
des `dossiers` (§3). En ligne uniquement, comme le reste de l'étape A.

- **Notes** — texte libre avec titre optionnel, `NoteFormSheet` pour créer et
  modifier, confirmation avant suppression.
- **Photos** — upload multiple (`<input type=file accept=image/*>`),
  redimensionnées/recompressées côté client avant envoi (`compressImage`,
  canvas, 1600px max, JPEG qualité 0.75) puis envoyées séquentiellement (pas
  `Promise.all` : une connexion chantier ne supporte pas des uploads en
  parallèle) vers le Worker `/api/photos` → R2 (§3). Les octets ne
  transitent jamais par IndexedDB ni Cache API : chaque vignette est
  récupérée à la demande (`getPhotoObjectUrl`, JWT requis) en object URL,
  révoquée dès que la liste change — pas de hors ligne pour cette étape
  (§5 ne couvre que la bibliothèque).
- **Titre de photo** — `updateDossierPhotoTitre`, simple édition du champ
  `titre` sur la ligne existante (pas de copie). Éditable/supprimable depuis
  le visualiseur plein écran ; vider le champ et valider supprime le titre.
  Affiché en légende sur la vignette si renseigné.
- **Annotation (dessin libre)** — `PhotoAnnotator.tsx`, ouvert depuis le
  visualiseur plein écran d'une photo. Dessin à main levée par-dessus
  l'image (pointer events, 3 couleurs, annuler le trait/tout effacer),
  aplati en JPEG à l'enregistrement et envoyé via le **même**
  `uploadDossierPhoto` que l'upload direct : le résultat est toujours une
  **nouvelle** photo, jamais un remplacement. Supprimer la photo source ne
  supprime pas les annotations déjà créées à partir d'elle — aucune relation
  n'est stockée entre l'original et ses annotations, ce sont des lignes
  `dossier_photos` indépendantes.

---

## 11. Ce qui reste à faire

**Étape B — coffre de données sensibles : TERMINÉE.** Spécifiée et
implémentée en totalité (tranches 1 à 6) ; détail complet et récapitulatif
dans `Feature coffre données sensibles.md` (§12 pour l'état réel, y compris
les quelques écarts par rapport à la conception initiale). Chiffrement
côté client (WebCrypto), zero-knowledge vis-à-vis de Supabase, panneau admin
(comptes / accès / rotation).

Fichiers clés :

- `src/lib/vault.js` + `vault.d.ts` — cœur crypto (WebCrypto pur), testé de
  façon isolée par `src/lib/test-vault.mjs` (20/20, `node test-vault.mjs`).
- `src/lib/vaultEnroll.ts`, `src/screens/VaultEnrollScreen.tsx` — enrôlement
  (flux strict admin avec clé papier / flux léger monteur sans clé papier).
- `src/lib/vaultSecrets.ts`, `src/lib/vaultSession.tsx`,
  `src/lib/useVaultSession.ts`, `src/components/VaultSheet.tsx` — ouverture,
  verrouillage, édition du contenu (notes multiples) depuis la fiche dossier.
- `src/lib/vaultAdmin.ts`, `src/screens/VaultAdminScreen.tsx` — panneau admin
  (comptes, activer/réparer l'accès, révoquer). Héberge aussi, au-delà du
  coffre : le toggle "peut publier" (`is_comms_publisher`, lignes monteur
  uniquement, §17) dans l'onglet "Comptes", et l'onglet "Demandes"
  (approbation/rejet des demandes d'équipement manuel, §10, via
  `listPendingEquipmentRequests`/`resolveEquipmentRequest`).
- `src/lib/vaultRotation.ts`, `src/components/VaultRotationSheet.tsx` —
  rotation de clé, déclenchée depuis l'onglet "Rotation" du panneau admin.
- `supabase/migrations/20260728190000_vault_user_keys.sql`,
  `20260728190500_vault_secrets_access.sql`,
  `20260729_184323_vault_recovery_admin.sql`,
  `20260730_090000_vault_rotate_secret.sql` — les 4 migrations vault (schéma,
  RLS, rôle admin-récupérateur, rotation atomique via RPC `SECURITY DEFINER`).

Dette restante : pas d'interface pour supprimer la ligne `vault_user_keys`
d'un monteur avant un ré-enrôlement après mot de passe perdu (repose sur une
suppression manuelle en base — la RLS l'autorise déjà) ; pas de geste pour
retirer le rôle `is_recovery_admin` (assumé, message explicite dans l'onglet
Accès).

**Chantier en cours — onboarding par liste blanche (§7).** Spécifié, migration
`onboarding_invitations` versionnée. Restent à construire : l'Edge Function
`enroll` et l'écran d'auto-enrôlement côté PWA, puis la coupure des
inscriptions publiques Supabase (dans cet ordre, §7).

**Carnet non-sensible (notes + photos) : TERMINÉ pour le périmètre actuel.**
Notes, photos, titre de photo et annotation par dessin libre — détail complet
en §10. Construit directement (schéma créé hors dépôt puis documenté ici),
sans passer par un fichier `Feature ... .md` dédié comme les autres chantiers
notables — écart assumé à ce stade, pas de nouvelle fonctionnalité de fond
depuis à re-spécifier séparément pour l'instant.

Dette connue : pas de relation stockée entre une photo et ses annotations
(§10) — si utile un jour (regrouper visuellement l'original et ses dérivés),
ce sera une colonne `dossier_photos.annotation_de` à ajouter, pas un
changement de comportement à la suppression (déjà volontairement
indépendant). Pas de mode hors ligne, cohérent avec le reste de l'étape A
(§5, §10).

**Demande d'équipement manuel : TERMINÉ.** Table, RPC `SECURITY DEFINER`,
couche data et UI (monteur + admin) en place — détail en §3/§10 et dans
l'onglet "Demandes" ci-dessus. `dossier_equipment_requests` n'a pas été
vérifiée pour le piège RETURNING/policy SELECT documenté en §3 — à faire si
un futur soft-delete est ajouté sur cette table.

**Communications d'entreprise : TERMINÉ.** Détail complet en §17.

**Mini-jeu (PdfTetris) et classement : TERMINÉ.** Détail complet en §18.

---

## 12. Traitement obligatoire de l'extrait surligné

`ts_headline` (moteur en ligne) renvoie du HTML **non échappé**. Le champ
`content` provient de PDF téléversés : il peut contenir n'importe quoi, y
compris des balises. Injecter `extrait` directement dans le DOM serait une
faille XSS. Le moteur hors ligne (§8) construit son propre extrait en texte
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

## 13. Sécurité

- **Seule la clé `anon` figure dans l'application front.** Jamais la clé
  `service_role` : elle contourne la RLS. Elle reste exclusivement dans n8n.
- **`ANTHROPIC_API_KEY` ne vit que dans les credentials du workflow n8n**
  (nœud Juge, Header Auth `x-api-key`, §9) — jamais dans le front, jamais
  dans une Edge Function Supabase, jamais dans Git.
- `VITE_N8N_INGEST_SECRET` (header `x-webhook-secret` du webhook de capture)
  n'est **pas** un vrai secret. Comme tout `VITE_*`, il est figé au build donc
  inscrit en dur dans le bundle JS — lui-même servi en static asset public,
  avant tout login. Il est donc extractible par quiconque ouvre l'URL : c'est
  un garde-fou faible (obfuscation), pas une authentification. Sa seule
  fonction est d'écarter les appels accidentels au webhook. Le risque associé
  — écriture non authentifiée vers la bibliothèque (pollution, conso
  n8n/Supabase, pas d'exfiltration) — est **accepté à ce stade** car l'outil
  est interne. Pour un durcissement réel, router la capture par une Edge
  Function `verify_jwt` (comme `delete-account`/`promote-equipment-notice`)
  qui rappellerait n8n avec un secret côté serveur — à faire dans un cycle
  dédié si besoin. Reste malgré
  tout jamais commité (`.env*` dans `.gitignore`, seul `.env.example` sans
  valeurs est versionné).
- La clé `anon` est publique par conception ; c'est la RLS qui protège les
  données. `SUPABASE_ANON_KEY` dupliquée dans les `vars` du Worker (§14) est
  cette même clé publique, pas un nouveau secret.
- Le Worker `/api/photos` (§2/§3/§10) valide qu'un JWT Supabase est présent
  et valide, mais ne vérifie pas que l'appelant a un lien avec le
  `dossier_id` ni avec le document demandé — cohérent avec la RLS `dossiers`
  (lecture/écriture pour tout utilisateur authentifié, §3), pas un
  relâchement supplémentaire, mais à garder en tête si ce modèle de
  permission évolue un jour.
- La lecture (`GET`) du Worker est volontairement préfixe-agnostique (elle
  sert aussi bien `documents/` que les autres préfixes du bucket) et
  l'upload (`POST`) reste borné par deux allowlists : `GENERIC_PREFIX_RE`
  (préfixes à segment d'entité, `galerie|plans` — les PDF, eux, sont écrits
  en R2 par n8n, jamais par le Worker, §9) et `GLOBAL_PREFIXES` (préfixes
  globaux à segment unique, sans entité rattachée — `communications`, §17).
  **`DELETE` est admin-only pour tout préfixe SAUF `vault/`**
  (`checkIsAdmin`, rejoue le JWT de l'appelant sur la RPC `is_vault_admin` —
  même rôle admin que le reste de l'app, pas une notion propre au coffre) :
  `documents/`, `plans/`, `galerie/`, `communications/…` restent strictement
  admin-only — tolérable tant que Supabase Storage servait de filet pour les
  PDF, ce n'est plus le cas depuis que R2 en est la **source unique** (bucket
  Supabase `documents` vidé, §3) — une suppression malveillante ou
  accidentelle y serait irréversible sans re-ingestion n8n. Sous
  `vault/{dossierId}/…` (fichiers chiffrés du coffre), le Worker autorise
  **aussi** un utilisateur non-admin ayant accès au dossier
  (`checkHasDossierVaultAccess`, rejoue le JWT sur la RPC
  `has_dossier_vault_access(p_dossier_id)`, testée en premier —
  `is_vault_admin` n'est rejouée qu'en repli si cet accès échoue) : miroir
  volontaire de la policy `DELETE` de `vault_files` côté Postgres (accès
  nominatif OU admin), pas un relâchement de la règle admin-only ci-dessus
  pour les autres préfixes.
- Les URL signées Supabase Storage (repli `storage_provider = 'supabase'`,
  §3) expirent (1 h) : ne pas les stocker, les régénérer à la demande. Une
  fois le PDF téléchargé dans le Cache API, il est servi localement et
  l'expiration n'a plus d'effet.
- **Règle de contenu** (§9) : documentation fabricant librement diffusée
  uniquement — jamais de contenu sous licence de tiers (normes NIN/NIBT,
  contenus payants) capturé vers la bibliothèque.

---

## 14. Déploiement

Cloudflare Workers avec static assets (et non Cloudflare Pages, déprécié pour
les nouveaux projets). Build statique (`npm run build` : type-check puis build
Vite), déploiement automatique depuis GitHub à chaque push sur `main`, ou
manuel via `npm run deploy` (`wrangler deploy`, nécessite `wrangler login`).

`wrangler.jsonc` à la racine :

```jsonc
{
  "name": "laydevant-app",
  "compatibility_date": "2026-07-24",
  "main": "worker/index.js",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
    "binding": "ASSETS",
  },
  "r2_buckets": [
    { "binding": "PHOTOS_BUCKET", "bucket_name": "laydevant-photos" },
  ],
  "vars": {
    "SUPABASE_URL": "...",
    "SUPABASE_ANON_KEY": "...",
  },
}
```

Le mode `single-page-application` gère le routage côté client : inutile
d'ajouter un fichier `_redirects`. `main` pointe vers un vrai Worker
(`worker/index.js`, §2/§10) : il intercepte `/api/photos` (proxy R2 pour les
photos du carnet) et ne délègue à `env.ASSETS.fetch` que pour tout le reste —
la présence de `main` change le modèle de déploiement (Worker + assets, pas
assets statiques purs), mais le comportement SPA ci-dessus est inchangé.
`SUPABASE_URL`/`SUPABASE_ANON_KEY` dans `vars` sont dupliqués depuis les
`VITE_*` ci-dessous : le Worker tourne côté serveur Cloudflare, il n'a pas
accès aux variables injectées au build Vite.

Variables d'environnement front, toutes préfixées `VITE_` et **figées au
moment du build** (Vite les inscrit en dur, elles ne sont pas lues à
l'exécution) — à configurer dans les paramètres du projet Cloudflare,
`.env.local` n'étant pas versionné :

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_N8N_INGEST_URL`, `VITE_N8N_INGEST_SECRET` (webhook de capture, §9)

HTTPS est fourni automatiquement — indispensable, sans lui pas de service
worker donc pas de PWA.

Pour un accès S3-compatible direct au bucket R2 (admin/débogage, hors
Worker) : endpoint **sans** nom de bucket dans l'URL, **Force Path Style
ON**, région `'auto'` — jamais `us-east-1`, sinon le listage renvoie 0 objet
sans erreur, piège silencieux.

---

## 15. À tester tôt, avant d'aller loin

Parc d'appareils : majorité Android (~50 monteurs et techniciens) — la
**plateforme de référence, jamais dégradée**. S'y ajoute une poignée
d'iPhones (3 : responsables d'équipe et direction) — **secondaire** : iOS a
des chemins spécifiques, isolés derrière `isIosDevice()`
(`src/lib/pdfMeasure.ts`), pour contourner les limites du WebKit iOS
(`window.open` bloqué après un `await`, polyfill `pdf.js` requis, garde-fou
« plan trop détaillé ») sans jamais toucher au comportement Android. Chrome
implémente `navigator.storage.persist()` et l'accorde en principe
automatiquement aux PWA installées sur l'écran d'accueil (demandé une fois
par session au démarrage, `src/lib/storagePersistence.ts`).

Vérifier malgré tout sur un appareil réel, via l'écran diagnostic
(`DiagnosticScreen`, accessible hors du parcours principal) : que
`navigator.storage.persisted()` renvoie bien true une fois la PWA installée,
que les tailles de blobs épinglés correspondent à ce qui est attendu, et que
les documents épinglés survivent à plusieurs jours sans ouverture de
l'application.

L'application doit être **installée** sur l'écran d'accueil, pas consultée
dans un onglet : la garantie de persistance en dépend.

---

## 16. Hors périmètre actuel

Ne pas implémenter, même partiellement, sans spécification dédiée au préalable :

- résumé automatique, traduction, ou toute réponse générée par IA au-delà du
  tri de résultats de la recherche web de notices (§9) ;
- recherche web en masse ou programmée — une recherche = une action volontaire
  de l'utilisateur devant un équipement ;
- interface générique d'ajout/édition de documents dans le front (l'ingestion
  reste déléguée au workflow n8n existant, y compris pour la capture web,
  qui n'est qu'une nouvelle porte d'entrée vers ce même pipeline).

---

## 17. Communications d'entreprise

Espace global (pas de `dossier_id`) pour diffuser des PDF à toute l'équipe —
notes de service, procédures internes. Schéma en §3. Écran
`CommunicationsScreen` (`src/lib/communications.ts`, cran de nav
`communications`, `nav.goCommunications`).

- **Lecture** — la dernière communication publiée s'affiche en vignette avec
  aperçu `PdfViewer` in-app (lazy-loadé, comme la bibliothèque §8), gaté sur
  `isOnline` (aucun fetch tenté hors ligne, `PdfPlaceholder` affiché à la
  place — en ligne uniquement, comme les dossiers §10, pas de repli hors
  ligne §5). Les communications plus anciennes s'affichent en liste, ouvertes
  au clic dans le lecteur PDF natif (`window.open`, même motif que le
  raccourci plein écran de la bibliothèque, §8). Libellé affiché : `titre` si
  renseigné, sinon dérivé du nom de fichier déposé (`deriveLabel`, retire le
  préfixe UUID généré à l'upload).
- **Publication** — réservée aux `admin` et aux monteurs avec
  `profiles.is_comms_publisher = true`. `titre` de la ligne = `file.name` du
  fichier déposé au moment de l'upload (pas de saisie manuelle côté
  formulaire) ; `deriveLabel` n'est qu'un filet d'affichage pour les lignes
  plus anciennes sans `titre` propre.
- **Droit de publier** — toggle "peut publier" dans l'onglet "Comptes" du
  panneau admin (`VaultAdminScreen`, §11), lignes monteur uniquement (un
  admin peut déjà tout publier via son rôle). RPC `set_comms_publisher`
  (§3), admin-only. Un trigger `profiles_guard` sur `profiles` empêche
  l'auto-octroi : ni `is_comms_publisher` ni `role` ne peuvent être modifiés
  par l'utilisateur sur sa propre ligne, seule la RPC (`SECURITY DEFINER`)
  ou un admin via les canaux prévus le peuvent.
- **Suppression** — RPC `soft_delete_communication` (§3), **jamais** un
  `.update()` direct : voir le piège RETURNING/policy SELECT documenté en
  §3, propre à `communications` (`deleted_at IS NULL` en `SELECT`).
- **Worker** — préfixe `communications` autorisé côté `POST`/`GET` via
  `GLOBAL_PREFIXES` (§2/§13) : égalité stricte sur une allowlist fermée,
  pas de regex à trou, puisqu'un préfixe global n'a par construction aucun
  segment d'entité à valider après la tête (contrairement à `galerie`/`plans`
  qui exigent un slug, §13).

---

## 18. Mini-jeu (PdfTetris) et classement

Mini-jeu autonome (`PdfTetris`, thème « range la bibliothèque »), accessible
depuis le petit bouton "Jeu" de l'accueil (`nav.goGame`) — a pris
l'emplacement historique du bouton "Diagnostic stockage", déplacé dans le
sous-menu "Outils". Sans rapport avec la recherche web ou la bibliothèque
documentaire ; sert à patienter.

- **`GameScreen`** — menu local (état `'menu' | 'play'`, pas de cran de
  navigation dédié pour cette bascule) avec deux boutons, "Jouer" et
  "Classement". Le classement, lui, est un cran de navigation séparé
  (`nav.goGameLeaderboard`, `GameLeaderboardScreen`) pour que le retour
  Android y ramène au menu du jeu plutôt qu'à l'accueil.
- **Score** — `submitScore` (`src/lib/gameScores.ts`) upsert sur
  `game_scores`, ne garde que le meilleur score connu
  (`greatest(existant, nouveau)` recalculé côté client, l'upsert PostgREST ne
  sachant pas exprimer une clause de conflit dépendante de la ligne
  existante) ; `best_lines`, lui, suit toujours la dernière partie, sans
  `greatest`. Pas de RPC `submit_game_score` : envisagée puis abandonnée au
  profit d'un upsert direct depuis `gameScores.ts`, RLS suffisant (chacun
  n'écrit que sa propre ligne, §3).
- **Classement** — `getLeaderboard` lit la vue `game_leaderboard` (déjà
  triée), rendue par le composant partagé `Leaderboard.tsx`.
