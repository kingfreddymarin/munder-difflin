// Responsiveness numbers, kept in memory and readable from devtools in the desktop app:
// `__paramountPerf.summary()` gives count / p50 / p95 / max in ms per measure (snapshot fetch, render per
// page, long tasks). Nothing is sent anywhere; the buffer keeps the last 200 samples per measure.
const LIMIT = 200;
const samples = new Map<string, number[]>();

export function record(name: string, ms: number) {
  const list = samples.get(name) ?? [];
  list.push(ms);
  if (list.length > LIMIT) list.shift();
  samples.set(name, list);
}

const pick = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const round = (ms: number) => Math.round(ms * 10) / 10;

export function summary() {
  return Object.fromEntries([...samples].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return [name, { count: list.length, p50: round(pick(sorted, 0.5)), p95: round(pick(sorted, 0.95)), max: round(sorted[sorted.length - 1]) }];
  }));
}

declare global {
  interface Window { __paramountPerf?: { summary: typeof summary; samples: typeof samples } }
}

if (typeof window !== 'undefined') {
  window.__paramountPerf = { summary, samples };
  // Main-thread blocks over 50 ms are what the human feels as jank; Chromium reports them as long tasks.
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => record('longtask', entry.duration)))
      .observe({ type: 'longtask', buffered: true });
  } catch {
    /* longtask entries are Chromium-only */
  }
}
