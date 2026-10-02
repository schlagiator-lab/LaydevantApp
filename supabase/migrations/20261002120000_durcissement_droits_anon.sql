-- =====================================================================
-- Durcissement des droits du rôle anon (CLAUDE.md §3, « Droits du rôle anon »).
--
-- DÉJÀ APPLIQUÉ à la main le 2026-10-02 dans le SQL Editor. Consigné ici
-- pour que le dépôt reflète la base. Idempotent.
-- =====================================================================

-- A) Policies de dossier_equipment_request_files réservées aux connectés
alter policy dossier_equipment_request_files_select_all
  on public.dossier_equipment_request_files to authenticated;
alter policy dossier_equipment_request_files_insert_own
  on public.dossier_equipment_request_files to authenticated;
alter policy dossier_equipment_request_files_delete_own_or_admin
  on public.dossier_equipment_request_files to authenticated;

-- B) Vues sans security_invoker : aucun accès anon
revoke all on public.v_recherche_web_sante, public.vault_public_keys,
              public.vault_recovery_admins from anon;

-- C) Fonctions SECURITY DEFINER (hors triggers) : retrait public/anon,
--    droits authenticated/service_role préservés
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ok,
           has_function_privilege('service_role',  p.oid, 'EXECUTE') as svc_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth_ok then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if f.svc_ok  then execute format('grant execute on function %s to service_role',  f.sig); end if;
  end loop;
end $$;

-- D) Fonctions futures créées par postgres : plus de droit anon/PUBLIC par défaut
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres revoke execute on functions from public;
