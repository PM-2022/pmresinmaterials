-- Run once in the Supabase SQL Editor.
-- Reviews and Beginner Guide text live here. Photos are uploaded to Cloudflare R2, and only the public URL is stored.

create table if not exists public.store_reviews (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  review_text text not null,
  rating integer not null check (rating between 1 and 5),
  image_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.beginner_guide_blocks (
  id uuid primary key default gen_random_uuid(),
  title text,
  body text not null,
  image_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.store_reviews enable row level security;
alter table public.beginner_guide_blocks enable row level security;

drop policy if exists "store_reviews_public_read" on public.store_reviews;
create policy "store_reviews_public_read" on public.store_reviews
  for select to anon, authenticated using (true);

drop policy if exists "store_reviews_admin_write" on public.store_reviews;
create policy "store_reviews_admin_write" on public.store_reviews
  for all to authenticated using (true) with check (true);

drop policy if exists "beginner_guide_public_read" on public.beginner_guide_blocks;
create policy "beginner_guide_public_read" on public.beginner_guide_blocks
  for select to anon, authenticated using (true);

drop policy if exists "beginner_guide_admin_write" on public.beginner_guide_blocks;
create policy "beginner_guide_admin_write" on public.beginner_guide_blocks
  for all to authenticated using (true) with check (true);
