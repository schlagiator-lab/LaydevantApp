# Audit pré-production — LaydevantApp

Audit en lecture seule. Aucun fichier de code modifié, aucun commit, aucune
migration lancée. Ce document ne contient pas de correctifs — chaque
trouvaille sera traitée séparément, une par une.

Périmètre couvert : fuite de secrets, gates d'autorisation (Edge Functions +
RPC `SECURITY DEFINER`), gestion d'erreur sur les chemins critiques,
garde-fous iOS, état lint/typecheck, code mort de l'ancien chemin de
recherche web.

## Récapitulatif

| Sévérité | Nombre |
|---|---|
| Bloquant prod | 3 |
| À corriger | 6 |
| Cosmétique | 6 |
| **Total** | **15** |

---

## Bloquant prod

### 1. `supabase/functions/add-dossier-equipment-notice/index.ts:200-222` — approbation de demande d'équipement sans vérifier le lien appelant ↔ demande

**Problème** : l'étape 5 de la fonction accepte un `request_id` fourni tel quel dans le body par le client, et l'utilise pour faire, avec `service_role`, un `UPDATE` sur `dossier_equipment_requests` (statut → `approved`, `resolved_by`, `resolved_product_id`) sans vérifier que ce `request_id` appartient au `dossier_id`/à l'appelant du reste de la requête. Seul un filtre `.eq('status', 'pending')` limite le rayon d'action.

**Impact** : n'importe quel utilisateur authentifié (simple monteur, pas admin) peut faire approuver n'importe quelle demande d'équipement `pending` d'un tiers en fournissant son `id` dans le body, en dehors du flux normal. Cela contourne directement la règle documentée en CLAUDE.md §3/§11 : « Résolution admin-only... jamais d'update direct côté client » — ici c'est un `UPDATE` en `service_role` déclenché par un non-admin.

### 2. RPC `SECURITY DEFINER` sensibles absentes de tout fichier versionné dans le dépôt — re-vérification interne du rôle invérifiable

**Fonctions concernées** : `resolve_dossier_equipment_request` (écrit `products`/`dossier_produits`), `upsert_dossier_product` (écrit `products`, appelée par `add-dossier-equipment-notice/index.ts:137`), `soft_delete_communication`, `set_comms_publisher`. Aucune n'a de `CREATE FUNCTION`/`CREATE OR REPLACE FUNCTION` dans `supabase/migrations/**/*.sql` (recherche exhaustive du dossier `migrations/`).

**Problème** : CLAUDE.md documente ces quatre RPC comme admin-only avec revérification interne de `is_vault_admin()`, mais leur code SQL réel n'est présent nulle part dans le dépôt (contrairement à `search_dossiers`, `dossier_documents_complets` et `rotate_vault_secret`, qui elles sont versionnées et vérifiables — `rotate_vault_secret` fait un exemple correct de la vérification attendue, `20260730_090000_vault_rotate_secret.sql:41-43`).

**Impact** : impossible de confirmer par lecture de source, avant mise en prod, que ces quatre fonctions revérifient bien le rôle appelant à l'intérieur de leur corps plutôt que de faire confiance à un contrôle uniquement côté client/RLS de façade. Ce sont les opérations les plus sensibles de l'app (écriture catalogue produits, résolution de demandes, suppression de communication, octroi du droit de publier) — le risque n'est pas confirmé mais n'est pas non plus exclu par le dépôt.

### 3. `src/lib/auth.tsx:18-22` — `getSession()` sans `.catch()`, écran blanc indéfini possible

```ts
supabase.auth.getSession().then(({ data }) => {
  if (cancelled) return;
  setSession(data.session);
  setIsReady(true);
});
```

**Problème** : aucune gestion du cas où la promesse rejette (storage local corrompu/indisponible). `setIsReady(true)` n'est alors jamais appelé, et `src/App.tsx:115` fait `if (!isReady) return null;`.

**Impact** : l'application entière reste sur un écran blanc, indéfiniment, sans aucun message d'erreur ni fallback — y compris pour un technicien qui a déjà des documents épinglés hors ligne et n'a besoin d'aucun réseau pour les consulter. C'est exactement le scénario que CLAUDE.md §6 décrit vouloir éviter à tout prix (« un technicien qui se retrouve éjecté de l'application dans une cave... perd l'accès à des documents pourtant présents sur son appareil ») — ici le mécanisme de protection lui-même a un trou qui produit un blocage total plutôt qu'une dégradation. Probabilité faible, mais aucun garde-fou (pas de timeout, pas de fallback) une fois le cas déclenché.

---

## À corriger

### 4. `supabase/functions/enroll/index.ts:98-101` — retour d'erreur du `.update()` ignoré

```ts
await admin
  .from('onboarding_invitations')
  .update({ consumed_at: new Date().toISOString(), consumed_by: userId })
  .eq('email', email);

return json({ ok: true }, 200);
```

**Problème** : le `{ error }` de cet `.update()` n'est ni destructuré ni vérifié avant de renvoyer `{ ok: true }`.

**Impact** : si cette écriture échoue (panne DB transitoire), le compte applicatif est bien créé et utilisable — pas de perte pour l'utilisateur — mais l'invitation reste visible comme « pending » côté admin alors que la personne est déjà enrôlée, source de confusion pour le panneau Onboarding.

### 5. Gate `verify_jwt` des Edge Functions invérifiable statiquement depuis le dépôt

**Problème** : aucun `supabase/config.toml` ni fichier de config par fonction n'est versionné dans le dépôt (seul `supabase/.temp/linked-project.json`, généré localement, existe). Le gate `verify_jwt` réel de chaque fonction (`enroll` désactivé, les autres activées) n'est documenté que par des commentaires en tête de fichier, jamais par une source de configuration vérifiable en revue de code.

**Impact** : rien n'empêche un futur déploiement avec un `verify_jwt` erroné (ex. désactivé par erreur sur une fonction admin) sans que cela apparaisse dans un diff Git.

### 6. `src/components/PdfTetris.tsx:593` — mutation d'une valeur reçue en argument de hook (`react-hooks/immutability`)

```
591 |   useEffect(() => {
592 |     const audio = primedMusicAudio ?? new Audio(TETRIS_MUSIC_SRC);
593 |     audio.loop = true;
```

**Problème** : `audio` peut référencer directement `primedMusicAudio`, une valeur passée en prop/argument, mutée ensuite (`audio.loop`, `audio.volume`) — flaggé par la règle ESLint `react-hooks/immutability` comme modification interdite d'une valeur externe au composant.

**Impact** : lié à la fonctionnalité mode duo (musique host, commit `c8ed5ff`) — risque de désynchronisation d'état audio entre rendus, non critique pour les chemins documentation/dossiers/coffre.

### 7. `src/components/PdfTetris.tsx:609` — mutation d'un ref juste après un appel de hook (`react-hooks/immutability`)

```
607 |   useEffect(() => {
608 |     const sfx = createTetrisSfx();
609 |     sfxRef.current = sfx;
```

**Problème** : `sfxRef.current` est modifié après le retour du hook plutôt qu'avant son appel, flaggé par la même règle ESLint.

**Impact** : même feature (mini-jeu, non critique), risque de désynchronisation d'état entre le ref et les effets qui en dépendent.

### 8. `src/screens/GameDuoLobbyScreen.tsx:179` — accès à un ref pendant le rendu (`react-hooks/refs`)

```
177 |         duoMatch={launch}
178 |         onExitDuoMatch={handleExitDuoMatch}
> 179 |         primedMusicAudio={primedMusicRef.current ?? undefined}
```

**Problème** : `primedMusicRef.current` est lu directement dans le JSX rendu (pas dans un effet/handler), ce que React documente comme pouvant empêcher le composant de se remettre à jour correctement.

**Impact** : mode duo du mini-jeu, non critique ; risque de non-mise à jour de l'état audio primé lors d'un re-render.

### 9. `supabase/functions/web-search-notices/index.ts` — Edge Function de l'ancien pipeline encore présente et probablement encore déployée

**Problème** : le code complet de l'ancienne Edge Function `web-search-notices` (décrite en CLAUDE.md §9 comme le chemin en production) est toujours dans le dépôt, mais `src/lib/webSearch.ts` ne l'appelle plus du tout (aucune occurrence de `supabase.functions.invoke('web-search-notices'` dans `src/`) — le front fait désormais un `INSERT` direct sur une table `web_search_jobs` puis un polling (`src/lib/webSearch.ts:93-168`), confirmé par `HANDOFF_recherche_web_ensemble_juge.md:210` (« débrancher l'ancienne Edge Function `web-search-notices` — le nouveau chemin ne passe plus par elle ») et `ETAT_PROJET.md:255`.

**Impact** : CLAUDE.md §9 est obsolète sur toute la description de l'architecture de recherche web (l'actuelle passe par `web_search_jobs` + n8n + juge LLM, pas par cette Edge Function) — risque de mauvaises décisions si quelqu'un s'y fie pour une future modification. La fonction elle-même reste potentiellement déployée et invocable par tout utilisateur authentifié (elle a `verify_jwt` activé), ce qui n'est pas une faille en soi mais un coût/une surface résiduelle inutile (peut encore consommer du budget Anthropic si appelée directement).

---

## Cosmétique

### 10. Historique Git — ancien commit `.env.local` jamais purgé (clé anon uniquement)

**Problème** : `.env.local` a été commité par erreur (`9668fb5 "Create .env.local"`) puis retiré du suivi (`6b0e7bf "Retire .env.local du suivi git"`), mais reste visible pour toujours dans l'historique Git (pas de réécriture d'historique). Contenu : uniquement `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (ancien format JWT de la clé anon).

**Impact** : la clé anon est publique par conception (RLS = la vraie protection, CLAUDE.md §13), donc pas une fuite critique — mais reste un point d'hygiène/traçabilité Git à connaître.

### 11. `worker/index.js:129-152` — comportement du `DELETE` plus nuancé que ce que documente CLAUDE.md §13

**Problème** : CLAUDE.md §13 affirme sans nuance que « `DELETE` est admin-only ». Le code réel autorise aussi un utilisateur non-admin ayant accès au dossier concerné à supprimer un fichier sous le préfixe `vault/` (`checkHasDossierVaultAccess`, ligne 137, en plus de `checkIsAdmin`), miroir volontaire de la policy Postgres `vault_files` DELETE (commentaire lignes 121-125). Tous les autres préfixes restent strictement admin-only.

**Impact** : aucune faille — comportement intentionnel et cohérent avec le modèle du coffre — mais la documentation CLAUDE.md est à corriger pour refléter cette branche.

### 12. Écart doc/code — CLAUDE.md §15 dit « Android uniquement, aucun iOS » alors que le code maintient des garde-fous iOS actifs

**Problème** : `isIosDevice()` (`src/lib/pdfMeasure.ts:47-52`), viewers PDF/plan dédiés iOS (`PlansSection.tsx`, `VaultSheet.tsx`, `EquipmentRequestNotices.tsx`), polyfill `pdf.js` et verrou anti-overscroll sont activement maintenus, avec des commentaires citant des retours terrain iOS/WebKit précis.

**Impact** : simple écart de documentation à signaler (soit §15 est obsolète, soit un usage iOS existe déjà sans être documenté) — pas un bug, ces garde-fous sont par ailleurs tous conformes (voir section 4 de l'audit, aucune violation trouvée).

### 13. `no-useless-assignment` — variable `n8nBody` assignée puis jamais utilisée

**Fichiers** : `supabase/functions/add-dossier-equipment-notice/index.ts:175`, `supabase/functions/promote-equipment-notice/index.ts:171`.

**Impact** : code mort mineur détecté par ESLint, aucun impact fonctionnel.

### 14. `web_search_jobs` colonnes par-moteur obsolètes + `private_config.n8n_webhook_url_pplx` — hors du contrôle du dépôt

**Problème** : ni la table `web_search_jobs` ni `private_config` n'ont de migration versionnée dans ce dépôt (schéma géré hors dépôt, cohérent avec CLAUDE.md §3). Le front n'utilise que 3 colonnes de `web_search_jobs` (`id, status_final, final_results` — `src/lib/webSearch.ts:25`). D'éventuelles colonnes par-moteur obsolètes (`results_anthropic`, `results_perplexity`, `status_*`, `done_at_*`, citées dans `HANDOFF_recherche_web_ensemble_juge.md:280`) et la clé `n8n_webhook_url_pplx` (citée comme « orpheline » dans le même document) ne sont référencées nulle part dans le code applicatif de ce dépôt.

**Impact** : rien à nettoyer côté ce dépôt — à vérifier/nettoyer directement côté base Supabase (hors périmètre du code source).

### 15. Warnings ESLint `react-refresh/only-export-components` (3)

**Fichiers** : `src/components/AnnotationOverlay.tsx:35`, `src/components/EquipmentRequestSheet.tsx:36`, `src/components/PdfTetris.tsx:195`.

**Impact** : purement stylistique (dégrade le fast-refresh en dev), aucun impact fonctionnel ni en production.

---

## Annexe A — Inventaire des Edge Functions et de leurs gates

| Fonction | Gate déclaré | Contrôle interne réel | Statut |
|---|---|---|---|
| `enroll/index.ts` | `verify_jwt` désactivé (nécessaire, l'appelant n'a pas encore de compte) | `service_role` + vérifie `onboarding_invitations.consumed_at IS NULL` avant `auth.admin.createUser` ; rôle pris depuis l'invitation, jamais depuis le body client | RAS (hors finding #4) |
| `delete-account/index.ts` | `verify_jwt` activé | Relit `profiles.role` de l'appelant en `service_role`, exige `admin`, exige cible non-admin, accès coffre déjà révoqué et cible non-récupérateur | RAS |
| `promote-equipment-notice/index.ts` | `verify_jwt` activé | Rejoue le JWT sur un client scopé puis `caller.rpc('is_vault_admin')`, refuse si non admin | RAS |
| `add-dossier-equipment-notice/index.ts` | `verify_jwt` activé | Gate authentifié simple (assumé, chemin direct monteur) | Voir finding #1 (bloquant) |
| `web-search-notices/index.ts` | `verify_jwt` activé | Décode le JWT (sans le revérifier), le rejoue ensuite sur un client scopé pour la RLS `web_search_log` | RAS pour le gate ; voir finding #9 (code mort) |

Gate `verify_jwt` non confirmable statiquement pour aucune fonction faute de `config.toml` versionné — voir finding #5.

## Annexe B — Inventaire des RPC `SECURITY DEFINER`

| Fonction | Migration | Revérification interne du rôle |
|---|---|---|
| `is_vault_admin()` | `20260728190000_vault_user_keys.sql:14-25` | N/A (helper) |
| `vault_user_keys_guard()` (trigger) | `20260728190000_vault_user_keys.sql:49-66`, redéfini `20260729_184323_vault_recovery_admin.sql:25-44` | Oui — appelle `is_vault_admin()` |
| `has_vault_access()` | `20260728190500_vault_secrets_access.sql:25-33` | N/A (helper lecture) |
| `has_dossier_vault_access(p_dossier_id)` | `20260728190500_vault_secrets_access.sql:78-86` | N/A (helper lecture) |
| `vault_secrets_touch()` (trigger) | `20260728190500_vault_secrets_access.sql:103-110` | N/A (horodatage seul) |
| `rotate_vault_secret(...)` | `20260730_090000_vault_rotate_secret.sql:23-119` | Oui — `is_vault_admin()` vérifié ligne 41-43 avant toute écriture, exemplaire |
| `delete_dossier_equipment_request(p_request_id)` | `20260820190000_delete_dossier_equipment_request.sql:23-46` | Oui — admin OU (auteur ET statut `pending`), lignes 37-40 |
| `normalize_invitation_email()` (trigger) | `20260731090000_onboarding_invitations.sql:19-25` | N/A (n'écrit rien de sensible) |
| `search_dossiers` | `20260728182730_fix_dossier_documents_rpc.sql:36`, `20260801100000_add_notes_to_search_dossiers.sql:25` | Lecture seule, RLS standard |
| `dossier_documents_complets` | `20260728182730_fix_dossier_documents_rpc.sql:74` | Lecture seule, RLS standard |
| `resolve_dossier_equipment_request` | **Absente du dépôt** | Invérifiable — voir finding #2 |
| `upsert_dossier_product` | **Absente du dépôt** | Invérifiable — voir finding #2 |
| `soft_delete_communication` | **Absente du dépôt** | Invérifiable — voir finding #2 |
| `set_comms_publisher` | **Absente du dépôt** | Invérifiable — voir finding #2 |

## Annexe C — État lint + typecheck (détail complet)

**Typecheck** (`npx tsc --noEmit -p tsconfig.app.json`) : **0 erreur**.

**Lint** (`npm run lint`, ESLint) : **6 erreurs, 3 warnings** (9 problèmes au total).

Erreurs :
1. `src/components/PdfTetris.tsx:593:5` — `react-hooks/immutability` (finding #6)
2. `src/components/PdfTetris.tsx:609:5` — `react-hooks/immutability` (finding #7)
3. `src/screens/GameDuoLobbyScreen.tsx:179:27` — `react-hooks/refs` (finding #8)
4. `src/screens/GameDuoLobbyScreen.tsx:179:27` — `react-hooks/refs` (occurrence dupliquée par ESLint sur la même ligne, finding #8)
5. `supabase/functions/add-dossier-equipment-notice/index.ts:175:7` — `no-useless-assignment` (finding #13)
6. `supabase/functions/promote-equipment-notice/index.ts:171:7` — `no-useless-assignment` (finding #13)

Warnings :
1. `src/components/AnnotationOverlay.tsx:35:17` — `react-refresh/only-export-components` (finding #15)
2. `src/components/EquipmentRequestSheet.tsx:36:14` — `react-refresh/only-export-components` (finding #15)
3. `src/components/PdfTetris.tsx:195:17` — `react-refresh/only-export-components` (finding #15)

## Annexe D — Code mort ancien chemin recherche web (détail)

Voir finding #9 pour l'Edge Function `web-search-notices` et finding #14 pour
`web_search_jobs`/`private_config.n8n_webhook_url_pplx`. Constat transverse :
`CLAUDE.md` §9 décrit encore l'ancienne architecture (Edge Function →
Anthropic) comme le chemin en production ; le code réel (`src/lib/webSearch.ts`)
utilise déjà le nouveau pipeline `web_search_jobs` + n8n + juge LLM, documenté
dans `HANDOFF_recherche_web_ensemble_juge.md` et `ETAT_PROJET.md` mais pas
encore répercuté dans `CLAUDE.md`.
