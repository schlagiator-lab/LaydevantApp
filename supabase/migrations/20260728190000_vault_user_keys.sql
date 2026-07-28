-- =====================================================================
-- Coffre données sensibles — TRANCHE 1 : vault_user_keys
-- La paire de clés (RSA-OAEP) de chaque utilisateur, publiée à la
-- première connexion. Aucun secret en clair : seule la clé publique
-- est en clair, la clé privée est emballée deux fois (mot de passe /
-- clé de récupération). Voir "Feature coffre données sensibles.md".
--
-- À versionner dans supabase/migrations/ (préfixe timestamp à ajouter).
-- Testable seul : aucune dépendance à vault_secrets / vault_dossier_access.
-- =====================================================================

-- --- Helper : l'appelant est-il admin ? (SECURITY DEFINER pour éviter
-- --- la RLS de profiles et toute récursion) -------------------------
create or replace function public.is_vault_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- --- Table ----------------------------------------------------------
create table if not exists public.vault_user_keys (
  user_id                       uuid primary key references auth.users(id) on delete cascade,
  public_key                    text not null,   -- RSA publique (spki, base64), en clair
  wrapped_private_key_pw        text not null,   -- privée emballée sous clé PBKDF2 du mot de passe
  wrapped_private_key_recovery  text not null,   -- privée emballée sous clé PBKDF2 de récupération
  pw_salt                       text not null,
  recovery_salt                 text not null,
  pw_iv                         text not null,
  recovery_iv                   text not null,
  kdf_iterations                integer not null,
  access_enabled                boolean not null default false,  -- levier admin (§5)
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

alter table public.vault_user_keys enable row level security;

-- --- Garde-fou : seul un admin peut toucher access_enabled ----------
-- Un utilisateur peut créer/mettre à jour SA ligne (rotation de mot de
-- passe = réécrire wrapped_private_key_pw), mais ne peut PAS s'ouvrir
-- l'accès lui-même. Le trigger neutralise toute tentative.
create or replace function public.vault_user_keys_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_vault_admin() then
    if tg_op = 'INSERT' then
      new.access_enabled := false;
    elsif tg_op = 'UPDATE' then
      new.access_enabled := old.access_enabled;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_vault_user_keys_guard on public.vault_user_keys;
create trigger trg_vault_user_keys_guard
  before insert or update on public.vault_user_keys
  for each row execute function public.vault_user_keys_guard();

-- --- RLS ------------------------------------------------------------
-- Lecture : sa propre ligne, ou tout pour un admin (panneau admin).
drop policy if exists vault_user_keys_select on public.vault_user_keys;
create policy vault_user_keys_select on public.vault_user_keys
  for select using (user_id = auth.uid() or public.is_vault_admin());

-- Création : uniquement sa propre ligne.
drop policy if exists vault_user_keys_insert on public.vault_user_keys;
create policy vault_user_keys_insert on public.vault_user_keys
  for insert with check (user_id = auth.uid());

-- Mise à jour : sa propre ligne, ou un admin (pour activer l'accès).
-- Le trigger empêche un non-admin de modifier access_enabled.
drop policy if exists vault_user_keys_update on public.vault_user_keys;
create policy vault_user_keys_update on public.vault_user_keys
  for update using (user_id = auth.uid() or public.is_vault_admin())
  with check (user_id = auth.uid() or public.is_vault_admin());

-- Suppression : admin uniquement (nettoyage de compte).
drop policy if exists vault_user_keys_delete on public.vault_user_keys;
create policy vault_user_keys_delete on public.vault_user_keys
  for delete using (public.is_vault_admin());

-- --- Vue des clés publiques emballables -----------------------------
-- Expose (user_id, public_key) des SEULS utilisateurs autorisés, à tout
-- authentifié : nécessaire pour emballer une DEK vers eux à la création
-- d'un dossier (tranche 2). N'expose jamais les enveloppes privées.
-- Vue en security_invoker OFF (défaut) : contourne la RLS de la table
-- pour ne livrer que ces deux colonnes filtrées.
create or replace view public.vault_public_keys as
  select user_id, public_key
  from public.vault_user_keys
  where access_enabled = true;

grant select on public.vault_public_keys to authenticated;
