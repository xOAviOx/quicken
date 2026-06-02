#!/usr/bin/env node
/**
 * Module 2 — Novel ingest + chunker (plan.md §3 step 1, §6 item 2).
 *
 * Takes a plain-text Project Gutenberg novel and populates Supabase:
 *   - inserts one `books` row (type='novel')
 *   - splits the text into ~300-word "pages" and inserts one `pages` row each,
 *     with page_number (1-based) and raw_text filled (image/audio/summary left null)
 *   - sets books.status = 'ingested' when done
 *
 * Usage:
 *   node scripts/ingest-novel.mjs <path-to.txt> [--title "Custom Title"] [--force]
 *
 * Env (.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (service role — backend only, never the browser)
 *
 * This module does NOT do summaries, images, TTS, or any frontend. Those are
 * later modules.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';

// --- Chunking knobs (words) ----------------------------------------------------
const TARGET_WORDS = 300; // aim per page
const FLUSH_WORDS = 350; // adding a paragraph past this flushes the current page
const MAX_PARAGRAPH_WORDS = 400; // a single paragraph above this is split on sentences
const INSERT_BATCH = 500; // rows per pages insert call

// --- Gutenberg boundary markers ------------------------------------------------
// Real files embed the title between "EBOOK" and "***", so match loosely.
const GUTENBERG_START = /^\*\*\* *START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*.*$/im;
const GUTENBERG_END = /^\*\*\* *END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*.*$/im;

// Only run when executed directly (so the pure helpers below can be imported/tested).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  const { filePath, title: titleArg, force } = parseCli();

  const { url, serviceKey } = readEnv();
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Read + clean
  const rawFile = await readFile(filePath, 'utf8');
  const title = titleArg?.trim() || titleFromFilename(filePath);
  const body = stripGutenberg(rawFile);

  // 2. Chunk into pages
  const pages = chunkIntoPages(body);
  if (pages.length === 0) {
    throw new Error('No readable text found after cleanup — nothing to ingest.');
  }
  console.log(`Parsed "${title}" → ${pages.length} page(s) (~${TARGET_WORDS} words each).`);

  // 3. Idempotency: handle an existing book with the same title
  await handleExisting(supabase, title, force);

  // 4. Insert the book row (mark in-progress until pages land)
  const { data: book, error: bookErr } = await supabase
    .from('books')
    .insert({
      type: 'novel',
      title,
      source: basename(filePath),
      status: 'ingesting',
    })
    .select('id')
    .single();
  if (bookErr) throw new Error(`Failed to insert book: ${bookErr.message}`);

  // 5. Insert pages (batched), then mark the book ingested
  try {
    await insertPages(supabase, book.id, pages);
    const { error: updErr } = await supabase
      .from('books')
      .update({ status: 'ingested' })
      .eq('id', book.id);
    if (updErr) throw new Error(`Pages inserted but status update failed: ${updErr.message}`);
  } catch (err) {
    // Best-effort: flag the half-ingested book so it isn't mistaken for done.
    await supabase.from('books').update({ status: 'failed' }).eq('id', book.id);
    throw err;
  }

  // 6. Report
  console.log('\n✓ Ingest complete');
  console.log(`  book id     : ${book.id}`);
  console.log(`  title       : ${title}`);
  console.log(`  total pages : ${pages.length}`);
}

// ------------------------------------------------------------------------------
// CLI + env
// ------------------------------------------------------------------------------

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        title: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    throw new Error(`${err.message}\n${usage()}`);
  }

  const filePath = parsed.positionals[0];
  if (!filePath) throw new Error(`Missing input file.\n${usage()}`);
  if (extname(filePath).toLowerCase() !== '.txt') {
    console.warn(`⚠ "${filePath}" is not a .txt file — continuing anyway.`);
  }
  return { filePath, title: parsed.values.title, force: parsed.values.force };
}

function usage() {
  return 'Usage: node scripts/ingest-novel.mjs <path-to.txt> [--title "Custom Title"] [--force]';
}

function readEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. ' +
        'Copy .env.example to .env and fill them in.',
    );
  }
  return { url, serviceKey };
}

function titleFromFilename(filePath) {
  return basename(filePath, extname(filePath))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------------------
// Cleanup
// ------------------------------------------------------------------------------

/** Strip the Gutenberg license header/footer. Warn + keep full text if absent. */
export function stripGutenberg(text) {
  const startMatch = text.match(GUTENBERG_START);
  const endMatch = text.match(GUTENBERG_END);

  if (!startMatch) console.warn('⚠ Gutenberg START marker not found — using text from the top.');
  if (!endMatch) console.warn('⚠ Gutenberg END marker not found — using text to the bottom.');

  const start = startMatch ? startMatch.index + startMatch[0].length : 0;
  const end = endMatch ? endMatch.index : text.length;
  return text.slice(start, end);
}

/**
 * Split into paragraphs. Normalizes line endings, treats blank lines as
 * paragraph separators, joins hard-wrapped lines within a paragraph, and
 * collapses runs of whitespace. Returns an array of clean paragraph strings.
 */
function toParagraphs(text) {
  return text
    .replace(/^﻿/, '') // strip BOM
    .replace(/\r\n?/g, '\n') // normalize newlines
    .split(/\n[ \t]*\n+/) // blank line(s) separate paragraphs
    .map((p) => p.replace(/\s+/g, ' ').trim()) // collapse internal whitespace
    .filter(Boolean);
}

// ------------------------------------------------------------------------------
// Chunking
// ------------------------------------------------------------------------------

/**
 * Greedy, paragraph-first chunker.
 *   - accumulate whole paragraphs until adding the next would exceed FLUSH_WORDS
 *   - a paragraph longer than MAX_PARAGRAPH_WORDS is split on sentence boundaries
 *   - raw_text keeps paragraph breaks as blank lines ("\n\n")
 * Returns an array of raw_text strings (one per page), in order.
 */
export function chunkIntoPages(text) {
  const paragraphs = toParagraphs(text);
  const pages = [];
  let current = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length) {
      pages.push(current.join('\n\n'));
      current = [];
      currentWords = 0;
    }
  };

  for (const para of paragraphs) {
    const pw = wordCount(para);

    // Oversized paragraph: flush, then pack its sentences into pages.
    if (pw > MAX_PARAGRAPH_WORDS) {
      flush();
      const sentences = splitSentences(para);
      let sub = [];
      let subWords = 0;
      for (const s of sentences) {
        const sw = wordCount(s);
        if (subWords > 0 && subWords + sw > FLUSH_WORDS) {
          pages.push(sub.join(' '));
          sub = [];
          subWords = 0;
        }
        sub.push(s);
        subWords += sw;
      }
      // Keep the remainder open so it can merge with following paragraphs.
      if (sub.length) {
        current = [sub.join(' ')];
        currentWords = subWords;
      }
      continue;
    }

    // Normal paragraph: flush first if it would push us over the limit.
    if (currentWords > 0 && currentWords + pw > FLUSH_WORDS) flush();
    current.push(para);
    currentWords += pw;
  }
  flush();

  return pages;
}

export function wordCount(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Naive but reliable sentence splitter: breaks after . ! ? (plus closing quotes). */
function splitSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+["'”’)\]]*(?=\s|$)|[^.!?]+$/g);
  return matches ? matches.map((s) => s.trim()).filter(Boolean) : [text.trim()];
}

// ------------------------------------------------------------------------------
// Supabase
// ------------------------------------------------------------------------------

/** Prompt (or --force) to wipe an existing same-title book before re-ingesting. */
async function handleExisting(supabase, title, force) {
  const { data: existing, error } = await supabase
    .from('books')
    .select('id')
    .eq('title', title);
  if (error) throw new Error(`Failed to check for existing book: ${error.message}`);
  if (!existing || existing.length === 0) return;

  const label = existing.length === 1 ? 'A book' : `${existing.length} books`;
  if (!force) {
    const ok = await confirm(
      `${label} titled "${title}" already exist(s). Wipe and re-ingest? [y/N] `,
    );
    if (!ok) {
      console.log('Aborted — existing book left untouched.');
      process.exit(0);
    }
  }

  const { error: delErr } = await supabase.from('books').delete().eq('title', title);
  if (delErr) throw new Error(`Failed to wipe existing book(s): ${delErr.message}`);
  console.log(`Removed ${existing.length} existing "${title}" book(s) (pages cascade-deleted).`);
}

/** Insert page rows in batches. raw_text only; image/audio/summary stay null. */
async function insertPages(supabase, bookId, pages) {
  const rows = pages.map((raw_text, i) => ({
    book_id: bookId,
    page_number: i + 1,
    raw_text,
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const { error } = await supabase.from('pages').insert(batch);
    if (error) {
      throw new Error(`Failed to insert pages ${i + 1}-${i + batch.length}: ${error.message}`);
    }
  }
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
