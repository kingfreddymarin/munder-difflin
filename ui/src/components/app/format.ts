export function clock(iso: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function day(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function stamp(iso: string) {
  if (!iso) return '—';
  return `${day(iso)} · ${clock(iso)}`;
}
export const tokens = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
