import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ParamountOrgTeam { id: string; name: string; objective?: string; leadId: string; memberIds: string[]; parents?: Record<string, string> }
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
    const objective = typeof t.objective === 'string' ? t.objective.trim() : '';
    if (t.objective !== undefined && (!objective || objective.length > 2000)) throw new Error(`Team ${id} needs an objective up to 2000 characters`);
    const parents = t.parents === undefined ? undefined : validateTeamParents(t.parents, leadId, new Set(memberIds));
    return { id, name, ...(objective ? { objective } : {}), leadId, memberIds, ...(parents ? { parents } : {}) };
  });
  const reportsTo: Record<string, string> = Object.create(null);
  for (const [agent, manager] of Object.entries(raw.reportsTo as Record<string, unknown>)) {
    if (!known.has(agent) || typeof manager !== 'string' || !known.has(manager)) throw new Error('Reporting lines must use existing agents');
    if (agent === manager) throw new Error('An agent cannot report to itself');
    reportsTo[agent] = manager;
  }
  for (const agent of agents) {
    const seen = new Set([agent]); let cursor = reportsTo[agent];
    while (cursor) { if (seen.has(cursor)) throw new Error('Reporting lines cannot contain a cycle'); seen.add(cursor); cursor = reportsTo[cursor]; }
  }
  return { version: 1, teams, reportsTo: { ...reportsTo } };
}

function validateTeamParents(value: unknown, leadId: string, members: Set<string>): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid team reporting lines');
  const parents = new Map<string, string>();
  for (const [agent, manager] of Object.entries(value)) {
    if (agent === leadId || !members.has(agent) || typeof manager !== 'string' || !members.has(manager)) {
      throw new Error('A team member must report to another member, and the lead is the root');
    }
    parents.set(agent, manager);
  }
  for (const member of parents.keys()) {
    const visited = new Set<string>();
    let cursor = member;
    while (cursor !== leadId) {
      if (visited.has(cursor)) throw new Error('Team reporting lines cannot contain a cycle');
      visited.add(cursor);
      cursor = parents.get(cursor) ?? leadId;
    }
  }
  return Object.fromEntries(parents);
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(org, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return org;
}

export function createOrgTeam(root: string | null, input: Record<string, unknown>, agents: string[], activeAgents: string[]): ParamountOrgTeam {
  const { name, objective, leadId, memberIds } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Enter a team name up to 100 characters');
  if (typeof objective !== 'string' || !objective.trim() || objective.trim().length > 2000) throw new Error('Enter an objective up to 2000 characters');
  const active = new Set(activeAgents);
  if (typeof leadId !== 'string' || !active.has(leadId) || !Array.isArray(memberIds) || !memberIds.every((member) => typeof member === 'string' && active.has(member))) {
    throw new Error('Select a lead and members from the current floor');
  }
  const organization = readOrg(root, agents);
  if (organization.teams.some((team) => team.name.toLowerCase() === name.trim().toLowerCase())) throw new Error('A team with this name already exists');
  const team = { id: randomUUID(), name: name.trim(), objective: objective.trim(), leadId, memberIds: [...new Set([leadId, ...memberIds])] };
  saveOrg(root, { ...organization, teams: [...organization.teams, team] }, agents);
  return team;
}

export function assignOrgTeamMember(root: string | null, input: Record<string, unknown>, agents: string[], activeAgents: string[]): ParamountOrgTeam {
  const { teamId, agentId, parentId } = input;
  const organization = readOrg(root, agents);
  const team = organization.teams.find((entry) => entry.id === teamId);
  if (!team) throw new Error('Team not found');
  const active = new Set(activeAgents);
  const manager = parentId ?? team.leadId;
  if (typeof agentId !== 'string' || !active.has(agentId) || typeof manager !== 'string' || !active.has(manager) || !team.memberIds.includes(manager)) {
    throw new Error('Assign an active floor agent to an active manager on this team');
  }
  const updated = {
    ...team,
    memberIds: [...new Set([...team.memberIds, agentId])],
    parents: { ...team.parents, [agentId]: manager },
  };
  saveOrg(root, { ...organization, teams: organization.teams.map((entry) => entry.id === team.id ? updated : entry) }, agents);
  return updated;
}
