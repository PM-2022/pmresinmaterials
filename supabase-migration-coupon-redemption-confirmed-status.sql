-- Coupon redemptions: record when order becomes Confirmed (not only legacy Paid).
-- Run in Supabase → SQL Editor once, if you already applied coupon_redemptions migration.

create or replace function public.trg_orders_coupon_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cc text;
begin
  if tg_op = 'UPDATE'
     and (new.status = 'Confirmed' or new.status = 'Paid')
     and coalesce(old.status, '') is distinct from new.status
  then
    cc := nullif(trim(upper(new.customer->>'coupon_code')), '');
    if cc is not null and cc <> '' then
      insert into public.coupon_redemptions (coupon_code, order_id)
      values (cc, new.id)
      on conflict (order_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;
