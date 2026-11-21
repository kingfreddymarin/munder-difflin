/** A brief scheduler nudge. Detailed state stays in the hive's durable files. */
export function heartbeatDigest(quietMs: number, actionable = 0): string {
  const lead = actionable > 0
    ? `Heartbeat: ${actionable} message${actionable === 1 ? '' : 's'} waiting. Read your inbox and handle ${actionable === 1 ? 'it' : 'them'}.`
    : `Heartbeat: quiet for ${Math.max(0, Math.round(quietMs / 60000))}m. Check for stalled work; rest if done.`;
  return `${lead}\nDetails: $AGENT_DIR/inbox, $HIVE_ROOT/fleet.json, $HIVE_ROOT/board.md, $HIVE_ROOT/log.jsonl.`;
}

export function orchestratorInboxNudge(count: number): string {
  return `${count} inbox message${count === 1 ? '' : 's'} waiting. Read "$AGENT_DIR/inbox", follow the pending requests, and move handled files to "$AGENT_DIR/inbox/.done".`;
}
