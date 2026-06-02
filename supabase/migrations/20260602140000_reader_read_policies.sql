-- Module 6: public read access for the reader frontend (plan.md §5).
--
-- The frontend uses the Supabase ANON key. Once RLS is enabled, a table with no
-- matching policy returns ZERO rows to anon — the #1 thing that silently breaks
-- the reader. These policies grant read-only SELECT to anon (and authenticated).
--
-- The batch workers (modules 2-5) use the SERVICE_ROLE key, which BYPASSES RLS,
-- so they are unaffected by this change. Storage buckets are already public, so
-- images/audio load without separate object policies.

alter table books enable row level security;
alter table pages enable row level security;
alter table page_lines enable row level security;

drop policy if exists "Public read books" on books;
create policy "Public read books"
  on books for select
  to anon, authenticated
  using (true);

drop policy if exists "Public read pages" on pages;
create policy "Public read pages"
  on pages for select
  to anon, authenticated
  using (true);

-- Not read by the module 6 reader yet (manga, module 7), but kept consistent so
-- the future manga reader works and the table isn't left without a policy.
drop policy if exists "Public read page_lines" on page_lines;
create policy "Public read page_lines"
  on page_lines for select
  to anon, authenticated
  using (true);
