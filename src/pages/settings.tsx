import * as React from 'react';
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Switch } from '@/components/animate-ui/components/radix/switch';
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
import { PrereqList } from '@/components/app/prereq-list';
import { Screen } from '@/components/app/screen';
import { CoreSettings } from '@/features/settings/core-settings';
import { ProviderSettings } from '@/features/settings/provider-settings';
import { MemorySettings } from '@/features/settings/memory-settings';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';

export function SettingsPage() {
  const me = useFloor((s) => s.me);
  const audit = useFloor((s) => s.audit);
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const profileReason = unsupported({ type: 'account.profile', patch: {} });
  const yoloReason = unsupported({ type: 'floor.yolo', patch: {} });
  const { route, go } = useRouter();
  const tab = route.params.get('tab') ?? 'account';
  const [profile, setProfile] = React.useState({ name: me.name, workEmail: me.workEmail, timezone: me.timezone });
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const connection = me.connections.find((item) => item.id === connectionId);
  const names = (ids: string[]) => ids.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(', ') || '—';

  const auditRow = (e: (typeof audit)[number]) => (
    <div key={e.id} className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <span className="flex items-center gap-2 text-sm"><span className="font-medium">{e.action}</span><span className="text-muted-foreground">· {e.target}</span><span className="text-muted-foreground ml-auto text-xs">{stamp(e.at)}</span></span>
      {e.detail && <span className="text-muted-foreground truncate text-xs">{e.detail}</span>}
      <span className="text-xs text-sky-300">Added to context of: {names(e.contextFor)}</span>
    </div>
  );

  return (
    <Screen>
      <div className="flex flex-col">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <span className="text-muted-foreground text-xs">Changes sent to the desktop core are logged with a correlation ID.</span>
      </div>
      <Tabs value={tab} onValueChange={(v) => go('settings', { tab: v })} className="flex min-h-0 flex-1 flex-col gap-3">
        <TabsList className="h-auto max-w-full flex-wrap">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="team">Team & models</TabsTrigger>
          <TabsTrigger value="providers">AI engines</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
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
              </div>
              <UnsupportedReason reason={profileReason} />
            </Tile>
          </TabsContent>
          <TabsContent value="connections">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {me.connections.map((c) => (
                <button key={c.id} type="button" onClick={() => setConnectionId(c.id)} className="bg-card hover:bg-accent flex items-center gap-3 rounded-xl border p-4 text-left">
                  <span className="flex flex-1 flex-col"><span className="font-medium">{c.name}</span><span className="text-muted-foreground text-xs">{c.detail}</span></span>
                  <Badge variant={c.connected ? 'success' : 'danger'}>{c.connected ? 'enabled' : 'off'}</Badge>
                </button>
              ))}
            </div>
            {!me.connections.length && <p className="text-muted-foreground p-4 text-sm">No integrations are registered in this core.</p>}
            <Dialog open={!!connection} onOpenChange={(open) => !open && setConnectionId(null)}>
              <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                {connection && <><DialogHeader><DialogTitle>{connection.name}</DialogTitle><DialogDescription>{connection.kind || connection.detail}</DialogDescription></DialogHeader>
                  <div className="grid gap-2 text-sm"><span>Endpoint: {connection.baseUrl || 'Not reported'}</span><span>Authentication: {connection.authType || 'Not reported'}</span><span>Credential: {connection.hasSecret ? 'Stored securely' : 'Not stored'}</span></div>
                  <div className="flex items-center gap-3"><span className="flex-1 text-sm">Allow agents to use this connection</span><Switch checked={connection.connected} disabled={!!unsupported({ type: 'account.connection', id: connection.id, connected: !connection.connected })} onCheckedChange={(on) => { void dispatch({ type: 'account.connection', id: connection.id, connected: on }); }} aria-label={`Enable ${connection.name}`} /></div>
                  <UnsupportedReason reason={unsupported({ type: 'account.connection', id: connection.id, connected: !connection.connected })} />
                </>}
              </DialogContent>
            </Dialog>
          </TabsContent>
          <TabsContent value="team"><CoreSettings /></TabsContent>
          <TabsContent value="providers"><ProviderSettings /></TabsContent>
          <TabsContent value="memory"><MemorySettings /></TabsContent>
          <TabsContent value="autonomy">
            <div className="grid gap-3 lg:grid-cols-2">
              <Tile title="YOLO mode" hint="no limits, fast cycles" className="border-fuchsia-500/30">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm">YOLO overrides autonomy limits while on. The breaker still records activity.</span>
                  <Switch checked={me.yolo.on} disabled={!!yoloReason} onCheckedChange={(v) => dispatch({ type: 'floor.yolo', patch: { on: v } })} aria-label="YOLO mode" />
                </div>
                <UnsupportedReason reason={yoloReason} />
              </Tile>
              <Tile title="Mission cadence"><p className="text-muted-foreground text-sm">Heartbeat and standup schedules are managed in Team → Automations.</p></Tile>
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
    </Screen>
  );
}
