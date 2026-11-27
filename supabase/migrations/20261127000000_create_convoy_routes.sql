create table public.convoy_routes (
  convoy_id uuid primary key references public.convoys(id) on delete cascade,
  destination_lat double precision not null check (destination_lat between -90 and 90),
  destination_lng double precision not null check (destination_lng between -180 and 180),
  route jsonb not null check (jsonb_typeof(route) = 'object'),
  shared_by uuid not null references auth.users(id) on delete cascade
);

alter table public.convoy_routes enable row level security;

create policy "Convoy members can read shared routes"
on public.convoy_routes for select to authenticated
using (public.is_convoy_member(convoy_id));

-- Compare against the actual convoy leader, not a role the client supplied.
create policy "Convoy leader can insert shared routes"
on public.convoy_routes for insert to authenticated
with check (shared_by = (select auth.uid()) and exists (
  select 1 from public.convoys c
  where c.id = convoy_id and c.leader_id = (select auth.uid())
    and c.destination_lat = convoy_routes.destination_lat
    and c.destination_lng = convoy_routes.destination_lng
));

create policy "Convoy leader can update shared routes"
on public.convoy_routes for update to authenticated
using (exists (
  select 1 from public.convoys c
  where c.id = convoy_id and c.leader_id = (select auth.uid())
))
with check (shared_by = (select auth.uid()) and exists (
  select 1 from public.convoys c
  where c.id = convoy_id and c.leader_id = (select auth.uid())
    and c.destination_lat = convoy_routes.destination_lat
    and c.destination_lng = convoy_routes.destination_lng
));

-- Joining by code requires reading convoy metadata; keep route geometry separate.
revoke all on public.convoy_routes from anon, authenticated;
grant select, insert, update on public.convoy_routes to authenticated;
alter publication supabase_realtime add table public.convoy_routes;

create function public.clear_convoy_route_on_destination_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.convoy_routes where convoy_id = new.id;
  return new;
end;
$$;

revoke execute on function public.clear_convoy_route_on_destination_change() from public;

create trigger clear_convoy_route_on_destination_change
after update of destination_lat, destination_lng on public.convoys
for each row when (old.destination_lat is distinct from new.destination_lat
                or old.destination_lng is distinct from new.destination_lng)
execute function public.clear_convoy_route_on_destination_change();
