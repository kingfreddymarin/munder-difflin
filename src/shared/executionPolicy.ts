/** User-selected launch policy. Managed host and remote-server policies still apply. */
export const EXECUTION_POLICIES = ['inherit', 'workspace-ask', 'workspace-auto', 'full-ask', 'full-auto'] as const;
export type ExecutionPolicy = typeof EXECUTION_POLICIES[number];
export function validExecutionPolicy(value: unknown): value is ExecutionPolicy {
  return typeof value === 'string' && (EXECUTION_POLICIES as readonly string[]).includes(value);
}
/** Called once at the common spawn boundary, after account launcher resolution.
 * Explicit floor choice replaces old saved/generated posture flags; inherit preserves them.
 * Remote TUI connections cannot configure the server that executes their tools.
 */
export function codexExecutionArgs(args: string[], policy: unknown): string[] {
  if (!validExecutionPolicy(policy) || policy === 'inherit' || args.some(a => a === '--remote' || a.startsWith('--remote='))) return args;
  const paired = ['-a', '--ask-for-approval', '-s', '--sandbox'];
  const standalone = ['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--approve-for-me'];
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { result.push(...args.slice(i)); break; }
    if ((a === '-c' || a === '--config') && /^(approval_policy|sandbox_mode|sandbox_workspace_write\.network_access)\s*=/.test(args[i + 1] ?? '')) { i++; continue; }
    if (/^--config=(approval_policy|sandbox_mode|sandbox_workspace_write\.network_access)\s*=/.test(a)) continue;
    if (paired.includes(a)) { i++; continue; }
    if (standalone.includes(a) || paired.some(flag => a.startsWith(flag + '='))) continue;
    result.push(a);
  }
  return ['-a', policy.endsWith('-ask') ? 'on-request' : 'never', '-s', policy.startsWith('full-') ? 'danger-full-access' : 'workspace-write', ...result];
}

/** Daemon startup is optional, and never overrides an explicit local policy. */
export function useCodexRemoteControl(enabled: boolean | undefined, policy: unknown): boolean {
  return enabled === true && (policy === undefined || policy === 'inherit');
}
