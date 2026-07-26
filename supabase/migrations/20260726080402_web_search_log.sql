-- Table de journalisation pour la fonctionnalité "Recherche web de notices"
-- (Feature recherche web notices.md, §3). Ne touche à aucune table existante
-- de CLAUDE.md §3 — nouvelle table dédiée à cette extension.
--
-- Sert deux besoins : garde-fou de coût (plafond souple par utilisateur et
-- par jour, appliqué par l'Edge Function web-search-notices) et traçabilité
-- (qui, quand, quelle requête).

create table if not exists public.web_search_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  brand text not null,
  model text not null,
  created_at timestamptz not null default now()
);

-- Sert la vérification du plafond quotidien : compter les lignes d'un
-- utilisateur depuis un instant donné.
create index if not exists web_search_log_user_created_idx
  on public.web_search_log (user_id, created_at desc);

alter table public.web_search_log enable row level security;

-- L'Edge Function agit avec le JWT de l'utilisateur appelant (jamais la clé
-- service_role, réservée à n8n — CLAUDE.md §8), donc les mêmes règles RLS
-- s'appliquent qu'un appel vienne d'elle ou, hypothétiquement, du front.
create policy "Users can log their own web searches"
  on public.web_search_log for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can read their own web search log"
  on public.web_search_log for select
  to authenticated
  using (user_id = auth.uid());

create policy "Admins can read all web search logs"
  on public.web_search_log for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );
