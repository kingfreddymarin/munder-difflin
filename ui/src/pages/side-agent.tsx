import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { PtyTerminalView } from '@/components/app/terminal/pty-terminal-view';
import { Screen } from '@/components/app/screen';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';
import { useRouter } from '@/app/router';
import { findBridge } from '@/data/bridge';
import type { SideAgentAction, SideAgentProvider, SideAgentState } from '../../../src/shared/sideAgent';

export function SideAgentPage() {
  const bridge = findBridge();
  const { go } = useRouter();
  const [provider, setProvider] = React.useState<SideAgentProvider>('opencode');
  const [state, setState] = React.useState<SideAgentState>({ status: 'idle' });
  const [busy, setBusy] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  const running = state.status === 'running';
  const context = state.status === 'idle' ? null : state.context;

  React.useEffect(() => {
    if (!bridge?.sideAgentState || !bridge.onSideAgentChanged) return;
    let active = true;
    let revision = 0;
    const refresh = () => {
      const requested = ++revision;
      void bridge.sideAgentState!().then((current) => {
        if (!active || requested !== revision) return;
        setState(current);
        setReady(true);
        if (current.status === 'running') setProvider(current.provider);
      }, () => {
        if (!active || requested !== revision) return;
        setError('Could not load the side agent. Reopen this page to try again.');
      });
    };
    const unsubscribe = bridge.onSideAgentChanged(refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  async function act(action: SideAgentAction) {
    if (!bridge?.sideAgentAct || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await bridge.sideAgentAct(action, provider);
      if (!result.ok) setError(result.error);
    } catch {
      setError('Could not reach the desktop session. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const ended = state.status === 'exited';
  const abnormal = ended && (Boolean(state.signal) || Boolean(state.exitCode));

  return (
    <Screen fill className="flex h-full min-h-0 flex-col gap-4 overflow-auto">
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Ask quick questions in a temporary session outside the floor. Each launch uses a fresh provider profile and may prompt you to sign in.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Provider
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={provider}
              disabled={busy || running}
              onChange={(event) => setProvider(event.target.value === 'claude' ? 'claude' : 'opencode')}
            >
              <option value="opencode">OpenCode 2</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          {running ? <>
            <Button variant="outline" disabled={busy} onClick={() => void act('stop')}>Stop</Button>
            <Button variant="outline" disabled={busy} onClick={() => void act('restart')}>Restart</Button>
          </> : <Button disabled={busy || !ready} onClick={() => void act('start')}>Start side agent</Button>}
        </div>
        {!bridge?.sideAgentAct && <p role="status" className="text-sm text-muted-foreground">Open this page in the Paramount desktop app to start a session.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {ended && <p role="status" className="text-sm">
          {abnormal
            ? `The provider exited (${state.signal ? `signal ${state.signal}` : `code ${state.exitCode}`}). Check the CLI installation and sign-in, then try again.`
            : 'The side agent ended.'}
        </p>}
        {state.status === 'stopped' && <p role="status" className="text-sm">Side agent stopped.</p>}
        {context && <div className="space-y-1 border-t pt-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{context.floorLabel} · {context.orchestratorName}</span>
            <Button size="sm" variant="outline" onClick={() => go(AGENT_VIEW, agentViewParams(context.orchestratorId))}>Open source orchestrator</Button>
          </div>
          <p className="text-muted-foreground">
            Board snapshot at {new Date(context.capturedAt).toLocaleString()}.
            {' '}{context.cards.length > 0 ? context.cards.map(({ id, status }) => `${id} (${status})`).join(', ') : 'No active card references shared.'}
          </p>
          <p className="text-muted-foreground">For more context, open the orchestrator or paste a relevant excerpt into the session.</p>
        </div>}
      </section>
      {running && <div className="min-h-[360px] flex-1 overflow-hidden rounded-xl border">
        <PtyTerminalView key={state.ptyId} ptyId={state.ptyId} label="Side agent terminal" />
      </div>}
    </Screen>
  );
}
