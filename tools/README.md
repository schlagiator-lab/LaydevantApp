# Procédure de restauration — LaydevantApp

Ce dossier contient la procédure de restauration d'une sauvegarde complète.
**Testée avec succès le 22 août 2026** : 29/29 tables sauvegardées restaurées à
l'identique, coffre compris.

Le modèle de sauvegarde repose sur deux moitiés complémentaires :

- **Les données** → workflow n8n vers Cloudflare R2 (`daily/AAAA-MM-JJ/`, un JSON
  par table + `_manifest.json`).
- **Le schéma** → `supabase/_schema_snapshot.sql`, versionné dans Git.

Aucune des deux ne suffit seule. Une restauration reconstruit d'abord le schéma,
puis les comptes, puis les données.

---

## Les quatre pièges (découverts lors du test réel)

### 1. `auth.users` n'est PAS dans la sauvegarde

C'est une table système Supabase, hors du schéma `public`. Or presque toutes les
tables ont une clé étrangère vers elle (`profiles.id`, `dossiers.created_by`,
`vault_user_keys.user_id`, tous les `deleted_by`…).

**Conséquence : sans recréer les comptes AVANT d'injecter les données, tout
échoue.** Et les comptes doivent avoir **exactement les mêmes UUID** qu'à
l'origine, sinon les FK pointent dans le vide.

Récupérer la liste des UUID depuis la base d'origine tant qu'elle est
accessible — ou, si elle ne l'est plus, les déduire de `profiles.json`
(colonne `id`) présent dans la sauvegarde.

### 2. `specialties` s'auto-référence

`specialties.parent_id` pointe vers `specialties.id`. Selon l'ordre des lignes,
l'insertion échoue. Le script traite cette table en **deux passes** : insertion
avec `parent_id` à NULL, puis mise à jour des parents.

### 3. Les types `text[]` et `jsonb` demandent un traitement différent

`documents.tags` est un `text[]`. Sérialisé en `"[]"` (syntaxe JSON), Postgres
refuse : `malformed array literal`. Il attend `{}`.

Inversement, `web_search_jobs.results` et `web_search_results.raw_results` sont
des `jsonb` contenant des tableaux à la racine : les passer comme tableau natif
provoque `invalid input syntax for type json`.

**Le script actuel devine le type d'après la valeur, ce qui ne peut pas être
correct dans les deux cas à la fois.** Correctif robuste si besoin : lire le type
réel de chaque colonne dans `information_schema.columns` et convertir en
conséquence. Pour un test ponctuel, relancer le script suffit (il est
idempotent).

### 4. L'ordre d'insertion est imposé par les clés étrangères

L'ordre est codé en dur dans `restore.js` (constante `ORDER`), déduit du graphe
réel des FK. Ne pas le modifier sans reconsulter ce graphe :

```sql
select c.conrelid::regclass::text as enfant,
       c.confrelid::regclass::text as parent
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where c.contype = 'f' and n.nspname = 'public'
order by 2, 1;
```

---

## Marche à suivre

### Étape 1 — Créer une base cible

Un projet Supabase neuf (jamais la production, sauf sinistre avéré).

### Étape 2 — Recréer le schéma

Copier tout le contenu de `supabase/_schema_snapshot.sql` dans le SQL Editor du
projet cible. Vérifier ensuite :

```sql
select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r') as tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public') as fonctions;
```

Repère du test du 22.08.2026 : **30 tables, 39 fonctions**.

### Étape 3 — Recréer les comptes

Insérer dans `auth.users` les utilisateurs avec leurs UUID d'origine. Les mots de
passe n'ont pas d'importance sur une base de test ; sur une vraie restauration,
prévoir une réinitialisation pour chaque utilisateur.

Modèle d'insertion (adapter les UUID et emails) :

```sql
insert into auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values (
  '<uuid>', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', '<email>',
  crypt('<mot-de-passe-temporaire>', gen_salt('bf')), now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, '', '', '', ''
)
on conflict (id) do nothing;
```

### Étape 4 — Injecter les données

Depuis un environnement disposant de Node (Codespaces ou VPS) :

```bash
npm install @aws-sdk/client-s3 pg

export R2_ACCOUNT_ID='...'
export R2_ACCESS_KEY_ID='...'
export R2_SECRET_ACCESS_KEY='...'
export PGURL='postgresql://...'      # chaîne de la base CIBLE
export BACKUP_DATE=AAAA-MM-JJ

node restore.js
```

**Garde-fou avant de lancer** — vérifier qu'on ne pointe pas sur la production :

```bash
echo $PGURL | grep -o '<ref-du-projet-cible>' \
  && echo "OK : bonne cible" || echo "STOP : mauvaise base"
```

Le script est **idempotent** (`on conflict do nothing`) : il peut être relancé
sans risque de doublon.

### Étape 5 — Vérifier

Le script affiche en fin d'exécution un tableau comparant, pour chaque table :
lignes insérées / attendues selon le `_manifest.json` / réellement présentes en
base / conforme oui-non.

**Une restauration n'est validée que si toutes les tables sont conformes.** Ne
jamais se fier au seul fait que le script s'est terminé.

---

## Ce que la restauration ne couvre PAS

- **Les fichiers binaires sur R2** (PDF de la bibliothèque, photos, fichiers du
  coffre). La sauvegarde contient le *catalogue* (`documents`, `dossier_photos`,
  `vault_files`), pas les octets. Une ligne restaurée pointe vers un objet R2 qui
  doit exister par ailleurs.
- **`private_config`**, exclue volontairement de la sauvegarde (config
  reconstructible ; évite de dupliquer des quasi-secrets au repos).
- **Les Edge Functions et leurs secrets**, qui vivent côté Supabase et se
  redéploient depuis le dépôt.
- **Les tables créées après la date de la sauvegarde utilisée** : elles
  apparaîtront comme « ABSENT du backup ». Normal, pas une erreur.
