-- =====================================================================
-- Coffre données sensibles — TRANCHE 6 : rotation atomique de clé
-- Dépend des tranches 1-2 (vault_user_keys, vault_secrets,
-- vault_dossier_access, is_vault_admin). Voir "Feature coffre données
-- sensibles.md" et l'onglet "Rotation" du panneau admin (front).
--
-- Pourquoi une fonction plutôt que deux écritures depuis le front :
-- remplacer les lignes vault_dossier_access ET mettre à jour vault_secrets
-- sont deux requêtes distinctes vues du client. Si la seconde échoue après
-- que la première a réussi (perte réseau, app tuée), le coffre se retrouve
-- dans un état incohérent : les accès pointent vers la nouvelle DEK mais le
-- ciphertext est encore chiffré avec l'ancienne — personne ne peut plus le
-- lire, et rien ne permet de le corriger depuis l'app. Cette fonction fait
-- les deux écritures dans UNE seule transaction Postgres (implicite à
-- l'appel d'une fonction) : soit tout est appliqué, soit rien ne l'est.
--
-- Tout le calcul cryptographique (déballage/re-chiffrement/ré-emballage)
-- reste côté client (src/lib/vault.js, WebCrypto) — cette fonction ne
-- reçoit que des valeurs déjà chiffrées/emballées, jamais de secret en
-- clair, et ne fait aucune crypto elle-même.
-- =====================================================================

create or replace function public.rotate_vault_secret(
  p_dossier_id           uuid,
  p_ciphertext           text,
  p_content_iv           text,
  p_expected_dek_version integer,
  p_new_dek_version      integer,
  p_access_rows          jsonb  -- [{ "user_id": uuid, "wrapped_dek": text }, ...]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected_count integer;
  v_updated_count  integer;
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
  -- vérifié côté app AVANT préparation de la crypto (elle a besoin de la
  -- liste des clés publiques de toute façon) ; ici on vérifie seulement
  -- qu'une liste non vide a été fournie, filet de sécurité minimal si la
  -- fonction est jamais appelée hors du flux normal de l'app.
  v_expected_count := jsonb_array_length(p_access_rows);
  if v_expected_count is null or v_expected_count = 0 then
    raise exception 'Aucun destinataire fourni — rotation refusée.' using errcode = 'P0001';
  end if;

  -- --- Ré-emballage : UPDATE, jamais INSERT --------------------------
  -- Le jeu de destinataires ne change pas pendant une rotation (ce n'est
  -- pas le geste qui accorde ou retire l'accès) : on mets à jour les
  -- lignes existantes, on n'en crée jamais. Le nombre de lignes réellement
  -- mises à jour DOIT correspondre au nombre de destinataires envoyés par
  -- l'appelant — sinon sa vue du dossier (obtenue avant préparation de la
  -- crypto) est périmée par rapport à l'état réel (ex: quelqu'un révoqué
  -- entre-temps), et on annule plutôt que de roter sur une base fausse.
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

  -- --- Contenu ---------------------------------------------------------
  update public.vault_secrets
  set ciphertext  = p_ciphertext,
      content_iv  = p_content_iv,
      dek_version = p_new_dek_version
  where dossier_id = p_dossier_id;
end;
$$;

grant execute on function public.rotate_vault_secret(uuid, text, text, integer, integer, jsonb) to authenticated;
