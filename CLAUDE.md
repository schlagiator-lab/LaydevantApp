# Spécification — PWA de documentation technique de terrain

Document de référence du projet. À relire avant chaque étape d'implémentation.

---

## 1. Objectif

Une PWA consultée sur téléphone par les techniciens de Laydevant SA (électricité,
télécom, portes automatiques) pour retrouver en quelques secondes la notice ou le
manuel de programmation d'un produit qu'ils ont sous les yeux sur un chantier.

**La contrainte structurante : le réseau est souvent absent.** L'utilisateur est
dans un local technique de sous-sol, une gaine, une cage d'ascenseur. Le mode hors
ligne n'est pas un cas dégradé, c'est la situation nominale.

Périmètre de cette version (v1) : consultation seule. L'ajout de documents se fait
par un workflow n8n existant, hors de cette application.

---

## 2. Stack

- **React + Vite + TypeScript**
- **vite-plugin-pwa** pour le service worker et le manifest
- **@supabase/supabase-js** pour la base, le stockage et l'authentification
- **MiniSearch** pour l'index de recherche hors ligne (côté client)
- **idb** (ou Dexie) pour IndexedDB
- **Cache API** pour le stockage des PDF (pas IndexedDB : mieux adapté aux binaires volumineux)

Pas de framework CSS lourd. Le design est fourni en HTML/CSS, il doit être porté
tel quel en composants.

---

## 3. Ce qui existe déjà

Le backend Supabase est en place et fonctionnel. **Ne pas modifier le schéma.**

### Tables

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

`documents.content` contient le texte intégral extrait du PDF. C'est ce champ qui
alimente les deux moteurs de recherche.

`doc_type` ∈ `notice_installation`, `manuel_programmation`, `fiche_technique`,
`schema`, `fiche_perso`, `autre`.

### RLS

Tout utilisateur authentifié **lit** la documentation ; seuls les `admin`
**écrivent**. Les épingles sont strictement privées à chaque utilisateur.
L'application n'a donc jamais besoin d'écrire ailleurs que dans `pinned_documents`.

### Fonction de recherche en ligne

```ts
supabase.rpc('search_documents', {
  q: 'pare-feu',
  p_department_slug: 'telecom',  // ou null
  p_specialty_slug: null,
  p_limit: 30
})
```

Retourne : `id, title, doc_type, file_path, specialty_name, department_name,
product_label, extrait, rank`.

- `product_label` est **souvent null** (documents sans produit rattaché).
- `extrait` est du **HTML** contenant des balises `<b>` autour des termes trouvés.
  Voir §6 pour le traitement obligatoire.
- La fonction exige une requête. **Elle ne sert pas au mode parcours.**

### Stockage

Bucket `documents`, **privé**. Accès uniquement par URL signée :

```ts
supabase.storage.from('documents').createSignedUrl(file_path, 3600)
```

---

## 4. Architecture hors ligne

C'est le cœur du projet. Trois couches de stockage local :

| Donnée | Support | Contenu |
|---|---|---|
| Référentiel | IndexedDB | départements, spécialités (petit, toujours synchronisé) |
| Métadonnées + texte | IndexedDB | les documents épinglés, avec leur champ `content` |
| Fichiers PDF | Cache API | les binaires des documents épinglés |

### Épingler un document

1. Obtenir une URL signée
2. `fetch()` le PDF → blob
3. Stocker le blob dans le Cache API sous une clé stable : `/offline-pdf/{document_id}`
4. Stocker métadonnées + `content` dans IndexedDB
5. Insérer la ligne dans `pinned_documents` (synchronise l'épingle entre appareils)
6. Reconstruire l'index MiniSearch

Retirer = l'inverse, dans l'ordre inverse.

### Piège : épingle ≠ fichier présent

`pinned_documents` est **partagé entre les appareils** de l'utilisateur, mais le
PDF est stocké **par appareil**. Un utilisateur qui épingle sur son téléphone puis
ouvre l'application sur sa tablette verra l'épingle sans avoir le fichier.

Il faut donc gérer un troisième état : *épinglé sur le compte, absent de cet
appareil*. L'interface doit proposer de le télécharger ici, et ne surtout pas le
présenter comme disponible hors ligne.

### Deux moteurs de recherche

**En ligne** — appel à `search_documents`, couvre tout le corpus.

**Hors ligne** — index MiniSearch construit sur le `content` des documents
épinglés uniquement. Il doit produire des extraits surlignés **visuellement
identiques** à ceux du mode en ligne (voir §6) : l'utilisateur ne doit pas
percevoir deux moteurs différents, seulement une différence de périmètre.

L'écran de recherche affiche explicitement, en mode hors ligne, que la recherche
est limitée aux documents épinglés. Sans cela l'utilisateur conclura qu'un
document n'existe pas alors qu'il ne l'a simplement pas embarqué.

### Mode parcours (sans requête)

`search_documents` ne s'applique pas. Utiliser une requête directe :

```ts
supabase.from('documents')
  .select('id, title, doc_type, file_path, specialties(name, departments(name)), products(brand, model)')
  .eq('specialty_id', specialtyId)
  .order('title')
```

Les cartes sont alors compactes, sans extrait.

---

## 5. Écrans

Les maquettes HTML/CSS sont fournies séparément. Les porter fidèlement.

1. **Accueil** — trois tuiles de département, derniers documents consultés,
   accès aux documents épinglés, accès à toute la documentation
2. **Département** — liste des spécialités avec le nombre de documents
3. **Résultats / liste** — deux variantes de carte : avec extrait surligné
   (mode recherche), compacte (mode parcours). Filtres par département :
   Tout · Électricité · Télécom · Portes automatiques
4. **Fiche document** — visualiseur PDF, et trois états d'enregistrement :
   bouton « Enregistrer sur l'appareil » / progression / ligne verte
   « Disponible hors ligne » sans bouton

Les « derniers documents consultés » sont **locaux à l'appareil** (IndexedDB),
pas synchronisés. Ils doivent rester consultables hors ligne si le document est
épinglé, et grisés sinon.

---

## 6. Traitement obligatoire de l'extrait surligné

`ts_headline` renvoie du HTML **non échappé**. Le champ `content` provient de PDF
téléversés : il peut contenir n'importe quoi, y compris des balises. Injecter
`extrait` directement dans le DOM serait une faille XSS.

Traitement imposé :

1. Échapper **tout** le HTML de la chaîne reçue
2. Restaurer uniquement `&lt;b&gt;` → `<b>` et `&lt;/b&gt;` → `</b>`
3. Puis seulement injecter

Le surlignage se fait **uniquement par la couleur et la graisse**. Aucune marge,
aucun padding, aucun espacement latéral sur le `<b>` : la coupure se produit
parfois à l'intérieur d'un mot composé (`<b>pare</b>-feu`) et tout espacement
disloque le mot.

---

## 7. Authentification

Supabase Auth, email + mot de passe. Les comptes sont créés par un administrateur ;
pas d'inscription libre.

**Piège majeur : le rafraîchissement de session échoue hors ligne.** Par défaut,
supabase-js tente de renouveler le token et peut déconnecter l'utilisateur. Un
technicien qui se retrouve éjecté de l'application dans une cave, sans réseau pour
se reconnecter, perd l'accès à des documents pourtant présents sur son appareil.

L'application doit donc :

- détecter l'absence de réseau et ne pas tenter le rafraîchissement
- autoriser la consultation du contenu **déjà en cache** même avec une session expirée
- ne redemander l'authentification qu'au retour du réseau

---

## 8. Sécurité

- **Seule la clé `anon` figure dans l'application.** Jamais la clé `service_role` :
  elle contourne la RLS. Elle reste exclusivement dans n8n.
- La clé `anon` est publique par conception ; c'est la RLS qui protège les données.
- Les URL signées expirent (1 h). Ne pas les stocker : les régénérer à la demande.
  Une fois le PDF téléchargé dans le Cache API, il est servi localement et
  l'expiration n'a plus d'effet.

---

## 9. Déploiement

**Cloudflare Workers avec Static Assets** (pas Cloudflare Pages). Le build
Vite (`dist/`) est servi comme assets statiques par un Worker sans script
serveur — configuré dans `wrangler.jsonc` à la racine du dépôt.

- **HTTPS obligatoire** : sans lui, pas de service worker, donc pas de PWA.
  Fourni automatiquement par Cloudflare.
- Dépôt privé : sans rapport avec l'hébergeur ici (Workers ne dépend pas de
  la visibilité du dépôt GitHub comme le ferait GitHub Pages), mais le dépôt
  reste privé de toute façon.
- Déploiement : `npm run build` puis `wrangler deploy`. Pas de redéploiement
  automatique sur push configuré pour l'instant — à faire manuellement ou via
  une CI dédiée plus tard.

Manifest : `theme_color` `#1E3A6B`, `display: standalone`, icônes dérivées du
logo Laydevant.

---

## 10. À tester tôt, avant d'aller loin

**La persistance du cache sur iOS.** Les navigateurs mobiles peuvent évincer le
stockage d'un site sous pression mémoire, et les règles diffèrent entre iOS et
Android, entre navigateur et PWA installée sur l'écran d'accueil. Si les PDF
épinglés disparaissent au bout de quelques jours, toute la promesse de
l'application s'effondre.

Appeler `navigator.storage.persist()` pour demander un stockage persistant, et
exposer `navigator.storage.estimate()` dans un écran de diagnostic. **Vérifier le
comportement réel sur un appareil de chaque type avant de déployer à l'équipe.**

---

## 11. Hors périmètre v1

Ne pas implémenter, même partiellement : dossiers clients, photos, mastercodes
chiffrés, recherche sur des sites externes, réponses générées par IA, interface
d'ajout de documents.
