# Laydevant — Notice terrain : demande admin vs ajout direct
## Document de reprise (handoff)

Complète le HANDOFF général et l'`ETAT_PROJET.md`. Archive le POURQUOI de la
fonctionnalité « le monteur ajoute une notice depuis le chantier » — depuis la
première brique (joindre une doc à une demande) jusqu'à la bascule qui rend
l'ajout **direct** quand la doc est déjà en main. Le code dit le comment ; ce
document dit pourquoi c'est ainsi.

À jour au 21 août 2026. Fonctionnalité **déployée et testée de bout en bout**.

---

## 1. Le besoin terrain

Remontée d'un monteur : la notice d'un produit n'existe pas en base, mais il l'a
**déjà sur son téléphone**. Peut-il l'ajouter lui-même en déclarant l'équipement
absent, sans attendre un admin ?

Il existait déjà un flux « équipement manuel → demande admin »
(`dossier_equipment_requests`, résolu par `resolve_dossier_equipment_request`) :
le monteur déclare, un badge « en attente » apparaît, l'admin crée le produit et
le rattache. Mais rien ne permettait de **joindre la notice**, ni a fortiori de
l'ajouter directement.

---

## 2. L'insight fondateur : deux moments, pas un

Le besoin cache **deux exigences distinctes**, qu'il faut résister à traiter d'un
bloc :

1. **Immédiat, terrain** — le monteur veut *voir* la notice tout de suite, et que
   ses collègues sur le même dossier la voient. Aucune validation requise (modèle
   carnet : « tout authentifié lit/écrit »).
2. **Propre, bibliothèque** — pour qu'une notice **remonte automatiquement partout**
   (principe d'or : une notice vit via `products`, en un exemplaire, et remonte dans
   tous les dossiers portant ce produit), elle doit entrer dans `documents` avec des
   **métadonnées validées** et son **texte extrait** (sinon invisible en plein-texte).

Coller la notice brute directement dans `documents` polluerait la bibliothèque (métas
approximatives, `search_vector` vide). La garder « en attente » invisible raterait le
besoin terrain. D'où un découpage : **staging consultable tout de suite**, puis
**promotion contrôlée vers la bibliothèque**.

---

## 3. Le staging R2 — `equipment-requests/`

Les notices jointes transitent sous un préfixe R2 **dédié** `equipment-requests/`
(autorisé au POST dans le Worker `/api/photos`, Brique 1b), **jamais** directement sous
`documents/`. On ne mélange pas du binaire non contrôlé à la bibliothèque validée. Le
DELETE de ce préfixe reste **admin-only** côté Worker (conséquence importante, cf. §8).

Table enfant **`dossier_equipment_request_files`** (Brique 1a) : `request_id` (FK
`on delete cascade`), `storage_provider 'r2'`, `storage_key`, `nom_fichier`, `mime`,
`taille`, `doc_type_suggere` (capté à la source — le monteur sait si c'est une notice
d'install ou un manuel de prog), `auteur` (défaut `auth.uid()`), `promoted_document_id`
(ajouté en Brique 2b, ancre d'idempotence). RLS calquée sur la demande parente et le
carnet : SELECT `true`, INSERT `auteur = auth.uid()`, DELETE `auteur OR is_vault_admin()`.
**Hard delete** (table de staging, comme `vault_files`) — et `using(true)` en SELECT
évite le piège 42501 sur le RETURNING implicite du DELETE.

Consultation immédiate : les notices jointes s'ouvrent depuis la carte « en attente »
via le `<PdfViewer>` in-app partagé (règle de plateforme iOS respectée). Le monteur est
débloqué sur le chantier **dès cette brique**, avant toute promotion.

---

## 4. La promotion admin (Briques 2b–2e)

À la résolution, l'admin **promeut** une notice jointe vers la bibliothèque. Choix clés :

- **La promotion est un geste séparé de l'approbation, par notice.** On ne touche PAS
  à `resolve_dossier_equipment_request` (fonction testée qui crée le produit + pose
  `resolved_product_id`). La promotion lit ce `resolved_product_id` *après coup*, notice
  par notice. L'admin garde le contrôle (confirmer `doc_type`, un titre propre, écarter
  une pièce erronée).
- **Edge Function `promote-equipment-notice`** (gate **admin**) : la frontière. Vérifie
  `is_vault_admin()`, refuse si la demande n'est pas approuvée / `resolved_product_id`
  null / `promoted_document_id` déjà posé (409), assemble le payload (join `specialties`
  pour le slug), relaie le webhook n8n en Header Auth, puis écrit `promoted_document_id`
  depuis la réponse (`WHERE … AND promoted_document_id IS NULL` → idempotence par claim).
- Le front (Brique 2e) : bouton « Promouvoir vers la bibliothèque » sur les demandes
  approuvées, confirmation titre + doc_type, bascule visuelle « ✓ dans la bibliothèque »
  pilotée par `promoted_document_id`.

---

## 5. Le workflow n8n de promotion — cloné de l'ingestion, 3 différences

Le workflow `promote-equipment-notice` (webhook Header Auth) réutilise le contrat
d'insert éprouvé de `ingest-from-url`, avec trois écarts **voulus** :

1. **Pas de CTE produit.** L'ingestion web recrée/upsert le produit ; ici le produit
   **existe déjà** (`resolved_product_id` en promotion, ou `upsert_dossier_product` en
   direct). On insère `documents.product_id = <id>` directement — le lien de remontée
   exact (`dossier_documents_complets` joint sur `doc.product_id = dp.product_id`),
   déterministe, insensible à la casse.
2. **`specialty_id` en uuid, pas en slug.** Fourni par la demande/le direct, pas de
   lookup `specialties`.
3. **Filtre octet NUL ajouté** (`\u0000` avant `\s+`) — leçon 08P01 du chantier par lot.

Chaîne : **Webhook → Télécharger depuis R2 (`equipment-requests/`) → Extraire le texte →
Préparer → Upload R2 (`documents/`) → Insérer `documents` → Réponse (document.id)**.

> **Le download est imposé par l'extraction.** J'avais d'abord proposé un S3 CopyObject
> serveur-à-serveur (pas de download). Faux : pour remplir `content` (donc
> `search_vector`), n8n doit **extraire le texte**, donc avoir les octets en main. Une
> fois téléchargés, le re-upload vers `documents/` clone le nœud d'upload existant — un
> CopyObject serait une opération R2 en plus pour rien.

Deux invariants de `documents` qui ont failli coûter cher :
- **`documents` n'a PAS de colonne `model`** (erreur 42703 rencontrée) — le modèle vit
  sur `products`. `documents` porte `brand` seulement. Ne jamais faire remonter par un
  match texte marque+modèle.
- **`documents.search_vector` est GÉNÉRÉE** (`ALWAYS AS documents_tsv(title, tags,
  content)`) — n8n insère `content`/`title`/`tags`, jamais le vecteur. Le plein-texte
  se calcule seul. Mapping de noms : `documents` utilise `file_size`/`mime_type` (pas
  `taille`/`mime`) et `storage_provider` par défaut `'supabase'` → forcé à `'r2'`.

---

## 6. La bascule philosophique — demande vs direct (le cœur)

Une fois la chaîne complète en place, une **incohérence** est apparue : dans la
recherche web, **tout monteur ajoute déjà en base sans admin** (capture → produit +
`documents`, via la connexion Postgres privilégiée de n8n). Le principe implicite du
projet est donc : *un monteur est jugé compétent pour décider qu'une notice mérite
d'entrer en base.* Exiger une double validation admin quand il **tient déjà la doc**
est plus paternaliste que le flux web, et ne se défend pas.

En regardant `resolve_dossier_equipment_request`, l'apport réel de l'admin se réduisait
à **la spécialité** (créer le produit et le rattacher, le flux web le fait déjà sans
admin). Retirer l'admin du chemin « doc jointe » revient donc à **déplacer le choix de
la spécialité vers le monteur** — sain : il connaît son métier, et il choisit déjà une
spécialité pour ranger un équipement existant.

**Principe retenu — bifurcation à la déclaration :**
- **Doc jointe + spécialité → ajout DIRECT** (comme une capture web). Pas de demande.
- **Sans doc → demande admin** (inchangé). L'admin garde une vraie valeur : *trouver
  l'introuvable*, pile la philosophie du projet.

On ne jette rien : la promotion admin (§4) reste le moteur du cas « pas de doc », sa
raison d'être légitime. Le workflow n8n (§5) est **partagé** entre les deux chemins.

---

## 7. Le chemin direct (RPC + Edge Function sœur)

La RLS l'a dicté : `dossier_produits` est `ALL using(true)` (tout authentifié rattache),
mais **`products` est admin-only en écriture**. C'est pourquoi le flux web passe par
n8n (privilégié) et non par le monteur. Le direct reproduit ce contournement proprement.

- **RPC `upsert_dossier_product(dossier_id, specialty_id, brand, model) → product_id`**
  (SECURITY DEFINER, gate = **`auth.uid()` non null**, pas admin) : clone les étapes 1–3
  de `resolve` (normalisation, réutilisation anti-doublon `lower/lower`, création,
  rattachement avec résurrection soft-delete). **N'écrit pas `documents`** (c'est n8n).
  Retourne le `product_id`.
- **Edge Function `add-dossier-equipment-notice`** (gate = **authentifié**, sœur distincte
  de `promote-equipment-notice` — deux gates clairs plutôt qu'un mode surchargé) : appelle
  la RPC via un **client scopé utilisateur** (la RPC lit `auth.uid()`), relaie le **même**
  webhook n8n de promotion, et — si un `request_id` est fourni — **ferme la demande** via
  un **client service_role** (`status='approved'`, `resolved_product_id`, idempotent sur
  `status='pending'`).
- **Front (`EquipmentRequestSheet.tsx`)** : bifurcation à la soumission. Si un fichier est
  joint, la **spécialité devient obligatoire** (select porté du côté admin, même
  référentiel `getLocalDepartments`/`getLocalSpecialties` en IndexedDB, `optgroup` par
  département) ; on appelle le direct ; l'équipement apparaît **tout de suite** via le
  même contrat `onAdded → loadEquipments` (refetch complet, pas d'état optimiste), la
  notice remonte quelques secondes après via `product_id`. Sans fichier : `createEquipment
  Request` inchangé. **Décision 3** : joindre une doc à une demande déjà ouverte
  **déclenche le direct** et ferme la demande (cohérence totale : dès qu'une doc apparaît,
  l'ajout est direct).

---

## 8. Pièges rencontrés et leçons

- **`documents` sans `model`** (§5) : 42703. Le modèle est sur `products`.
- **`search_vector` générée** (§5) : ne jamais l'insérer ; alimenter `content`.
- **`products` admin-only en écriture** : un monteur ne peut créer un produit qu'en
  passant par une RPC SECURITY DEFINER. Vérifier la RLS **avant** de supposer qu'un
  INSERT client marchera.
- **Download imposé par l'extraction** (§5) : ne pas se raconter qu'un CopyObject
  évite le download quand on doit de toute façon lire les octets pour extraire.
- **Nettoyage staging impossible côté Edge Function** : le DELETE de
  `equipment-requests/` est admin-only côté Worker, or l'Edge Function n'est pas admin.
  Le cleanup **doit** se faire côté n8n (DeleteObject best-effort en fin de workflow),
  ce qui couvre les DEUX chemins d'un coup. Reporté à une brique dédiée (cf. §9).
- **Deux Edge Functions sœurs, deux gates** : ne pas surcharger la fonction admin
  sensible d'un second mode « authentifié ». Une fonction = un gate clair.
- **Le front reste bête** : il n'envoie que `file_id`/`title`/`doc_type` (promotion) ou
  les champs de déclaration (direct) ; toute l'autorité (product_id, storage_key,
  specialty_id) est relue en base par l'Edge Function. Un front compromis ne peut pas
  promouvoir vers un produit arbitraire.

---

## 9. Dettes ouvertes (spécifiques à cette fonctionnalité)

- **Nettoyage staging `equipment-requests/`** : objets orphelins après copie vers
  `documents/`. À faire côté n8n (DeleteObject best-effort, Continue On Fail). Négligeable
  en attendant.
- **Convergence `resolve_dossier_equipment_request` ↔ `upsert_dossier_product`** : la
  résolution admin garde une copie inline des étapes produit. Refactorer `resolve` pour
  appeler la RPC — dans une **brique isolée avec test**, pour ne pas mêler
  risque-sur-du-testé et feature. (Décision 1 de la session : créer la RPC d'abord,
  converger ensuite.)

---

## 10. Objets créés (récapitulatif)

- **SQL** : table `dossier_equipment_request_files` (+ colonne `promoted_document_id`) ;
  RPC `upsert_dossier_product(uuid,uuid,text,text)`.
- **Worker** : préfixe `equipment-requests/` autorisé au POST.
- **n8n** : workflow `promote-equipment-notice` (Header Auth, partagé par les deux chemins).
- **Edge Functions** : `promote-equipment-notice` (gate admin),
  `add-dossier-equipment-notice` (gate authentifié). Secrets partagés
  `N8N_PROMOTE_URL`/`N8N_HEADER_AUTH_NAME`/`N8N_HEADER_AUTH_SECRET` (Deno.env).
- **Front** : joindre/consulter une notice (staging + `<PdfViewer>`), bouton
  « Promouvoir », bifurcation direct/demande + select spécialité conditionnel.

---

## 11. Méthode (elle a tenu)

Brique par brique, base (SQL) validée avant les écrans, RPC testée en `begin; … rollback;`
avec `set_config('request.jwt.claims', …)` avant de brancher l'écran. Chaque workflow n8n
livré en `.json` importable (credentials re-sélectionnés à la main après import).
La source brute prime : chaque migration a été écrite **après** lecture du schéma réel
(`information_schema`, `pg_policies`, `pg_get_functiondef`), jamais sur un résumé.

---

## 12. Extension — notice catalogue (hors dossier), 25 août 2026

Besoin : ajouter une notice **sans dossier client**, depuis un sous-menu « Ajouter une
notice » de l'onglet Outils. Le monteur retombe sur le même scénario que « équipement
absent de la base ».

**L'insight qui rend ça trivial** : dans le chemin direct, le `dossier_id` ne servait
qu'au rattachement `dossier_produits`. Le staging R2, le workflow n8n de promotion et
l'insert `documents` (lié par `product_id`) sont **déjà dossier-agnostiques**. Ajouter au
catalogue = le chemin direct **moins le rattachement**. La notice entre dans `documents`
via le produit et remonte automatiquement dans tout dossier futur portant ce produit —
plus pur que le cas dossier.

**Ce qui a été créé (et ce qui ne bouge pas) :**
- **RPC `upsert_product_standalone(specialty_id, brand, model) → product_id`** : clone de
  `upsert_dossier_product` amputé de l'INSERT `dossier_produits`. Le dump a confirmé que
  `products` n'a **pas** de `deleted_at` (jamais soft-deleté) → pas de résurrection, RPC
  plus simple. On n'a **pas** réutilisé `upsert_dossier_product` avec un dossier bidon
  (ça polluerait `dossier_produits`) : sœur dédiée, sans effet de bord.
- **Edge Function `add-catalog-notice`** : sœur de `add-dossier-equipment-notice` (même
  gate authentifié, même webhook n8n partagé, **même payload**), sans `service_role` ni
  fermeture de demande. **Fichier obligatoire** : le fallback « demande admin » est
  intrinsèquement lié à un dossier, il n'a pas de sens ici.
- **Inchangés** : workflow n8n de promotion (partagé, dossier-agnostique), Worker
  (`equipment-requests/` déjà autorisé). La **contrainte de préfixe `equipment-requests/`
  sur `storage_key` est conservée** dans la nouvelle Edge Function : garde-fou contre un
  `storage_key` arbitraire qui ferait télécharger n'importe quel objet R2 par n8n.
- **Front** : écran autonome `AddCatalogNoticeScreen` (on n'a **pas** réutilisé
  `EquipmentRequestSheet`, couplé au dossier). Réemploie le select spécialité par
  département et le helper d'upload staging ; dépose dans le même `equipment-requests/`,
  appelle `add-catalog-notice`. Flux online-only. Pas de liste d'équipement à recharger,
  juste une confirmation « remonte dans la recherche d'ici quelques secondes ».

**Méthode** : dump `pg_get_functiondef` avant d'écrire la RPC (le dump a révélé l'absence
de `deleted_at` et le scope de l'anti-doublon), RPC testée en `begin; … rollback;` avant
tout branchement, Edge Functions sœurs à gate unique, front autonome pour ne pas toucher
au sheet testé.
