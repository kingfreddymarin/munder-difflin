import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ParamountOrgTeam { id: string; name: string; leadId: string; memberIds: string[] }
export interface ParamountOrg { version: 1; teams: ParamountOrgTeam[]; reportsTo: Record<string, string> }
const FILE = 'council/extensions/teams.json';
const empty = (): ParamountOrg => ({ version: 1, teams: [], reportsTo: {} });

export function validateOrg(value: unknown, agents: string[]): ParamountOrg {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Team organization must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.teams) || !raw.reportsTo || typeof raw.reportsTo !== 'object' || Array.isArray(raw.reportsTo)) throw new Error('Unsupported team organization format');
  const known = new Set(agents), ids = new Set<string>();
  const teams = raw.teams.map((item): ParamountOrgTeam => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid team');
    const t = item as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id.trim() : '', name = typeof t.name === 'string' ? t.name.trim() : '';
    const leadId = typeof t.leadId === 'string' ? t.leadId : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw new Error('Team ids must be unique and use letters, numbers, _ or -');
    ids.add(id);
    if (!name || name.length > 100) throw new Error(`Team ${id} needs a name up to 100 characters`);
    if (!known.has(leadId) || !Array.isArray(t.memberIds) || !t.memberIds.every((m) => typeof m === 'string' && known.has(m))) throw new Error(`Team ${id} must use existing agents`);
    const memberIds = [...new Set([leadId, ...t.memberIds as string[]])];
    return { id, name, leadId, memberIds };
  });
  const reportsTo: Record<string, string> = {};
  for (const [agent, manager] of Object.entries(raw.reportsTo as Record<string, unknown>)) {
    if (!known.has(agent) || typeof manager !== 'string' || !known.has(manager)) throw new Error('Reporting lines must use existing agents');
    if (agent === manager) throw new Error('An agent cannot report to itself');
    reportsTo[agent] = manager;
  }
  for (const agent of agents) {
    const seen = new Set([agent]); let cursor = reportsTo[agent];
    while (cursor) { if (seen.has(cursor)) throw new Error('Reporting lines cannot contain a cycle'); seen.add(cursor); cursor = reportsTo[cursor]; }
  }
  return { version: 1, teams, reportsTo };
}

export function readOrg(root: string | null, agents: string[]): ParamountOrg {
  if (!root) return empty();
  const path = join(root, FILE);
  if (!existsSync(path)) return empty();
  return validateOrg(JSON.parse(readFileSync(path, 'utf8')), agents);
}

export function saveOrg(root: string | null, value: unknown, agents: string[]): ParamountOrg {
  if (!root) throw new Error('Enable the Hive before saving teams');
  const org = validateOrg(value, agents), path = join(root, FILE);
  mkdirSync(join(root, 'council/extensions'), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(org, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  return org;
}
