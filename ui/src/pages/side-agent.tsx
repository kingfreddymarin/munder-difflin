import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { PtyTerminalView } from '@/components/app/terminal/pty-terminal-view';
import { SIDE_AGENT_TERMINAL_THEMES } from '@/components/app/terminal/terminal-themes';
import { OpenWith } from '@/components/app/external-link';
import { Screen } from '@/components/app/screen';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';
import { useRouter } from '@/app/router';
import { findBridge } from '@/data/bridge';
import type { SideAgentAction, SideAgentProvider, SideAgentState } from '../../../src/shared/sideAgent';

const outlineButton = 'border-neutral-300 bg-white text-black hover:bg-neutral-100 hover:text-black dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:hover:bg-neutral-800 dark:hover:text-white';
const buttonFocus = 'focus-visible:border-current focus-visible:ring-current/40';

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
      <section className="space-y-4 rounded-xl border border-neutral-300 bg-white p-4 text-black dark:border-neutral-700 dark:bg-neutral-950 dark:text-white">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Ask quick questions in a temporary session outside the floor. Each launch loads a fresh floor snapshot and uses a temporary provider profile that may prompt you to sign in.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Provider
            <select
              className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm focus-visible:outline-current dark:border-neutral-700 dark:bg-neutral-900"
              value={provider}
              disabled={busy || running}
              onChange={(event) => setProvider(event.target.value === 'claude' ? 'claude' : 'opencode')}
            >
              <option value="opencode">OpenCode 2</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          {running ? <>
            <Button className={`${outlineButton} ${buttonFocus}`} variant="outline" disabled={busy} onClick={() => void act('stop')}>Stop</Button>
            <Button className={`${outlineButton} ${buttonFocus}`} variant="outline" disabled={busy} onClick={() => void act('restart')}>Restart</Button>
            <OpenWith path={state.cwd} />
          </> : <Button className={`bg-yellow-300 text-black hover:bg-yellow-400 ${buttonFocus}`} disabled={busy || !ready} onClick={() => void act('start')}>Start side agent</Button>}
        </div>
        {!bridge?.sideAgentAct && <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">Open this page in the Paramount desktop app to start a session.</p>}
        {error && <p role="alert" className="text-sm text-black dark:text-white">{error}</p>}
        {ended && <p role="status" className="text-sm">
          {abnormal
            ? `The provider exited (${state.signal ? `signal ${state.signal}` : `code ${state.exitCode}`}). Check the CLI installation and sign-in, then try again.`
            : 'The side agent ended.'}
        </p>}
        {state.status === 'stopped' && <p role="status" className="text-sm">Side agent stopped.</p>}
        {context && <div className="space-y-1 border-t border-neutral-300 pt-3 text-sm dark:border-neutral-700">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{context.floorLabel} · {context.orchestratorName}</span>
            <Button size="sm" className={`${outlineButton} ${buttonFocus}`} variant="outline" onClick={() => go(AGENT_VIEW, agentViewParams(context.orchestratorId))}>Open source orchestrator</Button>
          </div>
          <p className="text-neutral-600 dark:text-neutral-400">
            Floor snapshot at {new Date(context.capturedAt).toLocaleString()}.
          </p>
          <details className="space-y-2">
            <summary className="cursor-pointer font-medium">View shared context</summary>
            <div className="max-h-64 space-y-3 overflow-auto">
              {context.boardSummary && <div>
                <h3 className="font-medium">Board summary</h3>
                <p className="whitespace-pre-line">{context.boardSummary}</p>
              </div>}
              {context.cards.length > 0 && <div>
                <h3 className="font-medium">Open cards</h3>
                <ul className="list-disc pl-5">
                  {context.cards.map(({ id, title, status, assignee, blocker }) => <li key={id}>
                    {`${id} (${status})`}{title && ` · ${title}`}{assignee && ` · Assigned to ${assignee}`}{blocker && ` · Blocker: ${blocker}`}
                  </li>)}
                </ul>
              </div>}
              {context.roster.length > 0 && <div>
                <h3 className="font-medium">Live roster</h3>
                <ul className="list-disc pl-5">
                  {context.roster.map(({ id, name, status, contextPct }) => <li key={id}>
                    {name ? `${name} (${id})` : id}{` · ${status}`}{contextPct !== null && ` · Context ${contextPct}%`}
                  </li>)}
                </ul>
              </div>}
              {context.decisions.length > 0 && <div>
                <h3 className="font-medium">Recent decisions</h3>
                <ul className="list-disc pl-5">
                  {context.decisions.map((decision) => <li key={decision}>{decision}</li>)}
                </ul>
              </div>}
              {!context.boardSummary && !context.cards.length && !context.roster.length && !context.decisions.length && <p>No floor notes, open cards, roster, or decisions were available at capture time.</p>}
            </div>
          </details>
        </div>}
      </section>
      {running && <div className="min-h-[360px] flex-1 overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700">
        <PtyTerminalView key={state.ptyId} ptyId={state.ptyId} cwd={state.cwd} label="Side agent terminal" palettes={SIDE_AGENT_TERMINAL_THEMES} />
      </div>}
    </Screen>
  );
}
