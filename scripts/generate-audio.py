#!/usr/bin/env python3
"""
'x
Module 5 - TTS worker (plan.md §3 step 5, §6 item 5). Novels only.

For one book, synthesizes narration audio from each page's `summary_text` using
Kokoro TTS (running locally on CPU), uploads the WAV to a public Supabase Storage
bucket, and writes the public URL into `pages.audio_url`.

Single fixed voice per book (manga character voices are module 7, not this).
Only pages where summary_text IS NOT NULL and audio_url IS NULL are processed,
so an interrupted run resumes cleanly on a plain re-run.

Usage:
    python scripts/generate-audio.py --book-id <uuid>
           [--voice af_heart] [--bucket page-audio] [--limit N]

Env (.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

SETUP:
    pip install -r requirements.txt
    # Kokoro needs espeak-ng installed for English grapheme->phoneme fallback:
    #   Windows : winget install espeak-ng   (or the .msi from the espeak-ng GitHub releases)
    #             If phonemizer can't find it, set PHONEMIZER_ESPEAK_LIBRARY to the
    #             espeak-ng DLL path.
    #   macOS   : brew install espeak-ng
    #   Linux   : sudo apt-get install espeak-ng
    # First run also downloads the Kokoro model + voice from Hugging Face (needs network once).

This module does NOT build the frontend - that's a later module.
"""

import argparse
import glob
import io
import os
import sys

import requests
from dotenv import load_dotenv

SAMPLE_RATE = 24000
LANG_CODE = "a"  # American English
DEFAULT_VOICE = "af_heart"
DEFAULT_BUCKET = "page-audio"

HTTP_TIMEOUT = 60
UPLOAD_TIMEOUT = 180


def main():
    args = parse_args()

    load_dotenv()
    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        die("Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in.")

    db = Supabase(supabase_url.rstrip("/"), service_key)

    # 1. Ensure the public bucket exists (fail fast before loading the model).
    db.ensure_bucket(args.bucket)

    # 2. Confirm the book exists.
    book = db.get_book(args.book_id)
    if not book:
        die(f"No book found with id {args.book_id}.")
    print(f'Book: "{book["title"]}" ({book["type"]})  id={book["id"]}')

    # 3. Pull pages that have a summary but no audio yet (resume-friendly).
    pages = db.pending_pages(args.book_id, args.limit)
    if not pages:
        print("No pages with summary_text awaiting audio - nothing to do.")
        return
    print(f"Voice      : {args.voice}")
    print(f"Bucket     : {args.bucket} (public)")
    print(f"To process : {len(pages)}\n")

    # 4. Load Kokoro once (deferred import so a no-op run stays fast and dep
    #    errors are clear). Kokoro's English G2P falls back to espeak-ng; on
    #    Windows phonemizer can't auto-locate the DLL, so point it there first.
    ensure_espeak_library()
    try:
        import numpy as np
        import soundfile as sf
        # pyrefly: ignore [missing-import]
        from kokoro import KPipeline
    except ImportError as e:
        die(f"Missing Python dependency ({e}). Run: pip install -r requirements.txt  (and install espeak-ng).")

    print("Loading Kokoro model...", end=" ", flush=True)
    pipeline = KPipeline(lang_code=LANG_CODE)
    print("ok\n")

    # 5. Process each page.
    generated = skipped = 0
    total = len(pages)
    for idx, page in enumerate(pages, 1):
        tag = f"[{idx}/{total}] page {page['page_number']}"
        text = (page.get("summary_text") or "").strip()
        if not text:
            print(f"{tag} - skipped (empty summary_text)", flush=True)
            skipped += 1
            continue
        try:
            wav_bytes = synthesize(pipeline, sf, np, text, args.voice)
            if not wav_bytes:
                raise RuntimeError("no audio produced")
            path = f"{args.book_id}/{page['id']}.wav"
            db.upload(args.bucket, path, wav_bytes, "audio/wav")
            db.set_audio_url(page["id"], db.public_url(args.bucket, path))
            print(f"{tag} - ok", flush=True)
            generated += 1
        except Exception as e:  # keep going; resume handles the rest
            print(f"{tag} - skipped ({e})", flush=True)
            skipped += 1

    # 6. Report.
    remaining = db.count_pending(args.book_id)
    print("\n=== Done ===")
    print(f"generated      : {generated}")
    print(f"skipped        : {skipped}")
    print(f"remaining null : {remaining}")
    if remaining:
        print(f"Re-run to resume the remaining {remaining} page(s).")


def synthesize(pipeline, sf, np, text, voice):
    """Kokoro text -> single mono WAV (bytes). Concatenates any split chunks."""
    chunks = []
    for _gs, _ps, audio in pipeline(text, voice=voice, speed=1, split_pattern=r"\n+"):
        arr = _to_numpy(np, audio)
        if arr.size:
            chunks.append(arr)
    if not chunks:
        return None
    audio = chunks[0] if len(chunks) == 1 else np.concatenate(chunks)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _to_numpy(np, audio):
    """Coerce a Kokoro chunk (torch tensor or ndarray) to a 1-D float32 array."""
    if hasattr(audio, "detach"):  # torch tensor
        audio = audio.detach().cpu().numpy()
    return np.asarray(audio, dtype="float32").reshape(-1)


def ensure_espeak_library():
    """Point phonemizer at the espeak-ng shared library if it can't find one.

    On Windows the installer ships libespeak-ng.dll under Program Files but does
    not register it where phonemizer looks, so Kokoro's G2P fallback fails with
    "failed to find espeak library". Respect an explicit env var if already set;
    otherwise probe the usual install locations and export it for this process.
    """
    if os.environ.get("PHONEMIZER_ESPEAK_LIBRARY"):
        return
    if sys.platform == "win32":
        candidates = [
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "eSpeak NG", "libespeak-ng.dll"),
            os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "eSpeak NG", "libespeak-ng.dll"),
        ]
    elif sys.platform == "darwin":
        candidates = glob.glob("/opt/homebrew/lib/libespeak-ng*.dylib") + glob.glob("/usr/local/lib/libespeak-ng*.dylib")
    else:
        candidates = glob.glob("/usr/lib/**/libespeak-ng.so*", recursive=True) + glob.glob("/usr/local/lib/libespeak-ng.so*")
    for path in candidates:
        if path and os.path.exists(path):
            os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = path
            return


# ---------------------------------------------------------------------------
# Supabase via REST (Storage + PostgREST) - no SDK, version-independent.
# ---------------------------------------------------------------------------


class Supabase:
    def __init__(self, url, key):
        self.url = url
        self.auth = {"apikey": key, "Authorization": f"Bearer {key}"}

    # --- storage ---
    def ensure_bucket(self, bucket):
        r = requests.get(f"{self.url}/storage/v1/bucket/{bucket}", headers=self.auth, timeout=HTTP_TIMEOUT)
        if r.status_code == 200:
            if not r.json().get("public", False):
                print(f'⚠ bucket "{bucket}" exists but is NOT public - the frontend won\'t be able to stream audio.')
            return
        # A non-200 here means the bucket doesn't exist yet — note Supabase returns
        # HTTP 400 (body: "Bucket not found"), not 404, so don't trust the status
        # alone. Fall through to create; a genuine auth error surfaces below.
        cr = requests.post(
            f"{self.url}/storage/v1/bucket",
            headers={**self.auth, "Content-Type": "application/json"},
            json={"id": bucket, "name": bucket, "public": True},
            timeout=HTTP_TIMEOUT,
        )
        if cr.status_code not in (200, 201):
            if "already exists" in cr.text.lower():
                return
            raise RuntimeError(f"Failed to create bucket {bucket}: {cr.status_code} {cr.text[:200]}")
        print(f'Created public storage bucket "{bucket}".')

    def upload(self, bucket, path, data, content_type):
        r = requests.post(
            f"{self.url}/storage/v1/object/{bucket}/{path}",
            headers={**self.auth, "Content-Type": content_type, "x-upsert": "true"},
            data=data,
            timeout=UPLOAD_TIMEOUT,
        )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"upload failed: {r.status_code} {r.text[:200]}")

    def public_url(self, bucket, path):
        return f"{self.url}/storage/v1/object/public/{bucket}/{path}"

    # --- database (PostgREST) ---
    def get_book(self, book_id):
        r = requests.get(
            f"{self.url}/rest/v1/books",
            headers=self.auth,
            params={"id": f"eq.{book_id}", "select": "id,title,type"},
            timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def pending_pages(self, book_id, limit):
        # Supabase caps reads ~1000 rows; the audio_url-null filter means a
        # re-run picks up any overflow.
        params = {
            "book_id": f"eq.{book_id}",
            "summary_text": "not.is.null",
            "audio_url": "is.null",
            "select": "id,page_number,summary_text",
            "order": "page_number.asc",
        }
        if limit:
            params["limit"] = str(limit)
        r = requests.get(f"{self.url}/rest/v1/pages", headers=self.auth, params=params, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def set_audio_url(self, page_id, url):
        r = requests.patch(
            f"{self.url}/rest/v1/pages",
            headers={**self.auth, "Content-Type": "application/json", "Prefer": "return=minimal"},
            params={"id": f"eq.{page_id}"},
            json={"audio_url": url},
            timeout=HTTP_TIMEOUT,
        )
        if r.status_code not in (200, 204):
            raise RuntimeError(f"db update failed: {r.status_code} {r.text[:200]}")

    def count_pending(self, book_id):
        r = requests.get(
            f"{self.url}/rest/v1/pages",
            headers={**self.auth, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
            params={
                "book_id": f"eq.{book_id}",
                "summary_text": "not.is.null",
                "audio_url": "is.null",
                "select": "id",
            },
            timeout=HTTP_TIMEOUT,
        )
        return parse_content_range_total(r.headers.get("Content-Range", ""))


def parse_content_range_total(content_range):
    """PostgREST 'Content-Range: 0-0/123' (or '*/0') -> total int."""
    if "/" in content_range:
        total = content_range.rsplit("/", 1)[-1]
        if total.isdigit():
            return int(total)
    return 0


# ---------------------------------------------------------------------------


def parse_args():
    p = argparse.ArgumentParser(description="Kokoro TTS worker for novel page summaries (module 5).")
    p.add_argument("--book-id", required=True, help="books.id to narrate")
    p.add_argument("--voice", default=DEFAULT_VOICE, help=f"Kokoro voice id, fixed across the book (default: {DEFAULT_VOICE})")
    p.add_argument("--bucket", default=DEFAULT_BUCKET, help=f"public storage bucket (default: {DEFAULT_BUCKET})")
    p.add_argument("--limit", type=int, default=None, help="process at most N pages (testing)")
    args = p.parse_args()
    if args.limit is not None and args.limit <= 0:
        p.error("--limit must be a positive integer")
    return args


def die(msg):
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
