/**
 * Pure helpers for NSC-259 (almost-done derived column) and NSC-257 (unblock
 * checklist auto-items). No React, no @/ aliases — compiles standalone for tests.
 */

export interface CardLike {
  key: string;
  status: string;
  boardArchivedAt?: string;
  dependsOn?: string;
  task?: string;
  refs: { kind: string }[];
}

export interface MessageLike {
  kind: string;
  ticket?: string;
  answer?: string;
  dismissed?: boolean;
}

/**
 * NSC-259 — a card is "almost done" if it has a PR ref or an open humanQA ask,
 * is not archived, and is not already done.
 *
 * Rule chosen: derived from existing fields (pr refs + open asks), not a new status.
 * Cards move to this virtual column; they disappear from their normal status column.
 */
export function isAlmostDone(card: CardLike, messages: MessageLike[]): boolean {
  if (card.boardArchivedAt || card.status === 'done') return false;
  if (card.refs.some((r) => r.kind === 'pr')) return true;
  if (!card.task) return false;
  return messages.some(
    (m) => m.kind === 'question' && m.ticket === card.task && !m.answer && !m.dismissed,
  );
}

/**
 * NSC-257 — auto-generated unblock items for a blocked card.
 * Returns one item per open humanQA ask on this card, plus a dependency item if dependsOn is set.
 */
export function autoUnblockItems(card: CardLike, messages: MessageLike[]): string[] {
  const items: string[] = [];
  if (card.dependsOn) {
    items.push(`Waiting on ${card.dependsOn} to complete`);
  }
  if (card.task) {
    for (const m of messages) {
      if (m.kind === 'question' && m.ticket === card.task && !m.answer && !m.dismissed) {
        items.push(`Open question needs an answer`);
        break;
      }
    }
  }
  return items;
}
