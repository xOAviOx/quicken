import { createClient } from '@supabase/supabase-js';

/**
 * Browser/server-safe Supabase client using the PUBLIC anon key.
 * Created lazily so `next build` doesn't require env vars (routes are
 * force-dynamic and only fetch at request time).
 */
export function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy web/.env.local.example to web/.env.local and fill them in.',
    );
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Always read the DB fresh — never let Next's data cache serve stale rows
      // (otherwise an early empty fetch gets cached and the reader looks empty
      // even after the workers fill in content).
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
}

export type BookRow = {
  id: string;
  title: string;
  type: 'manga' | 'novel';
  created_at: string;
};

export type PageRow = {
  page_number: number;
  image_url: string | null;
  audio_url: string | null;
  summary_text: string | null;
};
