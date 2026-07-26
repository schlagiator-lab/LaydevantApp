# Fonctionnalité — Recherche web de notices, avec capture vers la bibliothèque

Extension du v1. À lire en complément de `CLAUDE.md`. Ne rien implémenter qui
sorte de ce périmètre sans validation.

---

## 1. Le besoin

Un technicien est devant un équipement inconnu de la base (surtout en
électricité, où les marques sont très variées). Il lit la marque et le modèle
sur l'étiquette, et doit trouver la bonne notice de programmation ou le bon
manuel d'installation sur le web — ce qui lui prend aujourd'hui un temps
considérable à cause du bruit des résultats.

Objectif : il saisit marque + modèle, l'application lance une recherche web
**déjà formatée pour viser les notices**, trie les résultats, et lui présente
une liste courte et pertinente. S'il trouve la bonne notice, un bouton
l'**ajoute directement à la bibliothèque** — de sorte que le produit devienne
un cas résolu pour toute l'équipe et n'ait plus jamais à être recherché.

Le réseau n'est pas une contrainte ici : cette recherche est une fonctionnalité
en ligne assumée (les équipements concernés sont quasi toujours dans des zones
couvertes).

---

## 2. Architecture

Deux chemins distincts, à ne pas confondre.

**Recherche** — le front n'appelle JAMAIS l'API Anthropic directement (la clé
serait exposée). Il passe par une Edge Function Supabase qui détient la clé et
relaie :

```
PWA → Edge Function "web-search-notices" → API Anthropic (avec recherche web)
    → réponse triée → PWA
```

**Capture** — réutilise le workflow d'ingestion n8n existant, qui sait déjà
extraire le texte d'un PDF, l'uploader dans Storage et créer la ligne. On lui
ajoute une porte d'entrée par URL (au lieu d'un fichier téléversé) :

```
PWA → webhook n8n "ingest-from-url" → télécharge le PDF → (mêmes étapes que
     le formulaire : extraction texte, upload Storage, upsert produit + insert
     document) → confirmation
```

---

## 3. Edge Function `web-search-notices`

### Contrat

Entrée (POST, corps JSON) :

```json
{
  "brand": "Hager",
  "model": "TN225",
  "department_name": "Électricité",
  "specialty_name": "NIBT"
}
```

`brand` et `model` requis ; `department_name`/`specialty_name` optionnels
(contexte pour affiner la requête). Le front les fournit à partir du filtre
département actif et de la saisie de l'utilisateur.

Sortie (JSON) :

```json
{
  "results": [
    {
      "type": "manuel_programmation",
      "title": "Hager TN225 - Manuel de programmation",
      "url": "https://hager.com/.../TN225_manual.pdf",
      "is_pdf": true,
      "source": "hager.com",
      "confidence": "haute"
    }
  ]
}
```

`type` ∈ `notice_installation`, `manuel_programmation`, `fiche_technique`,
`autre`. `is_pdf` = true si l'URL pointe un PDF direct (déterminant pour la
capture, voir §5).

### Appel à l'API Anthropic

- Endpoint `https://api.anthropic.com/v1/messages`, avec l'outil de recherche
  web activé (recherche côté serveur : un seul appel suffit, la recherche est
  effectuée par l'API).
- Modèle : un modèle de la gamme Sonnet (bon équilibre coût/qualité pour du tri).
  **Vérifier le nom de modèle et la version exacte de l'outil de recherche web
  en cours sur docs.claude.com avant de coder — ces chaînes évoluent.**
- La clé API est lue depuis une variable d'environnement de la fonction
  (`ANTHROPIC_API_KEY`), configurée en secret Supabase. Elle n'apparaît nulle
  part dans le front ni dans Git.

### Stratégie de prompt (exigences, pas le texte exact)

Le prompt doit demander à Claude de :

- rechercher spécifiquement les **notices d'installation, manuels de
  programmation et fiches techniques** du produit `{brand} {model}`, en
  intégrant le contexte de spécialité s'il est fourni (« TN225 disjoncteur »
  plutôt que « TN225 » seul écarte une grande part du bruit) ;
- **privilégier les sources fabricant et les liens PDF directs** ; écarter
  explicitement les pages commerciales, revendeurs, places de marché, forums ;
- pour chaque résultat retenu, identifier son **type** (installation /
  programmation / fiche technique) ;
- gérer le cas « rien de fiable trouvé » en renvoyant une liste vide plutôt
  que d'inventer des URL ;
- **répondre UNIQUEMENT par le JSON** défini ci-dessus, sans texte autour,
  sans balises Markdown.

### Traitement de la réponse

La réponse de l'API contient plusieurs blocs (texte, utilisation de l'outil,
résultats de recherche, puis texte final). Extraire le **bloc texte final**,
en retirer d'éventuelles balises ```json, puis parser. Encapsuler dans un
try/catch : en cas d'échec de parsing, renvoyer `{ "results": [] }` avec un
code d'eremreur propre plutôt que de planter.

### Sécurité et maîtrise du coût

- **`verify_jwt` reste activé** : seul un utilisateur authentifié peut appeler
  la fonction. Sans ça, n'importe qui pourrait brûler tes crédits API.
- Chaque appel a un coût (facturation à l'usage sur le compte Anthropic).
  Prévoir un garde-fou simple : journaliser les appels (qui, quand, quelle
  requête) dans une table `web_search_log`, et poser un plafond souple par
  utilisateur et par jour, rejeté proprement au-delà. Objectif : empêcher une
  boucle accidentelle ou un usage abusif de faire exploser la facture.

---

## 4. Front — mode « recherche web »

- Accessible depuis l'écran de recherche, comme un mode distinct de la
  recherche interne (un onglet ou un bouton « Chercher sur le web »).
  À n'afficher que si l'appareil est en ligne.
- Deux champs : marque, modèle. Le département courant (si un filtre est actif)
  sert de contexte, sans que l'utilisateur ait à le saisir.
- Pendant l'appel : indicateur de chargement explicite (la recherche web prend
  quelques secondes, plus long que la recherche interne instantanée).
- Résultats : liste courte, chaque entrée montrant le type, le titre, la source
  (nom de domaine), et le niveau de confiance. Tri par pertinence.
- État vide : « Aucune notice fiable trouvée » avec invitation à reformuler
  (autre orthographe du modèle, référence complète).

---

## 5. Capture vers la bibliothèque

- Le bouton **« Ajouter à la bibliothèque »** n'apparaît que sur les résultats
  où `is_pdf` est true (PDF direct capturable). Pour les résultats de type
  page, proposer seulement **« Ouvrir »** : l'utilisateur navigue et, s'il
  trouve le PDF, pourra le capturer ou le charger via le formulaire habituel.
- Au clic, afficher une **feuille de confirmation** pré-remplie (marque,
  modèle, spécialité, type de document) que l'utilisateur peut ajuster avant
  d'envoyer — les métadonnées auto-détectées ne sont pas fiables à 100 %, et
  c'est le moment de garantir un rangement propre. La spécialité doit être un
  choix parmi les spécialités existantes (feuilles uniquement, jamais un parent).
- L'envoi POST le tout au webhook n8n `ingest-from-url` :

```json
{
  "pdf_url": "...",
  "brand": "...",
  "model": "...",
  "specialty_slug": "...",
  "doc_type": "...",
  "title": "...",
  "source_url": "..."
}
```

- Retour : confirmation de succès, et le document apparaît dès lors dans la
  bibliothèque interne. Idéalement, rafraîchir pour que l'utilisateur puisse
  l'épingler dans la foulée.

---

## 6. Webhook n8n `ingest-from-url`

Nouveau flux dans n8n, distinct du formulaire mais partageant la fin de chaîne.

1. **Webhook Trigger** (POST) recevant le JSON ci-dessus.
2. **HTTP Request** qui télécharge le PDF depuis `pdf_url` (sortie binaire).
3. À partir de là, **exactement les mêmes nœuds que le formulaire** : nœud
   Code (nettoyage texte, chemin de stockage), upload Storage, insert avec
   upsert produit. Le slug de spécialité et les métadonnées viennent du corps
   du webhook au lieu des champs du formulaire.
4. **Réponse** au webhook : succès + id du document créé, ou erreur.

Limite honnête à gérer : certaines sources fabricant bloquent le téléchargement
automatique (403, portail, contenu derrière JavaScript). Si le download échoue,
renvoyer une erreur claire au front — l'utilisateur téléchargera alors le PDF
à la main et passera par le formulaire d'ingestion classique. Ne pas masquer
cet échec.

---

## 7. Garde-fou de contenu

Cette capture ne concerne que la **documentation fabricant librement diffusée**
(notices, manuels, fiches techniques) — pratique standard du métier. Elle ne
doit jamais servir à aspirer du contenu sous licence de tiers (normes type NIN,
contenus payants). Cette distinction, déjà posée pour la bibliothèque, reste
valable ici.

---

## 8. Hors périmètre

Pas de couche de résumé automatique de la notice trouvée, pas de traduction,
pas de recherche web en masse ou programmée. Une recherche = une action
volontaire de l'utilisateur devant un équipement. On garde la fonctionnalité
étroite et lisible.
