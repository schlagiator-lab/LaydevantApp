-- Corrige web_search_log : la table déployée en production a été créée avec
-- une colonne `query` au lieu de `brand`/`model` (désynchronisation avec
-- 20260726080402_web_search_log.sql, dont le `create table if not exists`
-- ne pouvait pas corriger un schéma déjà existant). Résultat en prod :
-- l'Edge Function web-search-notices échouait à chaque appel avec
-- PGRST204 "Could not find the 'brand' column...".
--
-- Table de log neuve, 0 ligne en prod au moment de cette correction :
-- aucune perte de données.

alter table public.web_search_log drop column if exists query;

alter table public.web_search_log
  add column if not exists brand text,
  add column if not exists model text;

alter table public.web_search_log
  alter column brand set not null,
  alter column model set not null;
