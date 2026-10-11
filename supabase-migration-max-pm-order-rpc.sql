-- Run once in Supabase SQL Editor so checkout can pick the next order number without exposing full orders to anonymous users.
-- Re-run after instore pickup ids (PMINS-*) so delivery (PM-*) and pickup share one number series.
-- Fixes: duplicate key value violates unique constraint "orders_pkey" when ordering from a phone (anon cannot read orders table).

create or replace function public.max_pm_order_number()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    max((regexp_match(id, '^PM(INS)?-([0-9]+)$', 'i'))[2]::integer),
    3189
  )
  from public.orders;
$$;

grant execute on function public.max_pm_order_number() to anon, authenticated, service_role;
