-- Corrige deux fonctions de la fonctionnalité "Dossiers clients" (CLAUDE.md
-- §3/§9) qui ne renvoient pas la documentation attendue en production :
--
-- - `search_dossiers` : nb_documents reste à 0 même quand le dossier a des
--   documents (équipements ou rattachements directs).
-- - `dossier_documents_complets` : ne renvoie aucune ligne, donc la fiche
--   dossier n'affiche ni "Via équipement" ni "Retirer du dossier" — la
--   section Documentation apparaît vide alors qu'elle ne devrait pas l'être.
--
-- Les deux symptômes ont la même cause : la logique de rattachement
-- (dossier_documents pour le direct, dossier_produits → documents.product_id
-- pour les équipements, avec union/dédoublonnage) n'était pas implémentée
-- correctement. On redéfinit proprement les deux fonctions plutôt que de
-- corriger un bug non observable depuis ce dépôt (leur définition n'est pas
-- versionnée ici, cf. CLAUDE.md §3).
--
-- Le bloc DO ci-dessous supprime toute version existante des fonctions quel
-- que soit leur signature exacte (inconnue depuis ce dépôt) avant de les
-- recréer, pour éviter une erreur "cannot change return type" avec un simple
-- CREATE OR REPLACE.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('search_dossiers', 'dossier_documents_complets')
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

create function public.search_dossiers(q text)
returns table (
  id uuid,
  nom_client text,
  adresse text,
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

create function public.dossier_documents_complets(p_dossier_id uuid)
returns table (
  id uuid,
  title text,
  doc_type text,
  file_path text,
  specialty_name text,
  product_label text,
  origine text
)
language sql
stable
as $$
  with direct_docs as (
    select doc.id, doc.title, doc.doc_type::text, doc.file_path, doc.specialty_id, doc.product_id,
           'direct'::text as origine
    from public.dossier_documents dd
    join public.documents doc on doc.id = dd.document_id
    where dd.dossier_id = p_dossier_id
  ),
  equipment_docs as (
    select doc.id, doc.title, doc.doc_type::text, doc.file_path, doc.specialty_id, doc.product_id,
           'equipement'::text as origine
    from public.dossier_produits dp
    join public.documents doc on doc.product_id = dp.product_id
    where dp.dossier_id = p_dossier_id
  ),
  -- Un document rattaché à la fois directement et via un équipement ne doit
  -- apparaître qu'une fois ; priorité à 'direct' (rattachement explicite de
  -- l'utilisateur) sur 'equipement' (remontée automatique) en cas de conflit.
  deduped as (
    select distinct on (id) id, title, doc_type, file_path, specialty_id, product_id, origine
    from (select * from direct_docs union all select * from equipment_docs) combined
    order by id, (origine = 'direct') desc
  )
  select
    c.id,
    c.title,
    c.doc_type,
    c.file_path,
    s.name as specialty_name,
    nullif(trim(concat_ws(' ', p.brand, p.model)), '') as product_label,
    c.origine
  from deduped c
  left join public.specialties s on s.id = c.specialty_id
  left join public.products p on p.id = c.product_id
  order by c.title;
$$;

grant execute on function public.search_dossiers(text) to authenticated;
grant execute on function public.dossier_documents_complets(uuid) to authenticated;
