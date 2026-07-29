-- =====================================================================
-- Coffre données sensibles — TRANCHE 1-bis : récupération par admin
-- Dépend de la tranche 1 (vault_user_keys, is_vault_admin, trigger guard).
--
-- Principe : deux comptes "admin-récupérateur" (toi + un suppléant) ont
-- accès à TOUS les coffres — les DEK leur sont emballées comme à tout
-- autorisé. Un monteur qui oublie son mot de passe de coffre NE récupère
-- pas son ancienne clé : il se ré-enrôle (nouvelle paire, nouveau mot de
-- passe) et un admin lui ré-emballe ses accès (même geste que l'activation).
-- => AUCUNE nouvelle crypto : réutilise wrapDekForUser / unwrapDek.
--
-- Cette tranche n'ajoute qu'un MARQUEUR : qui porte le rôle récupérateur.
-- Contrainte d'installation : les 2 admins s'enrôlent EN PREMIER, avant
-- tout monteur.
-- =====================================================================

-- Marqueur du rôle récupérateur. Distinct du rôle métier 'admin' de
-- profiles : être admin de l'app n'oblige pas à porter la récupération.
alter table public.vault_user_keys
  add column if not exists is_recovery_admin boolean not null default false;

-- Étendre le garde-fou existant : is_recovery_admin, comme access_enabled,
-- n'est modifiable que par un admin (un utilisateur ne se nomme pas
-- récupérateur lui-même). Même trigger, on remplace juste la fonction.
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
      new.is_recovery_admin := false;
    elsif tg_op = 'UPDATE' then
      new.access_enabled := old.access_enabled;
      new.is_recovery_admin := old.is_recovery_admin;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Clés publiques des admins-récupérateurs ACTIFS. Deux usages :
--   1. l'appli vérifie qu'au moins un existe avant d'enrôler un monteur ;
--   2. toute création de dossier doit TOUJOURS emballer sa DEK vers eux,
--      pour qu'ils gardent accès à l'ensemble des coffres (socle de la
--      récupération). En pratique, comme ils sont access_enabled=true, ils
--      sont déjà couverts par vault_public_keys — cette vue les isole pour
--      pouvoir le garantir/contrôler explicitement.
create or replace view public.vault_recovery_admins as
  select user_id, public_key
  from public.vault_user_keys
  where is_recovery_admin = true and access_enabled = true;

grant select on public.vault_recovery_admins to authenticated;
