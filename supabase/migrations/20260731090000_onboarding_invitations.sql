-- Onboarding par liste blanche : un admin "invite" un email, la personne
-- s'auto-enrôle à l'URL. La création de compte passera par l'Edge Function
-- `enroll` (service_role) qui vérifie cette table AVANT de créer le compte.
-- Cette table n'est JAMAIS lue par le client anon (RLS admin-only) ; seule
-- l'Edge Function la consulte, en contournant la RLS via service_role.

create table if not exists public.onboarding_invitations (
  email        text primary key,
  role         text not null default 'monteur' check (role in ('monteur','admin')),
  note         text,                       -- aide-mémoire admin (ex. "Jean, apprenti élec")
  created_by   uuid references auth.users(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz,                -- null = pending ; renseigné = déjà utilisé
  consumed_by  uuid references auth.users(id) on delete set null
);

-- Normalisation e-mail (minuscules + trim) garantie côté base, quel que soit
-- l'appelant. Évite les doublons "John@… / john@…" et les échecs de lookup.
create or replace function public.normalize_invitation_email()
returns trigger language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

drop trigger if exists onboarding_invitations_normalize on public.onboarding_invitations;
create trigger onboarding_invitations_normalize
  before insert or update on public.onboarding_invitations
  for each row execute function public.normalize_invitation_email();

-- RLS : ADMIN uniquement. L'anon (page d'enrôlement) n'a AUCUNE policy -> ne
-- peut ni lire ni écrire la table via l'API. L'Edge Function (service_role)
-- contourne la RLS et fait le contrôle elle-même.
alter table public.onboarding_invitations enable row level security;

create policy onboarding_invitations_admin_all
  on public.onboarding_invitations
  for all
  to authenticated
  using      (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
