import React, { useEffect, useState, type RefObject } from 'react';

interface Progress {
  ratio: number;
  minutesLeft: number;
  started: boolean;
  activeId: string | null;
}

/**
 * Tracks how far the reader is through `target` (the article body): a 0-1
 * ratio, an estimate of minutes left based on the post's reading time, and
 * the heading currently in view for the table of contents.
 */
export function useReadingProgress(target: RefObject<HTMLElement | null>, totalMinutes: number): Progress {
  const [state, setState] = useState<Progress>({ ratio: 0, minutesLeft: totalMinutes, started: false, activeId: null });

  useEffect(() => {
    const el = target.current;
    if (!el) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const span = rect.height - window.innerHeight * 0.6;
      const ratio = span <= 0 ? 1 : Math.min(1, Math.max(0, -rect.top / span));
      const headings = el.querySelectorAll<HTMLElement>('h2[id], h3[id]');
      let activeId: string | null = null;
      for (const hd of headings) {
        if (hd.getBoundingClientRect().top < 140) activeId = hd.id;
        else break;
      }
      setState({
        ratio,
        minutesLeft: Math.max(0, Math.ceil(totalMinutes * (1 - ratio))),
        started: rect.top < 0,
        activeId,
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [target, totalMinutes]);

  return state;
}

export function leftLabel(p: Progress): string {
  if (p.ratio >= 0.995) return 'Finished';
  if (p.minutesLeft <= 1) return 'Under a minute left';
  return `${p.minutesLeft} min left`;
}

/** Thin bar pinned to the top of the viewport, plus a mobile pill. */
export function ProgressBar({ progress }: { progress: Progress }): React.ReactElement {
  const pct = Math.round(progress.ratio * 100);
  return (
    <>
      <div
        className="mj-progress"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ transform: `scaleX(${progress.ratio})` }} />
      </div>
      <button
        type="button"
        className={`mj-progress-pill${progress.started ? ' is-on' : ''}`}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label={`${leftLabel(progress)}. Back to top`}
        tabIndex={progress.started ? 0 : -1}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="10" cy="10" r="8" className="mj-ring-bg" />
          <circle cx="10" cy="10" r="8" className="mj-ring" style={{ strokeDashoffset: 50.27 * (1 - progress.ratio) }} />
        </svg>
        <span>{leftLabel(progress)}</span>
      </button>
    </>
  );
}
