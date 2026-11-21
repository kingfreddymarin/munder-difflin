// STD-4: the floor's Main Objectives, set by the human on Home and saved by the core
// (home.objectives → preferences.objectives.items). Pure helpers so the provider, reducer
// and editor read and write one shape.
import type { Objective } from './types';

export type ObjectiveHealth = Objective['health'];
/** What home.objectives sends: an Objective without UI-only fields. */
export type ObjectiveInput = Pick<Objective, 'id' | 'title' | 'why' | 'owner' | 'cardKeys' | 'health'>;

const HEALTH: readonly ObjectiveHealth[] = ['on-track', 'at-risk', 'blocked'];
export const MAX_OBJECTIVES = 20;

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Reads `preferences.objectives`; malformed entries are dropped, never shown half-built. */
export function objectivesOf(raw: unknown): Objective[] {
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const out: Objective[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (!text(o.id) || !text(o.title).trim()) continue;
    out.push({ id: text(o.id), title: text(o.title), why: text(o.why), owner: text(o.owner),
      cardKeys: Array.isArray(o.cardKeys) ? o.cardKeys.filter((k): k is string => typeof k === 'string' && !!k) : [],
      health: HEALTH.includes(o.health as ObjectiveHealth) ? (o.health as ObjectiveHealth) : 'on-track' });
  }
  return out.slice(0, MAX_OBJECTIVES);
}

/** "NSC-1, NSC-2 ,," → ['NSC-1', 'NSC-2'] */
export const parseCardKeys = (value: string) => Array.from(new Set(value.split(',').map((k) => k.trim()).filter(Boolean)));

/** The editor's rows as the core accepts them: blank titles dropped, text trimmed. */
export function objectivesToSave(rows: ObjectiveInput[]): ObjectiveInput[] {
  return rows.filter((r) => r.title.trim()).slice(0, MAX_OBJECTIVES)
    .map((r) => ({ id: r.id, title: r.title.trim(), why: r.why.trim(), owner: r.owner, cardKeys: r.cardKeys, health: r.health }));
}

export function newObjective(existing: { id: string }[], now = Date.now()): ObjectiveInput {
  let id = `obj-${now.toString(36)}`;
  for (let n = 2; existing.some((o) => o.id === id); n++) id = `obj-${now.toString(36)}-${n}`;
  return { id, title: '', why: '', owner: '', cardKeys: [], health: 'on-track' };
}
