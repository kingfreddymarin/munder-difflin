/**
 * Paramount lane e-terminal: the artifact map behind each agent's terminal.
 *
 * `terminal.artifacts` is read-only. It lists what one agent touched:
 * - files changed in its working tree (git status of the agent's cwd),
 * - files in the newest commits of that tree (git log),
 * - absolute paths and http(s) links (PRs, runs, work items) in the messages it sent.
 * Every artifact that lives on disk carries `dir`, an existing absolute directory the
 * UI can hand to `shell.openIn` (lane a-shell) to open it in Warp or VS Code.
 * A source that cannot be read becomes a warning with an errorId that is also
 * logged; it never fails the whole map.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ParamountArtifact, ParamountArtifactMap, ParamountErrorCode, ParamountResult } from '../preload/paramount';
import { newErrorId } from './paramountObservability';

export interface ParamountGitResult { ok: boolean; stdout: string; error?: string }

export interface ParamountTerminalDeps {
  /** Messages the hive holds for this agent (VoiceMessage shape; redacted). */
  messages(agentId: string): unknown[];
  /** Runs git without a shell; injectable for tests. */
  git?(cwd: string, args: string[]): ParamountGitResult;
  /** Existing-path check; injectable for tests. */
  stat?(path: string): 'file' | 'dir' | null;
  logStep?(step: Record<string, unknown>): void;
}

type Fail = (code: ParamountErrorCode, message: string, cause?: unknown) => ParamountResult;

export const ARTIFACT_LIMITS = { commits: 10, items: 300 } as const;

export function gitRunner(cwd: string, args: string[]): ParamountGitResult {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
  if (run.error) return { ok: false, stdout: '', error: run.error.message };
  if (run.status !== 0) return { ok: false, stdout: run.stdout ?? '', error: (run.stderr || `git exited ${run.status}`).trim().slice(0, 300) };
  return { ok: true, stdout: run.stdout ?? '' };
}

export function statPath(path: string): 'file' | 'dir' | null {
  try {
    if (!existsSync(path)) return null;
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch { return null; }
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string { return typeof value === 'string' ? value : ''; }

const PATH_RE = /(?:^|[\s`'"(<\[])(\/(?:Users|home|private|tmp|var|opt|Volumes)\/[^\s`'"()<>\[\]]+)/g;
const URL_RE = /https?:\/\/[^\s`'"()<>\[\]]+/g;

/** Absolute paths and links in free text; trailing punctuation is trimmed. */
export function extractMentions(text: string): { paths: string[]; urls: string[] } {
  const trim = (s: string) => s.replace(/[.,;:!?]+$/, '');
  const paths = [...text.matchAll(PATH_RE)].map((m) => trim(m[1]));
  const urls = [...text.matchAll(URL_RE)].map((m) => trim(m[0]));
  return { paths: [...new Set(paths)], urls: [...new Set(urls)] };
}

/** Parses `git status --porcelain=v1 -z`; renames keep the new path. */
export function parsePorcelain(out: string): Array<{ status: string; path: string }> {
  const parts = out.split('\0');
  const rows: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    rows.push({ status: status.trim() || status, path: entry.slice(3) });
    if (status[0] === 'R' || status[0] === 'C') i++; // the next part is the old path
  }
  return rows;
}

/** Parses `git log --name-only --format=%x1e%h%x1f%s%x1f%cI`. */
export function parseLog(out: string): Array<{ commit: string; subject: string; at: string; files: string[] }> {
  return out.split('\x1e').filter((b) => b.trim()).map((block) => {
    const [head, ...rest] = block.split('\n');
    const [commit, subject, at] = head.split('\x1f');
    return { commit: commit ?? '', subject: subject ?? '', at: at ?? '', files: rest.map((l) => l.trim()).filter(Boolean) };
  });
}

export function buildArtifactMap(agentId: string, cwd: string, deps: ParamountTerminalDeps, cid: string): ParamountArtifactMap {
  const git = deps.git ?? gitRunner;
  const stat = deps.stat ?? statPath;
  const warnings: ParamountArtifactMap['warnings'] = [];
  const warn = (source: string, message: string) => {
    const errorId = newErrorId();
    warnings.push({ errorId, source, message });
    deps.logStep?.({ kind: 'paramount-terminal', cid, errorId, agentId, source, message });
  };
  const artifacts: ParamountArtifact[] = [];
  const seen = new Set<string>();
  const add = (a: ParamountArtifact) => {
    const key = `${a.kind}|${a.path ?? a.url ?? a.label}|${a.commit ?? ''}`;
    if (seen.has(key) || artifacts.length >= ARTIFACT_LIMITS.items) return;
    seen.add(key);
    artifacts.push(a);
  };
  const dirFor = (path: string): string | undefined => {
    const kind = stat(path);
    if (kind === 'dir') return path;
    if (kind === 'file') return dirname(path);
    const parent = dirname(path);
    return stat(parent) === 'dir' ? parent : undefined;
  };

  let repo: ParamountArtifactMap['repo'] = null;
  let notRepo = false;
  if (!cwd) warn('cwd', 'This agent has no working directory in the registry');
  else if (stat(cwd) !== 'dir') warn('cwd', `Working directory does not exist: ${cwd}`);
  else {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    // Munder's panel treats a folder outside git as empty, not broken: no warning, no errorId.
    if (!top.ok) notRepo = true;
    else {
      const root = top.stdout.trim();
      const branch = git(cwd, ['branch', '--show-current']);
      const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
      repo = { root, branch: branch.ok ? branch.stdout.trim() : '', head: head.ok ? head.stdout.trim() : '' };
      const status = git(cwd, ['status', '--porcelain=v1', '-z']);
      if (!status.ok) warn('git-status', status.error ?? 'git status failed');
      else for (const row of parsePorcelain(status.stdout)) {
        const path = join(root, row.path);
        add({ kind: 'changed', label: row.path, path, dir: dirFor(path), status: row.status });
      }
      const log = git(cwd, ['log', `-n${ARTIFACT_LIMITS.commits}`, '--name-only', '--format=%x1e%h%x1f%s%x1f%cI']);
      if (!log.ok) { if (repo.head) warn('git-log', log.error ?? 'git log failed'); }
      else for (const c of parseLog(log.stdout)) {
        add({ kind: 'commit', label: c.subject || c.commit, commit: c.commit, at: c.at, dir: root });
        for (const f of c.files) {
          const path = join(root, f);
          add({ kind: 'committed', label: f, path, dir: dirFor(path), commit: c.commit, at: c.at });
        }
      }
    }
  }

  let messages: unknown[] = [];
  try { messages = deps.messages(agentId); } catch (error) { warn('messages', error instanceof Error ? error.message : 'Could not read messages'); }
  for (const raw of messages) {
    const m = rec(raw);
    if (str(m.from) !== agentId) continue;
    const at = str(m.created_at) || undefined;
    const found = extractMentions(`${str(m.subject)}\n${str(m.body)}`);
    for (const path of found.paths) if (isAbsolute(path)) add({ kind: 'mentioned', label: path, path, dir: dirFor(path), at, messageId: str(m.id) || undefined });
    for (const url of found.urls) add({ kind: 'link', label: url, url, at, messageId: str(m.id) || undefined });
  }
  return { agentId, cwd, repo, ...(notRepo ? { notRepo: true } : {}), artifacts, warnings };
}

/** `terminal.artifacts` handler; `cwdOf` resolves the agent's registry cwd. */
export function runTerminalCommand(command: Record<string, unknown>, deps: ParamountTerminalDeps | undefined,
  agents: Record<string, unknown>, cid: string, fail: Fail): { artifacts: ParamountArtifactMap } | ParamountResult {
  const agentId = command.agentId;
  if (Object.keys(command).some((k) => k !== 'type' && k !== 'agentId') || typeof agentId !== 'string' || !agentId || agentId.length > 200) {
    return fail('INVALID_INPUT', 'terminal.artifacts takes { agentId }');
  }
  if (!deps) return fail('UNSUPPORTED', 'Artifact mapping is not available in this build');
  const agent = agents[agentId];
  if (!agent) return fail('NOT_FOUND', `No agent "${agentId}"`);
  const cwd = str(rec(agent).cwd);
  return { artifacts: buildArtifactMap(agentId, cwd && isAbsolute(cwd) ? cwd : '', deps, cid) };
}
