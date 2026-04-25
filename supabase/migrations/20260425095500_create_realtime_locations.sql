create extension if not exists pgcrypto;

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  latitude double precision not null,
  longitude double precision not null,
  accuracy double precision not null default 0,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.locations replica identity full;

create index if not exists locations_updated_at_idx on public.locations (updated_at desc);
create index if not exists locations_user_id_idx on public.locations (user_id);

alter table public.locations enable row level security;

drop policy if exists "locations_public_select" on public.locations;
create policy "locations_public_select"
on public.locations
for select
using (true);

drop policy if exists "locations_public_insert" on public.locations;
create policy "locations_public_insert"
on public.locations
for insert
with check (true);

drop policy if exists "locations_public_update" on public.locations;
create policy "locations_public_update"
on public.locations
for update
using (true)
with check (true);

alter publication supabase_realtime add table public.locations;
