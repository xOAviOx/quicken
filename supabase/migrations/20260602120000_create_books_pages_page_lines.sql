-- Module 1: core data model (plan.md §2)
-- Tables: books -> pages -> page_lines (created in dependency order).
--
-- Notes on faithful-but-explicit choices (column lists come straight from §2):
--   * `id` columns use uuid + gen_random_uuid() (Supabase convention).
--   * books.type is constrained to the two §2 values via CHECK.
--   * page_lines."order" is a reserved SQL word, so it is a quoted identifier.
--   * RLS is intentionally NOT configured here — there is no auth model yet.
--     Add policies before exposing these tables through the public API.

-- books (id, type['manga'|'novel'], title, source, status, created_at)
create table books (
  id         uuid primary key default gen_random_uuid(),
  type       text not null check (type in ('manga', 'novel')),
  title      text not null,
  source     text,
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);

-- pages (id, book_id, page_number, image_url, audio_url, summary_text, raw_text)
create table pages (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books (id) on delete cascade,
  page_number  integer not null,
  image_url    text,
  audio_url    text,
  summary_text text,
  raw_text     text,
  unique (book_id, page_number)
);

create index pages_book_id_idx on pages (book_id);

-- page_lines (id, page_id, order, speaker, line_text, voice_id, audio_url)
-- manga character voices; novels only use `pages`.
create table page_lines (
  id        uuid primary key default gen_random_uuid(),
  page_id   uuid not null references pages (id) on delete cascade,
  "order"   integer not null,
  speaker   text,
  line_text text,
  voice_id  text,
  audio_url text,
  unique (page_id, "order")
);

create index page_lines_page_id_idx on page_lines (page_id);
