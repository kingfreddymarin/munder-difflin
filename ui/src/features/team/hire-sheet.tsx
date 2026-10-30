// The Add-Agent form. "Hire" starts empty; "Hire from a bundle" pre-fills it from a hire manifest file
// (munder-difflin/hire@1). Review asks the core for the exact spawn plan; nothing starts until the human
// presses Hire on that plan, and the agent then runs in a visible terminal.
import * as React from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/animate-ui/components/radix/sheet';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNotice } from '@/components/app/error-notice';
import { CopyDiagnosticsButton, useTeamApi } from '@/data/store';
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
  const [form, setForm] = React.useState<Form>(EMPTY);
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
    api?.models().then((next) => {
      setModels(next);
      if (orchestrator) setForm((current) => ({
        ...current,
        provider: next.orchestratorProvider ?? current.provider,
        model: next.orchestratorModel ?? current.model,
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
      const plan = await api.hire(manifestFromForm(form), { ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), ...(orchestrator ? { orchestrator: true } : {}), confirm });
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
              <select id="h-engine" disabled={orchestrator} className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={form.provider} onChange={(e) => edit({ provider: e.target.value, model: '' })}>
                <option value="">Default engine</option>
                {models?.engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                {form.provider && !models?.engines.some((e) => e.id === form.provider) && <option value={form.provider}>{form.provider}</option>}
              </select></div>
            <div className="grid gap-1.5"><Label htmlFor="h-model">Model</Label>
              <ModelSelect id="h-model" models={models} engineId={engine?.id} value={form.model} onChange={(model) => edit({ model })} /></div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="h-cwd">Folder</Label>
            <Input id="h-cwd" placeholder={orchestrator ? 'Empty uses your first project or the Paramount workspace' : 'Absolute path; empty uses your first registered repo'} value={form.cwd} onChange={(e) => edit({ cwd: e.target.value })} /></div>
          <label className="flex items-center gap-3 text-sm"><Switch checked={form.isolate} onCheckedChange={(v) => edit({ isolate: v })} aria-label="Own git worktree" />Work in its own git worktree</label>

          {plan && (
            <div className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm" data-hire-plan={plan.agentId}>
              <span className="font-medium">{plan.name} <span className="text-muted-foreground font-mono text-xs">{plan.agentId}</span></span>
              <code className="bg-muted rounded px-2 py-1 font-mono text-xs break-all">{plan.command}</code>
              <span className="text-muted-foreground text-xs break-all">in {plan.cwd}{plan.isolate ? ' · own worktree' : ''}</span>
              {!plan.engineInstalled && <span className="text-xs text-amber-500">The {plan.engine} CLI is not installed; install it from Health, then hire.</span>}
              {plan.consentRequired.length > 0 && <span className="text-xs text-amber-500">Not enabled (needs your consent later): {plan.consentRequired.join(', ')}</span>}
              {plan.ignored.length > 0 && <span className="text-muted-foreground text-xs">Not applied by this build: {plan.ignored.join(', ')}</span>}
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
