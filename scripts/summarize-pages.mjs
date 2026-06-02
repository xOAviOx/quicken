#!/usr/bin/env node
/**
 * Module 3 — Summarize + image-prompt worker (plan.md §3 steps 2-3, §6 item 3).
 *
 * For one book, fills `summary_text` and `image_prompt` on every page using
 * Gemini. One structured-JSON call per page (to save quota) returns:
 *   { "summary": "...", "image_prompt": "..." }
 * A fixed STYLE SUFFIX is appended to every image_prompt so the whole book looks
 * visually consistent.
 *
 * Only pages where summary_text IS NULL are processed, so an interrupted run
 * (e.g. a rate-limit stop) resumes cleanly on a plain re-run.
 *
 * Usage:
 *   node scripts/summarize-pages.mjs --book-id <uuid> [--style "..."]
 *                                    [--model gemini-3.5-flash] [--delay-ms 6000]
 *                                    [--limit N]
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
 *
 * This module does NOT generate images, audio, or any frontend — later modules.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// --- Config -------------------------------------------------------------------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const DEFAULT_STYLE = 'cinematic digital painting, muted palette, soft light';
const DEFAULT_DELAY_MS = 6000; // ~10 req/min — under typical free-tier RPM. Tune with --delay-ms.

const PARSE_RETRIES = 1; // retry once on unparseable JSON, then skip the page
const MAX_HTTP_RETRIES = 6; // 429/503 backoff attempts before giving up on a page
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    image_prompt: { type: 'string' },
  },
  required: ['summary', 'image_prompt'],
  propertyOrdering: ['summary', 'image_prompt'],
};

// Only run when executed directly (so pure helpers can be imported/tested).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  const { bookId, style, model, delayMs, limit } = parseCli();
  const { supabaseUrl, serviceKey, geminiKey } = readEnv();

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Confirm the model is valid for this API key before doing any work.
  process.stdout.write(`Validating Gemini model "${model}"... `);
  await preflightModel(geminiKey, model);
  console.log('ok');

  // 2. Confirm the book exists.
  const book = await fetchBook(supabase, bookId);
  console.log(`Book: "${book.title}" (${book.type})  id=${book.id}`);

  // 3. Pull pages still needing a summary (resume-friendly).
  const pages = await fetchPendingPages(supabase, bookId, limit);
  if (pages.length === 0) {
    console.log('No pages with null summary_text — nothing to do.');
    return;
  }
  console.log(`Pages to process : ${pages.length}`);
  console.log(`Style suffix     : "${style}"`);
  console.log(`Throttle         : ${delayMs}ms between calls\n`);

  // 4. Process each page.
  let processed = 0;
  let skipped = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const tag = `[${i + 1}/${pages.length}] page ${page.page_number}`;

    if (!page.raw_text || !page.raw_text.trim()) {
      console.log(`${tag} — skipped (empty raw_text)`);
      skipped++;
    } else {
      try {
        const fields = await generatePageFields(geminiKey, model, page.raw_text);
        if (!fields) {
          console.log(`${tag} — skipped (unparseable JSON after retry)`);
          skipped++;
        } else {
          const image_prompt = applyStyleSuffix(fields.image_prompt, style);
          const { error } = await supabase
            .from('pages')
            .update({ summary_text: fields.summary, image_prompt })
            .eq('id', page.id);
          if (error) throw new Error(`DB update failed: ${error.message}`);
          console.log(`${tag} — ok`);
          processed++;
        }
      } catch (err) {
        if (err.fatal) throw err; // auth/permission problem — abort the whole run
        console.log(`${tag} — skipped (${err.message})`);
        skipped++;
      }
    }

    if (i < pages.length - 1) await sleep(delayMs); // throttle between calls
  }

  // 5. Report.
  const remaining = await countPendingPages(supabase, bookId);
  console.log('\n=== Done ===');
  console.log(`processed      : ${processed}`);
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
        style: { type: 'string' },
        model: { type: 'string' },
        'delay-ms': { type: 'string' },
        limit: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new Error(`${err.message}\n${usage()}`);
  }

  const bookId = values['book-id'];
  if (!bookId) throw new Error(`Missing --book-id.\n${usage()}`);

  const delayMs = Number(values['delay-ms'] ?? DEFAULT_DELAY_MS);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('--delay-ms must be a non-negative number.');

  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer.');
  }

  return {
    bookId,
    style: (values.style ?? DEFAULT_STYLE).trim(),
    model: (values.model ?? DEFAULT_MODEL).trim(),
    delayMs,
    limit,
  };
}

function usage() {
  return 'Usage: node scripts/summarize-pages.mjs --book-id <uuid> [--style "..."] [--model NAME] [--delay-ms N] [--limit N]';
}

function readEnv() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
    !geminiKey && 'GEMINI_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }
  return { supabaseUrl, serviceKey, geminiKey };
}

// ------------------------------------------------------------------------------
// Gemini
// ------------------------------------------------------------------------------

/** Confirm the chosen model exists and supports generateContent for this key. */
async function preflightModel(apiKey, model) {
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Could not list Gemini models (HTTP ${res.status}). Check GEMINI_API_KEY. ${body.slice(0, 200)}`);
  }
  const { models = [] } = await res.json();
  const wanted = models.find((m) => m.name === `models/${model}`);
  if (wanted && (wanted.supportedGenerationMethods ?? []).includes('generateContent')) return;

  const flash = models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent') && /flash/i.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''));
  throw new Error(
    `Model "${model}" isn't available for generateContent on this key.\n` +
      `Available Flash models: ${flash.join(', ') || '(none found)'}\n` +
      `Re-run with --model <name>.`,
  );
}

/** One page -> {summary, image_prompt}, or null if JSON couldn't be parsed. */
async function generatePageFields(apiKey, model, rawText) {
  const prompt = buildPrompt(rawText);
  for (let attempt = 0; attempt <= PARSE_RETRIES; attempt++) {
    const text = await callGemini(apiKey, model, prompt);
    const obj = extractJson(text);
    if (
      obj &&
      typeof obj.summary === 'string' && obj.summary.trim() &&
      typeof obj.image_prompt === 'string' && obj.image_prompt.trim()
    ) {
      return { summary: obj.summary.trim(), image_prompt: obj.image_prompt.trim() };
    }
  }
  return null;
}

/** Single generateContent REST call with backoff on 429/500/503. Returns the text part. */
async function callGemini(apiKey, model, prompt) {
  const url = `${GEMINI_BASE}/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  let backoff = BASE_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      return (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text)
        .filter(Boolean)
        .join('');
    }

    const retryable = res.status === 429 || res.status === 500 || res.status === 503;
    if (retryable && attempt < MAX_HTTP_RETRIES) {
      const headerWait = retryAfterMs(res);
      const wait = headerWait ?? Math.min(backoff, MAX_BACKOFF_MS);
      console.log(`    HTTP ${res.status} — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${MAX_HTTP_RETRIES})`);
      await sleep(wait);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }

    const errBody = await res.text().catch(() => '');
    const err = new Error(`Gemini API ${res.status}: ${errBody.slice(0, 200)}`);
    err.fatal = res.status === 401 || res.status === 403; // auth/permission -> abort run
    throw err;
  }
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

function buildPrompt(rawText) {
  return [
    'You are processing ONE page of a public-domain novel for an illustrated reading app.',
    'Read the page text below and reply with JSON containing exactly two fields:',
    '- "summary": 2-3 sentences capturing the key action and mood of THIS page.',
    '- "image_prompt": a vivid, concrete description of a single scene from this page',
    '  for a text-to-image generator. Describe setting, characters, action, lighting and',
    '  mood. Do NOT mention art style, medium, or quality keywords — those are added separately.',
    '',
    'Page text:',
    '"""',
    rawText,
    '"""',
  ].join('\n');
}

// ------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ------------------------------------------------------------------------------

/** Parse JSON from model output, tolerating code fences / surrounding prose. */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to brace extraction
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return null;
}

/** Append the locked style suffix, normalizing separators so it reads cleanly. */
export function applyStyleSuffix(prompt, style) {
  const p = prompt.trim().replace(/[\s.]+$/, '');
  const s = (style ?? '').trim().replace(/^[,\s]+/, '');
  return s ? `${p}, ${s}` : p;
}

// ------------------------------------------------------------------------------
// Supabase
// ------------------------------------------------------------------------------

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

/** Pages still missing a summary, oldest page first. (Supabase caps at ~1000 rows;
 *  the null-summary filter means a re-run picks up any overflow.) */
async function fetchPendingPages(supabase, bookId, limit) {
  let query = supabase
    .from('pages')
    .select('id, page_number, raw_text')
    .eq('book_id', bookId)
    .is('summary_text', null)
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
    .is('summary_text', null);
  if (error) throw new Error(`Failed to count remaining pages: ${error.message}`);
  return count ?? 0;
}
