// NSC-255: optional floor rules (Customize Rules). Studio rules are built in, apply to every floor
// and cannot be changed; floor rules add to them for one floor. Floor rules live in the floor's hive
// (one per home folder, so every floor window and process reads its own) as schema-validated YAML at
// council/extensions/floor-rules.yaml, next to teams.json. People never see or edit that file: they
// write rules in plain language, Paramount structures them, and a rule that would weaken a Studio
// rule, contradict another rule, or is malformed is refused before anything is written.
//
// Agent-suggested rules go to a review queue (the `suggestions` list) and only become active when
// the human approves them. Agents propose by dropping one JSON file into <hive>/rule-suggestions/;
// the harness moves each file into the queue. The effective rules (Studio + active floor rules) are
// rendered to <hive>/RULES.md, which every agent's prompt tells it to read before starting work.
//
// Electron-free on purpose: the tests load this file directly.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const FLOOR_RULES_FILE = 'council/extensions/floor-rules.yaml';
export const RULES_DOC = 'RULES.md';
export const SUGGESTION_DROP_DIR = 'rule-suggestions';
export const FLOOR_RULES_SCHEMA = 'paramount.floor-rules/v1';
export const MAX_RULES = 30;
export const MAX_SUGGESTIONS = 30;
export const MAX_RULE_TEXT = 300;
const MAX_REASON = 300;
const MAX_DROPS_PER_PASS = 20;
const MAX_DROP_BYTES = 8 * 1024;

export type RuleWhen = 'always' | 'on-start' | 'before-commit' | 'before-push' | 'before-pr' | 'before-done';
export type RuleKind = 'require' | 'forbid' | 'prefer';
export const RULE_WHENS: readonly RuleWhen[] = ['always', 'on-start', 'before-commit', 'before-push', 'before-pr', 'before-done'];
export const RULE_KINDS: readonly RuleKind[] = ['require', 'forbid', 'prefer'];

export interface StudioRule { id: string; text: string; why: string }
export interface FloorRule { id: string; text: string; when: RuleWhen; kind: RuleKind; source: 'you' | 'paramount'; addedAt: string }
export interface RuleSuggestion { id: string; text: string; when: RuleWhen; kind: RuleKind; reason?: string; from: string; suggestedAt: string }
export interface FloorRulesDoc { schema: typeof FLOOR_RULES_SCHEMA; rules: FloorRule[]; suggestions: RuleSuggestion[] }
export type RuleProblemCode = 'invalid' | 'unsafe' | 'conflict' | 'duplicate' | 'redundant' | 'limit' | 'unreadable';
export interface RuleProblem {
  level: 'error' | 'warning';
  code: RuleProblemCode;
  /** Plain language, shown to the human as is. */
  message: string;
  /** The draft rule (0-based) the problem is about. */
  index?: number;
  studioRuleId?: string;
}
export interface DraftRule { id?: string; text: string }
export interface CheckedRule { id?: string; text: string; when: RuleWhen; kind: RuleKind }
export interface FloorRulesState {
  studio: StudioRule[];
  rules: FloorRule[];
  suggestions: Array<RuleSuggestion & { problems: RuleProblem[] }>;
  /** Changes whenever the saved file changes; a save names the revision it started from. */
  revision: string;
  problems: RuleProblem[];
}

/** The mandatory rules every floor inherits. They restate protections the hive already enforces
 *  (PROTOCOL.md, the circuit breaker, permission prompts); floor rules can add to them, never
 *  weaken them. */
export const STUDIO_RULES: readonly StudioRule[] = Object.freeze([
  { id: 'studio.single-writer', text: 'Each agent writes only in its own folder and sends messages through its outbox.', why: 'Keeps every file single-writer, so agents never overwrite each other.' },
  { id: 'studio.board-scribe', text: 'Only Paramount edits board.md; other agents propose changes to it.', why: 'One scribe keeps the shared plan consistent.' },
  { id: 'studio.human-approval', text: 'Destructive actions, spending real money and scope changes need your approval.', why: 'You stay in control of anything that cannot be undone.' },
  { id: 'studio.no-secrets', text: 'Never commit, paste or share secrets, passwords or credentials.', why: 'Anything committed to a repository is permanent.' },
  { id: 'studio.guardrails', text: 'Follow the circuit breaker and token budgets when they ask an agent to stop or slow down.', why: 'Stops loops and runaway spending.' },
].map((rule) => Object.freeze(rule)));

// ── Plain language → structure ──────────────────────────────────────────────

const LEAD = /^(?:please\s+|you\s+(?:must|should)\s+|agents?\s+(?:must|should)\s+|always\s+|must\s+|make\s+sure\s+(?:to\s+|that\s+)?|never\s+|do\s+not\s+|don'?t\s+|avoid\s+|prefer\s+(?:to\s+)?|try\s+to\s+|ideally\s+)+/;

/** Lower case, no punctuation, single spaces. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[`'"’]/g, '').replace(/[^a-z0-9.#/+-]+/g, ' ').replace(/\.(?=\s|$)/g, '').replace(/\s+/g, ' ').trim();
}
/** What a rule is about, without its leading always/never/prefer: "never X" and "always X" share it. */
function core(text: string): string {
  return plain(text).replace(LEAD, '').trim();
}

/** Translate a plain-language rule into its structured form: when it applies and what kind it is. */
export function structureRule(text: string): { when: RuleWhen; kind: RuleKind } {
  const t = plain(text);
  const when: RuleWhen =
    /\bbefore (?:you |anyone |an agent |agents )?(?:open(?:ing)?|creat(?:e|ing)|rais(?:e|ing)|submit(?:ting)?|send(?:ing)?) (?:a |the |any )?(?:pr|prs|pull requests?|merge requests?)\b/.test(t) ? 'before-pr'
      : /\bbefore (?:you |anyone |an agent |agents )?(?:push(?:es|ing)?|a push)\b/.test(t) ? 'before-push'
        : /\bbefore (?:you |anyone |an agent |agents )?(?:commit(?:s|ting)?|a commit)\b/.test(t) ? 'before-commit'
          : /\bbefore (?:you |anyone |an agent |agents )?(?:mark(?:ing)?|clos(?:e|ing)|finish(?:ing)?|call(?:ing)?|complet(?:e|ing)|hand(?:ing)? off)\b.*\b(?:done|complete|finished|task|card|work)\b/.test(t) ? 'before-done'
            : /\b(?:at the start|when (?:you )?start(?:ing)?|before (?:you )?start(?:ing)?|first thing|at the beginning)\b/.test(t) ? 'on-start'
              : 'always';
  const kind: RuleKind = /^(?:never|do not|dont|avoid|no)\b/.test(t) || /\b(?:must|should) not\b|\bmust never\b/.test(t) ? 'forbid'
    : /^(?:prefer|try to|ideally|when possible|where possible)\b/.test(t) ? 'prefer'
      : 'require';
  return { when, kind };
}

// ── Safety, conflicts and redundancy ────────────────────────────────────────

/** `matches` finds the risky action; a "never …" rule about it restates the protection, unless
 *  `negated` says the "never" is what removes it ("never ask for approval"). */
interface Guard { studioRuleId: string; message: string; matches(t: string): boolean; negated?(t: string): boolean }
const SECRET = /\b(?:secrets?|passwords?|credentials?|api ?(?:keys?|tokens?)|access tokens?|auth tokens?|private keys?|\.env)\b/;
const GUARDS: readonly Guard[] = [
  { studioRuleId: 'studio.guardrails', message: 'This would switch off a Studio protection. Floor rules can add to Studio rules but never weaken them.',
    matches: (t) => /\b(?:ignore|skip|bypass|disable|override|overrule|turn off|switch off|circumvent|suspend|remove)\b.*\b(?:studio rules?|(?:the|these|all|any|safety|floor|hive) rules|protections?|guardrails?|circuit breaker|breaker|approvals?|permissions?|permission prompts?|token budgets?|budgets?|token limits?|spending limits?)\b/.test(t) },
  { studioRuleId: 'studio.single-writer', message: "Agents must not write in another agent's folder. Ask them through a message instead.",
    matches: (t) => /\b(?:write|edit|change|modify|delete|move|overwrite)\b.*\b(?:another|other|every|all|each others?)\b.*\bagents?s?\b.*\b(?:folders?|inbox(?:es)?|outbox(?:es)?|workspaces?|memory|handoffs?|files)\b/.test(t) },
  { studioRuleId: 'studio.board-scribe', message: 'Only Paramount edits board.md. Other agents propose changes to it.',
    matches: (t) => /\bboard(?:\.md| md)\b/.test(t) && /\b(?:edit|write|change|update|modify|rewrite)\b/.test(t) && /\b(?:agents?|workers?|anyone|everyone|every ?one|teammates?)\b/.test(t) && !/\bonly (?:paramount|the orchestrator|god)\b/.test(t) },
  { studioRuleId: 'studio.human-approval', message: 'Destructive or irreversible actions always need your approval; a floor rule cannot remove that.',
    matches: (t) => (/\bwithout (?:asking|approval|permission|confirmation|checking)\b/.test(t) && /\b(?:delete|remove|drop|wipe|destroy|erase|reset|spend|buy|purchase|pay|deploy|release|publish|merge|push|rm|scope)\b/.test(t)) || /\b(?:no|skip|without) (?:human |your )?(?:approval|confirmation)\b|\b(?:never|do not|dont|stop) ask(?:ing)? (?:the human|me|you|for approval|for permission|for confirmation)\b|\bforce[ -]?push\b|\brm -rf\b|\b(?:delete|drop|wipe) (?:the |any )?(?:repo|repository|database|db|tables?|production|prod|main branch)\b|\brewrite (?:git |the )?history\b/.test(t),
    negated: (t) => /\b(?:never|do not|dont|stop) ask(?:ing)? (?:the human|me|you|for approval|for permission|for confirmation)\b/.test(t) },
  { studioRuleId: 'studio.no-secrets', message: 'Secrets, passwords and credentials must never be committed or shared.',
    matches: (t) => SECRET.test(t) && /\b(?:commit|push|paste|post|share|print|log|send|upload|include|store|check in)\b/.test(t) && !/\b(?:redact|mask|strip|remove|scan|exclude|without)\b/.test(t) },
];

function checkOne(text: string, index: number): { checked?: CheckedRule; problems: RuleProblem[] } {
  if (typeof text !== 'string' || !text.trim()) return { problems: [{ level: 'error', code: 'invalid', message: 'Write the rule in a sentence.', index }] };
  const trimmed = text.trim();
  if (trimmed.length > MAX_RULE_TEXT) return { problems: [{ level: 'error', code: 'invalid', message: `Keep each rule under ${MAX_RULE_TEXT} characters.`, index }] };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { problems: [{ level: 'error', code: 'invalid', message: 'Write each rule on one line.', index }] };
  if (core(trimmed).length < 3) return { problems: [{ level: 'error', code: 'invalid', message: 'Say what the agents should do.', index }] };
  const { when, kind } = structureRule(trimmed);
  const t = plain(trimmed);
  const problems: RuleProblem[] = [];
  for (const guard of GUARDS) {
    if (!guard.matches(t)) continue;
    // "Never force-push" or "Never commit secrets" restates a Studio rule: harmless, but redundant.
    if (kind === 'forbid' && !guard.negated?.(t)) problems.push({ level: 'warning', code: 'redundant', message: 'Studio rules already cover this, so the rule is not needed.', index, studioRuleId: guard.studioRuleId });
    else problems.push({ level: 'error', code: 'unsafe', message: guard.message, index, studioRuleId: guard.studioRuleId });
    break;
  }
  const studio = STUDIO_RULES.find((rule) => core(rule.text) === core(trimmed));
  if (studio && !problems.length) problems.push({ level: 'warning', code: 'redundant', message: 'This is already a Studio rule.', index, studioRuleId: studio.id });
  return { checked: { text: trimmed, when, kind }, problems };
}

/** Check a whole list of floor rules: each must be valid and safe, none may repeat or contradict
 *  another. Errors block a save; warnings are shown but allowed. */
export function checkRules(drafts: readonly DraftRule[]): { rules: CheckedRule[]; problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const rules: CheckedRule[] = [];
  if (drafts.length > MAX_RULES) problems.push({ level: 'error', code: 'limit', message: `A floor can have up to ${MAX_RULES} rules.` });
  const seen = new Map<string, { index: number; kind: RuleKind }>();
  drafts.forEach((draft, index) => {
    const one = checkOne(draft?.text, index);
    problems.push(...one.problems);
    if (!one.checked) return;
    rules.push({ ...(typeof draft.id === 'string' && draft.id ? { id: draft.id } : {}), ...one.checked });
    const key = core(one.checked.text);
    const earlier = seen.get(key);
    if (!earlier) { seen.set(key, { index, kind: one.checked.kind }); return; }
    if (earlier.kind === one.checked.kind) problems.push({ level: 'error', code: 'duplicate', message: `This repeats rule ${earlier.index + 1}.`, index });
    else problems.push({ level: 'error', code: 'conflict', message: `This contradicts rule ${earlier.index + 1}. Keep one of them.`, index });
  });
  return { rules, problems };
}

export const hasErrors = (problems: readonly RuleProblem[]): boolean => problems.some((p) => p.level === 'error');

// ── Schema ──────────────────────────────────────────────────────────────────

const RULE_ID = /^(?:r|s)-[a-z0-9]{8,32}$/;
const ISO = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function only(item: Record<string, unknown>, keys: string[], what: string): void {
  const extra = Object.keys(item).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${what} has unknown field ${extra[0]}`);
}
function obj(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object`);
  return value as Record<string, unknown>;
}
function ruleText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_RULE_TEXT || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${what} needs one line of text up to ${MAX_RULE_TEXT} characters`);
  return value;
}

/** The floor rules schema. Throws with a plain message on anything else. */
export function validateFloorRulesDoc(value: unknown): FloorRulesDoc {
  const raw = obj(value, 'Floor rules');
  only(raw, ['schema', 'rules', 'suggestions'], 'Floor rules');
  if (raw.schema !== FLOOR_RULES_SCHEMA) throw new Error('Unsupported floor rules format');
  const rulesIn = raw.rules ?? [];
  const suggestionsIn = raw.suggestions ?? [];
  if (!Array.isArray(rulesIn) || rulesIn.length > MAX_RULES) throw new Error(`Floor rules must be a list of up to ${MAX_RULES}`);
  if (!Array.isArray(suggestionsIn) || suggestionsIn.length > MAX_SUGGESTIONS) throw new Error(`Rule suggestions must be a list of up to ${MAX_SUGGESTIONS}`);
  const ids = new Set<string>();
  const id = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !RULE_ID.test(v) || ids.has(v)) throw new Error(`${what} needs a unique id`);
    ids.add(v); return v;
  };
  const when = (v: unknown, what: string): RuleWhen => { if (!RULE_WHENS.includes(v as RuleWhen)) throw new Error(`${what} has an unknown "when"`); return v as RuleWhen; };
  const kind = (v: unknown, what: string): RuleKind => { if (!RULE_KINDS.includes(v as RuleKind)) throw new Error(`${what} has an unknown "kind"`); return v as RuleKind; };
  const rules = rulesIn.map((entry, i): FloorRule => {
    const what = `Floor rule ${i + 1}`;
    const r = obj(entry, what);
    only(r, ['id', 'text', 'when', 'kind', 'source', 'addedAt'], what);
    if (r.source !== 'you' && r.source !== 'paramount') throw new Error(`${what} has an unknown source`);
    if (!ISO(r.addedAt)) throw new Error(`${what} needs the time it was added`);
    return { id: id(r.id, what), text: ruleText(r.text, what), when: when(r.when, what), kind: kind(r.kind, what), source: r.source, addedAt: r.addedAt };
  });
  const suggestions = suggestionsIn.map((entry, i): RuleSuggestion => {
    const what = `Rule suggestion ${i + 1}`;
    const s = obj(entry, what);
    only(s, ['id', 'text', 'when', 'kind', 'reason', 'from', 'suggestedAt'], what);
    if (typeof s.from !== 'string' || !AGENT.test(s.from)) throw new Error(`${what} must say who suggested it`);
    if (s.reason !== undefined && (typeof s.reason !== 'string' || s.reason.length > MAX_REASON || /[\u0000-\u001f\u007f]/.test(s.reason))) throw new Error(`${what} has an invalid reason`);
    if (!ISO(s.suggestedAt)) throw new Error(`${what} needs the time it was suggested`);
    return { id: id(s.id, what), text: ruleText(s.text, what), when: when(s.when, what), kind: kind(s.kind, what), ...(s.reason ? { reason: s.reason as string } : {}), from: s.from, suggestedAt: s.suggestedAt };
  });
  // The file is written only through checkRules, so an unsafe or contradictory set means a hand edit.
  const check = checkRules(rules);
  const blocking = check.problems.find((p) => p.level === 'error');
  if (blocking) throw new Error(`Floor rule ${(blocking.index ?? 0) + 1}: ${blocking.message}`);
  return { schema: FLOOR_RULES_SCHEMA, rules, suggestions };
}

export const emptyFloorRules = (): FloorRulesDoc => ({ schema: FLOOR_RULES_SCHEMA, rules: [], suggestions: [] });

// ── YAML (the fixed subset this file is written in) ─────────────────────────

const yamlString = (v: string): string => JSON.stringify(v); // a JSON string is a valid YAML double-quoted scalar
const BARE = /^[A-Za-z0-9._:/-]+$/;
const yamlValue = (v: string): string => BARE.test(v) && !/^(?:true|false|null|yes|no|on|off|~|[0-9.+-]+)$/i.test(v) ? v : yamlString(v);

export function floorRulesToYaml(doc: FloorRulesDoc): string {
  const list = (key: string, items: ReadonlyArray<Record<string, string | undefined>>, order: string[], strings: string[]): string[] => {
    if (!items.length) return [`${key}: []`];
    const out = [`${key}:`];
    for (const item of items) {
      const fields = order.filter((k) => item[k] !== undefined);
      fields.forEach((k, i) => {
        const v = item[k] as string;
        out.push(`${i === 0 ? '  - ' : '    '}${k}: ${strings.includes(k) ? yamlString(v) : yamlValue(v)}`);
      });
    }
    return out;
  };
  return [
    '# Floor rules for this floor, managed by Paramount (Settings > Floor rules).',
    '# Studio rules are built in and are not stored here. Do not edit this file by hand.',
    `schema: ${doc.schema}`,
    ...list('rules', doc.rules as unknown as Array<Record<string, string>>, ['id', 'text', 'when', 'kind', 'source', 'addedAt'], ['text', 'addedAt']),
    ...list('suggestions', doc.suggestions as unknown as Array<Record<string, string>>, ['id', 'text', 'when', 'kind', 'reason', 'from', 'suggestedAt'], ['text', 'reason', 'suggestedAt']),
    ''
  ].join('\n');
}

function yamlScalar(raw: string, line: number): unknown {
  const v = raw.trim();
  if (v === '[]') return [];
  if (v.startsWith('"')) {
    let parsed: unknown;
    try { parsed = JSON.parse(v); } catch { throw new Error(`Floor rules file line ${line}: unreadable text`); }
    if (typeof parsed !== 'string') throw new Error(`Floor rules file line ${line}: unreadable text`);
    return parsed;
  }
  if (BARE.test(v)) return v;
  throw new Error(`Floor rules file line ${line}: unexpected value`);
}

/** Parse the YAML subset floorRulesToYaml writes: top-level scalars and lists of flat maps. Anything
 *  else (anchors, nesting, flow maps, tags) is refused rather than guessed at. */
export function parseFloorRulesYaml(source: string): unknown {
  const out: Record<string, unknown> = {};
  let list: Array<Record<string, unknown>> | null = null;
  let item: Record<string, unknown> | null = null;
  const set = (target: Record<string, unknown>, key: string, value: string, line: number) => {
    if (Object.hasOwn(target, key)) throw new Error(`Floor rules file line ${line}: ${key} is repeated`);
    target[key] = yamlScalar(value, line);
  };
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    let m = /^([A-Za-z][A-Za-z0-9]*):(?: +(.*))?$/.exec(raw);
    if (m) {
      const [, key, value] = m;
      if (Object.hasOwn(out, key)) throw new Error(`Floor rules file line ${n}: ${key} is repeated`);
      item = null;
      if (value === undefined || value.trim() === '') { list = []; out[key] = list; }
      else { set(out, key, value, n); list = null; }
      continue;
    }
    m = /^ {2}- ([A-Za-z][A-Za-z0-9]*): +(.+)$/.exec(raw);
    if (m) {
      if (!list) throw new Error(`Floor rules file line ${n}: a list item outside a list`);
      item = {};
      list.push(item);
      set(item, m[1], m[2], n);
      continue;
    }
    m = /^ {4}([A-Za-z][A-Za-z0-9]*): +(.+)$/.exec(raw);
    if (m) {
      if (!item) throw new Error(`Floor rules file line ${n}: a field outside a list item`);
      set(item, m[1], m[2], n);
      continue;
    }
    throw new Error(`Floor rules file line ${n} is not in the expected format`);
  }
  return out;
}

// ── Store ───────────────────────────────────────────────────────────────────

const revisionOf = (raw: string | null): string => raw === null ? 'none' : createHash('sha1').update(raw).digest('hex').slice(0, 16);
const newId = (prefix: 'r' | 's'): string => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** The saved floor rules. A missing file is an empty set; an unreadable one is reported, and only
 *  the Studio rules apply until it is saved again or reset. */
export function readFloorRules(root: string | null): { doc: FloorRulesDoc; revision: string; problems: RuleProblem[] } {
  if (!root) return { doc: emptyFloorRules(), revision: 'none', problems: [] };
  const path = join(root, FLOOR_RULES_FILE);
  let raw: string | null = null;
  try { raw = existsSync(path) ? readFileSync(path, 'utf8') : null; }
  catch (error) { return { doc: emptyFloorRules(), revision: 'unreadable', problems: [{ level: 'error', code: 'unreadable', message: `The saved floor rules could not be read (${error instanceof Error ? error.message : String(error)}). Only Studio rules apply until you save or reset.` }] }; }
  if (raw === null) return { doc: emptyFloorRules(), revision: 'none', problems: [] };
  try { return { doc: validateFloorRulesDoc(parseFloorRulesYaml(raw)), revision: revisionOf(raw), problems: [] }; }
  catch (error) { return { doc: emptyFloorRules(), revision: revisionOf(raw), problems: [{ level: 'error', code: 'unreadable', message: `The saved floor rules are not valid (${error instanceof Error ? error.message : String(error)}). Only Studio rules apply until you save or reset.` }] }; }
}

/** Validate, write atomically, and refresh RULES.md for the agents. Returns the new revision. */
export function writeFloorRules(root: string, value: FloorRulesDoc): string {
  const doc = validateFloorRulesDoc(value);
  const text = floorRulesToYaml(doc);
  // Written only after the round trip parses back to the same document.
  if (JSON.stringify(validateFloorRulesDoc(parseFloorRulesYaml(text))) !== JSON.stringify(doc)) throw new Error('Floor rules could not be written faithfully');
  const path = join(root, FLOOR_RULES_FILE);
  mkdirSync(join(root, 'council/extensions'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  writeEffectiveRulesDoc(root, doc);
  return revisionOf(text);
}

const WHEN_LABEL: Record<RuleWhen, string> = {
  'always': 'At all times', 'on-start': 'When starting work', 'before-commit': 'Before committing',
  'before-push': 'Before pushing', 'before-pr': 'Before opening a pull request', 'before-done': 'Before marking work done',
};

/** The effective rules as agents read them. */
export function renderRulesMd(doc: FloorRulesDoc): string {
  const lines = [
    '<!-- Generated and managed by Paramount from Settings > Floor rules. Local edits are replaced. -->',
    '',
    '# Rules for this floor',
    '',
    'Read these before you start work on this floor, and follow them for every task.',
    '',
    '## Studio rules (always apply, cannot be changed)',
    '',
    ...STUDIO_RULES.map((rule) => `- ${rule.text}`),
    '',
    '## Floor rules (added for this floor)',
    '',
  ];
  if (!doc.rules.length) lines.push('_No extra rules. Only the Studio rules apply._', '');
  for (const when of RULE_WHENS) {
    const group = doc.rules.filter((rule) => rule.when === when);
    if (!group.length) continue;
    lines.push(`### ${WHEN_LABEL[when]}`, '', ...group.map((rule) => `- ${rule.text}`), '');
  }
  lines.push(
    'Floor rules add to the Studio rules. If a floor rule ever seems to conflict with a Studio rule, the Studio rule wins: follow it and tell Paramount.',
    '',
    `To suggest a new floor rule, write ONE JSON file into \`${SUGGESTION_DROP_DIR}/\` in the hive root: {"text": "the rule in one plain sentence", "reason": "why, in one simple sentence"}. The human reviews every suggestion; it is NOT a rule until they approve it.`,
    ''
  );
  return lines.join('\n');
}

export function writeEffectiveRulesDoc(root: string, doc?: FloorRulesDoc): void {
  writeFileSync(join(root, RULES_DOC), renderRulesMd(doc ?? readFloorRules(root).doc), 'utf8');
}

/** Best-effort refresh at hive bootstrap: never throws (a floor without RULES.md still runs). */
export function refreshEffectiveRulesDoc(root: string | null): void {
  if (!root) return;
  try { writeEffectiveRulesDoc(root); } catch { /* the next save or bootstrap retries */ }
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** The floor rule list after an edit: drafts that keep an existing id keep its source and time;
 *  the rest are new rules. Throws a plain message when the list would be invalid or unsafe. */
export function applyDraftRules(doc: FloorRulesDoc, drafts: readonly DraftRule[], now: string, source: FloorRule['source'] = 'you'): { doc: FloorRulesDoc; problems: RuleProblem[] } {
  const check = checkRules(drafts);
  if (hasErrors(check.problems)) return { doc, problems: check.problems };
  const byId = new Map(doc.rules.map((rule) => [rule.id, rule]));
  const used = new Set<string>();
  const rules = check.rules.map((rule): FloorRule => {
    const existing = rule.id ? byId.get(rule.id) : undefined;
    if (existing && !used.has(existing.id)) {
      used.add(existing.id);
      return { ...existing, text: rule.text, when: rule.when, kind: rule.kind };
    }
    return { id: newId('r'), text: rule.text, when: rule.when, kind: rule.kind, source, addedAt: now };
  });
  return { doc: { ...doc, rules }, problems: check.problems };
}

const toDrafts = (rules: readonly FloorRule[]): DraftRule[] => rules.map((rule) => ({ id: rule.id, text: rule.text }));

/** Approve (optionally reworded) or reject one queued suggestion. Approval runs the same checks as
 *  a save, so an unsafe suggestion can never become active. */
export function reviewSuggestion(doc: FloorRulesDoc, id: string, decision: 'approve' | 'reject', now: string, text?: string): { doc: FloorRulesDoc; problems: RuleProblem[]; found: boolean } {
  const suggestion = doc.suggestions.find((s) => s.id === id);
  if (!suggestion) return { doc, problems: [], found: false };
  const suggestions = doc.suggestions.filter((s) => s.id !== id);
  if (decision === 'reject') return { doc: { ...doc, suggestions }, problems: [], found: true };
  const wording = text === undefined ? suggestion.text : text;
  const drafts = [...toDrafts(doc.rules), { text: wording }];
  const check = checkRules(drafts);
  // Only problems with the approved rule (the last one) or the list as a whole matter here.
  const problems = check.problems.filter((p) => p.index === undefined || p.index === drafts.length - 1).map((p) => ({ ...p, index: undefined }));
  if (hasErrors(problems)) return { doc, problems, found: true };
  const approved = check.rules[check.rules.length - 1];
  const rule: FloorRule = { id: newId('r'), text: approved.text, when: approved.when, kind: approved.kind, source: 'paramount', addedAt: now };
  return { doc: { ...doc, rules: [...doc.rules, rule], suggestions }, problems, found: true };
}

/** Add suggestions to the queue, skipping any that repeat an active rule or a queued suggestion. */
export function queueSuggestions(doc: FloorRulesDoc, items: ReadonlyArray<{ text: string; reason?: string; from: string }>, now: string): { doc: FloorRulesDoc; added: number } {
  const known = new Set([...doc.rules, ...doc.suggestions].map((r) => core(r.text)));
  const suggestions = [...doc.suggestions];
  for (const item of items) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    const one = checkOne(item.text, 0);
    if (!one.checked || !AGENT.test(item.from)) continue;
    const key = core(one.checked.text);
    if (known.has(key)) continue;
    known.add(key);
    const reason = typeof item.reason === 'string' && item.reason.trim() && item.reason.length <= MAX_REASON && !/[\u0000-\u001f\u007f]/.test(item.reason) ? item.reason.trim() : undefined;
    suggestions.push({ id: newId('s'), text: one.checked.text, when: one.checked.when, kind: one.checked.kind, ...(reason ? { reason } : {}), from: item.from, suggestedAt: now });
  }
  return { doc: { ...doc, suggestions }, added: suggestions.length - doc.suggestions.length };
}

/** Move agent suggestion files from <hive>/rule-suggestions/ into the review queue. Read files go to
 *  .done/, malformed ones to .failed/; nothing an agent drops is ever applied without review. */
export function ingestSuggestionDrops(root: string, now: string): { items: Array<{ text: string; reason?: string; from: string }>; consumed: string[] } {
  const dir = join(root, SUGGESTION_DROP_DIR);
  if (!existsSync(dir)) return { items: [], consumed: [] };
  const items: Array<{ text: string; reason?: string; from: string }> = [];
  const consumed: string[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort().slice(0, MAX_DROPS_PER_PASS);
  for (const file of files) {
    const path = join(dir, file);
    let ok = false;
    try {
      if (statSync(path).isFile() && statSync(path).size <= MAX_DROP_BYTES) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const r = raw as Record<string, unknown>;
          const from = typeof r.from === 'string' && AGENT.test(r.from) ? r.from : 'paramount';
          if (typeof r.text === 'string' && checkOne(r.text, 0).checked) {
            items.push({ text: r.text, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}), from });
            ok = true;
          }
        }
      }
    } catch { ok = false; }
    const target = join(dir, ok ? '.done' : '.failed');
    try { mkdirSync(target, { recursive: true }); renameSync(path, join(target, `${now.replace(/[:.]/g, '-')}-${basename(file)}`)); consumed.push(file); }
    catch { /* left in place; the next pass retries */ }
  }
  return { items, consumed };
}

/** Rule suggestions from the floor's connected repos: their build, test, lint and type-check
 *  scripts. Read-only, and only the top-level manifest of each repo. */
export function suggestFromRepos(repos: readonly string[]): Array<{ text: string; reason: string; from: string }> {
  const out: Array<{ text: string; reason: string; from: string }> = [];
  for (const repo of repos.slice(0, 10)) {
    const name = basename(repo);
    try {
      const pkgPath = join(repo, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> };
        const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
        const pm = existsSync(join(repo, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(repo, 'yarn.lock')) ? 'yarn' : existsSync(join(repo, 'bun.lockb')) || existsSync(join(repo, 'bun.lock')) ? 'bun' : 'npm';
        const run = (script: string) => script === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${script}`;
        if (typeof scripts.build === 'string') out.push({ text: `Always run \`${run('build')}\` in ${name} before pushing changes.`, reason: `${name} has a build script; a broken build should never be pushed.`, from: 'paramount' });
        if (typeof scripts.typecheck === 'string') out.push({ text: `Run \`${run('typecheck')}\` in ${name} before committing.`, reason: `${name} has a type check that catches mistakes early.`, from: 'paramount' });
        if (typeof scripts.lint === 'string') out.push({ text: `Run \`${run('lint')}\` in ${name} before committing.`, reason: `${name} has a lint script that keeps the code consistent.`, from: 'paramount' });
        if (typeof scripts.test === 'string' && !/no test specified/.test(String(scripts.test))) out.push({ text: `Run \`${run('test')}\` in ${name} before marking a task done.`, reason: `${name} has tests; passing tests show the work is finished.`, from: 'paramount' });
      } else if (existsSync(join(repo, 'Cargo.toml'))) {
        out.push({ text: `Run \`cargo test\` in ${name} before pushing changes.`, reason: `${name} is a Rust project with cargo tests.`, from: 'paramount' });
      } else if (existsSync(join(repo, 'pyproject.toml'))) {
        out.push({ text: `Run the Python tests in ${name} before pushing changes.`, reason: `${name} is a Python project.`, from: 'paramount' });
      }
    } catch { /* an unreadable manifest gives no suggestion */ }
  }
  return out.slice(0, 12);
}

/** Starter ideas shown while a floor is created (no repos are connected yet). */
export const STARTER_RULES: readonly string[] = Object.freeze([
  'Always run the build before pushing changes.',
  'Run the tests before marking a task done.',
  'Keep pull requests small and focused on one change.',
  'Write a short summary of what changed in every pull request.',
]);

/** Everything the Floor rules panel shows. */
export function floorRulesState(root: string | null): FloorRulesState {
  const { doc, revision, problems } = readFloorRules(root);
  const active = toDrafts(doc.rules);
  return {
    studio: STUDIO_RULES.map((rule) => ({ ...rule })),
    rules: doc.rules,
    suggestions: doc.suggestions.map((s) => {
      const drafts = [...active, { text: s.text }];
      const check = checkRules(drafts);
      return { ...s, problems: check.problems.filter((p) => p.index === drafts.length - 1).map((p) => ({ ...p, index: undefined })) };
    }),
    revision,
    problems,
  };
}
