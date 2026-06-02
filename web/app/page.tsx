import Link from 'next/link';
import { getSupabase, type BookRow } from '@/lib/supabase';

// Read at request time (not build) so no DB/env is needed to compile.
export const dynamic = 'force-dynamic';

type BookWithCount = BookRow & { pageCount: number };

async function loadLibrary(): Promise<{ books: BookWithCount[]; error: string | null }> {
  const supabase = getSupabase();
  const { data: books, error } = await supabase
    .from('books')
    .select('id, title, type, created_at')
    .order('created_at', { ascending: false });

  if (error) return { books: [], error: error.message };

  const withCounts = await Promise.all(
    (books ?? []).map(async (b) => {
      const { count } = await supabase
        .from('pages')
        .select('page_number', { count: 'exact', head: true })
        .eq('book_id', b.id);
      return { ...(b as BookRow), pageCount: count ?? 0 };
    }),
  );
  return { books: withCounts, error: null };
}

export default async function LibraryPage() {
  let result: { books: BookWithCount[]; error: string | null };
  try {
    result = await loadLibrary();
  } catch (e) {
    result = { books: [], error: e instanceof Error ? e.message : String(e) };
  }
  const { books, error } = result;

  return (
    <main className="library">
      <h1>Living Reader</h1>
      <p className="sub">Pick a book.</p>

      {error ? (
        <div className="notice">
          Couldn&apos;t load books: {error}
          <br />
          Check <code>web/.env.local</code> and that the read-policy migration has been applied.
        </div>
      ) : books.length === 0 ? (
        <div className="empty">
          No books yet. Ingest one with{' '}
          <code>node scripts/ingest-novel.mjs &lt;file.txt&gt;</code>, then run the summarize /
          image / audio workers.
        </div>
      ) : (
        <div className="book-grid">
          {books.map((b) => (
            <Link key={b.id} href={`/read/${b.id}`} className="book-card">
              <div className="title">
                {b.title}
                <span className="badge">{b.type}</span>
              </div>
              <div className="meta">{b.pageCount} pages</div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
