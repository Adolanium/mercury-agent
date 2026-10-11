import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { logger } from './logger.js';

/**
 * Event-loop stall monitor. Typing lag in the TUI and late Telegram replies
 * are almost always the main thread being held by synchronous work; this
 * makes that measurable (/api/health, doctor) instead of a feeling.
 */
let histogram: IntervalHistogram | null = null;
let last = { p99Ms: 0, maxMs: 0, at: 0 };
let timer: NodeJS.Timeout | null = null;

export const LOOP_STALL_WARN_MS = 250;

export function startLoopLagMonitor(windowMs = 10_000): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  timer = setInterval(() => {
    if (!histogram) return;
    const p99Ms = histogram.percentile(99) / 1e6;
    const maxMs = histogram.max / 1e6;
    last = { p99Ms, maxMs, at: Date.now() };
    if (maxMs >= LOOP_STALL_WARN_MS) {
      logger.warn({ maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms) }, 'Event loop stalled — something synchronous held the main thread');
    }
    histogram.reset();
  }, windowMs);
  timer.unref();
}

export function stopLoopLagMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
}

/** Last window's event-loop delay: p99 and worst stall, in ms. */
export function getLoopLag(): { p99Ms: number; maxMs: number; at: number } {
  return { ...last };
}
