-- =====================================================================
-- Coffre données sensibles — TRANCHE 2 : vault_secrets + vault_dossier_access
-- Le contenu chiffré (un par dossier) et les DEK emballées (présence =
-- accès). Dépend de la tranche 1 (vault_user_keys, is_vault_admin).
-- Voir "Feature coffre données sensibles.md".
--
-- Modèle d'accès rappelé :
--   * Le VRAI verrou "qui a accès au coffre" = access_enabled (tranche 1,
--     admin-only). Les lignes vault_dossier_access ne font que MATÉRIALISER
--     l'emballage d'une DEK vers quelqu'un de déjà autorisé.
--   * Emballer (INSERT/UPDATE d'une ligne d'accès) : tout utilisateur qui a
--     lui-même accès — nécessaire pour qu'un tech interne emballe la DEK
--     vers les autorisés à la CRÉATION d'un dossier.
--   * Révoquer (DELETE) : admin uniquement (geste nominatif + nettoyage de
--     rotation).
--   * Corollaire : l'admin qui ACTIVE un externe ou ROTE une clé doit
--     lui-même être access_enabled=true — il faut la DEK en clair pour la
--     ré-emballer. Un admin non-autorisé ne peut que révoquer (DELETE),
--     pas activer ni roter.
-- =====================================================================

-- --- Helpers (SECURITY DEFINER : bypass RLS, évite la récursion) -----

-- L'appelant a-t-il accès au coffre en général (access_enabled) ?
create or replace function public.has_vault_access()
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.vault_user_keys
    where user_id = auth.uid() and access_enabled = true
  );
$$;

-- (has_dossier_vault_access est défini plus bas, APRÈS sa table.)

-- =====================================================================
-- vault_dossier_access — les DEK emballées (créée avant vault_secrets
-- et avant has_dossier_vault_access, qui la référencent)
-- =====================================================================
create table if not exists public.vault_dossier_access (
  dossier_id   uuid not null references public.dossiers(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  wrapped_dek  text not null,          -- DEK emballée vers la clé publique RSA de l'user
  dek_version  integer not null default 1,
  granted_by   uuid default auth.uid() references auth.users(id),
  granted_at   timestamptz not null default now(),
  primary key (dossier_id, user_id)
);

alter table public.vault_dossier_access enable row level security;

-- Lecture : ses propres lignes (pour déballer sa DEK), ou tout pour un admin.
drop policy if exists vault_dossier_access_select on public.vault_dossier_access;
create policy vault_dossier_access_select on public.vault_dossier_access
  for select using (user_id = auth.uid() or public.is_vault_admin());

-- Octroi : tout utilisateur autorisé peut emballer (création de dossier),
-- l'admin aussi. La valeur emballée n'a de sens que produite correctement,
-- donc une ligne "bidon" ne donne accès à rien.
drop policy if exists vault_dossier_access_insert on public.vault_dossier_access;
create policy vault_dossier_access_insert on public.vault_dossier_access
  for insert with check (public.has_vault_access() or public.is_vault_admin());

-- Mise à jour (rotation : réécriture de wrapped_dek/dek_version).
drop policy if exists vault_dossier_access_update on public.vault_dossier_access;
create policy vault_dossier_access_update on public.vault_dossier_access
  for update using (public.has_vault_access() or public.is_vault_admin())
  with check (public.has_vault_access() or public.is_vault_admin());

-- Révocation : admin uniquement.
drop policy if exists vault_dossier_access_delete on public.vault_dossier_access;
create policy vault_dossier_access_delete on public.vault_dossier_access
  for delete using (public.is_vault_admin());

-- L'appelant a-t-il une ligne d'accès pour CE dossier ? (défini ici,
-- maintenant que vault_dossier_access existe)
create or replace function public.has_dossier_vault_access(p_dossier_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.vault_dossier_access
    where dossier_id = p_dossier_id and user_id = auth.uid()
  );
$$;

-- =====================================================================
-- vault_secrets — le contenu chiffré, un par dossier
-- =====================================================================
create table if not exists public.vault_secrets (
  dossier_id   uuid primary key references public.dossiers(id) on delete cascade,
  ciphertext   text not null,          -- contenu AES-GCM (base64)
  content_iv   text not null,          -- IV AES-GCM du contenu
  dek_version  integer not null default 1,
  updated_by   uuid default auth.uid() references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.vault_secrets enable row level security;

create or replace function public.vault_secrets_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_vault_secrets_touch on public.vault_secrets;
create trigger trg_vault_secrets_touch
  before update on public.vault_secrets
  for each row execute function public.vault_secrets_touch();

-- Lecture : seulement si on a une ligne d'accès pour ce dossier (le
-- ciphertext reste chiffré de toute façon), ou admin.
drop policy if exists vault_secrets_select on public.vault_secrets;
create policy vault_secrets_select on public.vault_secrets
  for select using (
    public.has_dossier_vault_access(dossier_id) or public.is_vault_admin()
  );

-- Création du coffre d'un dossier : par tout utilisateur autorisé (il
-- génère la DEK et chiffre), ou admin. Le créateur insère dans la foulée
-- les lignes vault_dossier_access correspondantes.
drop policy if exists vault_secrets_insert on public.vault_secrets;
create policy vault_secrets_insert on public.vault_secrets
  for insert with check (public.has_vault_access() or public.is_vault_admin());

-- Édition du contenu / rotation : réservée aux ayants droit du dossier.
drop policy if exists vault_secrets_update on public.vault_secrets;
create policy vault_secrets_update on public.vault_secrets
  for update using (
    public.has_dossier_vault_access(dossier_id) or public.is_vault_admin()
  ) with check (
    public.has_dossier_vault_access(dossier_id) or public.is_vault_admin()
  );

-- Suppression du coffre : admin uniquement (destructif).
drop policy if exists vault_secrets_delete on public.vault_secrets;
create policy vault_secrets_delete on public.vault_secrets
  for delete using (public.is_vault_admin());
