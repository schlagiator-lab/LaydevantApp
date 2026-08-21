


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."cancel_duo_match"("p_match_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NON_AUTHENTIFIE';
  end if;

  -- seul le host peut annuler, et seulement tant que le match est en attente.
  -- best-effort / idempotent : aucune erreur si déjà rejoint ou déjà fini.
  update public.duo_matches
    set status = 'finished', finished_at = now()
    where id = p_match_id
      and host = v_uid
      and status = 'waiting';
end;
$$;


ALTER FUNCTION "public"."cancel_duo_match"("p_match_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_duo_match"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
  rec    public.duo_matches;
begin
  if v_uid is null then
    raise exception 'NON_AUTHENTIFIE';
  end if;

  -- abandonner mes éventuels matchs encore "en attente"
  update public.duo_matches
    set status = 'finished', finished_at = now()
    where host = v_uid and status = 'waiting';

  -- code court unique parmi les matchs actifs (hex : pas de O/I ambigus)
  loop
    v_code := upper(substr(md5(random()::text), 1, 4));
    exit when not exists (
      select 1 from public.duo_matches
      where code = v_code and status in ('waiting','playing')
    );
  end loop;

  insert into public.duo_matches (code, seed, host, host_last_seen)
    values (v_code, (random() * 2147483647)::int, v_uid, now())
    returning * into rec;

  return jsonb_build_object(
    'id', rec.id, 'code', rec.code, 'seed', rec.seed, 'status', rec.status
  );
end;
$$;


ALTER FUNCTION "public"."create_duo_match"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_dossier_equipment_request"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  r dossier_equipment_requests;
begin
  select * into r from public.dossier_equipment_requests where id = p_request_id;
  if not found then
    raise exception 'Demande introuvable.' using errcode = 'P0002';
  end if;

  if not (
    public.is_vault_admin()
    or (r.requested_by = auth.uid() and r.status = 'pending')
  ) then
    raise exception 'Suppression non autorisée.' using errcode = '42501';
  end if;

  delete from public.dossier_equipment_requests where id = p_request_id;
end;
$$;


ALTER FUNCTION "public"."delete_dossier_equipment_request"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_dossier_if_empty"("p_dossier_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_blockers text[] := array[]::text[];
  v_n integer;
begin
  select count(*) into v_n from public.dossier_produits
    where dossier_id = p_dossier_id and deleted_at is null;
  if v_n > 0 then v_blockers := v_blockers || 'équipements'; end if;

  -- dossier_documents : PAS de deleted_at -> on compte les lignes telles quelles.
  select count(*) into v_n from public.dossier_documents
    where dossier_id = p_dossier_id;
  if v_n > 0 then v_blockers := v_blockers || 'documentation'; end if;

  select count(*) into v_n from public.dossier_notes
    where dossier_id = p_dossier_id and deleted_at is null;
  if v_n > 0 then v_blockers := v_blockers || 'notes'; end if;

  select count(*) into v_n from public.dossier_photos
    where dossier_id = p_dossier_id and deleted_at is null;
  if v_n > 0 then v_blockers := v_blockers || 'photos'; end if;

  select count(*) into v_n from public.dossier_plans
    where dossier_id = p_dossier_id and deleted_at is null;
  if v_n > 0 then v_blockers := v_blockers || 'plans'; end if;

  -- Coffre : bloque si une entrée de données sensibles existe (ciphertext non-vide).
  if exists (
    select 1 from public.vault_secrets
    where dossier_id = p_dossier_id
      and ciphertext is not null and length(ciphertext) > 0
  ) then
    v_blockers := v_blockers || 'données sensibles';
  end if;

  if array_length(v_blockers, 1) is not null then
    raise exception 'DOSSIER_NON_VIDE: %', array_to_string(v_blockers, ', ')
      using errcode = 'P0001';
  end if;

  delete from public.dossiers where id = p_dossier_id;  -- vide => suppression définitive
end;
$$;


ALTER FUNCTION "public"."delete_dossier_if_empty"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."destroy_dossier_vault"("p_dossier_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_vault_admin() then
    raise exception 'NON_AUTORISE: réservé aux administrateurs du coffre'
      using errcode = 'P0001';
  end if;

  -- Groupé en une transaction pour ne jamais laisser d'accès orphelins sans
  -- secret, ni de fichiers chiffrés sans coffre. La cascade FK effacerait
  -- vault_files si le dossier lui-même était supprimé, mais ici on détruit le
  -- COFFRE sans supprimer le dossier — donc on efface explicitement les fichiers.
  delete from public.vault_files          where dossier_id = p_dossier_id;
  delete from public.vault_dossier_access where dossier_id = p_dossier_id;
  delete from public.vault_secrets        where dossier_id = p_dossier_id;
end;
$$;


ALTER FUNCTION "public"."destroy_dossier_vault"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."documents_tsv"("p_title" "text", "p_tags" "text"[], "p_content" "text") RETURNS "tsvector"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select setweight(to_tsvector('french', coalesce(p_title, '')), 'A') ||
         setweight(to_tsvector('french', coalesce(array_to_string(p_tags, ' '), '')), 'B') ||
         setweight(to_tsvector('french', coalesce(p_content, '')), 'C');
$$;


ALTER FUNCTION "public"."documents_tsv"("p_title" "text", "p_tags" "text"[], "p_content" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dossier_documents_complets"("p_dossier_id" "uuid") RETURNS TABLE("id" "uuid", "title" "text", "doc_type" "text", "file_path" "text", "specialty_name" "text", "product_label" "text", "origine" "text")
    LANGUAGE "sql" STABLE
    AS $$
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
      and dp.deleted_at is null
  ),
  brand_docs as (
    select doc.id, doc.title, doc.doc_type::text, doc.file_path, doc.specialty_id, doc.product_id,
           'marque'::text as origine
    from public.dossier_produits dp
    join public.products pr on pr.id = dp.product_id
    join public.documents doc
      on doc.brand = pr.brand
     and doc.brand is not null
     and doc.product_id is null
    where dp.dossier_id = p_dossier_id
      and dp.deleted_at is null
  ),
  deduped as (
    select distinct on (id) id, title, doc_type, file_path, specialty_id, product_id, origine
    from (
      select * from direct_docs
      union all select * from equipment_docs
      union all select * from brand_docs
    ) combined
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


ALTER FUNCTION "public"."dossier_documents_complets"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dossier_has_configured_vault"("p_dossier_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from vault_secrets vs where vs.dossier_id = p_dossier_id);
$$;


ALTER FUNCTION "public"."dossier_has_configured_vault"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dossier_has_vault"("p_dossier_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from vault_secrets where dossier_id = p_dossier_id
  );
$$;


ALTER FUNCTION "public"."dossier_has_vault"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dossier_vault_has_content"("p_dossier_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.vault_secrets vs
    where vs.dossier_id = p_dossier_id
      and vs.ciphertext is not null
      and length(vs.ciphertext) > 0
  );
$$;


ALTER FUNCTION "public"."dossier_vault_has_content"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_stale_web_search_jobs"() RETURNS "void"
    LANGUAGE "sql"
    AS $$
  update web_search_jobs
  set status = 'failed',
      error = 'Timeout : la recherche a dépassé le délai maximum',
      updated_at = now()
  where status in ('pending','processing')
    and created_at < now() - interval '4 minutes';
$$;


ALTER FUNCTION "public"."fail_stale_web_search_jobs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_dossier_vault_deletion"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_dossier_id uuid;
  v_is_delete  boolean;
begin
  if TG_OP = 'DELETE' then
    v_dossier_id := OLD.id;
    v_is_delete  := true;                                   -- hard delete
  else
    v_dossier_id := NEW.id;
    v_is_delete  := (OLD.deleted_at is null and NEW.deleted_at is not null); -- soft delete
  end if;

  if v_is_delete
     and auth.uid() is not null            -- vrai utilisateur app (pas SQL/service)
     and not is_vault_admin()              -- et pas un admin
     and dossier_has_configured_vault(v_dossier_id)
  then
    raise exception
      'Suppression refusée : ce dossier contient des données sensibles et doit être vérifié par un administrateur avant suppression.'
      using errcode = 'check_violation';
  end if;

  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;


ALTER FUNCTION "public"."guard_dossier_vault_deletion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_dossier_vault_access"("p_dossier_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.vault_dossier_access
    where dossier_id = p_dossier_id and user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."has_dossier_vault_access"("p_dossier_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_vault_access"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.vault_user_keys
    where user_id = auth.uid() and access_enabled = true
  );
$$;


ALTER FUNCTION "public"."has_vault_access"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_comms_publisher"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_comms_publisher = true
  );
$$;


ALTER FUNCTION "public"."is_comms_publisher"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_vault_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_vault_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_duo_match"("p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  rec   public.duo_matches;
begin
  if v_uid is null then
    raise exception 'NON_AUTHENTIFIE';
  end if;

  update public.duo_matches
    set guest = v_uid, status = 'playing',
        started_at = now(), guest_last_seen = now()
    where code = upper(p_code)
      and status = 'waiting'
      and guest is null
      and host <> v_uid                 -- on ne rejoint pas son propre match
    returning * into rec;

  if rec.id is null then
    raise exception 'MATCH_INDISPONIBLE';   -- inexistant, déjà pris, ou le sien
  end if;

  return jsonb_build_object(
    'id', rec.id, 'code', rec.code, 'seed', rec.seed,
    'status', rec.status, 'host', rec.host
  );
end;
$$;


ALTER FUNCTION "public"."join_duo_match"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_waiting_duo_matches"() RETURNS TABLE("id" "uuid", "code" "text", "host_name" "text", "created_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select m.id, m.code, coalesce(p.full_name, 'Joueur'), m.created_at
  from public.duo_matches m
  left join public.profiles p on p.id = m.host
  where m.status = 'waiting'
    and m.guest is null
    and m.host <> auth.uid()
    and m.host_last_seen > now() - interval '15 seconds'
  order by m.created_at desc;
$$;


ALTER FUNCTION "public"."list_waiting_duo_matches"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_invitation_email"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_invitation_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_n8n_web_search"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_url    text;
  v_secret text;
begin
  -- URL du webhook du nouveau workflow multi-moteurs (path notices-search)
  select value into v_url    from private_config where key = 'n8n_webhook_url';
  select value into v_secret from private_config where key = 'n8n_webhook_secret';

  -- Garde-fou : ne JAMAIS casser l'INSERT du job si la config manque.
  if v_url is null or v_secret is null then
    return NEW;
  end if;

  -- Un SEUL appel, non bloquant, vers le pipeline multi-moteurs + juge.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'rechercheweb-webhook-secret', v_secret
               ),
    body    := jsonb_build_object('job_id', NEW.id)
  );

  return NEW;
end;
$$;


ALTER FUNCTION "public"."notify_n8n_web_search"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profiles_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- is_admin() est SECURITY DEFINER et lit profiles.role de l'appelant.
  if is_admin() then
    return new;  -- admin : aucun bridage
  end if;

  if tg_op = 'UPDATE' then
    -- un non-admin ne peut modifier ni son drapeau publisher, ni son rôle
    new.is_comms_publisher := old.is_comms_publisher;
    new.role := old.role;
  elsif tg_op = 'INSERT' then
    -- filet : une ligne créée par un non-admin ne s'octroie pas le drapeau
    new.is_comms_publisher := false;
    -- (on ne touche pas role à l'INSERT : le défaut 'monteur' / l'enrôlement
    --  serveur gère déjà le rôle ; voir note plus bas)
  end if;

  return new;
end $$;


ALTER FUNCTION "public"."profiles_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reenroll_vault_user"("p_public_key" "text", "p_wrapped_private_key_pw" "text", "p_wrapped_private_key_recovery" "text", "p_pw_salt" "text", "p_recovery_salt" "text", "p_pw_iv" "text", "p_recovery_iv" "text", "p_kdf_iterations" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_is_recovery boolean;
begin
  if v_uid is null then
    raise exception 'Non authentifié.' using errcode = 'insufficient_privilege';
  end if;

  -- Un administrateur-récupérateur ne se ré-enrôle PAS en libre-service :
  -- il invaliderait sa clé papier et pourrait casser la récupération globale.
  -- Pour lui, break-glass mutuel uniquement (l'autre récupérateur ré-octroie).
  select is_recovery_admin into v_is_recovery
  from vault_user_keys where user_id = v_uid;
  if coalesce(v_is_recovery, false) then
    raise exception 'Un administrateur-récupérateur ne peut pas se ré-enrôler ainsi.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Doit déjà être enrôlé (sinon c'est le flux d'enrôlement initial, pas celui-ci).
  if not exists (select 1 from vault_user_keys where user_id = v_uid) then
    raise exception 'Aucun enrôlement existant à réinitialiser.';
  end if;

  -- 1) Remplacer la paire. Le trigger vault_user_keys_guard laisse access_enabled
  --    et is_recovery_admin inchangés puisqu'on ne les cite pas dans le SET.
  update vault_user_keys set
    public_key                   = p_public_key,
    wrapped_private_key_pw       = p_wrapped_private_key_pw,
    wrapped_private_key_recovery = p_wrapped_private_key_recovery,
    pw_salt                      = p_pw_salt,
    recovery_salt                = p_recovery_salt,
    pw_iv                        = p_pw_iv,
    recovery_iv                  = p_recovery_iv,
    kdf_iterations               = p_kdf_iterations,
    updated_at                   = now()
  where user_id = v_uid;

  -- 2) Purger les accès obsolètes (DEK emballées vers l'ANCIENNE clé publique).
  --    -> état "apprenti sans accès", déjà géré par l'UI, en attente du ré-octroi.
  delete from vault_dossier_access where user_id = v_uid;
end $$;


ALTER FUNCTION "public"."reenroll_vault_user"("p_public_key" "text", "p_wrapped_private_key_pw" "text", "p_wrapped_private_key_recovery" "text", "p_pw_salt" "text", "p_recovery_salt" "text", "p_pw_iv" "text", "p_recovery_iv" "text", "p_kdf_iterations" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_dossier_deletion_request"("p_request_id" "uuid", "p_approve" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  r dossier_deletion_requests;
begin
  if not is_vault_admin() then
    raise exception 'Réservé aux administrateurs.' using errcode = 'insufficient_privilege';
  end if;

  select * into r from dossier_deletion_requests where id = p_request_id for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if r.status <> 'pending' then
    raise exception 'Cette demande a déjà été traitée.';
  end if;

  if p_approve then
    update dossiers
      set deleted_at = now(), deleted_by = auth.uid()
      where id = r.dossier_id and deleted_at is null;

    update dossier_deletion_requests
      set status = 'approved', resolved_by = auth.uid(), resolved_at = now()
      where id = p_request_id;
  else
    update dossier_deletion_requests
      set status = 'rejected', resolved_by = auth.uid(), resolved_at = now()
      where id = p_request_id;
  end if;
end $$;


ALTER FUNCTION "public"."resolve_dossier_deletion_request"("p_request_id" "uuid", "p_approve" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_dossier_equipment_request"("p_request_id" "uuid", "p_specialty_id" "uuid", "p_approve" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  r          dossier_equipment_requests;
  v_brand    text;
  v_model    text;
  v_name     text;
  v_product  uuid;
begin
  if not is_vault_admin() then
    raise exception 'Réservé aux administrateurs.' using errcode = 'insufficient_privilege';
  end if;

  select * into r from dossier_equipment_requests where id = p_request_id for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if r.status <> 'pending' then
    raise exception 'Cette demande a déjà été traitée.';
  end if;

  -- REFUS : on marque rejected, rien d'autre.
  if not p_approve then
    update dossier_equipment_requests
      set status = 'rejected', resolved_by = auth.uid(), resolved_at = now()
      where id = p_request_id;
    return;
  end if;

  -- APPROBATION : spécialité obligatoire (le monteur n'en a pas donné).
  if p_specialty_id is null then
    raise exception 'Une spécialité est requise pour approuver.';
  end if;
  if not exists (select 1 from specialties where id = p_specialty_id) then
    raise exception 'Spécialité introuvable.';
  end if;

  -- Normalisation des identifiants de la demande.
  v_brand := nullif(trim(r.marque), '');
  v_model := coalesce(nullif(trim(r.modele), ''), '');  -- model NOT NULL default ''
  if v_brand is null then
    raise exception 'La demande n''a pas de marque exploitable.';
  end if;
  v_name := trim(concat_ws(' ', v_brand, nullif(v_model, '')));

  -- 1) Réutiliser un produit existant (comparaison SANS la casse) …
  select id into v_product
  from products
  where specialty_id = p_specialty_id
    and lower(brand) = lower(v_brand)
    and lower(model) = lower(v_model)
  limit 1;

  -- 2) … sinon le créer avec la casse saisie.
  if v_product is null then
    insert into products (specialty_id, brand, model, name)
    values (p_specialty_id, v_brand, v_model, v_name)
    on conflict (specialty_id, brand, model) do nothing
    returning id into v_product;

    -- Filet si un insert concurrent a gagné la course (ON CONFLICT DO NOTHING
    -- ne renvoie rien) : on relit la ligne existante.
    if v_product is null then
      select id into v_product
      from products
      where specialty_id = p_specialty_id and brand = v_brand and model = v_model
      limit 1;
    end if;
  end if;

  if v_product is null then
    raise exception 'Échec de création/réutilisation du produit.';
  end if;

  -- 3) Rattacher le produit au dossier (résurrection si soft-deleted),
  --    même esprit que l'upsert de addDossierEquipment.
  insert into dossier_produits (dossier_id, product_id)
  values (r.dossier_id, v_product)
  on conflict (dossier_id, product_id) do update
    set deleted_at = null, deleted_by = null;

  -- 4) Clore la demande.
  update dossier_equipment_requests
    set status = 'approved',
        resolved_by = auth.uid(),
        resolved_at = now(),
        resolved_product_id = v_product,
        specialty_id = p_specialty_id
    where id = p_request_id;
end $$;


ALTER FUNCTION "public"."resolve_dossier_equipment_request"("p_request_id" "uuid", "p_specialty_id" "uuid", "p_approve" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rotate_vault_secret"("p_dossier_id" "uuid", "p_ciphertext" "text", "p_content_iv" "text", "p_expected_dek_version" integer, "p_new_dek_version" integer, "p_access_rows" "jsonb", "p_file_rows" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_expected_count integer;
  v_updated_count  integer;
  v_files_in_db    integer;   -- NOUVEAU
  v_files_expected integer;   -- NOUVEAU
  v_files_updated  integer;   -- NOUVEAU
begin
  -- --- Autorisation : seul un admin fait tourner une clé de coffre -------
  if not public.is_vault_admin() then
    raise exception 'Réservé aux administrateurs.' using errcode = '42501';
  end if;

  if p_new_dek_version <= p_expected_dek_version then
    raise exception 'dek_version invalide : % doit être supérieur à %.', p_new_dek_version, p_expected_dek_version
      using errcode = '22023';
  end if;

  -- --- Verrou + garde de version -----------------------------------------
  -- FOR UPDATE verrouille la ligne vault_secrets pour la durée de la
  -- transaction : deux rotations concurrentes sur le même dossier se
  -- sérialisent au lieu de courir l'une sur l'autre. Le contrôle de version
  -- attendue détecte qu'une rotation a déjà eu lieu entre la lecture faite
  -- par l'appelant et cet appel (concurrence), plutôt que d'écraser en
  -- silence une rotation plus récente.
  perform 1
    from public.vault_secrets
    where dossier_id = p_dossier_id
      and dek_version = p_expected_dek_version
    for update;

  if not found then
    raise exception
      'Version de clé inattendue pour ce coffre (attendue %) — une autre rotation a peut-être eu lieu entre-temps, ou ce coffre n''existe pas. Recommencez.',
      p_expected_dek_version
      using errcode = 'P0001';
  end if;

  -- --- Garde-fou destinataires ---------------------------------------
  -- Le garde-fou "au moins un récupérateur parmi les destinataires" est
  -- vérifié côté app AVANT préparation de la crypto ; ici on vérifie seulement
  -- qu'une liste non vide a été fournie, filet de sécurité minimal.
  v_expected_count := jsonb_array_length(p_access_rows);
  if v_expected_count is null or v_expected_count = 0 then
    raise exception 'Aucun destinataire fourni — rotation refusée.' using errcode = 'P0001';
  end if;

  -- --- Ré-emballage des accès : UPDATE, jamais INSERT ----------------
  -- Le jeu de destinataires ne change pas pendant une rotation. Le nombre de
  -- lignes mises à jour DOIT correspondre au nombre de destinataires envoyés,
  -- sinon la vue de l'appelant est périmée et on annule.
  with updates as (
    update public.vault_dossier_access da
    set wrapped_dek = r.wrapped_dek,
        dek_version = p_new_dek_version
    from (
      select
        (elem->>'user_id')::uuid as user_id,
        elem->>'wrapped_dek'     as wrapped_dek
      from jsonb_array_elements(p_access_rows) as elem
    ) r
    where da.dossier_id = p_dossier_id
      and da.user_id = r.user_id
    returning da.user_id
  )
  select count(*) into v_updated_count from updates;

  if v_updated_count <> v_expected_count then
    raise exception
      'Lignes d''accès mises à jour (%) différentes du nombre de destinataires attendu (%) — le jeu de destinataires a changé entre-temps, rotation annulée.',
      v_updated_count, v_expected_count
      using errcode = 'P0001';
  end if;

  -- --- NOUVEAU : ré-emballage des FEK des fichiers -------------------
  -- Même principe que pour les accès. Chaque fichier du dossier a une FEK
  -- emballée sous l'ANCIENNE DEK ; l'app fournit dans p_file_rows la même FEK
  -- ré-emballée sous la NOUVELLE DEK (les OCTETS R2 ne bougent pas). Contrôle
  -- strict : le nombre de FEK fournies doit égaler le nombre de fichiers
  -- réellement en base pour ce dossier — sinon un fichier a été ajouté/supprimé
  -- entre la préparation et l'exécution, et une FEK oubliée deviendrait
  -- illisible à la rotation suivante : on annule.
  select count(*) into v_files_in_db
    from public.vault_files
    where dossier_id = p_dossier_id;

  v_files_expected := coalesce(jsonb_array_length(p_file_rows), 0);

  if v_files_expected <> v_files_in_db then
    raise exception
      'Fichiers fournis (%) différents du nombre de fichiers en base (%) pour ce coffre — un fichier a changé entre-temps, rotation annulée.',
      v_files_expected, v_files_in_db
      using errcode = 'P0001';
  end if;

  if v_files_in_db > 0 then
    with fupd as (
      update public.vault_files vf
      set wrapped_fek = r.wrapped_fek,
          fek_wrap_iv = r.fek_wrap_iv,
          dek_version = p_new_dek_version
      from (
        select
          (elem->>'id')::uuid    as id,
          elem->>'wrapped_fek'   as wrapped_fek,
          elem->>'fek_wrap_iv'   as fek_wrap_iv
        from jsonb_array_elements(p_file_rows) as elem
      ) r
      where vf.dossier_id = p_dossier_id
        and vf.id = r.id
      returning vf.id
    )
    select count(*) into v_files_updated from fupd;

    -- Chaque id fourni doit correspondre à un fichier RÉEL de ce dossier.
    if v_files_updated <> v_files_expected then
      raise exception
        'FEK mises à jour (%) différentes du nombre de fichiers fournis (%) — un id ne correspond à aucun fichier de ce coffre, rotation annulée.',
        v_files_updated, v_files_expected
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Contenu ---------------------------------------------------------
  update public.vault_secrets
  set ciphertext  = p_ciphertext,
      content_iv  = p_content_iv,
      dek_version = p_new_dek_version
  where dossier_id = p_dossier_id;
end;
$$;


ALTER FUNCTION "public"."rotate_vault_secret"("p_dossier_id" "uuid", "p_ciphertext" "text", "p_content_iv" "text", "p_expected_dek_version" integer, "p_new_dek_version" integer, "p_access_rows" "jsonb", "p_file_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_documents"("q" "text", "p_department_slug" "text" DEFAULT NULL::"text", "p_specialty_slug" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 30) RETURNS TABLE("id" "uuid", "title" "text", "doc_type" "text", "file_path" "text", "specialty_name" "text", "department_name" "text", "product_label" "text", "extrait" "text", "rank" real)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $_$
  with pq as (
    -- Découpe q en mots, ne garde que les tokens alphanumériques,
    -- suffixe ':*' à chacun, assemble en 'a:* & b:* & ...'.
    -- NULL si aucun token exploitable (saisie vide / que des symboles).
    select nullif(
      (
        select string_agg(lower(tok) || ':*', ' & ')
        from regexp_split_to_table(coalesce(q, ''), '\s+') as tok
        where tok ~ '^[[:alnum:]]+$'
      ),
      ''
    )::tsquery as prefix_query
  )
  select
    d.id,
    d.title,
    d.doc_type,
    d.file_path,
    s.name   as specialty_name,
    dep.name as department_name,
    nullif(trim(concat_ws(' ', p.brand, p.model)), '') as product_label,
    ts_headline('french', coalesce(d.content, d.title),
                websearch_to_tsquery('french', q),
                'MaxWords=25, MinWords=10, ShortWord=3') as extrait,
    ts_rank(
      setweight(to_tsvector('french', coalesce(p.brand, '') || ' ' || coalesce(p.model, '')), 'A')
      || setweight(to_tsvector('french', coalesce(d.title, '')), 'B')
      || coalesce(d.search_vector, ''::tsvector),
      coalesce(websearch_to_tsquery('french', q), ''::tsquery)
      || coalesce((select prefix_query from pq), ''::tsquery)
    ) as rank
  from public.documents d
  join public.specialties  s   on s.id   = d.specialty_id
  join public.departments  dep on dep.id = s.department_id
  left join public.products p  on p.id   = d.product_id
  cross join pq
  where (
        -- 1) full-text existant (INCHANGÉ)
        d.search_vector @@ websearch_to_tsquery('french', q)
     or (
          setweight(to_tsvector('french', coalesce(p.brand, '') || ' ' || coalesce(p.model, '')), 'A')
          || setweight(to_tsvector('french', coalesce(d.title, '')), 'B')
        ) @@ websearch_to_tsquery('french', q)
        -- 2) NOUVEAU : matching par préfixe (si prefix_query non nul)
     or (
          pq.prefix_query is not null
          and (
               d.search_vector @@ pq.prefix_query
            or (
                 setweight(to_tsvector('french', coalesce(p.brand, '') || ' ' || coalesce(p.model, '')), 'A')
                 || setweight(to_tsvector('french', coalesce(d.title, '')), 'B')
               ) @@ pq.prefix_query
          )
        )
      )
    and (p_department_slug is null or dep.slug = p_department_slug)
    and (p_specialty_slug  is null or s.slug   = p_specialty_slug)
  order by rank desc
  limit p_limit;
$_$;


ALTER FUNCTION "public"."search_documents"("q" "text", "p_department_slug" "text", "p_specialty_slug" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_dossiers"("q" "text") RETURNS TABLE("id" "uuid", "nom_client" "text", "adresse" "text", "notes" "text", "nb_produits" integer, "nb_documents" integer)
    LANGUAGE "sql" STABLE
    AS $$
  select
    d.id,
    d.nom_client,
    d.adresse,
    d.notes,
    (
      select count(*)::integer
      from public.dossier_produits dp
      where dp.dossier_id = d.id
        and dp.deleted_at is null
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
          and dp.deleted_at is null
      ) all_docs
    ) as nb_documents
  from public.dossiers d
  where (d.deleted_at is null)
    and (q is null or q = '' or d.nom_client ilike '%' || q || '%' or d.adresse ilike '%' || q || '%')
  order by d.nom_client;
$$;


ALTER FUNCTION "public"."search_dossiers"("q" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_comms_publisher"("p_user_id" "uuid", "p_enabled" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not is_admin() then
    raise exception 'Réservé aux administrateurs.' using errcode = 'insufficient_privilege';
  end if;

  update profiles
    set is_comms_publisher = p_enabled
    where id = p_user_id;

  if not found then
    raise exception 'Utilisateur introuvable.';
  end if;
end $$;


ALTER FUNCTION "public"."set_comms_publisher"("p_user_id" "uuid", "p_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_demande_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  if new.statut = 'traitee' and coalesce(old.statut,'') <> 'traitee' then
    new.resolved_by := auth.uid();
    new.resolved_at := now();
  elsif new.statut <> 'traitee' then
    new.resolved_by := null;
    new.resolved_at := null;
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."set_demande_updated"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_dossier_note_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  return new;
end;
$$;


ALTER FUNCTION "public"."set_dossier_note_updated"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_galerie_item_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


ALTER FUNCTION "public"."set_galerie_item_updated"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."soft_delete_communication"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  -- Revérifie le droit EN INTERNE (on ne relâche pas la sécurité que la
  -- policy UPDATE assurait : admin OU publisher).
  if not (is_admin() or is_comms_publisher()) then
    raise exception 'Réservé aux publishers et administrateurs.'
      using errcode = 'insufficient_privilege';
  end if;

  update public.communications
    set deleted_at = now(), deleted_by = v_uid
    where id = p_id and deleted_at is null;
end $$;


ALTER FUNCTION "public"."soft_delete_communication"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_duo_match"("p_match_id" "uuid", "p_attack_total" integer, "p_died" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid   uuid := auth.uid();
  v_host  uuid;
  v_guest uuid;
  rec     public.duo_matches;
begin
  if v_uid is null then
    raise exception 'NON_AUTHENTIFIE';
  end if;

  select host, guest into v_host, v_guest
    from public.duo_matches where id = p_match_id;
  if not found then
    raise exception 'MATCH_INTROUVABLE';
  end if;

  if v_uid = v_host then
    update public.duo_matches
      set host_attack_total = greatest(host_attack_total, coalesce(p_attack_total, 0)),
          host_last_seen     = now(),
          host_died_at       = case when p_died and host_died_at is null
                                    then now() else host_died_at end
      where id = p_match_id
      returning * into rec;
  elsif v_uid = v_guest then
    update public.duo_matches
      set guest_attack_total = greatest(guest_attack_total, coalesce(p_attack_total, 0)),
          guest_last_seen     = now(),
          guest_died_at       = case when p_died and guest_died_at is null
                                     then now() else guest_died_at end
      where id = p_match_id
      returning * into rec;
  else
    raise exception 'NON_AUTORISE';        -- ni host ni guest de ce match
  end if;

  -- dès qu'un des deux est mort, le match est fini
  if (rec.host_died_at is not null or rec.guest_died_at is not null)
     and rec.status <> 'finished' then
    update public.duo_matches
      set status = 'finished', finished_at = coalesce(finished_at, now())
      where id = p_match_id
      returning * into rec;
  end if;

  return to_jsonb(rec) || jsonb_build_object('server_now', now());
end;
$$;


ALTER FUNCTION "public"."sync_duo_match"("p_match_id" "uuid", "p_attack_total" integer, "p_died" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_dossier_product"("p_dossier_id" "uuid", "p_specialty_id" "uuid", "p_brand" "text", "p_model" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_brand   text;
  v_model   text;
  v_name    text;
  v_product uuid;
begin
  if auth.uid() is null then
    raise exception 'Non authentifié.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from specialties where id = p_specialty_id) then
    raise exception 'Spécialité introuvable.';
  end if;

  v_brand := nullif(trim(p_brand), '');
  v_model := coalesce(nullif(trim(p_model), ''), '');  -- model NOT NULL default ''
  if v_brand is null then
    raise exception 'La marque est requise.';
  end if;
  v_name := trim(concat_ws(' ', v_brand, nullif(v_model, '')));

  -- Réutiliser un produit existant (comparaison sans la casse).
  select id into v_product
  from products
  where specialty_id = p_specialty_id
    and lower(brand) = lower(v_brand)
    and lower(model) = lower(v_model)
  limit 1;

  -- Sinon le créer.
  if v_product is null then
    insert into products (specialty_id, brand, model, name)
    values (p_specialty_id, v_brand, v_model, v_name)
    on conflict (specialty_id, brand, model) do nothing
    returning id into v_product;

    if v_product is null then  -- course concurrente : relire l'existant
      select id into v_product
      from products
      where specialty_id = p_specialty_id and brand = v_brand and model = v_model
      limit 1;
    end if;
  end if;

  if v_product is null then
    raise exception 'Échec de création/réutilisation du produit.';
  end if;

  -- Rattacher au dossier (résurrection si soft-deleted).
  insert into dossier_produits (dossier_id, product_id)
  values (p_dossier_id, v_product)
  on conflict (dossier_id, product_id) do update
    set deleted_at = null, deleted_by = null;

  return v_product;
end $$;


ALTER FUNCTION "public"."upsert_dossier_product"("p_dossier_id" "uuid", "p_specialty_id" "uuid", "p_brand" "text", "p_model" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vault_secrets_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;


ALTER FUNCTION "public"."vault_secrets_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vault_user_keys_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."vault_user_keys_guard"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."communications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "titre" "text",
    "storage_provider" "text" DEFAULT 'r2'::"text" NOT NULL,
    "storage_key" "text" NOT NULL,
    "mime" "text",
    "taille" bigint,
    "auteur" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    CONSTRAINT "communications_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'r2'::"text"])))
);


ALTER TABLE "public"."communications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'monteur'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_comms_publisher" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['monteur'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."communications_view" WITH ("security_invoker"='true') AS
 SELECT "c"."id",
    "c"."titre",
    "c"."storage_provider",
    "c"."storage_key",
    "c"."mime",
    "c"."taille",
    "c"."auteur",
    COALESCE("p"."full_name", 'Inconnu'::"text") AS "auteur_nom",
    "c"."created_at"
   FROM ("public"."communications" "c"
     LEFT JOIN "public"."profiles" "p" ON (("p"."id" = "c"."auteur")))
  WHERE ("c"."deleted_at" IS NULL);


ALTER VIEW "public"."communications_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demandes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "text" NOT NULL,
    "titre" "text",
    "message" "text" NOT NULL,
    "statut" "text" DEFAULT 'nouvelle'::"text" NOT NULL,
    "reponse_admin" "text",
    "contexte" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "auteur" "uuid",
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "demandes_message_check" CHECK (("length"("btrim"("message")) > 0)),
    CONSTRAINT "demandes_statut_check" CHECK (("statut" = ANY (ARRAY['nouvelle'::"text", 'en_cours'::"text", 'traitee'::"text"]))),
    CONSTRAINT "demandes_type_check" CHECK (("type" = ANY (ARRAY['amelioration'::"text", 'bug'::"text", 'autre'::"text"])))
);


ALTER TABLE "public"."demandes" OWNER TO "postgres";


COMMENT ON TABLE "public"."demandes" IS 'Canal de remontee terrain : propositions d''amelioration, bugs, autres. Monteur depose, admin traite.';



CREATE OR REPLACE VIEW "public"."demandes_view" WITH ("security_invoker"='true') AS
 SELECT "d"."id",
    "d"."type",
    "d"."titre",
    "d"."message",
    "d"."statut",
    "d"."reponse_admin",
    "d"."contexte",
    "d"."auteur",
    "d"."resolved_by",
    "d"."resolved_at",
    "d"."created_at",
    "d"."updated_at",
    "pa"."full_name" AS "auteur_nom",
    "pr"."full_name" AS "resolved_by_nom"
   FROM (("public"."demandes" "d"
     LEFT JOIN "public"."profiles" "pa" ON (("pa"."id" = "d"."auteur")))
     LEFT JOIN "public"."profiles" "pr" ON (("pr"."id" = "d"."resolved_by")));


ALTER VIEW "public"."demandes_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "icon" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "specialty_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "title" "text" NOT NULL,
    "doc_type" "text" DEFAULT 'autre'::"text" NOT NULL,
    "file_path" "text",
    "file_size" bigint,
    "mime_type" "text",
    "content" "text",
    "source_url" "text",
    "retrieved_at" "date",
    "version_label" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "search_vector" "tsvector" GENERATED ALWAYS AS ("public"."documents_tsv"("title", "tags", "content")) STORED,
    "storage_provider" "text" DEFAULT 'supabase'::"text" NOT NULL,
    "brand" "text",
    CONSTRAINT "documents_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['notice_installation'::"text", 'manuel_programmation'::"text", 'fiche_technique'::"text", 'schema'::"text", 'fiche_perso'::"text", 'autre'::"text"]))),
    CONSTRAINT "documents_has_payload" CHECK ((("file_path" IS NOT NULL) OR ("content" IS NOT NULL))),
    CONSTRAINT "documents_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'r2'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


COMMENT ON COLUMN "public"."documents"."brand" IS 'Si renseigné (et product_id NULL) : document de marque, remonte pour tout équipement de cette marque dans un dossier. Voir dossier_documents_complets.';



CREATE TABLE IF NOT EXISTS "public"."dossier_deletion_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dossier_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "reason" "text" DEFAULT 'vault_content'::"text" NOT NULL,
    "note" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    CONSTRAINT "dossier_deletion_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."dossier_deletion_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_documents" (
    "dossier_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dossier_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_equipment_request_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "storage_provider" "text" DEFAULT 'r2'::"text" NOT NULL,
    "storage_key" "text" NOT NULL,
    "nom_fichier" "text",
    "mime" "text",
    "taille" bigint,
    "doc_type_suggere" "text",
    "auteur" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "promoted_document_id" "uuid",
    CONSTRAINT "dossier_equipment_request_files_doc_type_suggere_check" CHECK (("doc_type_suggere" = ANY (ARRAY['notice_installation'::"text", 'manuel_programmation'::"text", 'fiche_technique'::"text", 'schema'::"text", 'fiche_perso'::"text", 'autre'::"text"]))),
    CONSTRAINT "dossier_equipment_request_files_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'r2'::"text"])))
);


ALTER TABLE "public"."dossier_equipment_request_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_equipment_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dossier_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "marque" "text",
    "modele" "text",
    "commentaire" "text",
    "specialty_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "resolved_product_id" "uuid",
    CONSTRAINT "dossier_equipment_requests_ident_chk" CHECK (((NULLIF(TRIM(BOTH FROM "marque"), ''::"text") IS NOT NULL) OR (NULLIF(TRIM(BOTH FROM "modele"), ''::"text") IS NOT NULL))),
    CONSTRAINT "dossier_equipment_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."dossier_equipment_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dossier_id" "uuid" NOT NULL,
    "titre" "text",
    "texte" "text" DEFAULT ''::"text" NOT NULL,
    "auteur" "uuid" DEFAULT "auth"."uid"(),
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid"
);


ALTER TABLE "public"."dossier_notes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dossier_notes_view" WITH ("security_invoker"='true') AS
 SELECT "n"."id",
    "n"."dossier_id",
    "n"."titre",
    "n"."texte",
    "n"."auteur",
    "n"."updated_by",
    "n"."created_at",
    "n"."updated_at",
    "pa"."full_name" AS "auteur_nom",
    "pu"."full_name" AS "updated_by_nom",
    "n"."deleted_at",
    "n"."deleted_by"
   FROM (("public"."dossier_notes" "n"
     LEFT JOIN "public"."profiles" "pa" ON (("pa"."id" = "n"."auteur")))
     LEFT JOIN "public"."profiles" "pu" ON (("pu"."id" = "n"."updated_by")));


ALTER VIEW "public"."dossier_notes_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dossier_id" "uuid" NOT NULL,
    "note_id" "uuid",
    "storage_provider" "text" DEFAULT 'supabase'::"text" NOT NULL,
    "storage_key" "text" NOT NULL,
    "mime" "text",
    "taille" bigint,
    "largeur" integer,
    "hauteur" integer,
    "auteur" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "titre" "text",
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "annotations" "jsonb",
    CONSTRAINT "dossier_photos_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'r2'::"text"])))
);


ALTER TABLE "public"."dossier_photos" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dossier_photos_view" WITH ("security_invoker"='true') AS
 SELECT "p"."id",
    "p"."dossier_id",
    "p"."note_id",
    "p"."storage_provider",
    "p"."storage_key",
    "p"."mime",
    "p"."taille",
    "p"."largeur",
    "p"."hauteur",
    "p"."auteur",
    "p"."created_at",
    "p"."titre",
    "p"."annotations",
    "pa"."full_name" AS "auteur_nom",
    "p"."deleted_at",
    "p"."deleted_by"
   FROM ("public"."dossier_photos" "p"
     LEFT JOIN "public"."profiles" "pa" ON (("pa"."id" = "p"."auteur")));


ALTER VIEW "public"."dossier_photos_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dossier_id" "uuid" NOT NULL,
    "titre" "text",
    "storage_provider" "text" DEFAULT 'r2'::"text" NOT NULL,
    "storage_key" "text" NOT NULL,
    "mime" "text",
    "taille" bigint,
    "largeur" integer,
    "hauteur" integer,
    "auteur" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    CONSTRAINT "dossier_plans_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'r2'::"text"])))
);


ALTER TABLE "public"."dossier_plans" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dossier_plans_view" WITH ("security_invoker"='true') AS
 SELECT "p"."id",
    "p"."dossier_id",
    "p"."titre",
    "p"."storage_provider",
    "p"."storage_key",
    "p"."mime",
    "p"."taille",
    "p"."largeur",
    "p"."hauteur",
    "p"."auteur",
    "pr"."full_name" AS "auteur_nom",
    "p"."created_at"
   FROM ("public"."dossier_plans" "p"
     LEFT JOIN "public"."profiles" "pr" ON (("pr"."id" = "p"."auteur")))
  WHERE ("p"."deleted_at" IS NULL);


ALTER VIEW "public"."dossier_plans_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossier_produits" (
    "dossier_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "note" "text",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid"
);


ALTER TABLE "public"."dossier_produits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "nom_client" "text" NOT NULL,
    "adresse" "text",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid"
);


ALTER TABLE "public"."dossiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."duo_matches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "seed" integer NOT NULL,
    "host" "uuid" NOT NULL,
    "guest" "uuid",
    "status" "text" DEFAULT 'waiting'::"text" NOT NULL,
    "host_attack_total" integer DEFAULT 0 NOT NULL,
    "guest_attack_total" integer DEFAULT 0 NOT NULL,
    "host_died_at" timestamp with time zone,
    "guest_died_at" timestamp with time zone,
    "host_last_seen" timestamp with time zone DEFAULT "now"() NOT NULL,
    "guest_last_seen" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    CONSTRAINT "duo_matches_status_check" CHECK (("status" = ANY (ARRAY['waiting'::"text", 'playing'::"text", 'finished'::"text"])))
);


ALTER TABLE "public"."duo_matches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."galerie_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "specialty_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "brand" "text",
    "notes" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."galerie_items" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."galerie_items_view" AS
SELECT
    NULL::"uuid" AS "id",
    NULL::"uuid" AS "specialty_id",
    NULL::"text" AS "name",
    NULL::"text" AS "brand",
    NULL::"text" AS "notes",
    NULL::timestamp with time zone AS "created_at",
    NULL::timestamp with time zone AS "updated_at",
    NULL::bigint AS "nb_photos",
    NULL::"jsonb" AS "photos";


ALTER VIEW "public"."galerie_items_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."galerie_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "item_id" "uuid" NOT NULL,
    "storage_provider" "text" DEFAULT 'r2'::"text" NOT NULL,
    "storage_key" "text" NOT NULL,
    "mime" "text",
    "libelle" "text",
    "largeur" integer,
    "hauteur" integer,
    "taille" bigint,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "galerie_photos_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'r2'::"text"])))
);


ALTER TABLE "public"."galerie_photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_scores" (
    "user_id" "uuid" NOT NULL,
    "best_score" integer DEFAULT 0 NOT NULL,
    "best_lines" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."game_scores" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."game_leaderboard" WITH ("security_invoker"='true') AS
 SELECT "gs"."user_id",
    COALESCE("p"."full_name", 'Inconnu'::"text") AS "joueur",
    "gs"."best_score",
    "gs"."best_lines",
    "gs"."updated_at"
   FROM ("public"."game_scores" "gs"
     LEFT JOIN "public"."profiles" "p" ON (("p"."id" = "gs"."user_id")))
  ORDER BY "gs"."best_score" DESC, "gs"."updated_at";


ALTER VIEW "public"."game_leaderboard" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_invitations" (
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'monteur'::"text" NOT NULL,
    "note" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "consumed_at" timestamp with time zone,
    "consumed_by" "uuid",
    CONSTRAINT "onboarding_invitations_role_check" CHECK (("role" = ANY (ARRAY['monteur'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."onboarding_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pinned_documents" (
    "user_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "pinned_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pinned_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."private_config" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL
);


ALTER TABLE "public"."private_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "specialty_id" "uuid" NOT NULL,
    "brand" "text" NOT NULL,
    "model" "text" DEFAULT ''::"text" NOT NULL,
    "name" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."specialties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "department_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "parent_id" "uuid",
    "display_mode" "text" DEFAULT 'documents'::"text" NOT NULL,
    CONSTRAINT "specialties_display_mode_check" CHECK (("display_mode" = ANY (ARRAY['documents'::"text", 'galerie'::"text"])))
);


ALTER TABLE "public"."specialties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vault_dossier_access" (
    "dossier_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "wrapped_dek" "text" NOT NULL,
    "dek_version" integer DEFAULT 1 NOT NULL,
    "granted_by" "uuid" DEFAULT "auth"."uid"(),
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vault_dossier_access" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vault_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dossier_id" "uuid" NOT NULL,
    "storage_key" "text" NOT NULL,
    "file_iv" "text" NOT NULL,
    "wrapped_fek" "text" NOT NULL,
    "fek_wrap_iv" "text" NOT NULL,
    "meta_ciphertext" "text" NOT NULL,
    "meta_iv" "text" NOT NULL,
    "dek_version" integer DEFAULT 1 NOT NULL,
    "taille" bigint,
    "auteur" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vault_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vault_user_keys" (
    "user_id" "uuid" NOT NULL,
    "public_key" "text" NOT NULL,
    "wrapped_private_key_pw" "text" NOT NULL,
    "wrapped_private_key_recovery" "text" NOT NULL,
    "pw_salt" "text" NOT NULL,
    "recovery_salt" "text" NOT NULL,
    "pw_iv" "text" NOT NULL,
    "recovery_iv" "text" NOT NULL,
    "kdf_iterations" integer NOT NULL,
    "access_enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_recovery_admin" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."vault_user_keys" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vault_public_keys" AS
 SELECT "user_id",
    "public_key"
   FROM "public"."vault_user_keys"
  WHERE ("access_enabled" = true);


ALTER VIEW "public"."vault_public_keys" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vault_recovery_admins" AS
 SELECT "user_id",
    "public_key"
   FROM "public"."vault_user_keys"
  WHERE (("is_recovery_admin" = true) AND ("access_enabled" = true));


ALTER VIEW "public"."vault_recovery_admins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vault_secrets" (
    "dossier_id" "uuid" NOT NULL,
    "ciphertext" "text" NOT NULL,
    "content_iv" "text" NOT NULL,
    "dek_version" integer DEFAULT 1 NOT NULL,
    "updated_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vault_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."web_search_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "brand" "text" NOT NULL,
    "model" "text",
    "equipment_type" "text",
    "department_name" "text",
    "specialty_name" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "results" "jsonb",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "results_anthropic" "jsonb",
    "results_perplexity" "jsonb",
    "status_anthropic" "text" DEFAULT 'pending'::"text" NOT NULL,
    "status_perplexity" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_anthropic" "text",
    "error_perplexity" "text",
    "done_at_anthropic" timestamp with time zone,
    "done_at_perplexity" timestamp with time zone,
    "status_final" "text",
    "final_results" "jsonb",
    "done_at_final" timestamp with time zone,
    CONSTRAINT "web_search_jobs_status_anthropic_check" CHECK (("status_anthropic" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'done'::"text", 'failed'::"text"]))),
    CONSTRAINT "web_search_jobs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'done'::"text", 'failed'::"text"]))),
    CONSTRAINT "web_search_jobs_status_perplexity_check" CHECK (("status_perplexity" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."web_search_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."web_search_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "results" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "brand" "text" NOT NULL,
    "model" "text" NOT NULL
);


ALTER TABLE "public"."web_search_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."web_search_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "engine" "text" NOT NULL,
    "status" "text" DEFAULT 'ok'::"text" NOT NULL,
    "candidate_count" integer DEFAULT 0 NOT NULL,
    "raw_results" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "error_message" "text",
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."web_search_results" OWNER TO "postgres";


ALTER TABLE ONLY "public"."communications"
    ADD CONSTRAINT "communications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demandes"
    ADD CONSTRAINT "demandes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_deletion_requests"
    ADD CONSTRAINT "dossier_deletion_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_documents"
    ADD CONSTRAINT "dossier_documents_pkey" PRIMARY KEY ("dossier_id", "document_id");



ALTER TABLE ONLY "public"."dossier_equipment_request_files"
    ADD CONSTRAINT "dossier_equipment_request_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_equipment_requests"
    ADD CONSTRAINT "dossier_equipment_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_notes"
    ADD CONSTRAINT "dossier_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_photos"
    ADD CONSTRAINT "dossier_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_plans"
    ADD CONSTRAINT "dossier_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossier_produits"
    ADD CONSTRAINT "dossier_produits_pkey" PRIMARY KEY ("dossier_id", "product_id");



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."duo_matches"
    ADD CONSTRAINT "duo_matches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."galerie_items"
    ADD CONSTRAINT "galerie_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."galerie_photos"
    ADD CONSTRAINT "galerie_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_scores"
    ADD CONSTRAINT "game_scores_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."onboarding_invitations"
    ADD CONSTRAINT "onboarding_invitations_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."pinned_documents"
    ADD CONSTRAINT "pinned_documents_pkey" PRIMARY KEY ("user_id", "document_id");



ALTER TABLE ONLY "public"."private_config"
    ADD CONSTRAINT "private_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_unique_ref" UNIQUE ("specialty_id", "brand", "model");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."specialties"
    ADD CONSTRAINT "specialties_department_id_slug_key" UNIQUE ("department_id", "slug");



ALTER TABLE ONLY "public"."specialties"
    ADD CONSTRAINT "specialties_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vault_dossier_access"
    ADD CONSTRAINT "vault_dossier_access_pkey" PRIMARY KEY ("dossier_id", "user_id");



ALTER TABLE ONLY "public"."vault_files"
    ADD CONSTRAINT "vault_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vault_secrets"
    ADD CONSTRAINT "vault_secrets_pkey" PRIMARY KEY ("dossier_id");



ALTER TABLE ONLY "public"."vault_user_keys"
    ADD CONSTRAINT "vault_user_keys_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."web_search_jobs"
    ADD CONSTRAINT "web_search_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."web_search_log"
    ADD CONSTRAINT "web_search_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."web_search_results"
    ADD CONSTRAINT "web_search_results_pkey" PRIMARY KEY ("id");



CREATE INDEX "communications_active_idx" ON "public"."communications" USING "btree" ("created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "ddr_dossier_idx" ON "public"."dossier_deletion_requests" USING "btree" ("dossier_id");



CREATE UNIQUE INDEX "ddr_one_pending_per_dossier" ON "public"."dossier_deletion_requests" USING "btree" ("dossier_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "ddr_status_idx" ON "public"."dossier_deletion_requests" USING "btree" ("status");



CREATE INDEX "demandes_auteur_idx" ON "public"."demandes" USING "btree" ("auteur", "created_at" DESC);



CREATE INDEX "demandes_statut_idx" ON "public"."demandes" USING "btree" ("statut", "created_at" DESC);



CREATE INDEX "deqrf_promoted_idx" ON "public"."dossier_equipment_request_files" USING "btree" ("promoted_document_id") WHERE ("promoted_document_id" IS NOT NULL);



CREATE INDEX "documents_product_idx" ON "public"."documents" USING "btree" ("product_id");



CREATE INDEX "documents_search_idx" ON "public"."documents" USING "gin" ("search_vector");



CREATE INDEX "documents_specialty_idx" ON "public"."documents" USING "btree" ("specialty_id");



CREATE INDEX "documents_tags_idx" ON "public"."documents" USING "gin" ("tags");



CREATE INDEX "documents_type_idx" ON "public"."documents" USING "btree" ("doc_type");



CREATE INDEX "dossier_documents_dossier_idx" ON "public"."dossier_documents" USING "btree" ("dossier_id");



CREATE INDEX "dossier_equipment_request_files_request_idx" ON "public"."dossier_equipment_request_files" USING "btree" ("request_id");



CREATE INDEX "dossier_equipment_requests_dossier_pending_idx" ON "public"."dossier_equipment_requests" USING "btree" ("dossier_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "dossier_equipment_requests_status_idx" ON "public"."dossier_equipment_requests" USING "btree" ("status", "created_at");



CREATE INDEX "dossier_notes_dossier_idx" ON "public"."dossier_notes" USING "btree" ("dossier_id", "created_at" DESC);



CREATE INDEX "dossier_notes_not_deleted_idx" ON "public"."dossier_notes" USING "btree" ("dossier_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "dossier_photos_dossier_idx" ON "public"."dossier_photos" USING "btree" ("dossier_id", "created_at" DESC);



CREATE INDEX "dossier_photos_not_deleted_idx" ON "public"."dossier_photos" USING "btree" ("dossier_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "dossier_photos_note_idx" ON "public"."dossier_photos" USING "btree" ("note_id");



CREATE INDEX "dossier_plans_dossier_id_idx" ON "public"."dossier_plans" USING "btree" ("dossier_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "dossier_produits_dossier_idx" ON "public"."dossier_produits" USING "btree" ("dossier_id");



CREATE INDEX "dossier_produits_not_deleted_idx" ON "public"."dossier_produits" USING "btree" ("dossier_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "dossier_produits_product_idx" ON "public"."dossier_produits" USING "btree" ("product_id");



CREATE INDEX "dossiers_adresse_idx" ON "public"."dossiers" USING "gin" ("to_tsvector"('"french"'::"regconfig", COALESCE("adresse", ''::"text")));



CREATE INDEX "dossiers_nom_idx" ON "public"."dossiers" USING "gin" ("to_tsvector"('"french"'::"regconfig", COALESCE("nom_client", ''::"text")));



CREATE UNIQUE INDEX "duo_matches_active_code" ON "public"."duo_matches" USING "btree" ("code") WHERE ("status" = ANY (ARRAY['waiting'::"text", 'playing'::"text"]));



CREATE INDEX "duo_matches_waiting" ON "public"."duo_matches" USING "btree" ("created_at") WHERE ("status" = 'waiting'::"text");



CREATE INDEX "galerie_items_specialty_idx" ON "public"."galerie_items" USING "btree" ("specialty_id");



CREATE UNIQUE INDEX "galerie_items_unique_name" ON "public"."galerie_items" USING "btree" ("specialty_id", "lower"("name"));



CREATE INDEX "galerie_photos_item_idx" ON "public"."galerie_photos" USING "btree" ("item_id");



CREATE INDEX "pinned_documents_user_idx" ON "public"."pinned_documents" USING "btree" ("user_id");



CREATE INDEX "products_brand_idx" ON "public"."products" USING "btree" ("brand");



CREATE INDEX "products_specialty_idx" ON "public"."products" USING "btree" ("specialty_id");



CREATE INDEX "vault_files_dossier_idx" ON "public"."vault_files" USING "btree" ("dossier_id");



CREATE INDEX "web_search_jobs_user_created_idx" ON "public"."web_search_jobs" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "web_search_log_user_day_idx" ON "public"."web_search_log" USING "btree" ("user_id", "created_at");



CREATE INDEX "web_search_results_engine_idx" ON "public"."web_search_results" USING "btree" ("engine");



CREATE INDEX "web_search_results_job_id_idx" ON "public"."web_search_results" USING "btree" ("job_id");



CREATE OR REPLACE VIEW "public"."galerie_items_view" WITH ("security_invoker"='true') AS
 SELECT "gi"."id",
    "gi"."specialty_id",
    "gi"."name",
    "gi"."brand",
    "gi"."notes",
    "gi"."created_at",
    "gi"."updated_at",
    "count"("gp"."id") AS "nb_photos",
    COALESCE("jsonb_agg"("jsonb_build_object"('id', "gp"."id", 'storage_provider', "gp"."storage_provider", 'storage_key', "gp"."storage_key", 'mime', "gp"."mime", 'libelle', "gp"."libelle", 'largeur', "gp"."largeur", 'hauteur', "gp"."hauteur", 'sort_order', "gp"."sort_order") ORDER BY "gp"."sort_order", "gp"."created_at") FILTER (WHERE ("gp"."id" IS NOT NULL)), '[]'::"jsonb") AS "photos"
   FROM ("public"."galerie_items" "gi"
     LEFT JOIN "public"."galerie_photos" "gp" ON (("gp"."item_id" = "gi"."id")))
  GROUP BY "gi"."id";



CREATE OR REPLACE TRIGGER "documents_touch_updated_at" BEFORE UPDATE ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "dossier_notes_set_updated" BEFORE UPDATE ON "public"."dossier_notes" FOR EACH ROW EXECUTE FUNCTION "public"."set_dossier_note_updated"();



CREATE OR REPLACE TRIGGER "dossiers_guard_vault_deletion" BEFORE DELETE OR UPDATE ON "public"."dossiers" FOR EACH ROW EXECUTE FUNCTION "public"."guard_dossier_vault_deletion"();



CREATE OR REPLACE TRIGGER "dossiers_touch_updated_at" BEFORE UPDATE ON "public"."dossiers" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "galerie_items_set_updated" BEFORE UPDATE ON "public"."galerie_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_galerie_item_updated"();



CREATE OR REPLACE TRIGGER "onboarding_invitations_normalize" BEFORE INSERT OR UPDATE ON "public"."onboarding_invitations" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_invitation_email"();



CREATE OR REPLACE TRIGGER "profiles_guard_trg" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."profiles_guard"();



CREATE OR REPLACE TRIGGER "trg_demande_updated" BEFORE UPDATE ON "public"."demandes" FOR EACH ROW EXECUTE FUNCTION "public"."set_demande_updated"();



CREATE OR REPLACE TRIGGER "trg_notify_n8n_web_search" AFTER INSERT ON "public"."web_search_jobs" FOR EACH ROW WHEN (("new"."status" = 'pending'::"text")) EXECUTE FUNCTION "public"."notify_n8n_web_search"();



CREATE OR REPLACE TRIGGER "trg_vault_secrets_touch" BEFORE UPDATE ON "public"."vault_secrets" FOR EACH ROW EXECUTE FUNCTION "public"."vault_secrets_touch"();



CREATE OR REPLACE TRIGGER "trg_vault_user_keys_guard" BEFORE INSERT OR UPDATE ON "public"."vault_user_keys" FOR EACH ROW EXECUTE FUNCTION "public"."vault_user_keys_guard"();



ALTER TABLE ONLY "public"."communications"
    ADD CONSTRAINT "communications_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."communications"
    ADD CONSTRAINT "communications_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."demandes"
    ADD CONSTRAINT "demandes_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."demandes"
    ADD CONSTRAINT "demandes_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."dossier_deletion_requests"
    ADD CONSTRAINT "dossier_deletion_requests_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_deletion_requests"
    ADD CONSTRAINT "dossier_deletion_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_deletion_requests"
    ADD CONSTRAINT "dossier_deletion_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_documents"
    ADD CONSTRAINT "dossier_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_documents"
    ADD CONSTRAINT "dossier_documents_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_equipment_request_files"
    ADD CONSTRAINT "dossier_equipment_request_files_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_equipment_request_files"
    ADD CONSTRAINT "dossier_equipment_request_files_promoted_document_id_fkey" FOREIGN KEY ("promoted_document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_equipment_request_files"
    ADD CONSTRAINT "dossier_equipment_request_files_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."dossier_equipment_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_equipment_requests"
    ADD CONSTRAINT "dossier_equipment_requests_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_equipment_requests"
    ADD CONSTRAINT "dossier_equipment_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_equipment_requests"
    ADD CONSTRAINT "dossier_equipment_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_equipment_requests"
    ADD CONSTRAINT "dossier_equipment_requests_resolved_product_id_fkey" FOREIGN KEY ("resolved_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_equipment_requests"
    ADD CONSTRAINT "dossier_equipment_requests_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_notes"
    ADD CONSTRAINT "dossier_notes_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_notes"
    ADD CONSTRAINT "dossier_notes_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_notes"
    ADD CONSTRAINT "dossier_notes_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_notes"
    ADD CONSTRAINT "dossier_notes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_photos"
    ADD CONSTRAINT "dossier_photos_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_photos"
    ADD CONSTRAINT "dossier_photos_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_photos"
    ADD CONSTRAINT "dossier_photos_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_photos"
    ADD CONSTRAINT "dossier_photos_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "public"."dossier_notes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_plans"
    ADD CONSTRAINT "dossier_plans_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_plans"
    ADD CONSTRAINT "dossier_plans_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_plans"
    ADD CONSTRAINT "dossier_plans_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_produits"
    ADD CONSTRAINT "dossier_produits_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossier_produits"
    ADD CONSTRAINT "dossier_produits_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossier_produits"
    ADD CONSTRAINT "dossier_produits_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."duo_matches"
    ADD CONSTRAINT "duo_matches_guest_fkey" FOREIGN KEY ("guest") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."duo_matches"
    ADD CONSTRAINT "duo_matches_host_fkey" FOREIGN KEY ("host") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."galerie_items"
    ADD CONSTRAINT "galerie_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."galerie_items"
    ADD CONSTRAINT "galerie_items_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."galerie_photos"
    ADD CONSTRAINT "galerie_photos_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."galerie_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_scores"
    ADD CONSTRAINT "game_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_invitations"
    ADD CONSTRAINT "onboarding_invitations_consumed_by_fkey" FOREIGN KEY ("consumed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."onboarding_invitations"
    ADD CONSTRAINT "onboarding_invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pinned_documents"
    ADD CONSTRAINT "pinned_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pinned_documents"
    ADD CONSTRAINT "pinned_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."specialties"
    ADD CONSTRAINT "specialties_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."specialties"
    ADD CONSTRAINT "specialties_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."specialties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_dossier_access"
    ADD CONSTRAINT "vault_dossier_access_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_dossier_access"
    ADD CONSTRAINT "vault_dossier_access_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."vault_dossier_access"
    ADD CONSTRAINT "vault_dossier_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_files"
    ADD CONSTRAINT "vault_files_auteur_fkey" FOREIGN KEY ("auteur") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vault_files"
    ADD CONSTRAINT "vault_files_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_secrets"
    ADD CONSTRAINT "vault_secrets_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_secrets"
    ADD CONSTRAINT "vault_secrets_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."vault_user_keys"
    ADD CONSTRAINT "vault_user_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."web_search_jobs"
    ADD CONSTRAINT "web_search_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."web_search_log"
    ADD CONSTRAINT "web_search_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."web_search_results"
    ADD CONSTRAINT "web_search_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."web_search_jobs"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can read all web search logs" ON "public"."web_search_log" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "Users can log their own web searches" ON "public"."web_search_log" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can read their own web search log" ON "public"."web_search_log" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "admin ecrit departements" ON "public"."departments" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin ecrit documents" ON "public"."documents" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin ecrit produits" ON "public"."products" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin ecrit specialites" ON "public"."specialties" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin gere les profils" ON "public"."profiles" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "authentifies gerent les documents du dossier" ON "public"."dossier_documents" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authentifies gerent les dossiers" ON "public"."dossiers" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authentifies gerent les equipements du dossier" ON "public"."dossier_produits" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "chacun gere ses epingles" ON "public"."pinned_documents" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "chacun lit son historique" ON "public"."web_search_log" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "chacun modifie son profil" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."communications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "communications_insert_publisher" ON "public"."communications" FOR INSERT TO "authenticated" WITH CHECK ((("auteur" = "auth"."uid"()) AND ("public"."is_admin"() OR "public"."is_comms_publisher"())));



CREATE POLICY "communications_select_all" ON "public"."communications" FOR SELECT TO "authenticated" USING (("deleted_at" IS NULL));



CREATE POLICY "communications_update_publisher_or_admin" ON "public"."communications" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR "public"."is_comms_publisher"())) WITH CHECK (("public"."is_admin"() OR "public"."is_comms_publisher"()));



CREATE POLICY "ddr_insert" ON "public"."dossier_deletion_requests" FOR INSERT TO "authenticated" WITH CHECK (("requested_by" = "auth"."uid"()));



CREATE POLICY "ddr_select" ON "public"."dossier_deletion_requests" FOR SELECT TO "authenticated" USING ((("requested_by" = "auth"."uid"()) OR "public"."is_vault_admin"()));



CREATE POLICY "ddr_update" ON "public"."dossier_deletion_requests" FOR UPDATE TO "authenticated" USING ("public"."is_vault_admin"()) WITH CHECK ("public"."is_vault_admin"());



ALTER TABLE "public"."demandes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "demandes_delete_admin" ON "public"."demandes" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "demandes_insert_self" ON "public"."demandes" FOR INSERT TO "authenticated" WITH CHECK (("auteur" = "auth"."uid"()));



CREATE POLICY "demandes_select_own_or_admin" ON "public"."demandes" FOR SELECT TO "authenticated" USING ((("auteur" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "demandes_update_admin" ON "public"."demandes" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dossier_deletion_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dossier_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dossier_equipment_request_files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dossier_equipment_request_files_delete_own_or_admin" ON "public"."dossier_equipment_request_files" FOR DELETE USING ((("auteur" = "auth"."uid"()) OR "public"."is_vault_admin"()));



CREATE POLICY "dossier_equipment_request_files_insert_own" ON "public"."dossier_equipment_request_files" FOR INSERT WITH CHECK (("auteur" = "auth"."uid"()));



CREATE POLICY "dossier_equipment_request_files_select_all" ON "public"."dossier_equipment_request_files" FOR SELECT USING (true);



ALTER TABLE "public"."dossier_equipment_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dossier_equipment_requests_insert_own" ON "public"."dossier_equipment_requests" FOR INSERT TO "authenticated" WITH CHECK (("requested_by" = "auth"."uid"()));



CREATE POLICY "dossier_equipment_requests_select_all" ON "public"."dossier_equipment_requests" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."dossier_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dossier_notes_delete" ON "public"."dossier_notes" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "dossier_notes_insert" ON "public"."dossier_notes" FOR INSERT TO "authenticated" WITH CHECK (("auteur" = "auth"."uid"()));



CREATE POLICY "dossier_notes_select" ON "public"."dossier_notes" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "dossier_notes_update" ON "public"."dossier_notes" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."dossier_photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dossier_photos_delete" ON "public"."dossier_photos" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "dossier_photos_insert" ON "public"."dossier_photos" FOR INSERT TO "authenticated" WITH CHECK (("auteur" = "auth"."uid"()));



CREATE POLICY "dossier_photos_select" ON "public"."dossier_photos" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "dossier_photos_update" ON "public"."dossier_photos" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."dossier_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dossier_plans_insert_own_author" ON "public"."dossier_plans" FOR INSERT TO "authenticated" WITH CHECK (("auteur" = "auth"."uid"()));



CREATE POLICY "dossier_plans_select_authenticated" ON "public"."dossier_plans" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "dossier_plans_update_authenticated" ON "public"."dossier_plans" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."dossier_produits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dossiers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."duo_matches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."galerie_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "galerie_items_delete" ON "public"."galerie_items" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "galerie_items_insert" ON "public"."galerie_items" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "galerie_items_select" ON "public"."galerie_items" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "galerie_items_update" ON "public"."galerie_items" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



ALTER TABLE "public"."galerie_photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "galerie_photos_delete" ON "public"."galerie_photos" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



CREATE POLICY "galerie_photos_insert" ON "public"."galerie_photos" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "galerie_photos_select" ON "public"."galerie_photos" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "galerie_photos_update" ON "public"."galerie_photos" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))));



ALTER TABLE "public"."game_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "game_scores_insert_own" ON "public"."game_scores" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "game_scores_select_all" ON "public"."game_scores" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "game_scores_update_own" ON "public"."game_scores" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "lecture departements" ON "public"."departments" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "lecture documents" ON "public"."documents" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "lecture produits" ON "public"."products" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "lecture specialites" ON "public"."specialties" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."onboarding_invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "onboarding_invitations_admin_all" ON "public"."onboarding_invitations" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



ALTER TABLE "public"."pinned_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."private_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profils lisibles par les authentifies" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."specialties" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vault_dossier_access" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_dossier_access_delete" ON "public"."vault_dossier_access" FOR DELETE USING ("public"."is_vault_admin"());



CREATE POLICY "vault_dossier_access_insert" ON "public"."vault_dossier_access" FOR INSERT WITH CHECK (("public"."has_vault_access"() OR "public"."is_vault_admin"()));



CREATE POLICY "vault_dossier_access_select" ON "public"."vault_dossier_access" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_vault_admin"()));



CREATE POLICY "vault_dossier_access_update" ON "public"."vault_dossier_access" FOR UPDATE USING (("public"."has_vault_access"() OR "public"."is_vault_admin"())) WITH CHECK (("public"."has_vault_access"() OR "public"."is_vault_admin"()));



ALTER TABLE "public"."vault_files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_files_delete" ON "public"."vault_files" FOR DELETE USING (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"()));



CREATE POLICY "vault_files_insert" ON "public"."vault_files" FOR INSERT WITH CHECK (("public"."has_vault_access"() OR "public"."is_vault_admin"()));



CREATE POLICY "vault_files_select" ON "public"."vault_files" FOR SELECT USING (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"()));



CREATE POLICY "vault_files_update" ON "public"."vault_files" FOR UPDATE USING (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"())) WITH CHECK (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"()));



ALTER TABLE "public"."vault_secrets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_secrets_delete" ON "public"."vault_secrets" FOR DELETE USING ("public"."is_vault_admin"());



CREATE POLICY "vault_secrets_insert" ON "public"."vault_secrets" FOR INSERT WITH CHECK (("public"."has_vault_access"() OR "public"."is_vault_admin"()));



CREATE POLICY "vault_secrets_select" ON "public"."vault_secrets" FOR SELECT USING (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"()));



CREATE POLICY "vault_secrets_update" ON "public"."vault_secrets" FOR UPDATE USING (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"())) WITH CHECK (("public"."has_dossier_vault_access"("dossier_id") OR "public"."is_vault_admin"()));



ALTER TABLE "public"."vault_user_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_user_keys_delete" ON "public"."vault_user_keys" FOR DELETE USING ("public"."is_vault_admin"());



CREATE POLICY "vault_user_keys_insert" ON "public"."vault_user_keys" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "vault_user_keys_select" ON "public"."vault_user_keys" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_vault_admin"()));



CREATE POLICY "vault_user_keys_update" ON "public"."vault_user_keys" FOR UPDATE USING ((("user_id" = "auth"."uid"()) OR "public"."is_vault_admin"())) WITH CHECK ((("user_id" = "auth"."uid"()) OR "public"."is_vault_admin"()));



ALTER TABLE "public"."web_search_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "web_search_jobs_insert_own" ON "public"."web_search_jobs" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "web_search_jobs_select_own" ON "public"."web_search_jobs" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "web_search_jobs_update_own" ON "public"."web_search_jobs" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."web_search_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."web_search_results" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."cancel_duo_match"("p_match_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_duo_match"("p_match_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_duo_match"("p_match_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_duo_match"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_duo_match"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_duo_match"() TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_dossier_equipment_request"("p_request_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_dossier_equipment_request"("p_request_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_dossier_equipment_request"("p_request_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_dossier_if_empty"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_dossier_if_empty"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_dossier_if_empty"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."destroy_dossier_vault"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."destroy_dossier_vault"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."destroy_dossier_vault"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."documents_tsv"("p_title" "text", "p_tags" "text"[], "p_content" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."documents_tsv"("p_title" "text", "p_tags" "text"[], "p_content" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."documents_tsv"("p_title" "text", "p_tags" "text"[], "p_content" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."dossier_documents_complets"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dossier_documents_complets"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dossier_documents_complets"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dossier_has_configured_vault"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dossier_has_configured_vault"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dossier_has_configured_vault"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dossier_has_vault"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dossier_has_vault"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dossier_has_vault"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dossier_vault_has_content"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dossier_vault_has_content"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dossier_vault_has_content"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fail_stale_web_search_jobs"() TO "anon";
GRANT ALL ON FUNCTION "public"."fail_stale_web_search_jobs"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fail_stale_web_search_jobs"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_dossier_vault_deletion"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_dossier_vault_deletion"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_dossier_vault_deletion"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_dossier_vault_access"("p_dossier_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_dossier_vault_access"("p_dossier_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_dossier_vault_access"("p_dossier_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_vault_access"() TO "anon";
GRANT ALL ON FUNCTION "public"."has_vault_access"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_vault_access"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_comms_publisher"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_comms_publisher"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_comms_publisher"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_vault_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_vault_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_vault_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."join_duo_match"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."join_duo_match"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_duo_match"("p_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."list_waiting_duo_matches"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_waiting_duo_matches"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_waiting_duo_matches"() TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_invitation_email"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_invitation_email"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_invitation_email"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_n8n_web_search"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_n8n_web_search"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_n8n_web_search"() TO "service_role";



GRANT ALL ON FUNCTION "public"."profiles_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."profiles_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."profiles_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."reenroll_vault_user"("p_public_key" "text", "p_wrapped_private_key_pw" "text", "p_wrapped_private_key_recovery" "text", "p_pw_salt" "text", "p_recovery_salt" "text", "p_pw_iv" "text", "p_recovery_iv" "text", "p_kdf_iterations" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."reenroll_vault_user"("p_public_key" "text", "p_wrapped_private_key_pw" "text", "p_wrapped_private_key_recovery" "text", "p_pw_salt" "text", "p_recovery_salt" "text", "p_pw_iv" "text", "p_recovery_iv" "text", "p_kdf_iterations" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reenroll_vault_user"("p_public_key" "text", "p_wrapped_private_key_pw" "text", "p_wrapped_private_key_recovery" "text", "p_pw_salt" "text", "p_recovery_salt" "text", "p_pw_iv" "text", "p_recovery_iv" "text", "p_kdf_iterations" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_dossier_deletion_request"("p_request_id" "uuid", "p_approve" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_dossier_deletion_request"("p_request_id" "uuid", "p_approve" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_dossier_deletion_request"("p_request_id" "uuid", "p_approve" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_dossier_equipment_request"("p_request_id" "uuid", "p_specialty_id" "uuid", "p_approve" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_dossier_equipment_request"("p_request_id" "uuid", "p_specialty_id" "uuid", "p_approve" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_dossier_equipment_request"("p_request_id" "uuid", "p_specialty_id" "uuid", "p_approve" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."rotate_vault_secret"("p_dossier_id" "uuid", "p_ciphertext" "text", "p_content_iv" "text", "p_expected_dek_version" integer, "p_new_dek_version" integer, "p_access_rows" "jsonb", "p_file_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."rotate_vault_secret"("p_dossier_id" "uuid", "p_ciphertext" "text", "p_content_iv" "text", "p_expected_dek_version" integer, "p_new_dek_version" integer, "p_access_rows" "jsonb", "p_file_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rotate_vault_secret"("p_dossier_id" "uuid", "p_ciphertext" "text", "p_content_iv" "text", "p_expected_dek_version" integer, "p_new_dek_version" integer, "p_access_rows" "jsonb", "p_file_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_documents"("q" "text", "p_department_slug" "text", "p_specialty_slug" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_documents"("q" "text", "p_department_slug" "text", "p_specialty_slug" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_documents"("q" "text", "p_department_slug" "text", "p_specialty_slug" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_dossiers"("q" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_dossiers"("q" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_dossiers"("q" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_comms_publisher"("p_user_id" "uuid", "p_enabled" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."set_comms_publisher"("p_user_id" "uuid", "p_enabled" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_comms_publisher"("p_user_id" "uuid", "p_enabled" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_demande_updated"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_demande_updated"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_demande_updated"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_dossier_note_updated"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_dossier_note_updated"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_dossier_note_updated"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_galerie_item_updated"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_galerie_item_updated"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_galerie_item_updated"() TO "service_role";



GRANT ALL ON FUNCTION "public"."soft_delete_communication"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."soft_delete_communication"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."soft_delete_communication"("p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_duo_match"("p_match_id" "uuid", "p_attack_total" integer, "p_died" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sync_duo_match"("p_match_id" "uuid", "p_attack_total" integer, "p_died" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_duo_match"("p_match_id" "uuid", "p_attack_total" integer, "p_died" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_dossier_product"("p_dossier_id" "uuid", "p_specialty_id" "uuid", "p_brand" "text", "p_model" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_dossier_product"("p_dossier_id" "uuid", "p_specialty_id" "uuid", "p_brand" "text", "p_model" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_dossier_product"("p_dossier_id" "uuid", "p_specialty_id" "uuid", "p_brand" "text", "p_model" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."vault_secrets_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."vault_secrets_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."vault_secrets_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."vault_user_keys_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."vault_user_keys_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."vault_user_keys_guard"() TO "service_role";


















GRANT ALL ON TABLE "public"."communications" TO "anon";
GRANT ALL ON TABLE "public"."communications" TO "authenticated";
GRANT ALL ON TABLE "public"."communications" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."communications_view" TO "anon";
GRANT ALL ON TABLE "public"."communications_view" TO "authenticated";
GRANT ALL ON TABLE "public"."communications_view" TO "service_role";



GRANT ALL ON TABLE "public"."demandes" TO "anon";
GRANT ALL ON TABLE "public"."demandes" TO "authenticated";
GRANT ALL ON TABLE "public"."demandes" TO "service_role";



GRANT ALL ON TABLE "public"."demandes_view" TO "anon";
GRANT ALL ON TABLE "public"."demandes_view" TO "authenticated";
GRANT ALL ON TABLE "public"."demandes_view" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_deletion_requests" TO "anon";
GRANT ALL ON TABLE "public"."dossier_deletion_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_deletion_requests" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_documents" TO "anon";
GRANT ALL ON TABLE "public"."dossier_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_documents" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_equipment_request_files" TO "anon";
GRANT ALL ON TABLE "public"."dossier_equipment_request_files" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_equipment_request_files" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_equipment_requests" TO "anon";
GRANT ALL ON TABLE "public"."dossier_equipment_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_equipment_requests" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_notes" TO "anon";
GRANT ALL ON TABLE "public"."dossier_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_notes" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_notes_view" TO "anon";
GRANT ALL ON TABLE "public"."dossier_notes_view" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_notes_view" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_photos" TO "anon";
GRANT ALL ON TABLE "public"."dossier_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_photos" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_photos_view" TO "anon";
GRANT ALL ON TABLE "public"."dossier_photos_view" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_photos_view" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_plans" TO "anon";
GRANT ALL ON TABLE "public"."dossier_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_plans" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_plans_view" TO "anon";
GRANT ALL ON TABLE "public"."dossier_plans_view" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_plans_view" TO "service_role";



GRANT ALL ON TABLE "public"."dossier_produits" TO "anon";
GRANT ALL ON TABLE "public"."dossier_produits" TO "authenticated";
GRANT ALL ON TABLE "public"."dossier_produits" TO "service_role";



GRANT ALL ON TABLE "public"."dossiers" TO "anon";
GRANT ALL ON TABLE "public"."dossiers" TO "authenticated";
GRANT ALL ON TABLE "public"."dossiers" TO "service_role";



GRANT ALL ON TABLE "public"."duo_matches" TO "anon";
GRANT ALL ON TABLE "public"."duo_matches" TO "authenticated";
GRANT ALL ON TABLE "public"."duo_matches" TO "service_role";



GRANT ALL ON TABLE "public"."galerie_items" TO "anon";
GRANT ALL ON TABLE "public"."galerie_items" TO "authenticated";
GRANT ALL ON TABLE "public"."galerie_items" TO "service_role";



GRANT ALL ON TABLE "public"."galerie_items_view" TO "anon";
GRANT ALL ON TABLE "public"."galerie_items_view" TO "authenticated";
GRANT ALL ON TABLE "public"."galerie_items_view" TO "service_role";



GRANT ALL ON TABLE "public"."galerie_photos" TO "anon";
GRANT ALL ON TABLE "public"."galerie_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."galerie_photos" TO "service_role";



GRANT ALL ON TABLE "public"."game_scores" TO "anon";
GRANT ALL ON TABLE "public"."game_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."game_scores" TO "service_role";



GRANT ALL ON TABLE "public"."game_leaderboard" TO "anon";
GRANT ALL ON TABLE "public"."game_leaderboard" TO "authenticated";
GRANT ALL ON TABLE "public"."game_leaderboard" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_invitations" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."pinned_documents" TO "anon";
GRANT ALL ON TABLE "public"."pinned_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."pinned_documents" TO "service_role";



GRANT ALL ON TABLE "public"."private_config" TO "anon";
GRANT ALL ON TABLE "public"."private_config" TO "authenticated";
GRANT ALL ON TABLE "public"."private_config" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."specialties" TO "anon";
GRANT ALL ON TABLE "public"."specialties" TO "authenticated";
GRANT ALL ON TABLE "public"."specialties" TO "service_role";



GRANT ALL ON TABLE "public"."vault_dossier_access" TO "anon";
GRANT ALL ON TABLE "public"."vault_dossier_access" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_dossier_access" TO "service_role";



GRANT ALL ON TABLE "public"."vault_files" TO "anon";
GRANT ALL ON TABLE "public"."vault_files" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_files" TO "service_role";



GRANT ALL ON TABLE "public"."vault_user_keys" TO "anon";
GRANT ALL ON TABLE "public"."vault_user_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_user_keys" TO "service_role";



GRANT ALL ON TABLE "public"."vault_public_keys" TO "anon";
GRANT ALL ON TABLE "public"."vault_public_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_public_keys" TO "service_role";



GRANT ALL ON TABLE "public"."vault_recovery_admins" TO "anon";
GRANT ALL ON TABLE "public"."vault_recovery_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_recovery_admins" TO "service_role";



GRANT ALL ON TABLE "public"."vault_secrets" TO "anon";
GRANT ALL ON TABLE "public"."vault_secrets" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."web_search_jobs" TO "anon";
GRANT ALL ON TABLE "public"."web_search_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."web_search_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."web_search_log" TO "anon";
GRANT ALL ON TABLE "public"."web_search_log" TO "authenticated";
GRANT ALL ON TABLE "public"."web_search_log" TO "service_role";



GRANT ALL ON TABLE "public"."web_search_results" TO "anon";
GRANT ALL ON TABLE "public"."web_search_results" TO "authenticated";
GRANT ALL ON TABLE "public"."web_search_results" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































