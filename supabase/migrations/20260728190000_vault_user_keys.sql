-- Coffre de données sensibles (étape B) — tranche 1.
-- Voir "Feature coffre données sensibles.md", §2-3 et §8-9. Domaine
-- auto-contenu : ses propres migrations versionnées ici (comme
-- web_search_log), jamais alimenté par n8n.
--
-- vault_user_keys porte la paire RSA-OAEP de chaque utilisateur et les deux
-- enveloppes qui protègent sa clé privée (mot de passe de coffre, clé de
-- récupération). Rien n'y est stocké en clair hormis la clé publique, qui
-- est publique par nature. Aucune table ici ne contient jamais de DEK nue,
-- de mot de passe ou de clé de récupération.

create table if not exists public.vault_user_keys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  public_key text not null,
  wrapped_private_key_pw text not null,
  wrapped_private_key_recovery text not null,
  pw_salt text not null,
  recovery_salt text not null,
  pw_iv text not null,
  recovery_iv text not null,
  kdf_iterations int not null check (kdf_iterations > 0),
  access_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vault_user_keys enable row level security;

-- Chacun lit et écrit sa propre ligne : création de sa paire à la première
-- connexion, changement de mot de passe, régénération après récupération.
-- access_enabled est volontairement exclu de ce qu'un utilisateur peut faire
-- varier lui-même — voir le trigger plus bas, pas ces policies.
create policy "Users can view their own vault key row"
  on public.vault_user_keys for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can create their own vault key row"
  on public.vault_user_keys for insert
  to authenticated
  with check (user_id = auth.uid() and access_enabled = false);

create policy "Users can update their own vault key row"
  on public.vault_user_keys for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Un UPDATE ne peut porter que sur une ligne visible par une policy SELECT
-- (règle Postgres, pas une lecture ajoutée par choix) : sans policy SELECT
-- dédiée aux admins, la policy d'update ci-dessous serait syntaxiquement
-- valide mais silencieusement inopérante sur la ligne d'un autre utilisateur.
create policy "Admins can view any vault key row"
  on public.vault_user_keys for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Levier admin (§5) : activer/révoquer l'accès de n'importe quel utilisateur.
-- En pratique, cette policy ne sert qu'à faire varier access_enabled — le
-- trigger ci-dessous borne ce qu'elle autorise réellement à changer.
create policy "Admins can update any vault key row"
  on public.vault_user_keys for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Deux garde-fous en un : (1) sans le premier bloc, la policy "own row"
-- laisserait n'importe quel utilisateur s'auto-accorder l'accès au coffre en
-- modifiant sa propre ligne — access_enabled ne doit changer que sous la
-- policy admin ; (2) sans le second, cette même policy admin (qui doit
-- pouvoir viser la ligne de n'importe qui pour cette seule colonne) pourrait
-- tout aussi bien réécrire la clé publique ou les enveloppes d'un autre
-- utilisateur — access_enabled est le SEUL levier admin sur cette table.
create or replace function public.vault_guard_access_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access_enabled is distinct from old.access_enabled then
    if not exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    ) then
      raise exception 'access_enabled ne peut être modifié que par un administrateur';
    end if;
  end if;

  if auth.uid() is distinct from old.user_id then
    if new.public_key is distinct from old.public_key
      or new.wrapped_private_key_pw is distinct from old.wrapped_private_key_pw
      or new.wrapped_private_key_recovery is distinct from old.wrapped_private_key_recovery
      or new.pw_salt is distinct from old.pw_salt
      or new.recovery_salt is distinct from old.recovery_salt
      or new.pw_iv is distinct from old.pw_iv
      or new.recovery_iv is distinct from old.recovery_iv
      or new.kdf_iterations is distinct from old.kdf_iterations
    then
      raise exception 'un administrateur ne peut modifier que access_enabled sur la ligne d''un autre utilisateur';
    end if;
  end if;

  return new;
end;
$$;

create trigger vault_user_keys_guard_access_enabled
  before update on public.vault_user_keys
  for each row
  execute function public.vault_guard_access_enabled();

-- Vue des clés publiques (§5, §8) : emballer une DEK vers un autre
-- utilisateur exige de connaître sa clé publique, donc cette projection doit
-- être visible pour tout utilisateur authentifié — alors que la table
-- elle-même ne l'est que ligne par ligne. Créée dans une migration, elle
-- appartient au rôle d'exécution des migrations (postgres, BYPASSRLS côté
-- Supabase) : elle contourne donc délibérément les policies "own row"
-- ci-dessus pour exposer toutes les lignes. C'est le comportement recherché,
-- pas un contournement accidentel — ne jamais y ajouter les colonnes
-- d'enveloppe, de sel ou d'IV.
create or replace view public.vault_public_keys as
  select user_id, public_key, access_enabled
  from public.vault_user_keys;

grant select on public.vault_public_keys to authenticated;
