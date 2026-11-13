import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/animate-ui/components/buttons/icon';
import { Send } from '@/components/animate-ui/icons/send';
import { Search } from '@/components/animate-ui/icons/search';
import { X } from '@/components/animate-ui/icons/x';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { AgentSummary } from '@/components/app/agent-summary';
import { MessageItem } from '@/components/app/message-item';
import { EngineSignInActions } from '@/components/app/engine-sign-in-actions';
import { isOpenAsk } from '@/features/home/ask-preview';
import { roleMeta, statusMeta } from '@/components/app/status';
import { clock } from '@/components/app/format';
import { useDispatch, useFloor, useTeamApi } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import { UPDATE_KINDS, type Agent, type Chat, type Message } from '@/data/types';
import type { ParamountTeamModels } from '@/data/paramount-api';
import { Screen } from '@/components/app/screen';
import { findBridge } from '@/data/bridge';

type Filter = 'all' | 'unread' | 'asks' | 'leads' | 'workers' | 'groups';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'asks', label: 'Asking you' },
  { value: 'leads', label: 'Leads' }, { value: 'workers', label: 'Workers' }, { value: 'groups', label: 'Groups' },
];
const LEAD_ROLES = ['paramount', 'lead', 'co-lead'];
const WORKER_ROLES = ['worker', 'ephemeral', 'watcher'];
const isUpdate = (m: Message) => UPDATE_KINDS.includes(m.kind);

/** Clicking an agent's picture opens that agent's settings (Team › agent › Profile). */
function AvatarLink({ agent, size, onOpen }: { agent: Agent; size?: 'sm' | 'md'; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(agent.id)} aria-label={`Open ${agent.name}'s settings`} title={`Open ${agent.name}'s settings`} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:outline-none">
      <AgentAvatar agent={agent} size={size} tooltip={false} />
    </button>
  );
}

export function ChatsPage() {
  const chats = useFloor((s) => s.chats);
  const messages = useFloor((s) => s.messages);
  const agents = useFloor((s) => s.agents);
  const view = useFloor((s) => s.chatView);
  const dispatch = useDispatch();
  const teamApi = useTeamApi();
  const { route, go } = useRouter();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [q, setQ] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const [attachments, setAttachments] = React.useState<Array<{ path: string; name: string }>>([]);
  const [inputStatus, setInputStatus] = React.useState('');
  const [recording, setRecording] = React.useState(false);
  const recorder = React.useRef<MediaRecorder | null>(null);
  const audioChunks = React.useRef<Blob[]>([]);
  React.useEffect(() => () => { try { recorder.current?.stop(); } catch { /* already stopped */ } }, []);
  const current = route.params.get('c') ?? chats[0]?.id;
  const endRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const openSettings = (id: string) => go('team', { agent: id, tab: 'profile' });

  const hideUpdates = view?.hideUpdates === true;
  const hiddenIds = React.useMemo(() => new Set(view?.hiddenIds ?? []), [view?.hiddenIds]);
  const hideOne = (id: string) => void dispatch({ type: 'chats.view', hiddenIds: [...(view?.hiddenIds ?? []), id] });

  const lead = (c: Chat) => agents.find((a) => a.id === c.agentIds[0]);
  const byChat = React.useMemo(() => {
    const out = new Map<string, Message[]>();
    for (const m of messages) out.set(m.chatId, [...(out.get(m.chatId) ?? []), m]);
    return out;
  }, [messages]);
  const lastOf = (id: string) => [...(byChat.get(id) ?? [])].reverse().find((m) => m.kind !== 'context');
  const unreadOf = (id: string) => (byChat.get(id) ?? []).filter((m) => m.from !== 'you' && !m.read && m.kind !== 'context' && m.kind !== 'route').length;
  const asksOf = (id: string) => (byChat.get(id) ?? []).filter(isOpenAsk).length;

  const matches = (c: Chat, f: Filter) => {
    const a = lead(c);
    if (f === 'unread') return unreadOf(c.id) > 0;
    if (f === 'asks') return asksOf(c.id) > 0;
    if (f === 'groups') return c.kind !== 'agent';
    if (f === 'leads') return !!a && LEAD_ROLES.includes(a.role);
    if (f === 'workers') return !!a && WORKER_ROLES.includes(a.role);
    return true;
  };
  // Search looks at the chat title, its agents' names and roles, and what was said.
  const searched = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter((c) => {
      const names = c.agentIds.map((id) => agents.find((a) => a.id === id)).flatMap((a) => (a ? [a.name, a.role] : []));
      const said = (byChat.get(c.id) ?? []).map((m) => m.text);
      return [c.title, ...names, ...said].some((s) => s.toLowerCase().includes(needle));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, agents, byChat, q]);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, searched.filter((c) => matches(c, f.value)).length])) as Record<Filter, number>;
  const list = searched
    .filter((c) => matches(c, filter))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (lastOf(b.id)?.at ?? '').localeCompare(lastOf(a.id)?.at ?? ''));

  const chat = chats.find((c) => c.id === current);
  const fullThread = React.useMemo(() => byChat.get(current ?? '') ?? [], [byChat, current]);
  const updates = fullThread.filter(isUpdate);
  const hiddenHere = updates.filter((m) => hideUpdates || hiddenIds.has(m.id)).length;
  const thread = fullThread.filter((m) => !isUpdate(m) || !(hideUpdates || hiddenIds.has(m.id)));
  const focus = chat ? agents.find((a) => a.id === chat.agentIds[0]) : undefined;
  const [accountModels, setAccountModels] = React.useState<ParamountTeamModels | null>(null);
  const accountModel = focus ? accountModels?.agents[focus.id] : undefined;
  React.useEffect(() => {
    setAccountModels(null);
    if (!focus || (focus.engine !== 'claude' && focus.engine !== 'codex') || !teamApi) return;
    let active = true;
    teamApi.models().then((models) => { if (active) setAccountModels(models); }, () => { if (active) setAccountModels(null); });
    return () => { active = false; };
  }, [teamApi, focus?.id, focus?.engine]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length, current]);

  const send = () => {
    const text = [draft.trim(), ...attachments.map((file) => `Attached file: ${file.path}`)].filter(Boolean).join('\n\n');
    if (!text || !chat) return;
    void dispatch({ type: 'chat.send', chatId: chat.id, text }).then((ok) => { if (ok) { setDraft(''); setAttachments([]); } });
  };
  const addFiles = (files: Array<{ path: string; name: string }>) => setAttachments((current) => [...current, ...files.filter((file) => !current.some((item) => item.path === file.path))]);
  const chooseFiles = async () => {
    setInputStatus('');
    try { const bridge = findBridge(); if (!bridge?.attachFiles) throw new Error('File attachments need the desktop app.'); const result = await bridge.attachFiles(); if (!result.ok) throw new Error(result.error); addFiles(result.files); }
    catch (error) { setInputStatus(error instanceof Error ? error.message : 'Could not choose files'); }
  };
  const pasteImage = async () => {
    setInputStatus('');
    try { const bridge = findBridge(); if (!bridge?.saveClipboardImage) throw new Error('Clipboard image attachments are unavailable.'); const result = await bridge.saveClipboardImage(); if (!result.ok) throw new Error(result.error); addFiles([result.file]); }
    catch (error) { setInputStatus(error instanceof Error ? error.message : 'No clipboard image available'); }
  };
  const toggleDictation = async () => {
    setInputStatus('');
    if (recording && recorder.current) { recorder.current.stop(); return; }
    try {
      const bridge = findBridge();
      if (!bridge?.freeflowTranscribe) throw new Error('Dictation is unavailable in this desktop build.');
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This device does not support microphone capture.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const active = new MediaRecorder(stream); audioChunks.current = []; recorder.current = active;
      active.ondataavailable = (event) => { if (event.data.size) audioChunks.current.push(event.data); };
      active.onerror = () => { stream.getTracks().forEach((track) => track.stop()); setRecording(false); setInputStatus('Microphone recording failed.'); };
      active.onstop = async () => {
        setRecording(false); stream.getTracks().forEach((track) => track.stop()); recorder.current = null;
        try {
          const audio = new Blob(audioChunks.current, { type: active.mimeType || 'audio/webm' });
          const bytes = await audio.arrayBuffer(); const result = await bridge.freeflowTranscribe!({ audio: bytes, mimeType: audio.type, filename: 'paramount-dictation.webm' });
          if (!result.ok || !result.text) throw new Error(result.error || 'No speech was detected.');
          setDraft((current) => `${current}${current ? ' ' : ''}${result.text}`);
        } catch (error) { setInputStatus(error instanceof Error ? error.message : 'Dictation failed. Check Free Flow setup and microphone access.'); }
      };
      active.start(); setRecording(true); setInputStatus('Recording. Select Stop dictation to transcribe.');
    } catch (error) { setInputStatus(error instanceof Error ? error.message : 'Microphone permission was denied or unavailable.'); }
  };
  const showUpdates = () => void dispatch({ type: 'chats.view', hideUpdates: false, hiddenIds: (view?.hiddenIds ?? []).filter((id) => !updates.some((m) => m.id === id)) });

  return (
    <Screen fill className="bg-card grid grid-cols-1 gap-0 overflow-hidden rounded-xl border lg:grid-cols-[320px_1fr] 2xl:grid-cols-[320px_1fr_320px]">
      <aside className="flex min-h-0 flex-col overflow-hidden border-r">
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="bg-muted/60 focus-within:ring-ring/50 flex h-9 items-center gap-2 rounded-lg px-2.5 focus-within:ring-2">
            <Search className="text-muted-foreground size-4 shrink-0" />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
              placeholder="Search people, roles or messages"
              aria-label="Search chats"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {q && (
              <button type="button" aria-label="Clear search" onClick={() => { setQ(''); searchRef.current?.focus(); }} className="text-muted-foreground hover:text-foreground rounded p-0.5">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div role="tablist" aria-label="Filter chats" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                  filter === f.value ? 'bg-primary text-primary-foreground border-transparent' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {f.label}
                <span className={cn('tabular-nums text-[10px]', filter === f.value ? 'opacity-80' : 'opacity-60')}>{counts[f.value]}</span>
              </button>
            ))}
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-2" aria-label="Chats">
          {list.length === 0 && (
            <span className="text-muted-foreground p-3 text-center text-sm">{q ? `No chat matches “${q}”` : 'No chats in this filter'}</span>
          )}
          {list.map((c) => {
            const a = lead(c);
            const last = lastOf(c.id);
            const unread = unreadOf(c.id);
            const asks = asksOf(c.id);
            return (
              <div key={c.id} className={cn('hover:bg-accent flex items-center gap-3 rounded-lg p-2', c.id === current && 'bg-accent')}>
                {a && c.kind === 'agent' ? <AvatarLink agent={a} onOpen={openSettings} /> : <span className="bg-secondary flex size-10 shrink-0 items-center justify-center rounded-full font-mono text-xs">{c.kind === 'group' ? '#' : 'TG'}</span>}
                <button type="button" onClick={() => go('chats', { c: c.id })} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{c.title}</span>
                    {a && c.kind === 'agent' && <Badge variant={roleMeta[a.role].variant} className="px-1.5 py-0 text-[10px]">{roleMeta[a.role].label}</Badge>}
                    <span className="text-muted-foreground ml-auto text-[11px]">{last ? clock(last.at) : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn('truncate text-xs', asks ? 'text-amber-300' : 'text-muted-foreground')}>{last?.text ?? ''}</span>
                    {asks > 0 && <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-300" title={`${asks} waiting on you`}>{asks} ask{asks === 1 ? '' : 's'}</span>}
                    {unread > 0 && <span className={cn('bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] font-semibold', !asks && 'ml-auto')}>{unread}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => {
        const bridge = findBridge();
        const files = [...event.dataTransfer.files].flatMap((file) => { const path = bridge?.pathForFile?.(file); return path ? [{ path, name: file.name }] : []; });
        if (files.length) { event.preventDefault(); addFiles(files); setInputStatus('Files attached. Select Send to share their paths with the agent.'); }
      }}>
        {chat && (
          <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
            {focus && chat.kind === 'agent' ? <AvatarLink agent={focus} size="sm" onOpen={openSettings} /> : null}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{chat.title}</span>
              <span className={cn('truncate text-xs', focus ? statusMeta[focus.status].text : 'text-muted-foreground')}>{chat.kind === 'agent' && focus ? focus.doing : `${chat.agentIds.length} agents`}</span>
            </div>
            <button
              type="button"
              aria-pressed={hideUpdates}
              onClick={() => void dispatch({ type: 'chats.view', hideUpdates: !hideUpdates })}
              title="Pipeline, routing, context and suggestion cards"
              className={cn('rounded-full border px-2.5 py-1 text-xs', hideUpdates ? 'bg-accent' : 'text-muted-foreground hover:bg-accent')}
            >
              {hideUpdates ? 'Updates hidden' : 'Hide updates'}
            </button>
            {chat.kind === 'agent' && focus && (
              <button type="button" className="text-primary text-sm hover:underline" onClick={() => go('terminal', { a: focus.id })}>
                Terminal
              </button>
            )}
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
          <div className="mt-auto" />
          {chat?.kind === 'agent' && focus?.status === 'crashed' && (focus.engine === 'claude' || focus.engine === 'codex') && accountModel && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="mb-2 flex flex-col gap-1"><span className="text-sm font-medium">{focus.engine === 'codex' ? 'Codex' : 'Claude Code'} unavailable?</span><span className="text-muted-foreground text-xs">Check sign-in for this chat’s account{accountModel.launcher ? ` (${accountModel.launcher?.label})` : ' (provider default)'}. Sign in here if needed; then check again. Restart the agent after access is restored.</span></div>
            <EngineSignInActions provider={focus.engine} state="unknown" cliAvailable={accountModel.installed} accountId={accountModel.launcher?.id} accountFingerprint={accountModel.launcher?.fingerprint} accountLabel={accountModel.launcher?.label} />
          </div>}
          {hiddenHere > 0 && (
            <div className="text-muted-foreground flex items-center justify-center gap-2 self-center text-xs">
              {hiddenHere} update{hiddenHere === 1 ? '' : 's'} hidden
              <button type="button" className="text-primary hover:underline" onClick={showUpdates}>Show</button>
            </div>
          )}
          {thread.map((m) => (
            <MessageItem key={m.id} m={m} agents={agents} showNames={chat?.kind !== 'agent'} onHide={isUpdate(m) ? () => hideOne(m.id) : undefined} />
          ))}
          <div ref={endRef} />
        </div>
        {attachments.length > 0 && <div className="flex flex-wrap gap-2 border-t px-3 pt-3" aria-label="Attached files">{attachments.map((file) => <span key={file.path} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs"><span className="truncate">{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}>×</button></span>)}</div>}
        {inputStatus && <p role="status" aria-live="polite" className={`px-4 pt-2 text-xs ${recording ? 'text-rose-300' : 'text-muted-foreground'}`}>{inputStatus}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t p-3">
          <button type="button" onClick={() => void chooseFiles()} className="rounded-full border px-3 py-2 text-xs hover:bg-accent" aria-label="Attach files">Attach</button>
          <button type="button" onClick={() => void pasteImage()} className="rounded-full border px-3 py-2 text-xs hover:bg-accent" aria-label="Attach clipboard image">Paste image</button>
          <button type="button" onClick={() => void toggleDictation()} aria-pressed={recording} className={`rounded-full border px-3 py-2 text-xs hover:bg-accent ${recording ? 'border-rose-400 text-rose-300' : ''}`}>{recording ? 'Stop dictation' : 'Dictate'}</button>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={chat ? `Message ${chat.title} · goes to the front of its queue` : 'Pick a chat'}
            aria-label="Message"
            className="h-11 rounded-full px-4"
            onPaste={(event) => {
              const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              const bridge = findBridge();
              const direct = images.flatMap((file) => { const path = bridge?.pathForFile?.(file); return path ? [{ path, name: file.name || 'clipboard-image' }] : []; });
              if (direct.length) { event.preventDefault(); addFiles(direct); setInputStatus('Clipboard image attached. Select Send to share it with the agent.'); }
              else if (event.clipboardData.types.includes('image')) {
                event.preventDefault(); void pasteImage();
              }
            }}
          />
          <IconButton aria-label="Send" onClick={send} className="size-11 rounded-full">
            <Send animateOnHover />
          </IconButton>
        </div>
      </section>

      {focus && (
        <aside className="hidden min-h-0 overflow-y-auto border-l p-4 2xl:block">
          <AgentSummary agent={focus} onOpenProfile={() => openSettings(focus.id)} />
        </aside>
      )}
    </Screen>
  );
}
