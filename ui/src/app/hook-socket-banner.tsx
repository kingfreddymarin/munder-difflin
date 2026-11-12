// The agent hook socket (hooks.sock) failed to bind. Until it recovers, every agent hook is
// allowed without checks and no cost is recorded: say so instead of failing open silently.
import { useFloor } from '@/data/store';

export function HookSocketBanner() {
  const hook = useFloor((s) => s.hookSocket);
  if (!hook || hook.listening || !hook.lastError || hook.lastError === 'NOROOT') return null;
  return (
    <div role="alert" data-testid="hook-socket-error" className="border-destructive/40 bg-destructive/10 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
      <span className="text-destructive font-semibold">Agent hooks are not connected ({hook.lastError})</span>
      <span className="text-muted-foreground flex-1">Agent actions run without approval checks and no cost is recorded. {hook.lastError === 'EADDRINUSE' ? 'Another app is listening on this floor\'s hook socket; it may have this floor open.' : 'The app keeps retrying.'} Attempts: {hook.attempts}.</span>
    </div>
  );
}

// The orchestrator Council started exited while starting, for example a resume with no such
// session. Its registry entry was kept as it was; say so instead of archiving it silently.
export function OrchestratorFailureBanner() {
  const failure = useFloor((s) => s.orchestratorFailure);
  if (!failure) return null;
  return (
    <div role="alert" data-testid="orchestrator-start-error" className="border-destructive/40 bg-destructive/10 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
      <span className="text-destructive font-semibold">The orchestrator did not start</span>
      <span className="text-muted-foreground flex-1">{failure.message}</span>
    </div>
  );
}
