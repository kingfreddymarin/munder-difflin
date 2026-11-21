// Lane b-home-chats: the Paramount commands behind Home and Chats.
//   ask.reply   - the human answers an ask (Munder's ASK ME): free text, a picked
//                 option, or "done" for a to-do only the human could do.
//   ask.dismiss - clears a card's open ask without answering (the question stays).
//   home.layout - Home tile sizes, order, hidden tiles and spacing.
//   home.objectives - the floor's Main Objectives (replaces the list).
//   chats.view  - which update cards (pipeline, routing, context) Chats hides.
// dispatchParamount routes these here; on success it appends and publishes the
// event, so this file only validates and writes.
import type { ParamountAskMode, ParamountErrorCode, ParamountHomeChatsCommand, ParamountResult } from '../preload/paramount';

/** The humanQA entry as the hive writes it (PROTOCOL.md, "Asking the human"). */
interface AskEntry { q: string; a?: string; askedAt?: string; answeredAt?: string; dismissedAt?: string; from?: string; mode?: ParamountAskMode }

export interface HomeChatsDeps {
  tasks(): { tasks?: Array<{ id: string; title?: string; assignee?: string; humanQA?: AskEntry[] }> };
  patchTask(id: string, patch: Record<string, unknown>): boolean;
  agents(): Record<string, unknown>;
  savePreference(key: 'home' | 'chats' | 'objectives', value: Record<string, unknown>): void;
  /** hive.send on the human's behalf. Absent means replies cannot be mailed (UNSUPPORTED). */
  send?(msg: { to: string; act: 'inform'; subject: string; body: string; in_reply_to?: string }): { ok: boolean; error?: string };
  /** One hive message by id, for replies to a direct question. */
  message?(id: string): { id: string; from: string; to: string; subject: string } | null;
  /** Orchestrator id; asks without `from` belong to it. */
  godId?(): string | undefined;
}

type Fail = (code: ParamountErrorCode, message: string, cause?: unknown) => ParamountResult;

export const HOME_CHATS_COMMANDS = ['ask.reply', 'ask.dismiss', 'home.layout', 'home.objectives', 'chats.view'] as const;
const HEALTH = ['on-track', 'at-risk', 'blocked'];
const MAX_OBJECTIVES = 20;
const MODES: readonly ParamountAskMode[] = ['answer', 'decision', 'done'];
const DENSITIES = ['compact', 'comfortable', 'spacious'];
const SIZES = ['sm', 'md', 'lg'];
const MAX_HIDDEN = 500;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\r\n\0]/.test(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 10_000;

/** Finds the card and humanQA index for `<task id>:<index>`. */
function locate(deps: HomeChatsDeps, messageId: string) {
  const tasks = deps.tasks().tasks ?? [];
  const task = tasks.find((t) => messageId.startsWith(`${t.id}:`));
  if (!task) return null;
  const suffix = messageId.slice(task.id.length + 1);
  const index = /^(0|[1-9]\d*)$/.test(suffix) ? Number(suffix) : -1;
  return { task, index, qa: task.humanQA ?? [] };
}

const open = (entry: AskEntry | undefined): entry is AskEntry => !!entry && typeof entry.q === 'string' && !entry.a && !entry.dismissedAt;

const replyLine = (mode: ParamountAskMode, text: string) =>
  mode === 'done' ? `DONE (the human completed this): ${text}` : mode === 'decision' ? `DECISION: ${text}` : `A: ${text}`;

/**
 * Returns null when the command was applied (the caller emits the event), or a
 * failure. `markWrite` is called right before the first write, so a throw after
 * it is reported as UNCERTAIN_STATE rather than INTERNAL.
 */
export function dispatchHomeChats(command: ParamountHomeChatsCommand, deps: HomeChatsDeps, fail: Fail, markWrite: () => void): ParamountResult | null {
  switch (command.type) {
    case 'ask.reply': {
      if (!isId(command.messageId) || !isText(command.text) || !MODES.includes(command.mode)) return fail('INVALID_INPUT', 'An ask reply needs a messageId, a mode (answer, decision or done) and text');
      const found = locate(deps, command.messageId);
      if (found) {
        const { task, index, qa } = found;
        if (!open(qa[index])) return fail('CONFLICT', 'This ask is no longer open; refresh to see its answer');
        if (!deps.send) return fail('UNSUPPORTED', 'This core cannot mail the answer to the agent');
        const entry = qa[index];
        const next = qa.map((item, i) => i === index ? { ...item, a: command.text.trim(), answeredAt: new Date().toISOString(), mode: command.mode } : item);
        markWrite();
        if (!deps.patchTask(task.id, { humanQA: next })) return fail('CONFLICT', 'The card changed before the answer was saved; retry');
        // Munder's ASK ME contract: the answer is on the card AND mailed to god,
        // who unblocks the card. The asking agent (if not god) gets a copy.
        const body = [
          `The human answered the open ask on task ${task.id} ("${task.title ?? task.id}"):`,
          `Q: ${entry.q}`,
          replyLine(command.mode, command.text.trim()),
          "The answer is also recorded in the card's humanQA. Act on it, unblock the card, and continue the work."
        ].join('\n');
        const god = deps.godId?.() ?? 'god';
        const recipients = [god, ...(entry.from && entry.from !== god && entry.from in deps.agents() ? [entry.from] : [])];
        for (const to of recipients) {
          const sent = deps.send({ to, act: 'inform', subject: `HUMAN ANSWER on task "${task.title ?? task.id}"`, body });
          if (!sent.ok) throw new Error(`answer saved on the card but mail to ${to} failed: ${sent.error ?? 'unknown error'}`);
        }
        return null;
      }
      // Not a card ask: a hive message the agent sent straight to the human.
      if (!deps.message || !deps.send) return fail('UNSUPPORTED', 'This core cannot reply to a direct message');
      const original = deps.message(command.messageId);
      if (!original) return fail('NOT_FOUND', 'The question was not found on a card or in the hive mail');
      markWrite();
      const sent = deps.send({ to: original.from, act: 'inform', in_reply_to: original.id, subject: `Re: ${original.subject}`.slice(0, 200), body: replyLine(command.mode, command.text.trim()) });
      if (!sent.ok) throw new Error(`reply to ${original.from} failed: ${sent.error ?? 'unknown error'}`);
      return null;
    }
    case 'ask.dismiss': {
      if (!isId(command.messageId)) return fail('INVALID_INPUT', 'ask.dismiss needs a messageId');
      const found = locate(deps, command.messageId);
      if (!found) return fail('NOT_FOUND', 'Only an ask on a card can be dismissed');
      if (!open(found.qa[found.index])) return fail('CONFLICT', 'This ask is no longer open');
      const next = found.qa.map((item, i) => i === found.index ? { ...item, dismissedAt: new Date().toISOString() } : item);
      markWrite();
      if (!deps.patchTask(found.task.id, { humanQA: next })) return fail('CONFLICT', 'The card changed before the ask was dismissed; retry');
      return null;
    }
    case 'home.layout': {
      const layout = command.layout;
      if (!isObject(layout)) return fail('INVALID_INPUT', 'home.layout needs a layout object');
      const value: Record<string, unknown> = {};
      if (layout.density !== undefined) {
        if (typeof layout.density !== 'string' || !DENSITIES.includes(layout.density)) return fail('INVALID_INPUT', `density must be one of ${DENSITIES.join(', ')}`);
        value.density = layout.density;
      }
      if (layout.order !== undefined) {
        if (!Array.isArray(layout.order) || layout.order.length > 50 || !layout.order.every(isId)) return fail('INVALID_INPUT', 'order must be a list of tile ids');
        value.order = layout.order;
      }
      if (layout.tiles !== undefined) {
        if (!isObject(layout.tiles) || Object.keys(layout.tiles).length > 50) return fail('INVALID_INPUT', 'tiles must map tile ids to settings');
        for (const [key, tile] of Object.entries(layout.tiles)) {
          if (!isId(key) || !isObject(tile)) return fail('INVALID_INPUT', 'Each tile needs an id and a settings object');
          if (tile.size !== undefined && (typeof tile.size !== 'string' || !SIZES.includes(tile.size))) return fail('INVALID_INPUT', `size must be one of ${SIZES.join(', ')}`);
          if (tile.hidden !== undefined && typeof tile.hidden !== 'boolean') return fail('INVALID_INPUT', 'hidden must be true or false');
          if (Object.keys(tile).some((k) => k !== 'size' && k !== 'hidden')) return fail('INVALID_INPUT', 'A tile accepts only size and hidden');
        }
        value.tiles = layout.tiles;
      }
      if (!Object.keys(value).length) return fail('INVALID_INPUT', 'home.layout changed nothing');
      markWrite();
      deps.savePreference('home', value);
      return null;
    }
    case 'home.objectives': {
      const list = command.objectives;
      if (!Array.isArray(list) || list.length > MAX_OBJECTIVES) return fail('INVALID_INPUT', `objectives must be a list of at most ${MAX_OBJECTIVES}`);
      const items: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const o of list as unknown[]) {
        if (!isObject(o) || !isId(o.id) || seen.has(o.id)) return fail('INVALID_INPUT', 'Each objective needs a unique id');
        if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 200) return fail('INVALID_INPUT', 'Each objective needs a title of at most 200 characters');
        if (typeof o.health !== 'string' || !HEALTH.includes(o.health)) return fail('INVALID_INPUT', `health must be one of ${HEALTH.join(', ')}`);
        if (o.why !== undefined && (typeof o.why !== 'string' || o.why.length > 1000)) return fail('INVALID_INPUT', 'why must be text of at most 1000 characters');
        if (o.owner !== undefined && o.owner !== '' && !isId(o.owner)) return fail('INVALID_INPUT', 'owner must be an agent id');
        if (o.cardKeys !== undefined && (!Array.isArray(o.cardKeys) || o.cardKeys.length > 50 || !o.cardKeys.every(isId))) return fail('INVALID_INPUT', 'cardKeys must be a list of card keys');
        if (Object.keys(o).some((k) => !['id', 'title', 'why', 'owner', 'cardKeys', 'health'].includes(k))) return fail('INVALID_INPUT', 'An objective accepts only id, title, why, owner, cardKeys and health');
        seen.add(o.id);
        items.push({ id: o.id, title: o.title.trim(), health: o.health, ...(typeof o.why === 'string' && o.why.trim() ? { why: o.why.trim() } : {}),
          ...(typeof o.owner === 'string' && o.owner ? { owner: o.owner } : {}), ...(Array.isArray(o.cardKeys) && o.cardKeys.length ? { cardKeys: o.cardKeys } : {}) });
      }
      markWrite();
      deps.savePreference('objectives', { items });
      return null;
    }
    case 'chats.view': {
      const value: Record<string, unknown> = {};
      if (command.hideUpdates !== undefined) {
        if (typeof command.hideUpdates !== 'boolean') return fail('INVALID_INPUT', 'hideUpdates must be true or false');
        value.hideUpdates = command.hideUpdates;
      }
      if (command.hiddenIds !== undefined) {
        if (!Array.isArray(command.hiddenIds) || !command.hiddenIds.every(isId)) return fail('INVALID_INPUT', 'hiddenIds must be a list of message ids');
        // Newest last; the oldest fall off so the preference file stays small.
        value.hiddenIds = command.hiddenIds.slice(-MAX_HIDDEN);
      }
      if (!Object.keys(value).length) return fail('INVALID_INPUT', 'chats.view changed nothing');
      markWrite();
      deps.savePreference('chats', value);
      return null;
    }
  }
}
