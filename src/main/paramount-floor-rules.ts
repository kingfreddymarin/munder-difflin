// NSC-255: Floor rules commands (Settings > Floor rules, and Customize Rules at floor creation).
// dispatchParamount hands these over in one line; every failure goes through the same span, so it
// carries an errorId and a code. The rules logic and storage live in floor-rules.ts.
import { randomUUID } from 'node:crypto';
import type { ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountResult, ParamountRulesResult } from '../preload/paramount';
import { auditOnFloor, type FloorAudit } from './paramount-pre-floor';
import type { Span } from './paramountObservability';
import {
  MAX_RULES, SUGGESTION_DROP_DIR, applyDraftRules, checkRules, emptyFloorRules, floorRulesState, hasErrors, ingestSuggestionDrops,
  queueSuggestions, readFloorRules, reviewSuggestion, suggestFromRepos, writeFloorRules, type DraftRule, type FloorRulesDoc, type RuleProblem,
} from './floor-rules';

export interface ParamountRulesDeps {
  /** The floor's hive root; null before a floor is set up. */
  hiveRoot(): string | null;
  /** Repositories connected to this floor, for rule suggestions. */
  repos?(): string[];
  /** The orchestrator's id, when one is registered. */
  orchestratorId?(): string | undefined;
  /** Mail the orchestrator a request (as the human). */
  askOrchestrator?(agentId: string, subject: string, body: string): void;
}

interface Deps extends FloorAudit {
  publish(event: ParamountEvent): void;
  rules?: ParamountRulesDeps;
}

export const RULES_TYPES: ReadonlySet<string> = new Set(['rules.get', 'rules.check', 'rules.save', 'rules.reset', 'rules.suggestion', 'rules.suggest']);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(command: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(command).every((key) => allowed.includes(key));
}
const revision = (value: unknown): value is string | undefined => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 40);

/** Draft rules from the UI: a short list of `{ id?, text }`. Null when the shape is wrong. */
export function draftRules(value: unknown): DraftRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_RULES) return null;
  const out: DraftRule[] = [];
  for (const item of value) {
    if (!object(item) || !onlyKeys(item, ['id', 'text']) || typeof item.text !== 'string' || item.text.length > 2_000) return null;
    if (item.id !== undefined && (typeof item.id !== 'string' || item.id.length > 40)) return null;
    out.push({ ...(item.id ? { id: item.id as string } : {}), text: item.text });
  }
  return out;
}

/** The first blocking problem as one plain sentence, naming the rule it is about. */
export function blockingMessage(problems: readonly RuleProblem[]): string {
  const p = problems.find((x) => x.level === 'error');
  if (!p) return '';
  return p.index === undefined ? p.message : `Rule ${p.index + 1}: ${p.message}`;
}

const SUGGEST_SUBJECT = 'Suggest floor rules';
const suggestBody = (repos: string[]) => [
  'The human asked for floor rule suggestions in Settings > Floor rules.',
  `Look at this floor's purpose${repos.length ? ` and its connected repos (${repos.map((r) => r.split(/[\\/]/).pop()).join(', ')})` : ''}, then suggest up to 5 rules that would help the team.`,
  `For each one, write ONE JSON file into ${SUGGESTION_DROP_DIR}/ in the hive root: {"text": "the rule in one plain sentence", "reason": "why, in one simple sentence"}.`,
  'Rules must add to the Studio rules in RULES.md, never weaken them. The human reviews every suggestion; none is active until they approve it.',
].join('\n');

/** Handles a floor rules command, or returns null when the command is not one. */
export function dispatchRules(command: Record<string, unknown>, deps: Deps, span: Span): ParamountResult | null {
  const commandType = String(command.type);
  if (!RULES_TYPES.has(commandType)) return null;
  const fail = (code: ParamountErrorCode, message: string, cause?: unknown): ParamountResult => span.fail(code, message, cause, { commandType });
  const rules = deps.rules;
  if (!rules) return fail('UNSUPPORTED', `${commandType} is not available in this build`);
  const done = (payload: Omit<ParamountRulesResult, 'ok' | 'event'>): ParamountResult => {
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
    auditOnFloor(deps, event, commandType);
    deps.publish(event);
    return { ok: true, event, ...payload } as ParamountResult;
  };
  let writeAttempted = false;
  const now = () => new Date().toISOString();
  try {
    // rules.check works before a floor exists: Customize Rules at floor creation uses it.
    if (commandType === 'rules.check') {
      const drafts = onlyKeys(command, ['type', 'rules']) ? draftRules(command.rules) : null;
      if (!drafts) return fail('INVALID_INPUT', `rules.check takes up to ${MAX_RULES} rules, each { text }`);
      return done({ ruleCheck: checkRules(drafts) });
    }
    const root = rules.hiveRoot();
    if (!root) return fail('CONFLICT', 'Finish floor setup before changing floor rules');
    const current = readFloorRules(root);
    const unreadable = current.problems.some((p) => p.code === 'unreadable');
    const stale = (expected: unknown): boolean => expected !== undefined && expected !== current.revision;
    const save = (doc: FloorRulesDoc) => { writeAttempted = true; writeFloorRules(root, doc); };
    // Agents' suggestion files join the review queue whenever the panel reads the rules.
    const ingest = (doc: FloorRulesDoc): { doc: FloorRulesDoc; changed: boolean } => {
      const drops = ingestSuggestionDrops(root, now());
      if (!drops.consumed.length) return { doc, changed: false };
      const queued = queueSuggestions(doc, drops.items, now());
      return { doc: queued.doc, changed: queued.added > 0 };
    };
    switch (commandType) {
      case 'rules.get': {
        if (!onlyKeys(command, ['type'])) return fail('INVALID_INPUT', 'rules.get takes no fields');
        if (!unreadable) {
          const next = ingest(current.doc);
          if (next.changed) save(next.doc);
        }
        return done({ floorRules: floorRulesState(root) });
      }
      case 'rules.save': {
        const drafts = onlyKeys(command, ['type', 'rules', 'expected']) && revision(command.expected) ? draftRules(command.rules) : null;
        if (!drafts) return fail('INVALID_INPUT', `rules.save takes up to ${MAX_RULES} rules, each { id?, text }, and the revision it started from`);
        if (stale(command.expected)) return fail('CONFLICT', 'Floor rules changed since you opened them. Reload them, then save again.');
        // An unreadable file is replaced only by an explicit save; its pending suggestions are lost with it.
        const base = unreadable ? emptyFloorRules() : current.doc;
        const next = applyDraftRules(base, drafts, now());
        if (hasErrors(next.problems)) return fail('INVALID_INPUT', blockingMessage(next.problems));
        save(next.doc);
        return done({ floorRules: floorRulesState(root) });
      }
      case 'rules.reset': {
        if (!onlyKeys(command, ['type', 'expected']) || !revision(command.expected)) return fail('INVALID_INPUT', 'rules.reset takes only the revision it started from');
        if (stale(command.expected)) return fail('CONFLICT', 'Floor rules changed since you opened them. Reload them, then reset again.');
        // Reset removes this floor's rules; queued suggestions stay for review.
        save({ ...(unreadable ? emptyFloorRules() : current.doc), rules: [] });
        return done({ floorRules: floorRulesState(root) });
      }
      case 'rules.suggestion': {
        const valid = onlyKeys(command, ['type', 'id', 'decision', 'text', 'expected'])
          && typeof command.id === 'string' && command.id.length <= 40
          && (command.decision === 'approve' || command.decision === 'reject')
          && (command.text === undefined || (typeof command.text === 'string' && command.text.length <= 2_000))
          && revision(command.expected);
        if (!valid) return fail('INVALID_INPUT', 'rules.suggestion takes { id, decision: approve | reject, text? }');
        if (unreadable) return fail('CONFLICT', 'The saved floor rules are not valid. Save or reset them first.');
        if (stale(command.expected)) return fail('CONFLICT', 'Floor rules changed since you opened them. Reload them, then try again.');
        const reviewed = reviewSuggestion(current.doc, command.id as string, command.decision as 'approve' | 'reject', now(), command.text as string | undefined);
        if (!reviewed.found) return fail('NOT_FOUND', 'That suggestion is no longer waiting for review');
        if (hasErrors(reviewed.problems)) return fail('INVALID_INPUT', blockingMessage(reviewed.problems));
        save(reviewed.doc);
        return done({ floorRules: floorRulesState(root) });
      }
      case 'rules.suggest': {
        if (!onlyKeys(command, ['type'])) return fail('INVALID_INPUT', 'rules.suggest takes no fields');
        if (unreadable) return fail('CONFLICT', 'The saved floor rules are not valid. Save or reset them first.');
        const repos = (rules.repos?.() ?? []).filter((r) => typeof r === 'string' && r.length > 0);
        const fromDrops = ingest(current.doc);
        const queued = queueSuggestions(fromDrops.doc, suggestFromRepos(repos), now());
        if (fromDrops.changed || queued.added > 0) save(queued.doc);
        // Paramount (the orchestrator) adds suggestions about the floor's purpose through the drop folder.
        const god = rules.orchestratorId?.();
        let askedParamount = false;
        if (god && rules.askOrchestrator) {
          try { rules.askOrchestrator(god, SUGGEST_SUBJECT, suggestBody(repos)); askedParamount = true; }
          catch { /* the repo suggestions above still stand */ }
        }
        return done({ floorRules: floorRulesState(root), suggested: queued.added, askedParamount });
      }
    }
    return fail('INVALID_COMMAND', 'Unknown floor rules command');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    return writeAttempted
      ? fail('UNCERTAIN_STATE', `Floor rules may have been saved; reload them before retrying: ${message}`, error)
      : fail('INTERNAL', message, error);
  }
}
