import { LauncherSelect } from './launcher-select';
import type { CouncilLauncherPick } from '@/data/paramount-api';
// The Add-Agent form. "Hire" starts empty; "Hire from a bundle" pre-fills it from a hire manifest file
// (munder-difflin/hire@1). Review asks the core for the exact spawn plan; nothing starts until the human
// presses Hire on that plan, and the agent then runs in a visible terminal.
import * as React from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/animate-ui/components/radix/sheet';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { OpenWith } from '@/components/app/external-link';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNotice } from '@/components/app/error-notice';
import { CopyDiagnosticsButton, useDispatch, useFloor, useTeamApi } from '@/data/store';
import { findBridge } from '@/data/bridge';
import { fitLauncher } from '@/lib/launcher-fit';
import { chooseFolder } from '@/app/folder-pick';
import { BackendError, toBackendError } from '@/data/errors';
import type { ParamountHirePlan, ParamountTeamModels } from '@/data/paramount-api';

const SPEC = 'munder-difflin/hire@1';
type Form = { name: string; description: string; goal: string; provider: string; model: string; cwd: string; isolate: boolean; extra: Record<string, unknown> };
const EMPTY: Form = { name: '', description: '', goal: '', provider: '', model: '', cwd: '', isolate: false, extra: {} };
type Step = { kind: 'form' } | { kind: 'reviewing' } | { kind: 'plan'; plan: ParamountHirePlan } | { kind: 'starting'; plan: ParamountHirePlan } | { kind: 'started'; plan: ParamountHirePlan };

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Reads a bundle file into the form; fields the form does not show ride along in `extra` and the core validates them. */
export function formFromManifest(raw: unknown): Form {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw BackendError.local('INVALID_INPUT', 'A bundle is a JSON object (a munder-difflin/hire@1 manifest).', 'agent.hire');
  const m = raw as Record<string, unknown>;
  const { spec: _s, name, description, goal, provider, model, isolate, ...extra } = m;
  return { name: text(name), description: text(description), goal: text(goal), provider: text(provider), model: text(model), cwd: '', isolate: isolate === true, extra };
}

export function manifestFromForm(form: Form): Record<string, unknown> {
  return {
    ...form.extra, spec: SPEC, name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.goal.trim() ? { goal: form.goal.trim() } : {}),
    ...(form.provider ? { provider: form.provider } : {}),
    ...(form.model ? { model: form.model } : {}),
    ...(form.isolate ? { isolate: true } : {}),
  };
}

/** `manifest` pre-fills the form (an imported agent); `bundle` asks for a bundle file as the sheet opens. */
export function HireSheet({ open, bundle, orchestrator = false, manifest, notes, onClose }: { open: boolean; bundle: boolean; orchestrator?: boolean; manifest?: Record<string, unknown>; notes?: string[]; onClose: () => void }) {
  const api = useTeamApi();
  const dispatch = useDispatch();
  const [form, setForm] = React.useState<Form>(EMPTY);
  const floorRoot = useFloor((s) => s.floorSetup?.harnessHome ?? null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  const [launcher, setLauncher] = React.useState<CouncilLauncherPick | null>(null);
  const [models, setModels] = React.useState<ParamountTeamModels | null>(null);
  const [step, setStep] = React.useState<Step>({ kind: 'form' });
  const [error, setError] = React.useState<BackendError | null>(null);
  const file = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setStep({ kind: 'form' }); setError(null);
    try {
      setForm(manifest ? formFromManifest(manifest) : orchestrator
        ? { ...EMPTY, name: 'Paramount', description: 'Main orchestrator' }
        : EMPTY);
    } catch (cause) { setForm(EMPTY); setError(toBackendError(cause, 'agent.hire')); }
    setLauncher(null);
    api?.models().then((next) => {
      // The orchestrator runs the registered god's engine (orchestratorProvider); a saved launcher is
      // preselected only when it runs that same engine.
      const provider = orchestrator ? next.orchestratorProvider ?? 'claude' : text(manifest?.provider) || next.engines[0]?.id || 'claude';
      setLauncher(fitLauncher(orchestrator ? next.launcherState?.orchestrator : next.launcherState?.defaults?.[provider], provider, next.launchers));
      setModels(next);
      if (orchestrator) setForm((current) => ({
        ...current,
        provider,
        model: next.orchestratorModel ?? '',
      }));
    }, (cause) => setError(toBackendError(cause, 'team.models')));
    if (bundle) setTimeout(() => file.current?.click(), 0);
  }, [open, bundle, orchestrator, manifest, api]);

  const engine = models?.engines.find((e) => e.id === (form.provider || models.engines[0]?.id));
  const loadBundle = async (f: File | undefined) => {
    if (!f) return;
    try {
      setForm(formFromManifest(JSON.parse(await f.text())));
      setError(null);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? BackendError.local('INVALID_INPUT', `${f.name} is not valid JSON: ${cause.message}`, 'agent.hire') : toBackendError(cause, 'agent.hire'));
    }
  };
  const send = async (confirm: boolean) => {
    if (!api) return;
    const prior = step.kind === 'plan' ? step.plan : null;
    setError(null);
    setStep(confirm && prior ? { kind: 'starting', plan: prior } : { kind: 'reviewing' });
    try {
      const plan = await api.hire(manifestFromForm(form), { ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), ...(orchestrator ? { orchestrator: true } : {}), confirm, launcher });
      setStep(confirm ? { kind: 'started', plan } : { kind: 'plan', plan });
    } catch (cause) {
      setError(toBackendError(cause, 'agent.hire'));
      setStep(prior ? { kind: 'plan', plan: prior } : { kind: 'form' });
    }
  };
  const edit = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); if (step.kind === 'plan') setStep({ kind: 'form' }); };
  const plan = step.kind === 'plan' || step.kind === 'starting' || step.kind === 'started' ? step.plan : null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[560px] sm:max-w-[560px]">
        <SheetHeader>
          <SheetTitle>{orchestrator ? 'Start Paramount orchestrator' : bundle ? 'Hire from a bundle' : manifest ? `Hire ${text(manifest.name) || 'an imported agent'}` : 'Hire an agent'}</SheetTitle>
          <SheetDescription>{orchestrator ? 'Uses Munder’s main-agent role and the configured orchestrator engine. Review the exact command; nothing starts until you confirm.' : 'Review shows the exact command first. The agent starts only when you press Hire, in a terminal you can watch.'}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { void loadBundle(e.target.files?.[0]); e.target.value = ''; }} />
          {!api && <span className="text-muted-foreground text-sm">Hiring needs the desktop core.</span>}
          {notes && notes.length > 0 && (
            <ul className="text-muted-foreground list-disc pl-4 text-xs" aria-label="Import adjustments">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
          )}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => file.current?.click()}>Load a bundle file…</Button>
          <div className="grid gap-1.5"><Label htmlFor="h-name">Name</Label><Input id="h-name" value={form.name} onChange={(e) => edit({ name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="h-role">Role</Label><Input id="h-role" value={form.description} onChange={(e) => edit({ description: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="h-goal">Goal</Label><Textarea id="h-goal" rows={3} value={form.goal} onChange={(e) => edit({ goal: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label htmlFor="h-engine">Engine</Label>
              <select id="h-engine" disabled={orchestrator} className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={form.provider} onChange={(e) => { edit({ provider: e.target.value, model: '' }); { const p = e.target.value || models?.engines[0]?.id || 'claude'; setLauncher(fitLauncher(models?.launcherState?.defaults?.[p], p, models?.launchers)); } }}>
                <option value="">Default engine</option>
                {models?.engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                {form.provider && !models?.engines.some((e) => e.id === form.provider) && <option value={form.provider}>{form.provider}</option>}
              </select></div>
            <Button variant="link" size="sm" onClick={async () => { setStep({ kind: 'form' }); await dispatch({ type: 'launchers.refresh' }); api?.models().then(setModels, (e) => setError(toBackendError(e, 'team.models'))); }}>Refresh launchers</Button>
            <LauncherSelect discovery={models?.launchers} provider={engine?.id} value={launcher} onChange={(v) => { setLauncher(v); setStep({ kind: 'form' }); }} />
            {orchestrator && models?.orchestratorLauncherNote && <span className="text-xs text-amber-500" data-testid="orchestrator-launcher-note">{models.orchestratorLauncherNote}</span>}
            {orchestrator && models?.orchestratorConfiguredProvider && <span className="text-muted-foreground text-xs" data-testid="orchestrator-engine-note">This floor's orchestrator is registered on {engine?.label ?? models.orchestratorProvider}; the engine in Settings ({models.orchestratorConfiguredProvider}) applies only to a new orchestrator.</span>}
            <div className="grid gap-1.5"><Label htmlFor="h-model">Model</Label>
              <ModelSelect id="h-model" models={models} engineId={engine?.id} value={form.model} onChange={(model) => edit({ model })} /></div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="h-cwd">Folder</Label>
            <div className="flex gap-2">
              <Input id="h-cwd" placeholder={`Empty: floor root (${floorRoot ?? 'not open in this app'})`} value={form.cwd} onChange={(e) => edit({ cwd: e.target.value })} />
              <Button type="button" variant="outline" onClick={async () => {
                setPickError(null);
                const r = await chooseFolder(findBridge());
                if (r.kind === 'chosen') edit({ cwd: r.path });
                else if (r.kind === 'failed') setPickError(r.message);
                else if (r.kind === 'unavailable') setPickError('The folder dialog is not available here; type the full path instead.');
              }}>Choose folder…</Button>
            </div>
            {pickError && <p className="text-destructive text-xs">{pickError}</p>}</div>
          <label className="flex items-center gap-3 text-sm"><Switch checked={form.isolate} onCheckedChange={(v) => edit({ isolate: v })} aria-label="Own git worktree" />Work in its own git worktree</label>

          {plan && (
            <div className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm" data-hire-plan={plan.agentId}>
              <span>Account launcher: {plan.launcher ?? 'Provider default'}</span>
              <span className="font-medium">{plan.name} <span className="text-muted-foreground font-mono text-xs">{plan.agentId}</span></span>
              <code className="bg-muted rounded px-2 py-1 font-mono text-xs break-all">{plan.command}</code>
              <div className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground text-xs break-all">in {plan.cwd}{plan.isolate ? ' · own worktree' : ''}</span><OpenWith path={plan.cwd} /></div>
              {!plan.engineInstalled && <span className="text-xs text-amber-500">The {plan.engine} CLI is not installed; install it from Health, then hire.</span>}
              {plan.consentRequired.length > 0 && <span className="text-xs text-amber-500">Not enabled (needs your consent later): {plan.consentRequired.join(', ')}</span>}
              {plan.ignored.length > 0 && <span className="text-muted-foreground text-xs">Not applied by this build: {plan.ignored.join(', ')}</span>}
              {plan.notes?.map((note) => <span key={note} className="text-xs text-amber-500" data-testid="hire-plan-note">{note}</span>)}
              {step.kind === 'started' && <span role="status" className="text-xs text-emerald-500">Started. {plan.name} is on the Team and in Terminal.</span>}
            </div>
          )}
          {error && <ErrorNotice error={error}><CopyDiagnosticsButton size="sm" /></ErrorNotice>}
          <div className="mt-auto flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>{step.kind === 'started' ? 'Close' : 'Cancel'}</Button>
            {step.kind !== 'started' && <Button type="button" variant="outline" disabled={!api || !form.name.trim() || step.kind === 'reviewing' || step.kind === 'starting'} onClick={() => void send(false)}>
              {step.kind === 'reviewing' ? 'Checking…' : 'Review'}</Button>}
            {step.kind !== 'started' && <Button type="button" disabled={!plan || !plan.engineInstalled || step.kind !== 'plan'} onClick={() => void send(true)}
              title={plan ? undefined : 'Review the plan first'}>{step.kind === 'starting' ? 'Starting…' : orchestrator ? 'Start Paramount' : 'Hire'}</Button>}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Models of one engine from the core's catalog; the harness default is marked "· default". Empty = the default. */
export function ModelSelect({ id, models, engineId, value, onChange, disabled }: { id?: string; models: ParamountTeamModels | null; engineId?: string; value: string; onChange: (model: string) => void; disabled?: boolean }) {
  const engine = models?.engines.find((e) => e.id === engineId);
  const mark = (modelId?: string) => (modelId && modelId === models?.defaultModel ? ' · default' : '');
  return (
    <select id={id} disabled={disabled || !engine} className="border-input bg-background h-9 rounded-md border px-2 text-sm"
      value={value} onChange={(e) => onChange(e.target.value)} title={engine ? undefined : 'This engine takes no model choice.'}>
      <option value="">Use the default{models?.defaultModel && engine?.models.some((m) => m.id === models.defaultModel) ? ` (${models.defaultModel})` : ''}</option>
      {engine?.models.filter((m) => m.id).map((m) => <option key={m.id} value={m.id}>{m.label}{mark(m.id)}</option>)}
      {value && !engine?.models.some((m) => m.id === value) && <option value={value}>{value}</option>}
    </select>
  );
}
