// Parent/child links between Board cards (`parentId`). Pure helpers shared by the Board and the card
// detail; the core enforces the same rules (paramount-board.ts parentError) before it saves a parent.
import type { Card } from './types';

/** The Board cards (not archived) whose parent is `key`. */
export function childrenOf(cards: readonly Card[], key: string): Card[] {
  return cards.filter((c) => c.parentId === key && !c.boardArchivedAt);
}

/** "2/5 done" for a parent card; null when it has no children on the Board. */
export function childRollup(cards: readonly Card[], key: string): { done: number; total: number } | null {
  const children = childrenOf(cards, key);
  return children.length ? { done: children.filter((c) => c.status === 'done').length, total: children.length } : null;
}

/** Whether `key` is `ancestor` or sits anywhere below it. */
export function isUnder(cards: readonly Card[], key: string, ancestor: string): boolean {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const seen = new Set<string>();
  for (let at: string | undefined = key; at && !seen.has(at); at = byKey.get(at)?.parentId) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

/** Cards that can be `card`'s parent: active cards that are not the card itself or one of its descendants. */
export function parentCandidates(cards: readonly Card[], card: Card): Card[] {
  return cards.filter((c) => !c.boardArchivedAt && !isUnder(cards, c.key, card.key));
}

/** The Board's parent filter: the parent card itself and its direct children. */
export function inFamily(card: Card, parents: readonly string[]): boolean {
  return parents.includes(card.key) || (!!card.parentId && parents.includes(card.parentId));
}
