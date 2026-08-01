-- Ajoute `notes` au retour de `search_dossiers` (CLAUDE.md §3/§9) pour
-- afficher la note du dossier ("résidence secondaire", etc.) directement
-- dans la liste des dossiers clients, sans requête supplémentaire par ligne.
--
-- Sa définition n'est pas versionnée ici (CLAUDE.md §3 : dossiers gérées
-- hors de ce dépôt) mais un précédent existe déjà pour la corriger depuis ce
-- repo (20260728182730_fix_dossier_documents_rpc.sql). Même pattern : drop
-- par OID (signature inconnue depuis ce dépôt) puis recreate, pour éviter
-- l'erreur "cannot change return type" d'un simple CREATE OR REPLACE.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_dossiers'
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

create function public.search_dossiers(q text)
returns table (
  id uuid,
  nom_client text,
  adresse text,
  notes text,
  nb_produits integer,
  nb_documents integer
)
language sql
stable
as $$
  select
    d.id,
    d.nom_client,
    d.adresse,
    d.notes,
    (
      select count(*)::integer
      from public.dossier_produits dp
      where dp.dossier_id = d.id
    ) as nb_produits,
    (
      select count(distinct doc_id)::integer
      from (
        select dd.document_id as doc_id
        from public.dossier_documents dd
        where dd.dossier_id = d.id
        union
        select doc.id as doc_id
        from public.dossier_produits dp
        join public.documents doc on doc.product_id = dp.product_id
        where dp.dossier_id = d.id
      ) all_docs
    ) as nb_documents
  from public.dossiers d
  where q is null or q = '' or d.nom_client ilike '%' || q || '%' or d.adresse ilike '%' || q || '%'
  order by d.nom_client;
$$;

grant execute on function public.search_dossiers(text) to authenticated;
