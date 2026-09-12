-- =====================================================================
-- Liste de prix — suppression d'un article (CLAUDE.md §4).
--
-- prix_articles a un soft-delete (deleted_at/deleted_by) et sa policy SELECT
-- filtre deleted_at IS NULL (fetchPrixArticles, src/lib/prixArticles.ts).
-- Même piège que documenté en §3 ("soft-delete et policy SELECT restrictive") :
-- l'UPDATE posant deleted_at via PostgREST échoue en 42501 — PostgREST génère
-- un RETURNING implicite même en Prefer: return=minimal, et Postgres
-- revérifie la ligne modifiée contre la policy SELECT, qui la rejette
-- puisqu'elle ne satisfait plus deleted_at IS NULL. Même fix que déjà
-- appliqué pour communications (soft_delete_communication) et
-- dossier_equipment_requests (delete_dossier_equipment_request) : RPC
-- SECURITY DEFINER qui fait l'UPDATE hors RLS.
--
-- Pas de restriction de rôle ajoutée ici : create/updatePrixArticle
-- (src/lib/prixArticles.ts) n'ont aucun garde-fou admin côté front et
-- ListePrixScreen n'a pas de check de rôle non plus — l'écriture sur
-- prix_articles est déjà ouverte à tout utilisateur authentifié. Cette RPC
-- ne fait que contourner le piège RETURNING, pas ajouter une restriction
-- nouvelle par rapport au comportement actuel de create/update.
-- =====================================================================

create or replace function public.soft_delete_prix_article(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.prix_articles
  set deleted_at = now(), deleted_by = auth.uid()
  where id = p_id and deleted_at is null;
end;
$$;

grant execute on function public.soft_delete_prix_article(uuid) to authenticated;
