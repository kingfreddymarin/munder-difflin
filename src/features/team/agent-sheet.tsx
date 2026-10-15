import * as React from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/animate-ui/components/radix/sheet';
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { AgentSummary } from '@/components/app/agent-summary';
import { clock } from '@/components/app/format';
import { accent } from '@/components/app/status';
import { useDispatch, useFloor } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';

const tones = ['Concise', 'Detailed', 'Friendly', 'Formal'];
const autonomies = ['Read only', 'Ask for merges', 'Ask for anything risky', 'Full within budget'];

/** `tab` opens a given tab first (Chats' avatar click opens `profile`, the agent's settings). */
export function AgentSheet({ agentId, onClose, tab }: { agentId: string | null; onClose: () => void; tab?: string | null }) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === agentId));
  const cards = useFloor((s) => s.cards);
  const activity = useFloor((s) => s.activity);
  const engines = useFloor((s) => s.engines);
  const dispatch = useDispatch();
  const { go } = useRouter();
  const [form, setForm] = React.useState({ name: '', color: 'slate', model: '', engine: '', tokensCap: 1, persona: '', tone: 'Concise', autonomy: 'Ask for merges', yolo: false });
  React.useEffect(() => {
    if (agent) setForm({ name: agent.name, color: agent.color, model: agent.model, engine: agent.engine, tokensCap: agent.tokensCap, persona: agent.persona ?? '', tone: agent.tone ?? 'Concise', autonomy: agent.autonomy ?? 'Ask for merges', yolo: !!agent.yolo });
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = React.useMemo(() => cards.filter((c) => c.agentId === agentId && c.status !== 'done'), [cards, agentId]);
  const events = React.useMemo(() => activity.filter((e) => e.agentId === agentId).slice(0, 8), [activity, agentId]);

  const save = () => {
    if (!agent) return;
    const patch = Object.fromEntries(Object.entries(form).filter(([k, v]) => (agent as unknown as Record<string, unknown>)[k] !== v && !(k === 'yolo' && !v && !agent.yolo)));
    if (Object.keys(patch).length) dispatch({ type: 'agent.update', agentId: agent.id, patch });
  };

  return (
    <Sheet open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[520px] sm:max-w-[520px]">
        {agent && (
          <>
            <SheetHeader>
              <SheetTitle>{agent.name}</SheetTitle>
              <SheetDescription>{agent.doing}</SheetDescription>
            </SheetHeader>
            <Tabs key={`${agentId}:${tab ?? ''}`} defaultValue={tab ?? 'overview'} className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
              <TabsList className="w-full">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="tasks">Tasks</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="profile">Profile</TabsTrigger>
              </TabsList>
              <TabsContents className="min-h-0 flex-1">
                <TabsContent value="overview">
                  <AgentSummary agent={agent} />
                  <div className="mt-3 flex gap-2">
                    <Button className="flex-1" onClick={() => { const c = `c-${agent.id}`; go('chats', { c }); }}>Message (priority)</Button>
                    <Button variant="outline" className="flex-1" onClick={() => go('terminal', { a: agent.id })}>Terminal</Button>
                  </div>
                </TabsContent>
                <TabsContent value="tasks" className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs">In the order {agent.name} will work them; it reads this queue every turn.</span>
                  {mine.map((c, i) => {
                    const now = c.plan.find((p) => p.state === 'doing' || p.state === 'ask' || p.state === 'blocked');
                    return (
                      <button key={c.key} type="button" onClick={() => go('board', { card: c.key })} className="hover:bg-accent flex gap-3 rounded-lg border p-3 text-left">
                        <span className="text-muted-foreground font-mono text-xs">{i + 1}</span>
                        <span className="flex flex-1 flex-col gap-1">
                          <span className="text-sm font-medium"><span className="text-muted-foreground font-mono text-xs">{c.key}</span> {c.title}</span>
                          <span className="text-muted-foreground text-xs">Now: {now?.text ?? c.status}</span>
                        </span>
                        <Badge variant="outline">{c.status}</Badge>
                      </button>
                    );
                  })}
                  {mine.length === 0 && <span className="text-muted-foreground text-sm">No open cards.</span>}
                </TabsContent>
                <TabsContent value="activity" className="flex flex-col gap-2">
                  {events.map((e) => (
                    <div key={e.id} className="flex gap-3 text-sm">
                      <span className="text-muted-foreground w-11 font-mono text-xs">{clock(e.at)}</span>
                      <span className="flex-1">{e.text}</span>
                      <span className="text-muted-foreground text-xs">{e.tokens}</span>
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="profile" className="flex flex-col gap-3">
                  <div className="grid gap-1.5"><Label htmlFor="ag-name">Display name</Label><Input id="ag-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div className="grid gap-1.5">
                    <Label>Colour</Label>
                    <ToggleGroup type="single" value={form.color} onValueChange={(v) => v && setForm({ ...form, color: v })} aria-label="Colour">
                      {Object.keys(accent).map((c) => (
                        <ToggleGroupItem key={c} value={c} aria-label={c} className="size-8 p-0"><span className={cn('size-4 rounded-full', accent[c].bg, 'ring-1 ring-current', accent[c].fg)} /></ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Engine and model</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="outline" className="justify-between">{form.engine} · {form.model}<span className="text-muted-foreground text-xs">change</span></Button></DropdownMenuTrigger>
                      <DropdownMenuContent className="w-72">
                        <DropdownMenuRadioGroup value={`${form.engine}|${form.model}`} onValueChange={(v) => { const [engine, model] = v.split('|'); setForm({ ...form, engine, model }); }}>
                          {engines.map((e, i) => (
                            <React.Fragment key={e.id}>
                              {i > 0 && <DropdownMenuSeparator />}
                              <DropdownMenuLabel className="text-muted-foreground text-xs">{e.name} · {e.plan}</DropdownMenuLabel>
                              {e.models.map((m) => <DropdownMenuRadioItem key={m} value={`${e.name}|${m}`} disabled={e.state === 'fail'}>{m}</DropdownMenuRadioItem>)}
                            </React.Fragment>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="grid gap-1.5"><Label htmlFor="ag-persona">Persona and standing instructions</Label><Textarea id="ag-persona" rows={3} value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} /></div>
                  <div className="grid gap-1.5"><Label>Tone</Label>
                    <ToggleGroup type="single" variant="outline" size="sm" value={form.tone} onValueChange={(v) => v && setForm({ ...form, tone: v })}>{tones.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5 text-xs">{t}</ToggleGroupItem>)}</ToggleGroup>
                  </div>
                  <div className="grid gap-1.5"><Label>Autonomy</Label>
                    <ToggleGroup type="single" variant="outline" size="sm" value={form.autonomy} onValueChange={(v) => v && setForm({ ...form, autonomy: v })} className="flex-wrap">{autonomies.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5 text-xs">{t}</ToggleGroupItem>)}</ToggleGroup>
                  </div>
                  <div className="flex items-center gap-3">
                    <Label className="flex-1">Daily token budget</Label>
                    <Button size="sm" variant="outline" onClick={() => setForm({ ...form, tokensCap: Math.max(0.5, form.tokensCap - 0.5) })}>−</Button>
                    <span className="w-14 text-center font-mono text-sm">{form.tokensCap}M</span>
                    <Button size="sm" variant="outline" onClick={() => setForm({ ...form, tokensCap: form.tokensCap + 0.5 })}>+</Button>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-fuchsia-500/30 p-2.5">
                    <span className="flex flex-1 flex-col"><span className="text-sm font-medium">YOLO for this agent</span><span className="text-muted-foreground text-xs">No cap, approvals auto-granted, fast cycles</span></span>
                    <Switch checked={form.yolo} onCheckedChange={(v) => setForm({ ...form, yolo: v })} aria-label="YOLO for this agent" />
                  </div>
                  <Button onClick={save}>Save · logged and sent to {agent.name}</Button>
                </TabsContent>
              </TabsContents>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
