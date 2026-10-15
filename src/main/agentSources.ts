/**
 * Read-only adapters that list agent definitions from existing setups so
 * Paramount can import them:
 *   claude  ~/.claude/agents/*.md and <project>/.claude/agents/*.md (YAML frontmatter)
 *   codex   ~/.codex/agents/*.toml|*.md, ~/.codex/AGENTS.md, <project>/AGENTS.md,
 *           and ~/.codex/config.toml [profiles.*] (model only)
 *   munder  a Munder/Paramount hive dir: registry.json + agents/<id>/identity.md
 *
 * Rules:
 *   - Strictly read-only. Nothing here writes, renames or creates a file.
 *   - ALLOWLIST: only the file shapes above are opened. Credential, env,
 *     session and history files are refused by name even if a root points at them.
 *   - A missing root yields no agents and no warning. Every other unreadable or
 *     malformed file yields a warning with its path and an errorId; it is never
 *     skipped silently.
 *
 * No Electron import: index.ts supplies the roots, tests drive this directly.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ParamountAgentDiscovery, ParamountAgentSource, ParamountDiscoveredAgent, ParamountSourceWarning } from '../preload/paramount';
import { newErrorId } from './paramountObservability';

export const AGENT_SOURCES: readonly ParamountAgentSource[] = ['claude', 'codex', 'munder'];
/** Agent definitions are prompts, not data dumps; anything bigger is refused. */
export const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_DIR = 500;

export interface AgentSourceRoots {
  /** Directory holding `agents/` for Claude Code user agents (default ~/.claude). */
  claudeHome: string;
  /** Codex home (default ~/.codex). */
  codexHome: string;
  /** Munder/Paramount hive dir; null when none is configured. */
  munderHive: string | null;
  /** Set when resolving the default Munder hive itself failed. */
  munderHiveWarning?: ParamountSourceWarning;
}

export interface DiscoverOptions {
  sources?: readonly ParamountAgentSource[];
  /** Adds <projectDir>/.claude/agents and <projectDir>/AGENTS.md. */
  projectDir?: string;
}

/** A discovered agent plus what the import step needs. Internal only. */
export interface FoundAgent {
  agent: ParamountDiscoveredAgent;
  /** Instruction text already read during discovery. */
  instructions?: string;
  /** Read the instruction text on demand (munder identity.md). */
  loadInstructions?: (warnings: ParamountSourceWarning[]) => string | undefined;
  /** Munder registry provider, passed through to the hire manifest. */
  provider?: string;
  capabilities?: string[];
}

// ─── allowlisted reads ──────────────────────────────────────────────────────
/** Names that are never opened, whatever a root points at. */
const REFUSED_NAME = /^(auth\.json|\.credentials.*|.*\.token|\.env(\..*)?|.*histor(y|ies).*|.*sessions?.*)$/i;

export function warn(path: string, message: string): ParamountSourceWarning {
  return { errorId: newErrorId(), path, message };
}

function errMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const text = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${text}` : text;
}

/** List a directory's entries. ENOENT is "no agents here", not a warning. */
function listDir(dir: string, warnings: ParamountSourceWarning[]): string[] {
  try {
    const names = readdirSync(dir).sort();
    if (names.length > MAX_FILES_PER_DIR) {
      warnings.push(warn(dir, `directory has ${names.length} entries; only the first ${MAX_FILES_PER_DIR} were read`));
      return names.slice(0, MAX_FILES_PER_DIR);
    }
    return names;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    warnings.push(warn(dir, `could not list directory (${errMessage(error)})`));
    return [];
  }
}

/** Read one allowlisted file. `optional` turns ENOENT into undefined without a warning. */
function readAllowed(path: string, warnings: ParamountSourceWarning[], optional = false): string | undefined {
  if (REFUSED_NAME.test(basename(path))) {
    warnings.push(warn(path, 'refused: credential, env, session or history files are never read'));
    return undefined;
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      warnings.push(warn(path, 'not a regular file'));
      return undefined;
    }
    if (st.size > MAX_AGENT_FILE_BYTES) {
      warnings.push(warn(path, `file is ${st.size} bytes; the limit is ${MAX_AGENT_FILE_BYTES}`));
      return undefined;
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    warnings.push(warn(path, `could not read file (${errMessage(error)})`));
    return undefined;
  }
}

// ─── minimal YAML frontmatter ───────────────────────────────────────────────
export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
  errors: string[];
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Parses the flat `key: value` frontmatter agent files use: scalars, quoted
 *  strings, `[a, b]` and `- a` lists, and `|` / `>` block scalars. Returns null
 *  when the text has no frontmatter block at all. */
export function parseFrontmatter(text: string): Frontmatter | null {
  const src = text.replace(/^﻿/, '');
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return { data: {}, body: '', errors: ['frontmatter is not closed with "---"'] };
  const data: Record<string, string | string[]> = {};
  const errors: string[] = [];
  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) { errors.push(`frontmatter line ${i + 1} is not "key: value"`); i++; continue; }
    const [, key, rest] = m;
    i++;
    if (/^[|>][+-]?$/.test(rest.trim())) {
      const block: string[] = [];
      while (i < end && (lines[i].trim() === '' || /^\s/.test(lines[i]))) block.push(lines[i++].trim());
      data[key] = rest.trim().startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (rest.trim() === '') {
      const items: string[] = [];
      while (i < end && /^\s*-\s+/.test(lines[i])) items.push(unquote(lines[i++].replace(/^\s*-\s+/, '')));
      data[key] = items.length ? items : '';
    } else if (rest.trim().startsWith('[') && rest.trim().endsWith(']')) {
      data[key] = rest.trim().slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(rest);
    }
  }
  return { data, body: lines.slice(end + 1).join('\n').trim(), errors };
}

// ─── minimal TOML ───────────────────────────────────────────────────────────
export interface TomlDoc {
  /** Table name ('' = root) -> key -> string value (non-strings kept as raw text). */
  tables: Map<string, Record<string, string>>;
  errors: string[];
}

function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      if (c === '\\' && quote === '"') k++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '#') break;
  }
  return depth <= 0;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
function unescapeBasic(text: string): string {
  return text.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (all, esc: string) =>
    esc.length > 1 ? String.fromCodePoint(parseInt(esc.slice(1), 16)) : ESCAPES[esc] ?? all);
}

/** Enough TOML for agent files and config profiles: tables, dotted/quoted
 *  keys, basic/literal/multi-line strings. Other values are kept as raw text.
 *  Errors carry line numbers only, never content (config.toml may hold secrets). */
export function parseToml(text: string): TomlDoc {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const tables = new Map<string, Record<string, string>>([['', {}]]);
  const errors: string[] = [];
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1].split('.').map((part) => unquote(part)).join('.');
      if (!tables.has(table)) tables.set(table, {});
      continue;
    }
    const kv = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$/.exec(line);
    if (!kv) { errors.push(`line ${i + 1} is not "key = value"`); continue; }
    const keyPath = kv[1].split(/\s*\.\s*/).map(unquote);
    const key = keyPath.pop()!;
    const target = [table, ...keyPath].filter(Boolean).join('.');
    let value = kv[2];
    const start = i + 1;
    const triple = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
    if (triple) {
      let body = value.slice(3);
      while (!body.includes(triple) && i + 1 < lines.length) body += '\n' + lines[++i];
      const close = body.indexOf(triple);
      if (close < 0) { errors.push(`line ${start}: multi-line string is not closed`); break; }
      let str = body.slice(0, close).replace(/^\r?\n/, '');
      if (triple === '"""') str = unescapeBasic(str.replace(/\\\r?\n\s*/g, ''));
      value = str;
    } else {
      while (!balanced(value) && i + 1 < lines.length) value += '\n' + lines[++i];
      value = value.trim();
      const basic = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(value);
      const literal = /^'([^']*)'\s*(#.*)?$/.exec(value);
      if (basic) {
        value = unescapeBasic(basic[1]);
      } else if (literal) value = literal[1];
      else if (value.startsWith('"') || value.startsWith("'")) { errors.push(`line ${start}: string is not closed`); continue; }
      else value = value.replace(/\s+#.*$/, '');
    }
    if (!tables.has(target)) tables.set(target, {});
    tables.get(target)![key] = value;
  }
  return { tables, errors };
}

// ─── adapters ───────────────────────────────────────────────────────────────
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function list(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = items.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : undefined;
}
/** First markdown heading or first non-empty line, as a one-line description. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && l !== '---') ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 300);
}

/** A markdown agent file with YAML frontmatter (Claude Code; also Codex .md agents). */
function markdownAgent(source: ParamountAgentSource, origin: 'user' | 'project', path: string, warnings: ParamountSourceWarning[]): FoundAgent | null {
  const text = readAllowed(path, warnings);
  if (text === undefined) return null;
  const fm = parseFrontmatter(text);
  if (!fm) { warnings.push(warn(path, 'no YAML frontmatter ("---" block with name and description); not an agent file')); return null; }
  const own: ParamountSourceWarning[] = fm.errors.map((e) => warn(path, e));
  if (fm.errors.some((e) => e.includes('not closed'))) { warnings.push(...own); return null; }
  const stem = basename(path, extname(path));
  const name = str(fm.data.name);
  if (!name) own.push(warn(path, `frontmatter has no "name"; using the file name "${stem}"`));
  const description = str(fm.data.description);
  if (!description) own.push(warn(path, 'frontmatter has no "description"'));
  const model = str(fm.data.model);
  const tools = list(fm.data.tools);
  return {
    agent: {
      source, id: `${origin}:${stem}`, name: name ?? stem, description: description ?? '',
      ...(model ? { model } : {}), ...(tools ? { tools } : {}),
      instructionsPath: path, origin, warnings: own
    },
    instructions: fm.body
  };
}

function claudeAgents(roots: AgentSourceRoots, projectDir: string | undefined, warnings: ParamountSourceWarning[]): { found: FoundAgent[]; scanned: string[] } {
  const dirs: Array<[string, 'user' | 'project']> = [[join(roots.claudeHome, 'agents'), 'user']];
  if (projectDir) dirs.push([join(projectDir, '.claude', 'agents'), 'project']);
  const found: FoundAgent[] = [];
  for (const [dir, origin] of dirs) {
    for (const name of listDir(dir, warnings)) {
      if (extname(name) !== '.md') continue;
      const agent = markdownAgent('claude', origin, join(dir, name), warnings);
      if (agent) found.push(agent);
    }
  }
  return { found, scanned: dirs.map(([dir]) => dir) };
}

function agentsMd(path: string, origin: 'user' | 'project', label: string, warnings: ParamountSourceWarning[]): FoundAgent | null {
  const text = readAllowed(path, warnings, true);
  if (text === undefined) return null;
  const own = text.trim() ? [] : [warn(path, 'AGENTS.md is empty')];
  return {
    agent: {
      source: 'codex', id: `${origin}:AGENTS.md`, name: label, description: firstLine(text),
      instructionsPath: path, origin, warnings: own
    },
    instructions: text.trim()
  };
}

function codexAgents(roots: AgentSourceRoots, projectDir: string | undefined, warnings: ParamountSourceWarning[]): { found: FoundAgent[]; scanned: string[] } {
  const found: FoundAgent[] = [];
  const agentsDir = join(roots.codexHome, 'agents');
  for (const name of listDir(agentsDir, warnings)) {
    const path = join(agentsDir, name);
    if (extname(name) === '.md') {
      const agent = markdownAgent('codex', 'user', path, warnings);
      if (agent) found.push(agent);
      continue;
    }
    if (extname(name) !== '.toml') continue;
    const text = readAllowed(path, warnings);
    if (text === undefined) continue;
    const doc = parseToml(text);
    const own = doc.errors.map((e) => warn(path, e));
    const root = doc.tables.get('')!;
    const stem = basename(name, '.toml');
    if (!str(root.name)) own.push(warn(path, `no "name"; using the file name "${stem}"`));
    if (!str(root.description)) own.push(warn(path, 'no "description"'));
    const instructions = str(root.developer_instructions) ?? str(root.instructions);
    if (!instructions) own.push(warn(path, 'no "developer_instructions"'));
    const model = str(root.model);
    found.push({
      agent: {
        source: 'codex', id: `user:agents/${stem}`, name: str(root.name) ?? stem, description: str(root.description) ?? '',
        ...(model ? { model } : {}), instructionsPath: path, origin: 'user', warnings: own
      },
      instructions
    });
  }
  const userMd = agentsMd(join(roots.codexHome, 'AGENTS.md'), 'user', 'Codex global AGENTS.md', warnings);
  if (userMd) found.push(userMd);
  if (projectDir) {
    const projectMd = agentsMd(join(projectDir, 'AGENTS.md'), 'project', `${basename(projectDir)} AGENTS.md`, warnings);
    if (projectMd) found.push(projectMd);
  }
  // config.toml: profiles carry a model only. Nothing else from this file is
  // returned or logged; it can hold MCP env values.
  const configPath = join(roots.codexHome, 'config.toml');
  const config = readAllowed(configPath, warnings, true);
  if (config !== undefined) {
    const doc = parseToml(config);
    warnings.push(...doc.errors.map((e) => warn(configPath, e)));
    for (const [table, values] of doc.tables) {
      const m = /^profiles\.([^.]+)$/.exec(table);
      if (!m) continue;
      const model = str(values.model);
      found.push({
        agent: {
          source: 'codex', id: `user:profile:${m[1]}`, name: m[1], description: `Codex profile "${m[1]}"`,
          ...(model ? { model } : {}), instructionsPath: configPath, origin: 'user',
          warnings: model ? [] : [warn(configPath, `profile "${m[1]}" has no "model"`)]
        }
      });
    }
  }
  const scanned = [agentsDir, join(roots.codexHome, 'AGENTS.md'), configPath];
  if (projectDir) scanned.push(join(projectDir, 'AGENTS.md'));
  return { found, scanned };
}

/** Registry ids become path segments, so only plain names are accepted. */
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function munderAgents(roots: AgentSourceRoots, warnings: ParamountSourceWarning[]): { found: FoundAgent[]; scanned: string[] } {
  if (roots.munderHiveWarning) warnings.push(roots.munderHiveWarning);
  const hive = roots.munderHive;
  if (!hive) return { found: [], scanned: [] };
  const registryPath = join(hive, 'registry.json');
  const text = readAllowed(registryPath, warnings, true);
  if (text === undefined) return { found: [], scanned: [registryPath] };
  let registry: unknown;
  try { registry = JSON.parse(text); } catch (error) {
    warnings.push(warn(registryPath, `registry.json is not valid JSON (${errMessage(error)})`));
    return { found: [], scanned: [registryPath] };
  }
  const agents = (registry as { agents?: unknown })?.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    warnings.push(warn(registryPath, 'registry.json has no "agents" object'));
    return { found: [], scanned: [registryPath] };
  }
  const found: FoundAgent[] = [];
  for (const key of Object.keys(agents).sort()) {
    const record = (agents as Record<string, unknown>)[key];
    if (!SAFE_AGENT_ID.test(key) || !record || typeof record !== 'object') {
      warnings.push(warn(registryPath, `agent entry ${JSON.stringify(key.slice(0, 80))} is malformed or has an unsafe id`));
      continue;
    }
    const r = record as Record<string, unknown>;
    const identity = join(hive, 'agents', key, 'identity.md');
    const own: ParamountSourceWarning[] = [];
    try {
      if (!statSync(identity).isFile()) own.push(warn(identity, 'identity.md is not a regular file'));
    } catch (error) {
      own.push(warn(identity, `identity.md is not readable (${errMessage(error)})`));
    }
    const name = str(r.name);
    if (!name) own.push(warn(registryPath, `agent "${key}" has no name; using its id`));
    const capabilities = list(r.capabilities);
    found.push({
      agent: {
        source: 'munder', id: key, name: name ?? key, description: str(r.role) ?? '',
        instructionsPath: identity, origin: 'user', warnings: own
      },
      loadInstructions: (w) => readAllowed(identity, w),
      provider: str(r.provider),
      ...(capabilities ? { capabilities } : {})
    });
  }
  return { found, scanned: [registryPath] };
}

/** Resolve the installed Munder app's hive: `<appData>/munder-difflin/config.json`
 *  -> `harnessHome` -> `<harnessHome>/hive`. Only `harnessHome` is read from
 *  the config; a missing config means no Munder hive. */
export function defaultMunderHive(appDataDir: string): { hive: string | null; warning?: ParamountSourceWarning } {
  const configPath = join(appDataDir, 'munder-difflin', 'config.json');
  const warnings: ParamountSourceWarning[] = [];
  const text = readAllowed(configPath, warnings, true);
  if (warnings.length) return { hive: null, warning: warnings[0] };
  if (text === undefined) return { hive: null };
  try {
    const home = (JSON.parse(text) as { harnessHome?: unknown }).harnessHome;
    return typeof home === 'string' && home.trim() ? { hive: join(home, 'hive') } : { hive: null };
  } catch (error) {
    return { hive: null, warning: warn(configPath, `Munder config is not valid JSON (${errMessage(error)})`) };
  }
}

/** Discovery with the internal fields the import step needs. */
export function findAgents(roots: AgentSourceRoots, options: DiscoverOptions = {}): { found: FoundAgent[]; warnings: ParamountSourceWarning[]; roots: ParamountAgentDiscovery['roots'] } {
  const sources = options.sources?.length ? options.sources : AGENT_SOURCES;
  const warnings: ParamountSourceWarning[] = [];
  const scanned: ParamountAgentDiscovery['roots'] = { claude: [], codex: [], munder: [] };
  const found: FoundAgent[] = [];
  for (const source of AGENT_SOURCES) {
    if (!sources.includes(source)) continue;
    const result = source === 'claude' ? claudeAgents(roots, options.projectDir, warnings)
      : source === 'codex' ? codexAgents(roots, options.projectDir, warnings)
        : munderAgents(roots, warnings);
    found.push(...result.found);
    scanned[source] = result.scanned;
  }
  return { found, warnings, roots: scanned };
}

export function discoverAgents(roots: AgentSourceRoots, options: DiscoverOptions = {}): ParamountAgentDiscovery {
  const { found, warnings, roots: scanned } = findAgents(roots, options);
  return { agents: found.map((f) => f.agent), warnings, roots: scanned };
}
