-- =====================================================================
-- Demande d'équipement manuel — suppression (CLAUDE.md §10/§11).
--
-- dossier_equipment_requests n'a ni policy DELETE ni policy UPDATE côté RLS
-- (select_all + insert_own uniquement) : la résolution passe déjà par
-- resolve_dossier_equipment_request (SECURITY DEFINER). Une fois résolue
-- (approuvée, notice promue ou non), rien ne permettait de la retirer de la
-- fiche dossier : elle restait affichée indéfiniment dans "Demandes
-- approuvées", sans action possible. Même motif que soft_delete_communication :
-- fonction SECURITY DEFINER qui revérifie les droits en interne plutôt
-- qu'une policy DELETE ouverte.
--
-- Droits : admin toujours ; l'auteur peut retirer sa PROPRE demande tant
-- qu'elle est encore 'pending' (annulation avant traitement) — jamais une
-- demande déjà résolue ('approved'/'rejected'), ni celle d'un autre monteur.
--
-- dossier_equipment_request_files.request_id est ON DELETE CASCADE vers
-- cette table : les notices jointes (lignes DB) disparaissent avec la
-- demande. Les octets R2 correspondants restent orphelins (best-effort côté
-- front avant l'appel RPC, même tolérance que deleteEquipmentRequestNotice).
-- =====================================================================

create or replace function public.delete_dossier_equipment_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

grant execute on function public.delete_dossier_equipment_request(uuid) to authenticated;
