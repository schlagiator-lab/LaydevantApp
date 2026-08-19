# Laydevant — Refonte de la recherche web (Ensemble Search : 3 moteurs + juge LLM + validation-avant-juge)
## Document de reprise (handoff) — le 8e

Complète les sept HANDOFF existants (projet général, coffre, carnet/onboarding/
recherche, finitions/navigation/clés/ingestion-lot, migration documents R2,
fichiers chiffrés du coffre, Tetris duo). Résume la **refonte complète de la
recherche web de notices**, menée brique par brique, **terminée, déployée et
testée** de bout en bout (déclenchée depuis l'appli). Garde surtout le POURQUOI —
le code dit le comment, les workflows n8n disent l'exact ; ce fichier dit pourquoi.

À jour au 19 août 2026.

> À lire avec `ETAT_PROJET.md` (l'état présent). Ce HANDOFF remplace, sur le sujet
> « recherche web », l'ancienne section « deux moteurs » des états précédents :
> l'architecture à 2 moteurs écrivant chacun leur colonne est **abandonnée**.

---

## 0. Le déclencheur

L'ancienne recherche web (2 moteurs — Anthropic Sonnet + Perplexity — écrivant
chacun sa colonne sur `web_search_jobs`, fusionnés/triés côté client) laissait
passer trop de notices : réglée pour la précision au détriment du rappel, et une
fusion mécanique incapable de distinguer un vrai manuel d'une fiche d'1 page, un
lien mort d'un lien vivant, ou deux URL pointant le même document.

But de la refonte : **trouver l'introuvable** (la vraie notice/manuel du produit),
pas aller vite. Le mini-jeu Tetris couvre l'attente.

---

## 1. LA décision fondatrice — un juge LLM (ensemble) plutôt qu'une fusion mécanique

Le cœur de la refonte : on lance plusieurs moteurs, on confie **tous** leurs
résultats bruts à un **modèle juge** (Claude Haiku 4.5) qui déduplique, priorise,
écarte le hors-sujet et ne garde que le meilleur. Un juge **raisonne** là où la
fusion mécanique ne pouvait que trier par (type, confiance) : il détecte les
homonymes, l'équivalence sémantique de deux URL, la qualité réelle d'une source.

Corollaire assumé : le juge devient un point sensible → **repli mécanique** si son
appel échoue ou rend du JSON invalide (on ne bloque jamais l'utilisateur).

---

## 2. Moteurs = RAPPEL, juge = PRÉCISION (le choix du mix)

Principe qui a commandé le choix des moteurs : **quand un juge fait la précision en
aval, chaque moteur doit maximiser le RAPPEL, pas pré-filtrer.** Pré-curer, c'est
jeter des candidats avant que le juge les voie.

- **Serper** = SERP Google brut (URLs + snippets), rappel pur. Lancé en **2
  requêtes** : normale + `filetype:pdf` (fait remonter les vraies notices, pas le
  marketing). `gl:'ch'`, `hl:'fr'`.
- **Gemini Flash + Grounding** = reformule la requête, cherche, synthétise. Apporte
  la **reformulation** (le « repli-gamme » qu'on bricolait avant).
- **Perplexity `sonar-pro`** (pas `sonar-reasoning-pro`) : plus de rappel/citations ;
  le raisonnement CoT serait gaspillé puisque le juge raisonne.

Écarté : empiler plusieurs moteurs « intelligents » redondants. Claude comme
**chercheur** a été abandonné (Serper donne déjà le Google brut) — Claude ne sert
plus que de **juge**.

---

## 3. Un seul workflow, un seul webhook + couche async fine (sync vs async)

Un seul workflow n8n, un seul webhook `notices-search`, **async** : le téléphone
crée un job, le trigger appelle le webhook, le workflow écrit le résultat, le
téléphone poll. La « couche async » se réduit à **1 ligne de job + le poll**.

Pourquoi async et pas sync (réponse directe du webhook) : la recherche se déclenche
**là où le réseau est mauvais** (sous-sols, gaines). Tenir une connexion 40-60 s y
est fragile ; l'async découple le téléphone des moteurs (résultat persisté, re-poll
au retour du réseau). Le sync aurait imposé un plafond serré (~20 s) → jeter le
moteur le plus lent les jours où il est lent, or c'est souvent lui qui trouve.

Note n8n : les branches « fannées » ne s'exécutent **pas** vraiment en parallèle.
Les 3 moteurs tournent donc **en séquence** (latence ≈ somme, ~40-55 s), choix
assumé (credentials propres, la vitesse n'est pas le but). Le **seul** vrai
parallélisme du pipeline est la validation d'URL (nœud Code + `Promise.all`, cf. §4).

---

## 4. Validation AVANT le juge (LA correction clé) + accord inter-moteurs

Première version : juge d'abord, validation HTTP des 1-3 gagnants ensuite. **Défaut
observé** : Gemini **hallucine** des URL de PDF plausibles (`/downloads/MAN_…_DF_05.pdf`
inventé, version incrémentée) ; le juge, ne pouvant pas savoir depuis un snippet
qu'une URL rend du HTML, les retenait comme « PDF ». La validation en aval ne
faisait que **constater** (option « marquer, jamais retirer »), trop tard.

**La cause n'est pas l'intelligence du juge** (il identifiait le bon document) mais
les **données** qu'on lui donnait. Un modèle plus puissant aurait fait le même
choix. → Corriger à la racine :

- **Valider le pool AVANT le juge.** Une shortlist de candidats-documents est testée
  en HTTP (HEAD puis GET Range, suit les redirections), **en parallèle**
  (`Promise.all` dans un nœud Code — `this.helpers.httpRequest` est dispo dans le
  sandbox). Le juge reçoit `link_ok`, `content_type` **réel** et `is_pdf` **vérifié**.
  Une URL `.pdf` qui rend `text/html` arrive étiquetée « pas un vrai PDF ».
- **Accord inter-moteurs** (`engine_count`) : combien de moteurs ont vu chaque URL.
  Une URL vue par ≥2 moteurs est fiable ; une URL Gemini-seule extraite du texte est
  suspecte. Le juge est instruit de préférer le corroboré + vérifié, et
  d'**utiliser les URL VERBATIM** (interdiction d'inventer/modifier).
- **La validation fait autorité** : `is_pdf` final = `content_type ? /pdf/ : suppo`.
  Un `text/html` écrase le `is_pdf:true` supposé (fini les fausses pastilles PDF).

Résultat : le juge choisit parmi des URL réelles et corroborées. L'hallucination
DF_05 ne peut plus être retenue comme PDF. **Sans rien retirer** — il choisit mieux.

`link_ok = false` reste un **avertissement doux** (le robot peut être bloqué, ex.
CDVI/bricometal), **jamais** « lien mort ».

---

## 5. Le contexte suisse (grossistes, homonymes, langue)

Calé sur le brut réel observé, pas sur une théorie :

- **Les grossistes suisses SONT des sources documentaires légitimes** :
  `ottofischer.ch`, `flextron.ch`, `feller.ch`, `sonepar.ch`, `eldas` hébergent les
  vraies notices fabricant. (Correction assumée d'une reco initiale « exclure les
  distributeurs » : fausse pour le marché suisse.)
- **Homonymes** : « ALADIN » = récepteur radio, mais aussi théâtre/astronomie ;
  « RBM » = contrôle d'accès CAME, mais aussi machine à ruban, antipaludisme,
  Restricted Boltzmann Machine (IEEE). Le juge tranche via **`equipment_type` +
  département** → d'où l'importance de **remplir le contexte** côté appli (levier
  qualité, cf. §12).
- **Langue** : FR si un document FR complet existe, sinon DE/EN complet prime sur FR
  partiel/absent (beaucoup de doc suisse est en DE ; un PDF CDVI **suédois** a même
  été rattrapé quand le `.fr` était mort).

---

## 6. Politique de résultats — 5 documents + 1 vidéo (Option A)

- **Jusqu'à 5 documents pertinents**, mais **jamais complétés à 5 avec du hors-sujet**
  (« mieux vaut 2 bons que 5 dont 3 bancals » ; la qualité prime sur le nombre).
- **Vidéo (YouTube) = ajout SÉPARÉ, toujours en dernier**, max 1. Option A : si une
  vidéo d'**installation/paramétrage** pertinente existe, on l'**ajoute toujours**,
  en plus des documents (total possible **6**). Jamais une pub/déballage.
- Piège corrigé : la validation-avant-juge filtrait les documents (`worth()`), donc
  les URL **YouTube ne passaient jamais** au juge → il n'en émettait aucune. Fix :
  la shortlist inclut explicitement `docs (≤15) + vidéos (≤3)`.

---

## 7. Le modèle de données

- **`web_search_jobs`** (étendu, additif) : `status_final` (`processing`/`done`),
  `final_results` (jsonb, **déjà trié/dédupliqué par le juge**), `done_at_final`. Le
  téléphone poll ces colonnes. Les anciennes colonnes par moteur
  (`results_anthropic`/`_perplexity`, `status_*`, …) sont **obsolètes mais laissées
  en place** (nettoyage différé).
- **`web_search_results`** (table enfant, nouvelle) — **journal d'observabilité** :
  une ligne **par moteur par job** (`serper`/`gemini`/`perplexity`) + une ligne
  **`juge`** (sa décision). Colonnes : `id`, `job_id` (FK cascade), `engine`,
  `status` (`ok`/`empty`/`error`/`fallback`), `candidate_count`, `raw_results`
  (jsonb), `error_message`, `created_at`. **RLS activée, ZÉRO policy** (service-only,
  motif `private_config`) : le téléphone ne lit JAMAIS le journal, il poll le job.
  Ajouter un moteur = une ligne de plus, aucun changement de schéma.

---

## 8. Le workflow n8n (ordre, points clés)

Chaîne : `Webhook → Lire le job → Statut processing → Construire requetes →
Serper → Serper PDF → Normaliser Serper → Gemini → Normaliser Gemini →
Perplexity → Normaliser Perplexity → Collecte → Valider pool → Juge →
Parser juge → Ecrire journal → Ecrire final`.

- **Construire requetes** : `q` (marque+modèle+type), `q_pdf` (+`filetype:pdf`),
  `prompt` (LLM, exige des URL directes).
- **Normaliser \<moteur\>** : chacun → candidats `{title,url,snippet,source}` +
  `status`/`error_message`. Serper fusionne ses 2 requêtes. Gemini : URL directes du
  **texte** d'abord, redirections `vertexaisearch` en filet.
- **Collecte** : pool dédupliqué avec **accord inter-moteurs** (`engine_count`),
  repli mécanique (top 5), contexte produit.
- **Valider pool** : validation HTTP parallèle (docs ≤15 + vidéos ≤3), résout les
  redirections vertexaisearch, `content_type` autorité sur `is_pdf` ; **construit le
  corps du juge** (SYSTEM + candidats vérifiés).
- **Juge** : Claude Haiku 4.5, `api.anthropic.com/v1/messages`, **Header Auth** (voir
  §11), JSON strict, `cache_control` sur le system.
- **Parser juge** : parse → forme front `{type,title,url,is_pdf,source,confidence,
  link_ok,http_status,content_type}` ; **reporte les flags de validation** depuis le
  pool ; repli mécanique si JSON invalide. Écrit la ligne `juge` du journal.
- **Ecrire journal** (POST **en masse** des lignes) puis **Ecrire final** (PATCH
  `final_results`/`status_final`/`done_at_final`).

Credentials : `Serper API` (Header Auth `X-API-KEY`, sur Serper + Serper PDF),
`Google Gemini(PaLM) Api` (natif, `googlePalmApi`), `Perplexity API` (Header Auth
`Authorization: Bearer …`), `Anthropic x-api-key` (Header Auth, sur Juge),
`Supabase account` (natif) + secret Supabase dans les headers manuels des 4 nœuds
Supabase.

Détails moteurs figés : Gemini `gemini-3.5-flash:generateContent`,
`tools:[{google_search:{}}]`, **`generationConfig.thinkingConfig.thinkingBudget:0`**,
timeout **90 s** ; Perplexity `sonar-pro`, `search_domain_filter` bannissant quelques
agrégateurs ; chaque moteur en **Continue On Fail** (dégradation gracieuse).

---

## 9. Le trigger — un seul webhook

`notify_n8n_web_search()` (SECURITY DEFINER, `AFTER INSERT WHEN status='pending'`)
réécrit pour **un seul** `net.http_post` vers `n8n_webhook_url` (path
`notices-search`), header `rechercheweb-webhook-secret`, body `{job_id: NEW.id}`.
**Garde-fou** : si l'URL ou le secret est `null`, `return NEW` — le trigger ne casse
JAMAIS l'INSERT du job. Secret/URL dans `private_config`. La clé
`n8n_webhook_url_pplx` est désormais **orpheline** (nettoyage possible).

---

## 10. Le front — bascule sur `final_results`

`src/lib/webSearch.ts` + `src/screens/WebSearchScreen.tsx` (commit `10772ca`
`refactor(recherche-web): bascule sur le pipeline back-end unique`).

- Poll `status_final`/`final_results` ; **arrêt sur `status_final==='done'`**.
- **Reveal 90 s supprimé** (`REVEAL_DELAY_MS`) — plus de résultats partiels, le juge
  rend une liste finale unique. **`HARD_LIMIT_MS` ~300 s conservé** en filet
  (timeout → « recherche interrompue »).
- **Fusion client supprimée** : `mergeAndDedupe`/`compareResults`/`normalizeUrl`/
  `typeRank`/`confidenceRank`/`markEngineFailed` sont morts (le juge trie).
- Type `WebSearchResult` étendu : `'video'` + `link_ok`/`http_status`/`content_type`
  optionnels. `database.ts` : `web_search_jobs` n'y a jamais été typé (schéma
  n8n/Supabase), rien à y faire.
- **Vidéos affichées en bas**, après les documents (tri stable, pas de tri qualité) ;
  ouverture externe (`window.open`) ; **non capturables** (bibliothèque PDF-only).
- `link_ok:false` = avertissement doux, pas « lien mort ».
- **En cours** : marquage visuel plus distinct des vidéos (badge/icône « Vidéo ») —
  prompt Claude Code fourni, à confirmer déployé.

---

## 11. Bêtisier (les pièges rencontrés et leurs leçons)

- **Credential Anthropic natif « fantôme »** : après suppression/recréation de
  credentials, le nœud gardait l'**ancien id** (`anthropicApi` id mort) →
  `Credential with ID … does not exist`, alors que la **clé marchait** (curl 200). Le
  bandeau rouge « Couldn't connect » du credential est un **faux positif** (son test
  interne tape un modèle par défaut). **Fix : Header Auth** (`x-api-key` +
  `anthropic-version` + `content-type`), qui court-circuite le credential natif.
  **Leçon** : après recréation d'un credential, **re-sélectionner** sur chaque nœud ;
  et diagnostiquer par le **vrai** `error.message` du nœud, pas par le bandeau.
- **Gemini `thinkingBudget:0` obligatoire** : `gemini-3.5-flash` « réfléchit » et
  peut consommer tout le budget de sortie → HTTP 200 avec `usageMetadata` mais **sans
  `candidates`** (indice : `thoughtsTokenCount` élevé). Sans le budget à 0, réponses
  vides intermittentes.
- **Gemini timeout** : 25 s trop court (grounding = plusieurs recherches + synthèse)
  → **90 s**. En async, sans conséquence.
- **Gemini hallucine des URL** de PDF plausibles (mono-moteur, extraites du texte).
  Traité par la validation-avant-juge + accord inter-moteurs (§4).
- **URL de grounding = redirections `vertexaisearch`**, pas directes → extraire les
  URL directes du texte d'abord, résoudre les redirections à la validation.
- **`source: ""` partout** : le constructeur **`URL` n'est pas exposé** dans le
  sandbox du nœud Code → extraction du domaine par **regex**.
- **`error_message = [object Object]`** : `String(resp.error)` sur un objet → utiliser
  `.message`/`JSON.stringify`.
- **`is_pdf` faux positif** : le juge a mis `true` sur une page HTML (CDVI) →
  `content_type` fait autorité quand présent.
- **Vidéos filtrées avant le juge** : la shortlist « documents » excluait YouTube →
  inclure les vidéos explicitement (§6).
- **« No items on branch » à l'écriture journal** : `Prefer: return=minimal` → 204 No
  Content → n8n n'affiche aucun item, mais **l'INSERT a réussi**. Pas un échec.
- **Faux « 0 ligne »** : coquille de copier-coller sur le `job_id`
  (`2d763f2a` vs `2d37632a`) — la bête noire habituelle. La source brute prime, mais
  vérifier aussi **la requête** avant de conclure à un bug.
- **n8n ne parallélise pas les branches fannées** → séquentiel ; le vrai parallèle se
  fait dans un nœud Code (`Promise.all`), ce qu'on a utilisé pour la validation.

---

## 12. Dettes & vigilance propres à ce chantier

- **Contexte du job souvent vide** (`equipment_type`/`department`/`specialty` = `?`
  dans plusieurs tests) : c'est le **signal le plus fort** du juge contre les
  homonymes. Vérifier que l'appli **remplit et envoie** ces champs à l'INSERT ; sinon
  fil coupé côté front à réparer. **Meilleur levier qualité restant.**
- **Nettoyer les colonnes par moteur** obsolètes de `web_search_jobs`
  (`results_anthropic`/`_perplexity`, `status_*`, `done_at_*`) — après une période de
  stabilité.
- **Débrancher l'ancienne Edge Function `web-search-notices`** (le nouveau chemin ne
  passe plus par elle) et **supprimer les anciens workflows** Anthropic/Perplexity et
  la clé `private_config.n8n_webhook_url_pplx` orpheline.
- **Badge vidéo côté front** : à confirmer déployé.
- **Latence** : validation parallèle de ~18 URL ajoute quelques secondes. Neutre en
  async ; réduire la shortlist si un jour gênant.
- **`web_search_results` au backup** : ajouter à l'export n8n quand on activera
  Schedule + purge (lignes = URLs/snippets publics, sans risque).

---

## 13. Méthode (elle a encore tenu)

- **Découper** : SQL (table enfant + colonnes job) validé avant le workflow ;
  workflow construit **brique par brique** (squelette 1 moteur → 3 moteurs → juge →
  validation → validation-avant-juge), chacune testée en base avant la suivante.
- **La source brute prime** : le brut de `web_search_results` a tout tranché — c'est
  lui qui a montré que les moteurs trouvaient la bonne notice mais que le juge était
  trompé par une URL inventée, et que les vidéos ne montaient pas au juge.
- **Diagnostiquer avant de patcher** : le vrai `error.message` (credential fantôme),
  `thoughtsTokenCount` (Gemini vide), le `content_type` (faux PDF) — jamais un patch
  réflexe ni un changement de modèle pour masquer un problème de données.
- **Le travail n'existe que poussé/publié** : credentials re-sélectionnés et workflow
  **publié** après édition ; commit/push depuis le terminal.
- **Secrets** : clés API en credentials natifs / Header Auth, jamais dans le fichier
  exporté ni le chat ; secret Supabase rempli dans l'UI.
