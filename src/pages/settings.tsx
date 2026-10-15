import * as React from 'react';
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { RadioGroup, RadioGroupItem } from '@/components/animate-ui/components/radix/radio-group';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tile } from '@/components/app/tile';
import { SeeAll } from '@/components/app/see-all';
import { stamp } from '@/components/app/format';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import { UnsupportedReason } from '@/components/app/error-notice';
import { useRouter } from '@/app/router';
import { resetMockData } from '@/data/mock-provider';
import { PrereqList } from '@/components/app/prereq-list';
import type { IterationSettings } from '@/data/types';

const speeds: Record<IterationSettings['speed'], { label: string; hint: string; patch: Partial<IterationSettings> }> = {
  fast: { label: 'Fast', hint: 'Heartbeat 15 s · standup every 15 min · checkpoint every step', patch: { speed: 'fast', heartbeatSec: 15, standupMin: 15, checkpointEverySteps: 1 } },
  balanced: { label: 'Balanced', hint: 'Heartbeat 60 s · standup hourly · checkpoint every step', patch: { speed: 'balanced', heartbeatSec: 60, standupMin: 60, checkpointEverySteps: 1 } },
  careful: { label: 'Careful', hint: 'Heartbeat 5 min · standup hourly · checkpoint every step, review before merges', patch: { speed: 'careful', heartbeatSec: 300, standupMin: 60, checkpointEverySteps: 1 } },
};

export function SettingsPage() {
  const me = useFloor((s) => s.me);
  const audit = useFloor((s) => s.audit);
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const profileReason = unsupported({ type: 'account.profile', patch: {} });
  const yoloReason = unsupported({ type: 'floor.yolo', patch: {} });
  const iterationReason = unsupported({ type: 'floor.iteration', patch: {} });
  const { route, go } = useRouter();
  const tab = route.params.get('tab') ?? 'account';
  const [profile, setProfile] = React.useState({ name: me.name, workEmail: me.workEmail, timezone: me.timezone });
  const names = (ids: string[]) => ids.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(', ') || '—';

  const auditRow = (e: (typeof audit)[number]) => (
    <div key={e.id} className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <span className="flex items-center gap-2 text-sm"><span className="font-medium">{e.action}</span><span className="text-muted-foreground">· {e.target}</span><span className="text-muted-foreground ml-auto text-xs">{stamp(e.at)}</span></span>
      {e.detail && <span className="text-muted-foreground truncate text-xs">{e.detail}</span>}
      <span className="text-xs text-sky-300">Added to context of: {names(e.contextFor)}</span>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-col">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <span className="text-muted-foreground text-xs">Every change here is logged and added to the context of the agents it affects.</span>
      </div>
      <Tabs value={tab} onValueChange={(v) => go('settings', { tab: v })} className="flex min-h-0 flex-1 flex-col gap-3">
        <TabsList>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="autonomy">Autonomy & YOLO</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="audit">My changes</TabsTrigger>
        </TabsList>
        <TabsContents className="min-h-0 flex-1">
          <TabsContent value="setup">
            <Tile title="What this Mac needs" hint="checked at every start · install from here">
              <PrereqList />
            </Tile>
          </TabsContent>
          <TabsContent value="account">
            <Tile title="Your account" className="max-w-xl">
              <div className="grid gap-1.5"><Label htmlFor="s-name">Name</Label><Input id="s-name" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label htmlFor="s-work">Work email (used for commits)</Label><Input id="s-work" value={profile.workEmail} onChange={(e) => setProfile({ ...profile, workEmail: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label htmlFor="s-tz">Time zone</Label><Input id="s-tz" value={profile.timezone} onChange={(e) => setProfile({ ...profile, timezone: e.target.value })} /></div>
              <div className="flex gap-2 pt-1">
                <Button disabled={!!profileReason} onClick={() => dispatch({ type: 'account.profile', patch: profile })}>Save</Button>
                <Button variant="ghost" onClick={() => { resetMockData(); window.location.reload(); }}>Reset sample data</Button>
              </div>
              <UnsupportedReason reason={profileReason} />
            </Tile>
          </TabsContent>
          <TabsContent value="connections">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {me.connections.map((c) => (
                <div key={c.id} className="bg-card flex items-center gap-3 rounded-xl border p-4">
                  <span className="flex flex-1 flex-col"><span className="font-medium">{c.name}</span><span className="text-muted-foreground text-xs">{c.detail}</span></span>
                  <Badge variant={c.connected ? 'success' : 'danger'}>{c.connected ? 'connected' : 'off'}</Badge>
                  <Switch checked={c.connected} disabled={!!unsupported({ type: 'account.connection', id: c.id, connected: !c.connected })} title={unsupported({ type: 'account.connection', id: c.id, connected: !c.connected }) ?? undefined} onCheckedChange={(v) => dispatch({ type: 'account.connection', id: c.id, connected: v })} aria-label={`Connect ${c.name}`} />
                </div>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="autonomy">
            <div className="grid gap-3 lg:grid-cols-2">
              <Tile title="YOLO mode" hint="no limits, fast cycles" className="border-fuchsia-500/30">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm">No token caps · approvals auto-granted · the breaker only steers. Everything is still logged.</span>
                  <Switch checked={me.yolo.on} disabled={!!yoloReason} onCheckedChange={(v) => dispatch({ type: 'floor.yolo', patch: { on: v } })} aria-label="YOLO mode" />
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm">Keep my hard rules (no deletes, no policy bypass)</span>
                  <Switch checked={me.yolo.keepHardRules} disabled={!!yoloReason} onCheckedChange={(v) => dispatch({ type: 'floor.yolo', patch: { keepHardRules: v } })} aria-label="Keep hard rules" />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm">Turn itself off after</span>
                  <RadioGroup value={String(me.yolo.autoOffHours ?? 'never')} disabled={!!yoloReason} onValueChange={(v) => dispatch({ type: 'floor.yolo', patch: { autoOffHours: v === 'never' ? null : Number(v) } })} className="flex flex-wrap gap-4">
                    {['1', '2', '8', 'never'].map((v) => (
                      <Label key={v} className="gap-2 font-normal"><RadioGroupItem value={v} />{v === 'never' ? 'Never' : `${v} h`}</Label>
                    ))}
                  </RadioGroup>
                </div>
                <UnsupportedReason reason={yoloReason} />
              </Tile>
              <Tile title="Iteration cycle" hint="how fast the floor loops">
                <RadioGroup value={me.iteration.speed} disabled={!!iterationReason} onValueChange={(v) => dispatch({ type: 'floor.iteration', patch: speeds[v as IterationSettings['speed']].patch })} className="flex flex-col gap-3">
                  {(Object.keys(speeds) as IterationSettings['speed'][]).map((k) => (
                    <Label key={k} className="items-start gap-3 rounded-lg border p-3 font-normal">
                      <RadioGroupItem value={k} className="mt-0.5" />
                      <span className="flex flex-col gap-0.5"><span className="font-medium">{speeds[k].label}</span><span className="text-muted-foreground text-xs">{speeds[k].hint}</span></span>
                    </Label>
                  ))}
                </RadioGroup>
                <UnsupportedReason reason={iterationReason} />
              </Tile>
            </div>
          </TabsContent>
          <TabsContent value="notifications">
            <Tile title="What reaches you" className="max-w-xl">
              {me.notify.map((n) => (
                <div key={n.id} className="flex items-center gap-3 py-1">
                  <span className="flex-1 text-sm">{n.label}</span>
                  <Switch checked={n.on} disabled={!!unsupported({ type: 'account.notify', id: n.id, on: !n.on })} title={unsupported({ type: 'account.notify', id: n.id, on: !n.on }) ?? undefined} onCheckedChange={(v) => dispatch({ type: 'account.notify', id: n.id, on: v })} aria-label={n.label} />
                </div>
              ))}
            </Tile>
          </TabsContent>
          <TabsContent value="audit">
            <Tile title="My changes" hint="the audit log of everything you changed here" actions={audit.length > 8 ? <SeeAll title="My changes" count={audit.length}>{audit.map(auditRow)}</SeeAll> : null}>
              <div className="grid gap-2 lg:grid-cols-2">{audit.slice(0, 8).map(auditRow)}</div>
            </Tile>
          </TabsContent>
        </TabsContents>
      </Tabs>
    </div>
  );
}
