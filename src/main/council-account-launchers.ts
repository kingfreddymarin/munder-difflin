/** Council extension. Queries alias/function tables without invoking launchers.
 * Resolved definitions are data: only a bounded, declarative subset is accepted. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

const KNOWN = { dc: true, dcm: true, dcx: true, dcxm: true } as const;
export const LAUNCHER_AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const;
export interface LauncherChoice { id: string; provider: string; label: string; fingerprint: string; unrestricted: boolean }
export interface LauncherPick { id: string; fingerprint: string; allowUnrestricted?: boolean }
export interface LauncherDiscovery { status: 'ok' | 'failed' | 'timeout'; choices: LauncherChoice[]; message?: string }
interface Profile extends LauncherChoice { bin: string; args: string[]; home: string }
interface Discovery extends LauncherDiscovery { profiles: Profile[] }
const errorText = 'Launcher discovery failed. Check declarative aliases/functions in your shell startup files and refresh. No launcher was executed.';

function words(text: string): string[] {
  // No shell evaluation: only quoting, HOME expansion and literal words.
  if (/[`\n\r\0;&|<>]/.test(text) || /\$(?!HOME\b|\{HOME\})/.test(text)) throw new Error('unsupported definition');
  const out: string[] = [];
  const re = /"([^"\n]*)"|'([^'\n]*)'|([^\s"']+)/gy;
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new Error('unsupported quoting');
    out.push(m[1] ?? m[2] ?? m[3]); i = re.lastIndex;
  }
  return out;
}
function profile(id: keyof typeof KNOWN, definition: string, home: string, inheritedHomes: Record<string, string> = {}): Profile {
  let body = definition.trim();
  let unsetKey: string | undefined;
  if (body.startsWith('{') && body.endsWith('}')) {
    body = body.slice(1, -1).trim();
    if (!/\s+"\$@"\s*;?$/.test(body)) throw new Error('function must forward argv');
    body = body.replace(/\s+"\$@"\s*;?$/, '');
    const unset = /^unset\s+(CLAUDE_CONFIG_DIR|CODEX_HOME)\s*(?:;|\n)\s*/.exec(body);
    if (unset) { unsetKey = unset[1]; body = body.slice(unset[0].length); }
    if (/[\n\r]/.test(body.trim())) throw new Error('unsupported function');
  }
  body = body.replace(/^(?:env|command)\s+/, '');
  const assignment = /^(CLAUDE_CONFIG_DIR|CODEX_HOME)=("[^"]*"|'[^']*'|[^\s]+)\s+/.exec(body);
  let explicitHome: string | undefined;
  if (assignment) {
    if (unsetKey) throw new Error('conflicting home');
    explicitHome = words(assignment[2])[0].replace(/^~(?=\/)|\$\{HOME\}|\$HOME\b/g, home);
    body = body.slice(assignment[0].length).replace(/^command\s+/, '');
  }
  const tokens = words(body);
  const bin = tokens.shift() ?? '';
  const provider = basename(bin);
  if (!['claude', 'codex'].includes(provider) || (!isAbsolute(bin) && bin !== provider)) throw new Error('unsupported provider');
  const homeKey = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  if ((unsetKey && unsetKey !== homeKey) || (assignment && assignment[1] !== homeKey)) throw new Error('provider/home mismatch');
  const defaultHome = join(home, provider === 'claude' ? '.claude' : '.codex');
  const selectedHome = explicitHome ?? (unsetKey ? defaultHome : inheritedHomes[homeKey] || defaultHome);
  const account = selectedHome === defaultHome ? 'Main' : 'Alternate';
  if (!isAbsolute(selectedHome) || /[\0\r\n]/.test(selectedHome)) throw new Error('invalid home');
  // No arbitrary config/auth/env overrides. Extend deliberately as formats evolve.
  const permitted = provider === 'claude' ? ['--dangerously-skip-permissions'] : ['--yolo', '--dangerously-bypass-approvals-and-sandbox'];
  if (tokens.some((arg) => !permitted.includes(arg))) throw new Error('unsupported launcher arguments');
  return { id, provider, label: `${id} · ${account}`, fingerprint: createHash('sha256').update(definition).update(home).update(selectedHome).digest('hex'), unrestricted: tokens.length > 0, bin, args: tokens, home: selectedHome };
}

export function discoverLaunchers(): Discovery { return discoverShellLaunchers(); }

/** Discovery runs the user's login shell, so main keeps ONE result and reruns it
 *  only on an explicit refresh (setup screen, "Refresh launchers"). Snapshots and
 *  screens read `current()`; the first read discovers once.
 *  With `discoverAsync` (owner use of 8f574966: beach ball), warm() and refresh() run the shell off
 *  the main thread; current() blocks only when nothing has been discovered yet. */
export function createLauncherDiscoveryCache(discover: () => Discovery = discoverLaunchers, discoverAsync?: () => Promise<Discovery>): { current(): Discovery; peek(): Discovery | undefined; refresh(): Discovery | Promise<Discovery>; warm(): Promise<Discovery> | undefined } {
  let cached: Discovery | undefined;
  let pending: Promise<Discovery> | undefined;
  const runAsync = (): Promise<Discovery> => {
    const run = (pending ??= (discoverAsync as () => Promise<Discovery>)().then((d) => { cached = d; return d; }).finally(() => { pending = undefined; }));
    return run;
  };
  return {
    current: () => (cached ??= discover()),
    peek: () => cached,
    refresh: () => (discoverAsync ? runAsync() : (cached = discover())),
    warm: () => (discoverAsync && !cached ? runAsync() : undefined),
  };
}

/** discoverShellLaunchers with the login shell run as a child process, off the main thread. */
export async function discoverLaunchersAsync(): Promise<Discovery> {
  // Same probe, gathered asynchronously, then parsed by the synchronous code path.
  const shell = process.env.SHELL || '/bin/zsh';
  let captured: ProbeResult = { stdout: '', status: null, error: { code: 'ENOENT' } };
  let script = '';
  // Capture the script the sync path would run, without running it.
  discoverShellLaunchers((_exe, text) => { script = text; return { stdout: '', status: 1 }; }, 2000, homedir(), shell);
  if (script) {
    captured = await new Promise<ProbeResult>((done) => {
      let out = ''; let timedOut = false;
      const child = spawn(shell, ['-lic', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 2000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { if (out.length <= 256_000) out += d; });
      child.on('error', (e) => { clearTimeout(timer); done({ stdout: '', status: null, error: { code: (e as NodeJS.ErrnoException).code } }); });
      child.on('close', (status) => { clearTimeout(timer); done(timedOut ? { stdout: '', status: null, error: { code: 'ETIMEDOUT' } } : { stdout: out, status }); });
    });
  }
  return discoverShellLaunchers(() => captured, 2000, homedir(), shell);
}
const NOT_DISCOVERED: Discovery = { status: 'failed', choices: [], profiles: [], message: 'Launchers have not been discovered yet. Refresh launchers.' };

interface ProbeResult { stdout: string; status: number | null; error?: { code?: string } }
type Probe = (shell: string, script: string, timeout: number) => ProbeResult;
/** Normal shell startup resolves conditional definitions, removals, precedence
 * and sourced files. The probe itself only reads shell tables using builtins;
 * no launcher name is ever used as a command. Startup chatter is discarded. */
export function discoverShellLaunchers(probe?: Probe, timeoutMs = 2000, home = homedir(), shell = process.env.SHELL || '/bin/zsh'): Discovery {
  const kind = basename(shell);
  if (!['zsh', 'bash'].includes(kind) || !['/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash'].includes(shell)) return { status: 'failed', choices: [], profiles: [], message: errorText };
  const common = `for council_launcher_name in dc dcm dcx dcxm; do\n`;
  const lookup = kind === 'zsh' ? `
if (( \${+aliases[$council_launcher_name]} )); then
  council_launcher_kind=alias
  council_launcher_definition="\${aliases[$council_launcher_name]}"
elif (( \${+functions[$council_launcher_name]} )); then
  council_launcher_kind=function
  council_launcher_definition="{\n\${functions[$council_launcher_name]}\n}"
else
  council_launcher_kind=absent
  council_launcher_definition=''
fi
` : `
if council_launcher_definition="$(builtin alias "$council_launcher_name" 2>/dev/null)"; then
  council_launcher_kind=alias
elif [[ "$(builtin type -t "$council_launcher_name")" == function ]]; then
  council_launcher_kind=function
  council_launcher_definition="$(builtin declare -f "$council_launcher_name")"
else
  council_launcher_kind=absent
  council_launcher_definition=''
fi
`;
  // printf's NUL framing prevents arbitrary startup output or newlines inside a
  // definition from becoming fabricated records. No raw output reaches IPC/logs.
  const script = common + lookup + `builtin printf '\\000COUNCIL_LAUNCHER_V1\\000%s\\000%s\\000%s\\000%s\\000%s\\000%s\\000' "$council_launcher_name" "$council_launcher_kind" "$council_launcher_definition" "$HOME" "\${CLAUDE_CONFIG_DIR-}" "\${CODEX_HOME-}"\ndone\n`;
  try {
    const run: Probe = probe ?? ((exe, text, timeout) => {
      const result = spawnSync(exe, ['-lic', text], { encoding: 'utf8', timeout, maxBuffer: 256_000, killSignal: 'SIGKILL', windowsHide: true });
      return { stdout: result.stdout || '', status: result.status, ...(result.error ? { error: { code: (result.error as NodeJS.ErrnoException).code } } : {}) };
    });
    const result = run(shell, script, timeoutMs);
    if (result.error?.code === 'ETIMEDOUT') return { status: 'timeout', choices: [], profiles: [], message: 'Launcher discovery timed out. Refresh to try again.' };
    if (result.error || result.status !== 0 || result.stdout.length > 256_000) throw new Error('probe failed');
    const records = result.stdout.split('\0COUNCIL_LAUNCHER_V1\0').slice(1);
    if (records.length !== 4) throw new Error('incomplete probe');
    const seen = new Set<string>(); const profiles: Profile[] = [];
    for (const record of records) {
      const [id, type, rawDefinition, shellHome, claudeHome, codexHome] = record.split('\0');
      let definition = rawDefinition;
      if (!Object.hasOwn(KNOWN, id) || seen.has(id) || !['alias', 'function', 'absent'].includes(type)) throw new Error('invalid probe');
      seen.add(id);
      if (kind === 'bash' && type === 'alias') {
        const match = new RegExp(`^alias ${id}='([\\s\\S]*)'$`).exec(definition);
        if (!match) throw new Error('unsupported alias quoting');
        definition = match[1];
      }
      if (kind === 'bash' && type === 'function') {
        const open = definition.indexOf('{');
        if (open < 0) throw new Error('unsupported function');
        definition = definition.slice(open);
      }
      if (type !== 'absent') {
        if (!shellHome || !isAbsolute(shellHome)) throw new Error('invalid shell home');
        try { profiles.push(profile(id as keyof typeof KNOWN, definition, shellHome, { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })); }
        catch { return { status: 'failed', choices: [], profiles: [], message: `Unsupported mapping for ${id}. Use a direct Claude/Codex executable with its matching account-home variable and argument forwarding, then refresh.` }; }
      }
    }
    return { status: 'ok', profiles, choices: profiles.map(({ bin: _b, args: _a, home: _h, ...choice }) => choice) };
  } catch { return { status: 'failed', choices: [], profiles: [], message: errorText }; }
}
export function launcherDisplayCommand(command: string): string {
  return command.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
}
export function publicDiscovery(discovery: Discovery = NOT_DISCOVERED): LauncherDiscovery {
  return { status: discovery.status, choices: discovery.choices, ...(discovery.message ? { message: discovery.message } : {}) };
}
export function validateLauncher(pick: unknown, provider: string, discovery: Discovery = NOT_DISCOVERED): Profile {
  if (!pick || typeof pick !== 'object' || Array.isArray(pick)) throw new Error('Choose an account launcher again.');
  const p = pick as LauncherPick;
  if (Object.keys(p).some((k) => !['id', 'fingerprint', 'allowUnrestricted'].includes(k)) || (p.allowUnrestricted !== undefined && typeof p.allowUnrestricted !== 'boolean')) throw new Error('Invalid launcher selection.');
  if (discovery.status !== 'ok') throw new Error(discovery.message);
  const found = discovery.profiles.find((f) => f.id === p.id);
  if (!found) throw new Error('Selected launcher is no longer available. Refresh and choose an account launcher.');
  if (found.fingerprint !== p.fingerprint) throw new Error('Selected launcher changed. Refresh and explicitly select it again.');
  if (found.provider !== provider) throw new Error('Selected launcher does not match this provider.');
  if (found.unrestricted && p.allowUnrestricted !== true) throw new Error('This launcher enables unrestricted execution. Explicit consent is required.');
  return found;
}
export interface LauncherState { version: 1; orchestrator?: LauncherPick; temps?: LauncherPick; agents: Record<string, LauncherPick>; defaults?: Record<string, LauncherPick> }
function statePath(root: string): string { return join(root, 'council', 'extensions', 'account-launchers.json'); }
const UNREADABLE = 'Council launcher settings are unreadable or unsupported; repair council/extensions/account-launchers.json before starting a selected account.';
const validPick = (pick: unknown): pick is LauncherPick => !!pick && typeof pick === 'object' && !Array.isArray(pick)
  && !Object.keys(pick).some((k) => !['id', 'fingerprint', 'allowUnrestricted'].includes(k))
  && typeof (pick as LauncherPick).id === 'string' && Object.hasOwn(KNOWN, (pick as LauncherPick).id) && /^[a-f0-9]{64}$/.test(String((pick as LauncherPick).fingerprint))
  && ((pick as LauncherPick).allowUnrestricted === undefined || typeof (pick as LauncherPick).allowUnrestricted === 'boolean');
/** Keys of saved picks that fail validation: 'orchestrator', 'temps', 'agent:<id>', 'default:<provider>'. */
const brokenPicks = new WeakMap<LauncherState, Set<string>>();
export function readLauncherState(root: string | null): LauncherState {
  if (!root || !existsSync(statePath(root))) return { version: 1, agents: {} };
  try {
    const v = JSON.parse(readFileSync(statePath(root), 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !['version', 'agents', 'orchestrator', 'temps', 'defaults'].includes(k)) || v.version !== 1 || !v.agents || typeof v.agents !== 'object' || Array.isArray(v.agents)) throw new Error();
    if (v.defaults !== undefined && (!v.defaults || typeof v.defaults !== 'object' || Array.isArray(v.defaults) || Object.keys(v.defaults).some((k) => !['claude', 'codex'].includes(k)))) throw new Error();
    // A bad entry is kept as written (a later save must not erase it) and marked,
    // so only the spawns that would use it fail.
    const broken = new Set<string>();
    for (const [key, pick] of [['orchestrator', v.orchestrator], ['temps', v.temps], ...Object.entries(v.agents).map(([id, p]) => [`agent:${id}`, p]), ...Object.entries(v.defaults ?? {}).map(([id, p]) => [`default:${id}`, p])] as Array<[string, unknown]>) {
      if (pick !== undefined && !validPick(pick)) broken.add(key);
    }
    brokenPicks.set(v, broken);
    return v;
  } catch { throw new Error(UNREADABLE); }
}
/** Saved picks with the broken ones left out, for screens. */
export function displayLauncherState(state: LauncherState): LauncherState {
  const broken = brokenPicks.get(state) ?? new Set<string>();
  const keep = (key: string, pick?: LauncherPick) => (pick !== undefined && !broken.has(key) ? pick : undefined);
  const agents = Object.fromEntries(Object.entries(state.agents).filter(([id]) => !broken.has(`agent:${id}`)));
  const defaults = state.defaults && Object.fromEntries(Object.entries(state.defaults).filter(([p]) => !broken.has(`default:${p}`)));
  const orchestrator = keep('orchestrator', state.orchestrator); const temps = keep('temps', state.temps);
  return { version: 1, agents, ...(orchestrator ? { orchestrator } : {}), ...(temps ? { temps } : {}), ...(defaults ? { defaults } : {}) };
}
export function saveLauncherPick(root: string, scope: 'orchestrator' | 'temps' | 'agent' | 'default', pick: LauncherPick | null, agentId?: string): void {
  const state = readLauncherState(root);
  if (scope === 'default') {
    if (!['claude', 'codex'].includes(agentId ?? '')) throw new Error('Invalid default provider');
    state.defaults ??= {}; if (pick) state.defaults[agentId!] = pick; else delete state.defaults[agentId!];
  }
  else if (scope === 'agent') { if (!agentId || ['__proto__', 'constructor', 'prototype'].includes(agentId)) throw new Error('Invalid agent id'); if (pick) state.agents[agentId] = pick; else delete state.agents[agentId]; }
  else if (pick) state[scope] = pick; else delete state[scope];
  const path = statePath(root); mkdirSync(join(root, 'council', 'extensions'), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path);
}
export function runtimeLauncher(root: string | null, agentId: string | undefined, isGod: boolean, isTemp: boolean, explicit?: LauncherPick | null, provider?: string, isNew = false): LauncherPick | undefined {
  if (explicit !== undefined) return explicit ?? undefined;
  // Launchers exist only for Claude and Codex; other engines never read the file.
  if (provider !== undefined && !['claude', 'codex'].includes(provider)) return undefined;
  // An unreadable file still throws: it is the only record of which agents use an
  // account, so a Claude/Codex spawn cannot tell whether it should use one.
  const state = readLauncherState(root);
  const broken = brokenPicks.get(state) ?? new Set<string>();
  const key = isGod ? 'orchestrator'
    : agentId && Object.hasOwn(state.agents, agentId) ? `agent:${agentId}`
    : !isNew ? undefined
    : isTemp && state.temps !== undefined ? 'temps'
    : state.defaults && Object.hasOwn(state.defaults, provider ?? '') ? `default:${provider}` : undefined;
  if (key && broken.has(key)) throw new Error(UNREADABLE);
  if (!key) return undefined;
  return key === 'orchestrator' ? state.orchestrator : key === 'temps' ? state.temps
    : key.startsWith('agent:') ? state.agents[agentId!] : state.defaults?.[provider ?? ''];
}
export function launcherEnvironment(p: Profile): Record<string, string> {
  // Set the canonical default home explicitly for `unset`, avoiding an inherited
  // alternate account. Never copy credentials or mutate process.env.
  return { [p.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: p.home };
}
export function launcherSessionExists(home: string, provider: string, sid: string): boolean {
  if (!/^[a-zA-Z0-9-]{1,160}$/.test(sid)) return false;
  let count = 0;
  const visit = (dir: string, depth: number): boolean => {
    if (depth > 4 || ++count > 3000 || !existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() ? visit(join(dir, e.name), depth + 1) : e.isFile() && e.name.endsWith(`${sid}.jsonl`));
  };
  try { return visit(join(home, provider === 'claude' ? 'projects' : 'sessions'), 0); } catch { return false; }
}

/** Shared runtime boundary used by every spawn, including restores and temps. */
/** The engine a launcher pick runs, from discovery; undefined when it is not (or no longer) discovered. */
export function launcherProvider(pick: LauncherPick | null | undefined, discovery: Discovery = NOT_DISCOVERED): string | undefined {
  return pick ? discovery.profiles.find((f) => f.id === pick.id)?.provider : undefined;
}
/** A launcher for this engine: `pick` when it runs `provider`; otherwise, for a NEW agent, the saved
 *  default launcher for `provider` when that one matches, and in every other case none (the engine's
 *  own default account, "Provider default"). Owner run of ceeb4aaf: a Codex launcher saved for the
 *  orchestrator made every Claude orchestrator start and hire fail with "Selected launcher does not
 *  match this provider". An existing agent such as the god never moves to the new-agent default: its
 *  session lives in the account it ran in, and a resume elsewhere is refused. */
export function launcherForProvider(root: string | null, pick: LauncherPick | null | undefined, provider: string, discovery: Discovery = NOT_DISCOVERED, newAgent = false): { pick: LauncherPick | null; ignored?: { id: string; provider: string } } {
  if (pick === null || pick === undefined) return { pick: null };
  // Anything malformed is returned as is, so validateLauncher still refuses it.
  const runs = typeof pick === 'object' && typeof pick.id === 'string' ? launcherProvider(pick, discovery) : undefined;
  if (runs === undefined || runs === provider) return { pick };
  let fallback: LauncherPick | null = null;
  if (newAgent) try { const d = readLauncherState(root).defaults?.[provider]; if (d && launcherProvider(d, discovery) === provider) fallback = d; } catch { fallback = null; }
  return { pick: fallback, ignored: { id: pick.id, provider: runs } };
}
export function resolveLauncherForSpawn(input: { root: string | null; agentId?: string; isGod: boolean; isTemp: boolean; provider: string; explicit?: LauncherPick | null; isNew?: boolean }, discovery?: Discovery | (() => Discovery)): Profile | undefined {
  const saved = runtimeLauncher(input.root, input.agentId, input.isGod, input.isTemp, input.explicit, input.provider, input.isNew);
  if (saved === undefined) return undefined;
  // A function is called here only, once: spawns without a launcher never discover.
  const found = typeof discovery === 'function' ? discovery() : discovery;
  // A saved pick for another engine is not this agent's account: its engine's default applies.
  const pick = input.explicit === undefined ? launcherForProvider(input.root, saved, input.provider, found, !!input.isNew && !input.isGod).pick : saved;
  if (pick === null) return undefined;
  const result = validateLauncher(pick, input.provider, found);
  let available = false;
  try { available = existsSync(result.home) && statSync(result.home).isDirectory(); } catch { /* paths are never included in errors */ }
  if (!available) throw new Error('Selected account home is unavailable. Authenticate that launcher outside Council, then retry.');
  return result;
}
