'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
// react-pageflip touches the DOM, so it's only rendered after mount (client-only).
// Imported directly (not via next/dynamic) so the ref — and thus pageFlip() — works.
import HTMLFlipBook from 'react-pageflip';
import { gsap } from 'gsap';
import type { PageRow } from '@/lib/supabase';

// Loosen the prop types of the third-party component to avoid TS friction.
const FlipBook = HTMLFlipBook as unknown as React.ForwardRefExoticComponent<any>;

export default function Reader({ title, pages }: { title: string; pages: PageRow[] }) {
  const bookRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  const [mounted, setMounted] = useState(false);
  const [started, setStarted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);

  // Refs mirror state so imperative handlers/effects never read stale values.
  const startedRef = useRef(false);
  const mutedRef = useRef(false);
  const autoAdvanceRef = useRef(true);
  useEffect(() => {
    mutedRef.current = muted;
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);
  useEffect(() => {
    autoAdvanceRef.current = autoAdvance;
  }, [autoAdvance]);

  useEffect(() => setMounted(true), []);

  const total = pages.length;

  // --- audio ----------------------------------------------------------------
  const playPage = useCallback(
    (i: number) => {
      const audio = audioRef.current;
      const page = pages[i];
      if (!audio) return;
      if (!page?.audio_url) {
        audio.pause();
        setIsPlaying(false);
        return;
      }
      audio.src = page.audio_url;
      audio.muted = mutedRef.current;
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false)); // blocked until a user gesture
    },
    [pages],
  );

  // Play whenever the page changes (after the Begin gate has unlocked audio).
  useEffect(() => {
    if (!startedRef.current) return;
    playPage(current);
  }, [current, playPage]);

  // Preload the NEXT page's image + audio so the upcoming flip feels instant.
  useEffect(() => {
    const next = pages[current + 1];
    if (!next) return;
    if (next.image_url) {
      const img = new window.Image();
      img.src = next.image_url;
    }
    if (next.audio_url) {
      const a = new window.Audio();
      a.preload = 'auto';
      a.src = next.audio_url;
    }
  }, [current, pages]);

  // --- navigation -----------------------------------------------------------
  const goNext = useCallback(() => bookRef.current?.pageFlip()?.flipNext(), []);
  const goPrev = useCallback(() => bookRef.current?.pageFlip()?.flipPrev(), []);

  const onFlip = useCallback((e: { data: number }) => {
    setCurrent(e.data);
  }, []);

  const onEnded = useCallback(() => {
    setIsPlaying(false);
    if (autoAdvanceRef.current) goNext(); // the "alive" auto-advance
  }, [goNext]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (!audio.src) playPage(current);
      else audio.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, [current, playPage]);

  // --- begin gate (unlocks autoplay within a user gesture) ------------------
  const handleBegin = useCallback(() => {
    startedRef.current = true;
    setStarted(true);
    playPage(current); // called synchronously inside the click -> autoplay allowed
  }, [current, playPage]);

  // --- light GSAP polish ----------------------------------------------------
  useEffect(() => {
    if (mounted && controlsRef.current) {
      gsap.from(controlsRef.current, { y: 16, opacity: 0, duration: 0.4, ease: 'power2.out' });
    }
  }, [mounted]);

  return (
    <div className="reader">
      <div className="reader-top">
        <Link href="/" className="back">
          ← Library
        </Link>
        <span className="book-title">{title}</span>
      </div>

      <div className="stage">
        {mounted && (
          <FlipBook
            ref={bookRef}
            width={550}
            height={733}
            size="stretch"
            minWidth={300}
            maxWidth={760}
            minHeight={400}
            maxHeight={1013}
            maxShadowOpacity={0.5}
            showCover={false}
            usePortrait
            mobileScrollSupport
            flippingTime={700}
            className="flipbook"
            onFlip={onFlip}
          >
            {pages.map((p) => (
              <div className="page" key={p.page_number}>
                <div className="page-inner">
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="page-img" src={p.image_url} alt={`Page ${p.page_number}`} />
                  ) : (
                    <div className="page-noimg">No image</div>
                  )}
                  {p.summary_text && <div className="page-caption">{p.summary_text}</div>}
                  <div className="page-num">{p.page_number}</div>
                </div>
              </div>
            ))}
          </FlipBook>
        )}

        {!started && (
          <div className="begin-overlay">
            <p>Audio narration plays as you read.</p>
            <button className="btn primary" onClick={handleBegin}>
              ▶ Begin reading
            </button>
          </div>
        )}
      </div>

      <div className="controls" ref={controlsRef}>
        <button className="btn" onClick={goPrev} aria-label="Previous page">
          ◀ Prev
        </button>
        <button className="btn" onClick={togglePlay} aria-label="Play or pause">
          {isPlaying ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button
          className={`btn ${muted ? 'active' : ''}`}
          onClick={() => setMuted((m) => !m)}
          aria-label="Mute"
        >
          {muted ? '🔇 Muted' : '🔊 Sound'}
        </button>
        <button
          className={`btn ${autoAdvance ? 'active' : ''}`}
          onClick={() => setAutoAdvance((a) => !a)}
          aria-label="Toggle auto-advance"
        >
          ⤳ Auto-advance {autoAdvance ? 'on' : 'off'}
        </button>
        <span className="spacer" />
        <span className="pageinfo">
          Page {current + 1} / {total}
        </span>
        <button className="btn" onClick={goNext} aria-label="Next page">
          Next ▶
        </button>
      </div>

      {/* single audio element drives the whole book */}
      <audio ref={audioRef} onEnded={onEnded} preload="auto" />
    </div>
  );
}
