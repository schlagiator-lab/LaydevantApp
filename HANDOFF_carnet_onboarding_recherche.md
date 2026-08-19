# Laydevant — Carnet public, Onboarding & Recherche web
## Document de reprise (handoff)

Complète les deux HANDOFF existants (projet général, coffre de données
sensibles). Résume trois chantiers **terminés et déployés** dans cette session,
et amorce le prochain (workflows n8n). Garde surtout le POURQUOI des décisions.
À jour au 2 août 2026.

---

## 0. Vue d'ensemble

Trois pièces livrées, indépendantes du coffre :

1. **Carnet public** par dossier (notes + photos), en clair, sans crypto.
   Photos hébergées sur **Cloudflare R2** (pas Supabase Storage).
2. **Onboarding par liste blanche** : un admin invite un email, la personne
   s'auto-enrôle à l'URL. Verrou côté serveur (Edge Function `enroll`).
3. **Amélioration de la recherche web** de notices : repli sur la gamme quand
   la référence exacte ne donne rien + log d'observabilité.

---

## 1. Carnet public (notes + photos)

### Le besoin
Remarques, photos et infos d'installation partagées par TOUS sur un dossier
client. Ce n'est PAS secret → ne passe pas par le coffre, pas de chiffrement,
RLS « tout authentifié lit/écrit ». Chantier léger, sans crypto.

### Décision structurante : stockage agnostique
La référence photo est **découplée de son lieu de stockage**. On ne code jamais
« la photo est sur Supabase » : chaque photo est une ligne avec
`storage_provider` + `storage_key`, le front résout l'URL selon le provider.
Conséquence : Supabase / R2 / autre, c'est le MÊME schéma — changer de backend
ne coûte aucune migration. (C'est la colonne `storage_provider` évoquée puis
mise de côté dans le handoff général ; elle est devenue utile ici.)

### Schéma SQL (migration `dossier_carnet_public.sql`)
- **`dossier_notes`** : `id`, `dossier_id` (FK, on delete cascade), `titre`
  (nullable), `texte`, `auteur` (FK auth.users, on delete **set null**),
  `updated_by`, `created_at`, `updated_at`. Trigger `set_dossier_note_updated`
  (updated_at/updated_by auto).
- **`dossier_photos`** : `id`, `dossier_id`, `note_id` (nullable — photo
  autonome OU liée à une note), `storage_provider` (défaut 'supabase', check
  in 'supabase'/'r2'), `storage_key`, `mime`, `taille`, `largeur`, `hauteur`,
  `auteur` (set null), `created_at`.
- **Vues** `dossier_notes_view` et `dossier_photos_view` (toutes deux
  `security_invoker = true`) : joignent `profiles` pour exposer `auteur_nom` /
  `updated_by_nom`. Colonne du nom = **`full_name`** (pas `nom`). `profiles`
  est déjà lisible par tout authentifié (`qual = true`), donc les noms des
  collègues remontent.

### RLS
Tout authentifié : SELECT/UPDATE/DELETE en `using(true)`. Anti-usurpation à
l'INSERT seul (`with check (auteur = auth.uid())`) : on ne crée pas une note au
nom d'un collègue, mais tout le monde peut éditer/supprimer (choix assumé :
carnet d'équipe). `on delete set null` : note/photo survit au départ de son
auteur (fin de stage/intérim), l'auteur devient « inconnu ».

### Backend photo — Cloudflare R2 (choix : « s'embêter un peu au début »)
- **Bucket** `laydevant-photos`. R2 activé sur le compte (carte requise pour
  l'activation ; free tier 10 Go + egress zéro, jamais facturé sous ces seuils).
- **Pas d'URL présignées S3** (qui obligeraient à stocker des clés d'accès R2).
  On utilise le **binding R2 natif** : le Worker a le bucket lié comme
  `env.PHOTOS_BUCKET` et lit/écrit les octets directement. **Aucune clé S3 à
  gérer.**
- **Worker intégré au front** (pas séparé) : le `wrangler.jsonc` était en
  assets purs (pas de `main`). On a ajouté `main = "worker/index.js"`, le
  binding R2, les `vars` (SUPABASE_URL + clé anon en clair, publique par
  conception), et `"binding": "ASSETS"`. Le `fetch` intercepte `/api/photos/*`
  et renvoie tout le reste sur `env.ASSETS.fetch`. **Même origine → zéro CORS,
  zéro variable VITE nouvelle, un seul déploiement.**
- **Sécurité** : le Worker vérifie le JWT Supabase via `GET /auth/v1/user`
  (valide quelle que soit la méthode de signature). Pas de token → 401. C'est
  le SEUL verrou : le modèle d'accès du carnet étant « tout authentifié », «
  connecté = autorisé » suffit. Test décisif = `POST /api/photos` **sans** token
  doit rendre 401.
- Division des rôles : le **Worker** ne fait que « octets authentifiés
  dans/hors R2 », il ne touche jamais la base. Le **client** insère la ligne
  `dossier_photos` via Supabase après upload (RLS `auteur = auth.uid()`).

### Couche données — `src/lib/dossiers.ts` (écrite à la main, pas Claude Code)
`listDossierNotes`, `createDossierNote`, `updateDossierNote`,
`deleteDossierNote`, `listDossierPhotos`, `uploadDossierPhoto`,
`getPhotoObjectUrl`, `deleteDossierPhoto`. Points clés :
- **Compression client** avant upload (`compressImage`, canvas, max 1600px,
  JPEG 0.75, `imageOrientation: 'from-image'`) : ~10× de gain, ~300-500 Ko.
  À faire quel que soit le backend.
- Photos affichées via **fetch blob + `URL.createObjectURL`** (jamais
  `storage_key` dans un `<img src>` nu : les octets exigent le JWT). Révoquer
  l'object URL au démontage. Ce pattern rendra le cache offline trivial plus
  tard.
- `deleteDossierPhoto` : supprime d'abord la ligne DB (source de vérité UI),
  puis best-effort R2 (un objet orphelin est silencieux et sans gravité).
- **Upload multiple** : `<input multiple>`, boucle **séquentielle**
  (`for…of` + `await`, PAS `Promise.all` — une connexion chantier ne supporte
  pas les uploads parallèles), progression « 3/8 », échec par fichier
  n'interrompt pas les suivants, recharge de la liste UNE fois à la fin.

### Écran
Section « Carnet » dans l'écran dossier, **entre Documentation et Données
sensibles** (ordre : équipements → documentation → carnet → données sensibles).
Notes (titre gras si présent, pied « par {auteur_nom} le {date} », mention
« modifié par… » si updated_at ≠ created_at) + photos en grille de vignettes.
Édition/suppression via la modale de confirmation existante.

### État : terminé, déployé, testé à l'écran. Online-only pour l'instant
(cohérent avec la v1 du coffre ; offline = cache IndexedDB du blob plus tard).

---

## 2. Onboarding par liste blanche

### Le besoin
Avant : création de compte manuelle en base (email + mot de passe à la main),
ingérable. Voulu : un admin met des emails en « pending » via l'UI admin ; la
personne ouvre l'URL, saisit un email connu (pending), choisit un mot de passe,
donne son nom. Pas n'importe qui ne doit pouvoir s'enrôler.

### Décision structurante : le verrou est CÔTÉ SERVEUR
L'URL de l'app n'est pas secrète, la clé anon est publique : l'obscurité ne
protège rien. Par défaut, Supabase autorise `signUp()` public → la liste
« pending » serait décorative. Deux mesures **indissociables** :
- **Edge Function `enroll` (service_role)** qui vérifie la liste pending AVANT
  de créer le compte (même esprit que `web-search-notices` : une fonction
  serveur tient le secret et fait le contrôle).
- **Inscriptions publiques Supabase désactivées** — DERNIER geste, voir §6.

### Clé de la liste : l'email seul
Choisi plutôt qu'un code à usage unique. Proportionné à 50 personnes internes,
colle au modèle mental « la personne saisit un email que tu connais ».

### Table `onboarding_invitations` (migration dédiée)
`email` PK (normalisé lower+trim par trigger `normalize_invitation_email`),
`role` (check monteur/admin), `note`, `created_by`, `created_at`,
`consumed_at` (null = pending, renseigné = consommé), `consumed_by`.
**RLS admin-only** : une seule policy `for all` gardée par
`profiles.role = 'admin'`. L'anon n'a AUCUNE policy → la page d'enrôlement ne
lit jamais la liste (sinon fuite des emails invités). Seule l'Edge Function la
consulte, en service_role.

### Edge Function `enroll` — `supabase/functions/enroll/index.ts`
Config **cruciale** : `verify_jwt = false` dans `config.toml` (la personne qui
s'enrôle n'a pas encore de compte → pas de JWT). Contre-intuitif mais sûr : le
vrai contrôle n'est pas le JWT (impossible ici), c'est la vérif de la liste
pending À L'INTÉRIEUR. `verify_jwt = false` ouvre la porte, la liste blanche
est le videur.

Flux : valide email/password(≥12)/nom → cherche l'invitation pending non
consommée (même message 403 « pas autorisé » que l'email soit inconnu ou déjà
consommé, pour ne pas révéler qui est sur la liste) → `auth.admin.createUser`
avec `email_confirm: true` (pas d'email de confirmation, connexion immédiate) →
`profiles.upsert` (nom + rôle **de l'invitation**, jamais du client) → marque
l'invitation consommée. Si le profil échoue, `deleteUser` pour ne pas laisser
un user orphelin.

Testé de bout en bout : (1) email invité → `ok:true` (compte + profil créés,
mêmes id dans auth.users et profiles), (2) 2e fois → 403 (usage unique),
(3) email non invité → 403 même message. **Leçon** : plusieurs curl enchaînés,
la sortie du premier remonte hors écran — lancer un par un ou ajouter
`-w '\n--- HTTP %{http_code}\n'`.

### Écrans
- **Onglet « Onboarding »** dans `VaultAdminScreen` (à côté de
  Comptes/Accès/Rotation) : liste des invitations (badge « En attente » /
  « Enrôlé le… »), ajout email + rôle + note, suppression via modale existante.
  Gate `role === 'admin'`.
- **Page d'enrôlement publique** : l'app n'a **pas de routeur** (navigation
  pilotée par `needsLogin`). Donc **toggle par état local** (`'login'` /
  `'enroll'`) au niveau qui rend `LoginScreen`, PAS de react-router (toucherait
  au service worker / offline). Lien « Première connexion ? » sur le login →
  `EnrollScreen` (calqué visuellement sur LoginScreen, mêmes tokens). Champs :
  email, mot de passe ≥12 + confirmation (pas de reset email possible sans
  SMTP), nom. À la réussite : `signInWithPassword` dans la foulée → la session
  fait disparaître l'écran d'enrôlement.

### Distinction à ne jamais perdre
Ici on crée le **compte applicatif** (login Supabase + profil : documents,
dossiers, carnet). L'enrôlement du **coffre** (paire RSA + mot de passe de
coffre) reste séparé, dans l'app, après login — règle « récupérateurs d'abord »
inchangée. Deux mots de passe distincts : login Supabase ≠ mot de passe de
coffre.

### État : fonction déployée et testée, écrans construits. **Reste** : couper
les inscriptions publiques (§6) après un dernier test du parcours complet à
l'écran.

---

## 3. Amélioration de la recherche web de notices

### Le diagnostic (pas un bug)
La fonction `web-search-notices` ne « ratait » pas : elle était **réglée pour la
précision au détriment du rappel**. Le prompt préfère explicitement une liste
vide à un résultat imparfait. Trois filtres cumulés coupent le rappel :
fabricant-only, FR-only, biais du vide. **Mais** avant de relâcher quoi que ce
soit, on a ajouté de l'observabilité (on lit la source avant de patcher).

### L'exemple qui a tout clarifié
`abb / aba / knx` → vide. Cause réelle : **référence tronquée à la saisie**
(`aba` au lieu de `ABA/S 1.2.1`), pas un défaut de la fonction. Avec la réf
complète, la notice est trouvée. La fonction était donc bonne.

### Ce qui a été ajouté (option « tout au prompt »)
1. **Log `EMPTY`** : sur liste vide, `console.log` de ce que la recherche web a
   RÉELLEMENT ramené (`web_search_tool_result` → titres/URL) + le `finalText`.
   Distingue trois causes qu'on ne pouvait pas séparer avant : rien trouvé
   (requête) / trouvé puis écarté (filtres) / JSON non parsé. À GARDER : c'est
   l'instrument de mesure pour la suite.
2. **Repli sur la gamme** : nouveau paragraphe dans « ## Méthode de recherche ».
   Si la référence exacte ne donne rien, retirer le suffixe de déclinaison
   (`ABA/S 1.2.1` → `ABA/S`, `TN225-A` → `TN225`) et chercher le manuel de
   SÉRIE. Fréquent en KNX (un doc pour toute une famille). Retenu en confiance
   « faible/moyenne », titre indiquant qu'il couvre la gamme. Ajout
   **conditionnel** (« si la réf exacte ne donne rien ») → n'ajoute un chemin
   que sur les cas qui échouaient, sans bruiter ceux qui marchent.

### Rappel des réglages coût déjà en place (inchangés)
`WEB_SEARCH_MAX_USES = 3` (1 était trop agressif, 5 trop cher — 3 laisse la
marge de reformuler), `cache_control` sur le system prompt (identique à chaque
appel), variante de recherche à filtrage dynamique, plafond `DAILY_LIMIT = 50`
par user/jour via `web_search_log`.

### État : déployé, non-régression vérifiée (`ABA/S 1.2.1` marche toujours) et
repli fonctionnel. À observer via le log `EMPTY` sur les prochaines semaines :
si la troncature auto rate trop, on ajoutera un champ « gamme » côté appli —
pas avant d'avoir mesuré sur quels cas.

---

## 4. Environnement & outils (les frictions résolues, à ne pas réapprendre)

- **Deux CLI, deux tokens, JAMAIS de `login` interactif** (le flux navigateur
  coince en Codespace) :
  | Besoin | CLI | Auth (export) |
  |---|---|---|
  | Front, R2, Workers | `npx wrangler …` | `CLOUDFLARE_API_TOKEN` |
  | Edge Functions, DB | `npx supabase …` | `SUPABASE_ACCESS_TOKEN` |
- **CLI Supabase** : ni `npm supabase install` ni `npm install supabase`
  (bloqué). Utiliser **`npx supabase …`** (pas d'install globale).
- **Déployer une fonction** : `npx supabase functions deploy <nom>
  --project-ref iixqfajflyxrnizlqdsn` (le `--project-ref` évite l'étape
  `supabase link`).
- **Node 22 obligatoire** (wrangler l'exige). `nvm use 22` ne survit pas à un
  nouveau terminal → poser un `.nvmrc` (`echo "22" > .nvmrc`). Après un
  changement de version Node, `node_modules` se désaligne (**bug rolldown
  « Cannot find native binding »**) : `rm -rf node_modules package-lock.json &&
  npm install`.
- **R2 doit être activé** dans le dashboard (carte bancaire) avant tout
  `wrangler r2 bucket create` — sinon erreur 10042.
- **Solution définitive à la friction tokens** : mettre `CLOUDFLARE_API_TOKEN`
  et `SUPABASE_ACCESS_TOKEN` dans les **Codespaces secrets** GitHub (Settings →
  Codespaces → Secrets) — injectés automatiquement, plus jamais à exporter, pas
  dans le repo. (À faire si pas encore fait.)



---

## 5. Prochain chantier — améliorer les workflows n8n

Deux besoins, à traiter dans un cycle dédié (après avoir réglé la dette
service_role ci-dessus, qui touche justement ces workflows).

### 5.1 Ingestion par BLOC (dossier multi-PDF, souvent trié par marque)
Aujourd'hui : ingestion **fichier par fichier** via le formulaire. Voulu :
déposer un **dossier de PDF** (souvent rangés par marque) et tout intégrer d'un
coup. Pistes à explorer au moment venu : formulaire n8n en `multipleFiles:
true` + boucle (Split In Batches / Loop Over Items) réutilisant la logique
d'extraction/upload/insert existante ; déduire marque/spécialité du nom de
dossier ou de fichier quand c'est possible ; gérer les PDF scannés (le flag
`scanne` + tag `a-ocr` existe déjà) et les échecs par fichier sans casser le
lot. Point ouvert : à quel point automatiser les métadonnées (titre, type,
marque) vs les saisir une fois par lot.

### 5.2 Intégrer des notices NON possédées (ABB, Schneider, Hager, Legrand…)
Voulu : peupler la base avec des notices de fabricants dont on n'a pas le PDF
sous la main. **Levier déjà en place** : la chaîne `web-search-notices`
(trouve les URL de notices) + workflow `ingest-from-url` (télécharge une URL de
PDF + métadonnées, insère). Le prochain travail = orchestrer les deux (trouver
puis capturer en série, éventuellement par gamme via le nouveau repli-gamme).
**Licence — rappel** : les notices/manuels **librement distribués** par les
fabricants peuvent être hébergés en interne (pratique de métier courante). Ceci
est DISTINCT des normes sous licence **NIBT/NIN** qui, elles, ne se copient PAS
(fiches perso résumées + liens vers la plateforme officielle uniquement).

---

## 6. Méthode (elle a encore tenu)

- **Découper** : base (SQL) validée avant écrans ; couche données écrite à la
  main (déterministe) quand c'est possible, Claude Code réduit aux écrans.
- **Diagnostiquer avant de patcher** : lire la source réelle (log `EMPTY`,
  console réseau, réponse HTTP, éditeur SQL) plutôt que deviner. Cas d'école de
  cette session : la recherche web « cassée » qui n'était qu'une réf tronquée.
- **La source brute prime** sur tout résumé d'agent.
- **Le travail n'existe que poussé** : commit + push depuis le terminal
  authentifié ; le Worker `/api/photos` n'est actif en prod qu'après push.
- **Tester à l'écran plutôt qu'en curl** quand l'UI existe : le premier upload
  photo EST le test d'endpoint R2 ; le parcours d'enrôlement complet remplace
  tout curl.
- **Secrets** : clé anon publique = OK en clair (config, bundle) ;
  service_role / access tokens = JAMAIS dans code/Git/chat.
- **Prompt Claude Code cadré** : lui faire montrer la structure du fichier
  AVANT modif, interdire la réécriture des fonctions données, exiger le diff
  avant commit, ne pas le laisser commit/push.
