// NSC-255: plain-language helpers for the floor rules screens. No React here, so tests load it directly.
import type { ParamountFloorRule, ParamountRuleKind, ParamountRuleProblem, ParamountRuleWhen } from '@/data/paramount-api';

export interface RuleDraft { key: string; id?: string; text: string }

export const WHEN_LABEL: Record<ParamountRuleWhen, string> = {
  'always': 'At all times',
  'on-start': 'When starting work',
  'before-commit': 'Before committing',
  'before-push': 'Before pushing',
  'before-pr': 'Before opening a pull request',
  'before-done': 'Before marking work done',
};
export const KIND_LABEL: Record<ParamountRuleKind, string> = { require: 'Must do', forbid: 'Must not do', prefer: 'Should do when possible' };
export const WHEN_ORDER: readonly ParamountRuleWhen[] = ['on-start', 'always', 'before-commit', 'before-push', 'before-pr', 'before-done'];

let next = 0;
export const draftKey = (): string => `d${++next}`;

export const draftsFrom = (rules: readonly ParamountFloorRule[]): RuleDraft[] => rules.map((r) => ({ key: r.id, id: r.id, text: r.text }));
/** The drafts the core checks or saves: blank rows are left out. */
export const toPayload = (drafts: readonly RuleDraft[]): Array<{ id?: string; text: string }> =>
  drafts.filter((d) => d.text.trim()).map((d) => ({ ...(d.id ? { id: d.id } : {}), text: d.text }));
/** Problems point at the payload index; map them back to the row they are about. */
export function problemsByKey(drafts: readonly RuleDraft[], problems: readonly ParamountRuleProblem[]): { rows: Record<string, ParamountRuleProblem[]>; general: ParamountRuleProblem[] } {
  const kept = drafts.filter((d) => d.text.trim());
  const rows: Record<string, ParamountRuleProblem[]> = {};
  const general: ParamountRuleProblem[] = [];
  for (const p of problems) {
    const row = p.index === undefined ? undefined : kept[p.index];
    if (row) (rows[row.key] ??= []).push(p); else general.push(p);
  }
  return { rows, general };
}
export const blocking = (problems: readonly ParamountRuleProblem[]): boolean => problems.some((p) => p.level === 'error');
export function changed(drafts: readonly RuleDraft[], saved: readonly ParamountFloorRule[]): boolean {
  const now = toPayload(drafts);
  return now.length !== saved.length || now.some((d, i) => d.id !== saved[i].id || d.text.trim() !== saved[i].text);
}
/** Saved floor rules grouped by when they apply, in the order a task meets them. */
export function grouped(rules: readonly ParamountFloorRule[]): Array<{ when: ParamountRuleWhen; label: string; rules: ParamountFloorRule[] }> {
  return WHEN_ORDER.map((when) => ({ when, label: WHEN_LABEL[when], rules: rules.filter((r) => r.when === when) })).filter((g) => g.rules.length);
}
