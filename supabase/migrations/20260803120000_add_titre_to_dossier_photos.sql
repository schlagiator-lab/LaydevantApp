-- Titre optionnel sur une photo du carnet (ex. "tableau du sous-sol").
-- Édition simple d'un champ existant : ne crée jamais de copie de la photo,
-- contrairement à l'annotation (dessin libre) qui produit toujours une
-- nouvelle photo indépendante.

alter table public.dossier_photos
  add column if not exists titre text;

-- CREATE OR REPLACE VIEW exige que les colonnes déjà exposées gardent leur
-- nom et leur position ; `titre` est donc ajouté en dernier, jamais inséré
-- au milieu de la liste (sinon Postgres refuse le remplacement). Reprend
-- exactement pg_get_viewdef() de la définition existante, plus la colonne.
create or replace view public.dossier_photos_view as
select
  p.id,
  p.dossier_id,
  p.note_id,
  p.storage_provider,
  p.storage_key,
  p.mime,
  p.taille,
  p.largeur,
  p.hauteur,
  p.auteur,
  p.created_at,
  pa.full_name as auteur_nom,
  p.titre
from public.dossier_photos p
left join public.profiles pa on pa.id = p.auteur;
