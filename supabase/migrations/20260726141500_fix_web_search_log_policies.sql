-- Les policies RLS déployées sur web_search_log divergent de
-- 20260726080402_web_search_log.sql (même désynchronisation que les
-- colonnes, corrigée par 20260726140000) : l'insert de journalisation dans
-- l'Edge Function échoue avec 42501 "new row violates row-level security
-- policy". On recrée les policies à l'identique de la migration d'origine,
-- sans dépendre de leur état actuel.

drop policy if exists "Users can log their own web searches" on public.web_search_log;
create policy "Users can log their own web searches"
  on public.web_search_log for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can read their own web search log" on public.web_search_log;
create policy "Users can read their own web search log"
  on public.web_search_log for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Admins can read all web search logs" on public.web_search_log;
create policy "Admins can read all web search logs"
  on public.web_search_log for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );
