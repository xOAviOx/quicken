# Living Reader — Build Plan

A web app that turns mangas + novels into "alive" reading experiences:
- **Manga:** book-style page reader + voice narration per page (character voices = the magic).
- **Novel:** per-page AI image + per-page summary + voice reading the summary (not the full text).

Built to run **$0** end-to-end. Designed so you can hand Claude Code one module at a time.

---

## 0. Core principle: PRE-GENERATE, don't generate live

Generating audio/images on each page turn = slow + instantly burns free quotas.

Instead: **Ingest → batch process → store assets → reader plays pre-made assets.**

The reader becomes a dumb-fast viewer of pre-baked content (just like real manga readers serve pre-made page images). All the AI cost happens once, offline, batched.

---

## 1. Stack ($0)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js** + `StPageFlip` / `react-pageflip` | You already know it; flip lib gives the book feel |
| Polish | **GSAP / ScrollTrigger** | Your wheelhouse; for the "alive" transitions |
| TTS | **Kokoro-82M** (`hexgrad/kokoro`) | Apache 2.0, $0, multi-voice, CPU-capable, #1 TTS Arena Jan 2026 |
| Images | **Cloudflare Workers AI** (FLUX.1-schnell, ~10k/day free) or **Pollinations.ai** (no key) | Free, fast, OpenAI-compatible |
| LLM (text + vision) | **Gemini free tier** | One provider for novel summaries AND reading manga dialogue |
| Storage + DB | **Supabase** (already connected) | Storage for audio/images, Postgres for metadata |
| Host | **Vercel** (frontend) + **Supabase** (backend) | Both free tiers |

Self-host Kokoro on a free **Google Colab** notebook (T4 GPU) exposed via a tunnel, or run on CPU for batch jobs where speed doesn't matter.

---

## 2. Data model (Supabase)

```
books        (id, type['manga'|'novel'], title, source, status, created_at)
pages        (id, book_id, page_number, image_url, audio_url, summary_text, raw_text)
page_lines   (id, page_id, order, speaker, line_text, voice_id, audio_url)  -- manga character voices
```

- `image_url` / `audio_url` point at Supabase Storage objects.
- `page_lines` only used for manga v2 (per-character voices). Novels just use `pages`.

---

## 3. Novel pipeline (BUILD THIS FIRST — it's clean)

Per page:

1. **Chunk** the book into "pages" (~250–400 words, or break on paragraph boundaries). Store `raw_text`.
2. **Summarize** → Gemini: "Summarize this page in 2–3 sentences capturing the key action/mood." → `summary_text`.
3. **Image prompt** → Gemini: "Write a vivid image-generation prompt depicting this scene. Style: [pick one consistent style]." Keep a fixed style suffix for visual consistency across the book.
4. **Generate image** → Cloudflare FLUX / Pollinations → upload to Supabase Storage → `image_url`.
5. **TTS** → Kokoro voices `summary_text` → upload → `audio_url`.

Reader shows: image + summary text + play button. Done.

> Tip: keep the image *style* locked per-book (same suffix in every prompt) or the book will look visually incoherent page to page.

---

## 4. Manga pipeline (BUILD SECOND — the hard part)

The challenge: dialogue is baked into the image. You must read it back out + get reading order + (ideally) who's speaking.

**v1 — simple narration**
1. For each page image → Gemini Vision: "Read all text on this page in correct manga reading order (right-to-left, top-to-bottom). Return plain text." → `raw_text`.
2. Kokoro voices it with 1–2 voices → `audio_url`.

**v2 — character voices (the "alive" version)**
1. Gemini Vision: "Return JSON: ordered list of `{speaker, line}` for all dialogue/narration on this page, in reading order." → store in `page_lines`.
2. Map each distinct `speaker` → a Kokoro voice (`voice_id`). Keep the mapping stable across the whole book.
3. TTS each line → stitch into one page audio track (optionally add SFX between lines).

**Known hard bits (set expectations):**
- Reading order on irregular panel layouts is error-prone. Vision LLM > classic OCR here.
- Speaker attribution will sometimes be wrong. Fine for v2; let users see/edit it later if you want.
- `manga-ocr` (kha-white) is the classic tool but Japanese-focused. For English scanlations, Gemini Vision is simpler and better.

---

## 5. The reader frontend

- Spread/single page view with `StPageFlip` flip animation.
- Per-page: lazy-load `image_url` + `audio_url`.
- Auto-play audio on page open (with a mute toggle); auto-advance option when audio ends = the "alive" feel.
- Preload next page's assets while current page plays (no perceived lag since everything's pre-baked).
- GSAP for entrance/transition polish.

---

## 6. How to drive Claude Code

Build in this order, one prompt per module. Don't ask it to build the whole thing at once.

1. **Supabase schema** — give it the data model in §2, have it write migrations.
2. **Novel ingest + chunker** — input a `.txt` (Gutenberg), output `pages` rows with `raw_text`.
3. **Summarize + image-prompt worker** — Gemini calls, fills `summary_text` + image prompt.
4. **Image worker** — Cloudflare/Pollinations call, uploads to Supabase, fills `image_url`.
5. **TTS worker** — Kokoro call, uploads, fills `audio_url`.
6. **Reader frontend** — Next.js + StPageFlip + autoplay, reads from Supabase.
7. **Manga vision worker (v1 then v2)** — last, because it's the hard one.

Each prompt: give Claude Code the schema, the exact input/output contract, and the env vars it can assume. Keep modules single-responsibility so failures are isolated.

---

## 7. Reality checks

- **Copyright:** manga + most novels are copyrighted. Build & demo on **Project Gutenberg** public-domain texts. Personal/portfolio use is fine; shipping a product that rebroadcasts copyrighted books with generated media is a legal minefield.
- **Quota math:** a long novel = hundreds of pages = hundreds of image + TTS calls. Free tiers handle it *if batched over time*. Throttle the workers, don't blast 500 requests at once.
- **Consistency > flash:** locked image style + stable voice mapping is what makes it feel polished rather than random.

---

## 8. First milestone

Get the **whole loop** working on ONE short public-domain novel: ingest → summarize → image → TTS → reader plays it. Once that round-trips, everything else is just scaling and adding the manga path.