import Link from 'next/link';
import { getSupabase, type PageRow } from '@/lib/supabase';
import Reader from '@/components/Reader';

export const dynamic = 'force-dynamic';

type BookInfo = { id: string; title: string; type: string };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="library">
      <p className="sub">
        <Link href="/" className="back">
          ← Library
        </Link>
      </p>
      <div className="notice">{children}</div>
    </main>
  );
}

export default async function ReadPage({ params }: { params: { bookId: string } }) {
  let book: BookInfo | null = null;
  let pages: PageRow[] = [];
  let loadError: string | null = null;

  try {
    const supabase = getSupabase();
    const { data: bookData, error: bookErr } = await supabase
      .from('books')
      .select('id, title, type')
      .eq('id', params.bookId)
      .maybeSingle();
    if (bookErr) throw new Error(bookErr.message);
    book = (bookData as BookInfo) ?? null;

    if (book) {
      const { data: pageData, error: pageErr } = await supabase
        .from('pages')
        .select('page_number, image_url, audio_url, summary_text')
        .eq('book_id', params.bookId)
        .order('page_number', { ascending: true });
      if (pageErr) throw new Error(pageErr.message);
      pages = (pageData ?? []) as PageRow[];
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  if (loadError) {
    return (
      <Shell>
        Couldn&apos;t load this book: {loadError}
        <br />
        Check <code>web/.env.local</code> and that the read-policy migration has been applied.
      </Shell>
    );
  }

  if (!book) {
    return <Shell>Book not found.</Shell>;
  }

  // Keep only pages that have something to show/play.
  const usable = pages.filter((p) => p.image_url || p.summary_text || p.audio_url);

  if (usable.length === 0) {
    return (
      <Shell>
        “{book.title}” has no generated pages yet. Run the summarize / image / audio workers first.
      </Shell>
    );
  }

  return <Reader title={book.title} pages={usable} />;
}
