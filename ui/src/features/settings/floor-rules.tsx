// NSC-255: optional floor rules. Studio rules are built in and protected; floor rules add to them for
// this floor. People write rules in plain language; the core structures, checks and stores them.
// Agent suggestions wait here for review and are not active until approved. Plain text only: no
// rule or reason is ever rendered as HTML.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tile } from '@/components/app/tile';
import { useRulesApi } from '@/data/store';
import type { ParamountFloorRules, ParamountRuleProblem } from '@/data/paramount-api';
import { KIND_LABEL, WHEN_LABEL, blocking, changed, draftKey, draftsFrom, grouped, problemsByKey, toPayload, type RuleDraft } from './floor-rules-model';

const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function Problems({ problems }: { problems: readonly ParamountRuleProblem[] }) {
  if (!problems.length) return null;
  return <ul className="flex flex-col gap-0.5">
    {problems.map((p, i) => <li key={i} className={`text-xs ${p.level === 'error' ? 'text-destructive' : 'text-amber-400'}`}>{p.message}</li>)}
  </ul>;
}

/** Checks the drafts with the core shortly after they change. Works before a floor exists. */
function useRuleCheck(drafts: readonly RuleDraft[]) {
  const api = useRulesApi();
  const [problems, setProblems] = React.useState<ParamountRuleProblem[]>([]);
  const [checking, setChecking] = React.useState(false);
  const payload = JSON.stringify(toPayload(drafts));
  React.useEffect(() => {
    if (!api) return;
    const rules = JSON.parse(payload) as Array<{ id?: string; text: string }>;
    if (!rules.length) { setProblems([]); return; }
    let alive = true;
    setChecking(true);
    const timer = setTimeout(() => {
      api.check(rules).then((r) => { if (alive) setProblems(r.problems); })
        .catch((error) => { if (alive) setProblems([{ level: 'error', code: 'invalid', message: message(error, 'The rules could not be checked.') }]); })
        .finally(() => { if (alive) setChecking(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, payload]);
  return { problems, checking };
}

/** The editable list of rule sentences, with each row's feedback under it. */
function RuleRows({ drafts, onChange, problems, disabled }: { drafts: RuleDraft[]; onChange(next: RuleDraft[]): void; problems: readonly ParamountRuleProblem[]; disabled?: boolean }) {
  const { rows, general } = problemsByKey(drafts, problems);
  return <div className="flex flex-col gap-2">
    {drafts.map((d, i) => <div key={d.key} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input aria-label={`Rule ${i + 1}`} value={d.text} disabled={disabled} placeholder="For example: Run the tests before marking a task done."
          onChange={(e) => onChange(drafts.map((x) => x.key === d.key ? { ...x, text: e.target.value } : x))} />
        <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Remove rule ${i + 1}`} onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}>Remove</Button>
      </div>
      <Problems problems={rows[d.key] ?? []} />
    </div>)}
    <Problems problems={general} />
    <div><Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...drafts, { key: draftKey(), text: '' }])}>Add a rule</Button></div>
  </div>;
}

/** Customize Rules at floor creation: optional, and nothing is saved until the floor is set up. */
export function CustomizeRulesDialog({ open, onOpenChange, starters, value, onSave }: { open: boolean; onOpenChange(open: boolean): void; starters: readonly string[]; value: readonly string[]; onSave(rules: string[]): void }) {
  const [drafts, setDrafts] = React.useState<RuleDraft[]>([]);
  React.useEffect(() => {
    if (open) setDrafts(value.length ? value.map((text) => ({ key: draftKey(), text })) : [{ key: draftKey(), text: '' }]);
  }, [open, value]);
  const { problems, checking } = useRuleCheck(drafts);
  const used = new Set(drafts.map((d) => d.text.trim()));
  const ideas = starters.filter((s) => !used.has(s));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Customize rules</DialogTitle>
        <DialogDescription>Optional. Studio rules always apply. Add rules for this floor in plain words, or skip this and add them later in Settings.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <RuleRows drafts={drafts} onChange={setDrafts} problems={problems} />
        {ideas.length > 0 && <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Ideas from Paramount</span>
          <div className="flex flex-wrap gap-1.5">
            {ideas.map((idea) => <Button key={idea} variant="outline" size="sm" onClick={() => setDrafts([...drafts.filter((d) => d.text.trim()), { key: draftKey(), text: idea }])}>{idea}</Button>)}
          </div>
        </div>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={checking || blocking(problems)} onClick={() => { onSave(toPayload(drafts).map((r) => r.text.trim())); onOpenChange(false); }}>Use these rules</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** Settings > Floor rules. */
export function FloorRulesPanel() {
  const api = useRulesApi();
  const [state, setState] = React.useState<ParamountFloorRules | null>(null);
  const [drafts, setDrafts] = React.useState<RuleDraft[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [failure, setFailure] = React.useState('');
  const [resetOpen, setResetOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const { problems, checking } = useRuleCheck(drafts);

  const apply = React.useCallback((next: ParamountFloorRules) => { setState(next); setDrafts(draftsFrom(next.rules)); }, []);
  React.useEffect(() => {
    if (!api) return;
    let alive = true;
    api.get().then((r) => { if (alive) apply(r); }).catch((error) => { if (alive) setFailure(message(error, 'Could not load the floor rules.')); });
    return () => { alive = false; };
  }, [api, apply]);

  if (!api) return <p className="text-muted-foreground text-sm">Floor rules need the Paramount desktop core.</p>;
  const run = async (work: () => Promise<ParamountFloorRules>, done: string) => {
    setBusy(true); setNotice(''); setFailure('');
    try { apply(await work()); setNotice(done); }
    catch (error) { setFailure(message(error, 'That did not work.')); }
    finally { setBusy(false); }
  };
  const suggest = async () => {
    if (!api.suggest) return;
    setBusy(true); setNotice(''); setFailure('');
    try {
      const r = await api.suggest();
      apply(r.rules);
      setNotice([r.suggested ? `${r.suggested} new suggestion${r.suggested === 1 ? '' : 's'} from your repos.` : 'No new suggestions from your repos.', r.askedParamount ? 'Paramount is looking at this floor and will add more for review.' : ''].filter(Boolean).join(' '));
    } catch (error) { setFailure(message(error, 'Could not get suggestions.')); }
    finally { setBusy(false); }
  };
  const dirty = !!state && changed(drafts, state.rules);
  const loaded = !!state;

  return <div className="flex flex-col gap-3">
    {failure && <p className="text-destructive text-sm" role="alert">{failure}</p>}
    {notice && <p className="text-sm text-emerald-400" role="status">{notice}</p>}
    {state && state.problems.length > 0 && <Problems problems={state.problems} />}

    <Tile title="Studio rules" hint="apply to every floor · protected, cannot be changed">
      <ul className="flex flex-col gap-2">
        {(state?.studio ?? []).map((r) => <li key={r.id} className="flex items-start gap-2 text-sm">
          <Badge variant="secondary">Protected</Badge>
          <span className="flex flex-col"><span>{r.text}</span><span className="text-muted-foreground text-xs">{r.why}</span></span>
        </li>)}
      </ul>
    </Tile>

    <Tile title="This floor's rules" hint="add to the Studio rules · write them in plain words"
      actions={<div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={!loaded || busy || !state?.rules.length} onClick={() => setResetOpen(true)}>Reset</Button>
        <Button size="sm" disabled={!loaded || busy || checking || !dirty || blocking(problems)} onClick={() => void run(() => api.save(toPayload(drafts), state?.revision), 'Floor rules saved. Agents follow them from their next task.')}>Save rules</Button>
      </div>}>
      {loaded
        ? <RuleRows drafts={drafts} onChange={setDrafts} problems={problems} disabled={busy} />
        : <p className="text-muted-foreground text-sm">Loading…</p>}
    </Tile>

    <Tile title="Suggestions to review" hint="not active until you approve them"
      actions={api.suggest && <Button variant="outline" size="sm" disabled={!loaded || busy} onClick={() => void suggest()}>Ask Paramount for suggestions</Button>}>
      {state && !state.suggestions.length && <p className="text-muted-foreground text-sm">No suggestions waiting.</p>}
      <ul className="flex flex-col gap-3">
        {(state?.suggestions ?? []).map((s) => {
          const edit = editing?.id === s.id ? editing : null;
          return <li key={s.id} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
            {edit
              ? <Input aria-label="Edit suggestion" value={edit.text} onChange={(e) => setEditing({ id: s.id, text: e.target.value })} />
              : <span className="text-sm">{s.text}</span>}
            <span className="text-muted-foreground text-xs">{WHEN_LABEL[s.when]} · {KIND_LABEL[s.kind]} · suggested by {s.from === 'paramount' ? 'Paramount' : s.from}{s.reason ? ` · ${s.reason}` : ''}</span>
            <Problems problems={s.problems} />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || (!edit && blocking(s.problems)) || dirty} onClick={() => void run(() => api.review(s.id, 'approve', edit?.text, state?.revision), 'Suggestion approved. It is now a floor rule.').then(() => setEditing(null))}>{edit ? 'Approve edited rule' : 'Approve'}</Button>
              {edit
                ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel edit</Button>
                : <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => setEditing({ id: s.id, text: s.text })}>Edit</Button>}
              <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void run(() => api.review(s.id, 'reject', undefined, state?.revision), 'Suggestion rejected.')}>Reject</Button>
            </div>
          </li>;
        })}
      </ul>
      {dirty && state && state.suggestions.length > 0 && <p className="text-muted-foreground text-xs">Save or undo your rule changes before reviewing suggestions.</p>}
    </Tile>

    <Tile title="What agents follow on this floor" hint="the Studio rules plus the saved floor rules">
      <div className="flex flex-col gap-2 text-sm">
        <span>All {state?.studio.length ?? 0} Studio rules, always.</span>
        {state && !state.rules.length && <span className="text-muted-foreground">No extra floor rules.</span>}
        {state && grouped(state.rules).map((g) => <div key={g.when} className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs">{g.label}</span>
          <ul className="flex flex-col gap-0.5">{g.rules.map((r) => <li key={r.id}>{KIND_LABEL[r.kind]}: {r.text}</li>)}</ul>
        </div>)}
      </div>
    </Tile>

    <Dialog open={resetOpen} onOpenChange={setResetOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset floor rules?</DialogTitle>
          <DialogDescription>This removes this floor's own rules.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm">The Studio rules stay, and suggestions stay waiting for review.</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setResetOpen(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => { setResetOpen(false); void run(() => api.reset(state?.revision), 'Floor rules reset. Only the Studio rules apply.'); }}>Reset rules</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
