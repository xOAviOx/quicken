#!/usr/bin/env node
/**
 * Module 4 — Image generation worker (plan.md §3 step 4, §6 item 4).
 *
 * For one book, generates an image per page from `image_prompt`, uploads the
 * bytes to a public Supabase Storage bucket, and writes the public URL into
 * `pages.image_url`.
 *
 * Only pages where image_prompt IS NOT NULL and image_url IS NULL are processed,
 * so an interrupted run resumes cleanly on a plain re-run.
 *
 * Usage:
 *   node scripts/generate-images.mjs --book-id <uuid>
 *        [--provider pollinations|cloudflare] [--width 768] [--height 1024]
 *        [--delay-ms 2000] [--limit N] [--bucket page-images]
 *
 * Env (.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY        (always)
 *   CF_ACCOUNT_ID, CF_API_TOKEN                    (only for --provider cloudflare)
 *
 * This module does NOT do TTS or any frontend — later modules.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// --- Config -------------------------------------------------------------------
const DEFAULT_PROVIDER = 'pollinations';
const PROVIDERS = ['pollinations', 'cloudflare'];
const DEFAULT_BUCKET = 'page-images';
const DEFAULT_WIDTH = 768; // portrait book ratio
const DEFAULT_HEIGHT = 1024;
const DEFAULT_DELAY_MS = 2000;

const MAX_TRIES = 4; // generation attempts per page before skipping
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const FETCH_TIMEOUT_MS = 90000; // image generation can be slow on free providers

// Only run when executed directly (so pure helpers can be imported/tested).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  const opts = parseCli();
  const { supabaseUrl, serviceKey } = readEnv(opts.provider);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (opts.provider === 'cloudflare') {
    console.warn('⚠ Cloudflare provider is an UNTESTED stub — verify before relying on it.');
  }

  // 1. Ensure the public bucket exists.
  await ensureBucket(supabase, opts.bucket);

  // 2. Confirm the book exists.
  const book = await fetchBook(supabase, opts.bookId);
  console.log(`Book: "${book.title}" (${book.type})  id=${book.id}`);

  // 3. Pull pages that have a prompt but no image yet (resume-friendly).
  const pages = await fetchPendingPages(supabase, opts.bookId, opts.limit);
  if (pages.length === 0) {
    console.log('No pages with an image_prompt awaiting an image — nothing to do.');
    return;
  }
  console.log(`Provider   : ${opts.provider}`);
  console.log(`Bucket     : ${opts.bucket} (public)`);
  console.log(`Size       : ${opts.width}x${opts.height}`);
  console.log(`Throttle   : ${opts.delayMs}ms between pages`);
  console.log(`To process : ${pages.length}\n`);

  // 4. Process each page.
  let generated = 0;
  let skipped = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const tag = `[${i + 1}/${pages.length}] page ${page.page_number}`;
    try {
      const seed = deriveSeed(page.id);
      const { bytes, contentType } = await generateWithRetry(opts.provider, page.image_prompt, {
        width: opts.width,
        height: opts.height,
        seed,
      });

      const path = `${opts.bookId}/${page.id}.jpg`;
      const { error: upErr } = await supabase.storage
        .from(opts.bucket)
        .upload(path, bytes, { contentType, upsert: true });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);

      const { data: pub } = supabase.storage.from(opts.bucket).getPublicUrl(path);
      const { error: updErr } = await supabase
        .from('pages')
        .update({ image_url: pub.publicUrl })
        .eq('id', page.id);
      if (updErr) throw new Error(`db update failed: ${updErr.message}`);

      console.log(`${tag} — ok`);
      generated++;
    } catch (err) {
      console.log(`${tag} — skipped (${err.message})`);
      skipped++;
    }

    if (i < pages.length - 1) await sleep(opts.delayMs); // throttle between pages
  }

  // 5. Report.
  const remaining = await countPendingPages(supabase, opts.bookId);
  console.log('\n=== Done ===');
  console.log(`generated      : ${generated}`);
  console.log(`skipped        : ${skipped}`);
  console.log(`remaining null : ${remaining}`);
  if (remaining > 0) console.log(`Re-run to resume the remaining ${remaining} page(s).`);
}

// ------------------------------------------------------------------------------
// CLI + env
// ------------------------------------------------------------------------------

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'book-id': { type: 'string' },
        provider: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        'delay-ms': { type: 'string' },
        limit: { type: 'string' },
        bucket: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new Error(`${err.message}\n${usage()}`);
  }

  const bookId = values['book-id'];
  if (!bookId) throw new Error(`Missing --book-id.\n${usage()}`);

  const provider = (values.provider ?? DEFAULT_PROVIDER).trim();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`--provider must be one of: ${PROVIDERS.join(', ')}`);
  }

  const width = posInt(values.width, DEFAULT_WIDTH, '--width');
  const height = posInt(values.height, DEFAULT_HEIGHT, '--height');
  const delayMs = Number(values['delay-ms'] ?? DEFAULT_DELAY_MS);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('--delay-ms must be a non-negative number.');

  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer.');
  }

  return {
    bookId,
    provider,
    width,
    height,
    delayMs,
    limit,
    bucket: (values.bucket ?? DEFAULT_BUCKET).trim(),
  };
}

function posInt(raw, fallback, label) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer.`);
  return n;
}

function usage() {
  return (
    'Usage: node scripts/generate-images.mjs --book-id <uuid> ' +
    '[--provider pollinations|cloudflare] [--width N] [--height N] [--delay-ms N] [--limit N] [--bucket NAME]'
  );
}

function readEnv(provider) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
    provider === 'cloudflare' && !process.env.CF_ACCOUNT_ID && 'CF_ACCOUNT_ID',
    provider === 'cloudflare' && !process.env.CF_API_TOKEN && 'CF_API_TOKEN',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }
  return { supabaseUrl, serviceKey };
}

// ------------------------------------------------------------------------------
// Image providers
// ------------------------------------------------------------------------------

/** Dispatch to the chosen provider. Returns { bytes: Buffer, contentType }. */
async function generateImage(provider, prompt, opts) {
  if (provider === 'pollinations') return generateViaPollinations(prompt, opts);
  if (provider === 'cloudflare') return generateViaCloudflare(prompt, opts);
  throw new Error(`Unknown provider "${provider}".`);
}

/** Retry wrapper with exponential backoff. */
async function generateWithRetry(provider, prompt, opts) {
  let backoff = BASE_BACKOFF_MS;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      return await generateImage(provider, prompt, opts);
    } catch (err) {
      if (attempt === MAX_TRIES) throw new Error(`gave up after ${MAX_TRIES} tries: ${err.message}`);
      const wait = Math.min(backoff, MAX_BACKOFF_MS);
      console.log(`    attempt ${attempt}/${MAX_TRIES} failed (${err.message}) — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      backoff *= 2;
    }
  }
  throw new Error('unreachable'); // satisfies control-flow analysis
}

/** Pollinations.ai — keyless GET returning image bytes directly. */
async function generateViaPollinations(prompt, { width, height, seed }) {
  const url = buildPollinationsUrl(prompt, { width, height, seed });
  const res = await fetch(url, {
    headers: { accept: 'image/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  const detected = detectImageType(bytes);
  if (!detected) {
    const ct = res.headers.get('content-type') || 'none';
    throw new Error(`non-image response (content-type: ${ct}, ${bytes.length} bytes)`);
  }
  return { bytes, contentType: detected };
}

/**
 * Cloudflare Workers AI — FLUX.1-schnell. UNTESTED STUB.
 * Real shape: POST .../ai/run/@cf/black-forest-labs/flux-1-schnell returns
 * JSON { result: { image: <base64> } }. width/height aren't first-class here.
 */
async function generateViaCloudflare(prompt /*, { width, height, seed } */) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Cloudflare HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  const json = await res.json();
  const b64 = json?.result?.image;
  if (!b64) throw new Error('Cloudflare response had no image data');
  const bytes = Buffer.from(b64, 'base64');
  const detected = detectImageType(bytes);
  if (!detected) throw new Error('Cloudflare returned non-image data');
  return { bytes, contentType: detected };
}

// ------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ------------------------------------------------------------------------------

export function buildPollinationsUrl(prompt, { width, height, seed }) {
  const base = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    nologo: 'true',
  });
  return `${base}?${params.toString()}`;
}

/** Deterministic 32-bit seed from a page UUID (FNV-1a), so re-runs reproduce. */
export function deriveSeed(pageId) {
  let h = 0x811c9dc5;
  for (let i = 0; i < pageId.length; i++) {
    h ^= pageId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sniff image magic bytes; returns a MIME type or null (so we never store error HTML). */
export function detectImageType(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  return null;
}

// ------------------------------------------------------------------------------
// Supabase
// ------------------------------------------------------------------------------

async function ensureBucket(supabase, bucket) {
  const { data } = await supabase.storage.getBucket(bucket);
  if (data) {
    if (!data.public) {
      console.warn(`⚠ bucket "${bucket}" exists but is NOT public — the frontend won't be able to read images.`);
    }
    return;
  }
  const { error } = await supabase.storage.createBucket(bucket, { public: true });
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`Failed to create bucket "${bucket}": ${error.message}`);
  }
  console.log(`Created public storage bucket "${bucket}".`);
}

async function fetchBook(supabase, bookId) {
  const { data, error } = await supabase
    .from('books')
    .select('id, title, type')
    .eq('id', bookId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load book: ${error.message}`);
  if (!data) throw new Error(`No book found with id ${bookId}.`);
  return data;
}

/** Pages with a prompt but no image, oldest first. (Supabase caps ~1000 rows;
 *  the image_url-null filter means a re-run picks up any overflow.) */
async function fetchPendingPages(supabase, bookId, limit) {
  let query = supabase
    .from('pages')
    .select('id, page_number, image_prompt')
    .eq('book_id', bookId)
    .not('image_prompt', 'is', null)
    .is('image_url', null)
    .order('page_number', { ascending: true });
  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load pages: ${error.message}`);
  return data ?? [];
}

async function countPendingPages(supabase, bookId) {
  const { count, error } = await supabase
    .from('pages')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId)
    .not('image_prompt', 'is', null)
    .is('image_url', null);
  if (error) throw new Error(`Failed to count remaining pages: ${error.message}`);
  return count ?? 0;
}
