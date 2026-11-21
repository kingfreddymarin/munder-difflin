import { assignOrgTeamMember, createOrgTeam, readOrg } from './paramount-org';

export function runHiveTeamCommand(root: string, registry: Record<string, { archived?: boolean }>, request: unknown) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !('action' in request)) {
    throw new Error('Use a team command: list, create or assign');
  }
  const command = request as Record<string, unknown>;
  const agents = Object.keys(registry);
  const active = agents.filter((id) => !registry[id].archived);
  switch (command.action) {
    case 'list': return readOrg(root, agents).teams;
    case 'create': return createOrgTeam(root, command, agents, active);
    case 'assign': return assignOrgTeamMember(root, command, agents, active);
    default: throw new Error('Use a team command: list, create or assign');
  }
}

/** Copied into the floor's bin directory with the other bundled-Node helpers. */
export const TEAM_COMMAND_SHIM = String.raw`'use strict';
const { createConnection } = require('node:net');
const [action, ...args] = process.argv.slice(2);
const usage = 'Usage: hive-team.cjs list | create <name> <objective> <lead-id> [member-id ...] | assign <team-id> <agent-id> [manager-id]';
const command = action === 'list' && args.length === 0 ? { action }
  : action === 'create' && args.length >= 3 ? { action, name: args[0], objective: args[1], leadId: args[2], memberIds: args.slice(3) }
  : action === 'assign' && (args.length === 2 || args.length === 3) ? { action, teamId: args[0], agentId: args[1], parentId: args[2] }
  : null;
function fail(message) { console.error(message); process.exitCode = 1; }
if (action === '--help') { console.log(usage); }
else if (!command) { fail(usage); }
else if (!process.env.HIVE_SOCK || !process.env.HIVE_TEAM_TOKEN || !process.env.AGENT_ID) {
  fail('Run this command in the floor orchestrator session.');
} else {
  const frame = JSON.stringify({ team_command: command, team_token: process.env.HIVE_TEAM_TOKEN, agent_id: process.env.AGENT_ID });
  const connection = createConnection(process.env.HIVE_SOCK, () => connection.write(frame + '\n'));
  connection.setEncoding('utf8');
  connection.setTimeout(5000, () => connection.destroy(new Error('Team command timed out. Run list before retrying.')));
  let reply = '';
  connection.on('data', (chunk) => { reply += chunk; });
  connection.on('error', (error) => fail(error.message));
  connection.on('end', () => {
    try {
      const result = JSON.parse(reply);
      if (result.ok) console.log(JSON.stringify(result.value, null, 2));
      else fail(result.error || 'The floor did not accept the team command.');
    } catch { fail('The floor returned no team result.'); }
  });
}
`;
