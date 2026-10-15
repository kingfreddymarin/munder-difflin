// Structural sharing for snapshot refreshes. The core re-sends the whole floor on every change; keeping the
// previous object wherever nothing changed means useFloor selectors return the same reference, so only the
// panels whose data actually changed re-render (and an identical refresh re-renders nothing).
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const own = Object.prototype.hasOwnProperty;

export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, index) => {
      const value = index < prev.length ? share(prev[index], item) : item;
      if (value !== prev[index]) same = false;
      return value;
    });
    return (same ? prev : out) as T;
  }
  if (plain(prev) && plain(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const had = own.call(prev, key);
      const value = had ? share(prev[key], next[key]) : next[key];
      if (!had || value !== prev[key]) same = false;
      out[key] = value;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
