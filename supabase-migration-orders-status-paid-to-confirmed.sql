-- One-time: align legacy “Paid” with canonical “Confirmed”. Run in Supabase → SQL Editor.

update public.orders
set status = 'Confirmed'
where status = 'Paid';
