// Domain model. Everything the UI shows comes through these types from a DataProvider;
// nothing about your org, people or repos is written into components.

export type Role = 'paramount' | 'lead' | 'co-lead' | 'worker' | 'ephemeral' | 'watcher';
export type AgentStatus = 'working' | 'waiting' | 'constrained' | 'idle' | 'crashed';

export interface Agent {
  id: string;
  name: string;
  initials: string;
  role: Role;
  status: AgentStatus;
  engine: string;
  model: string;
  level: number;
  color: string; // a token name from the accent palette, e.g. "violet"
  doing: string;
  ticket?: string;
  step: number;
  steps: number;
  tokensUsed: number; // millions
  tokensCap: number; // millions
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  contextPct: number;
  bundle: string;
  skills: string[];
  mcps: string[];
  rules: string[];
  reportsTo?: string;
  persona?: string;
  tone?: string;
  autonomy?: string;
  yolo?: boolean; // per-agent override of the floor setting
}

export type ChatKind = 'agent' | 'group' | 'channel';
export interface Chat {
  id: string;
  kind: ChatKind;
  title: string;
  agentIds: string[];
  pinned?: boolean;
}

export type MessageKind = 'text' | 'question' | 'approval' | 'build' | 'suggestion' | 'route' | 'file' | 'context';
export interface Message {
  id: string;
  chatId: string;
  from: 'you' | string; // agent id
  at: string; // ISO
  kind: MessageKind;
  text: string;
  priority?: boolean;
  read?: boolean;
  ticket?: string;
  options?: string[];
  answer?: string;
  meta?: string;
  rows?: { label: string; ok: boolean; detail: string }[];
  links?: { label: string; href: string }[];
  /** How you replied to this ask: free text, a picked option, or "done" for a to-do only you could do. */
  answerMode?: AskMode;
  /** Set when you cleared the ask without answering it. */
  dismissed?: boolean;
  /** Only card asks (humanQA) can be dismissed; a direct message can only be replied to. */
  dismissible?: boolean;
}

export type AskMode = 'answer' | 'decision' | 'done';
/** Message kinds that are status updates rather than conversation; Chats can hide them. */
export const UPDATE_KINDS: readonly MessageKind[] = ['build', 'route', 'context', 'suggestion'];

export type NotificationKind = 'question' | 'approval' | 'suggestion' | 'alert';
export interface Notification {
  id: string;
  kind: NotificationKind;
  from: string;
  title: string;
  body: string;
  at: string;
  chatId?: string;
  messageId?: string;
  actions: string[];
  resolved?: string;
}

export type CardStatus = 'backlog' | 'todo' | 'doing' | 'blocked' | 'review' | 'done';
export type StepState = 'done' | 'doing' | 'blocked' | 'ask' | 'todo';
/** A link to an external item (PR, build, run, ADO work item); `url` is the real link stored on the card. */
export type CardRef = import('./paramount-api').ParamountCardRef;
export interface Card {
  key: string;
  title: string;
  status: CardStatus;
  priority: 'P1' | 'P2' | 'P3';
  agentId: string;
  created: string;
  createdBy: string;
  updated: string;
  task?: string;
  description: string;
  dependsOn?: string;
  plan: { text: string; state: StepState; note?: string }[];
  doneMeans: string[];
  /** Labels the agents set; the board filters on them. */
  tags: string[];
  workspace?: string;
  /** Absolute working directory, opened in Warp or VS Code. */
  dir?: string;
  /** PRs, builds, runs and ADO work items; ADO work items hold the card's evidence. */
  refs: CardRef[];
  tokens: number;
  origin: string;
  people: string[];
}

export type ActivityKind = 'message' | 'tool' | 'edit' | 'ticket' | 'breaker' | 'question' | 'lifecycle';
export interface ActivityEvent {
  id: string;
  at: string;
  agentId: string;
  kind: ActivityKind;
  text: string;
  tokens?: string;
}
export interface Timeline {
  agentId: string;
  segments: { state: AgentStatus; pct: number }[];
  counts: { messages: number; tools: number; files: number; done: number };
}

export type Access = 'rw' | 'r' | 'none';
export interface Source {
  id: string;
  name: string;
  short: string;
  via: string;
  state: 'ok' | 'warn' | 'fail';
  stateLabel: string;
  description: string;
  fields: { key: string; value: string }[];
  file: string;
  lastSync: string;
}
export interface Engine {
  id: string;
  name: string;
  plan: string;
  state: 'ok' | 'warn' | 'fail';
  stateLabel: string;
  models: string[];
  defaultModel: string;
  note: string;
}

export interface Automation {
  id: string;
  name: string;
  when: string;
  onlyIf: string;
  then: string;
  onFailure: string;
  enabled: boolean;
  runs: ('ok' | 'fail' | 'skip')[];
  last: string;
  file: string;
}

export type ServiceGroup = 'command-center' | 'studio';
export interface Service {
  id: string;
  group: ServiceGroup;
  name: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}
export interface LogEvent {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  text: string;
  correlation: string;
}

export interface TerminalLine {
  stream: 'out' | 'err' | 'in' | 'sys';
  text: string;
}
export interface TerminalSession {
  agentId: string;
  ptyId?: string;
  cwd: string;
  lines: TerminalLine[];
  pending?: { prompt: string; options: string[] };
}

export interface Connection {
  id: string;
  name: string;
  detail: string;
  connected: boolean;
}
export type IterationSpeed = 'fast' | 'balanced' | 'careful';
export interface YoloSettings {
  on: boolean; // floor-wide: no token caps, approvals auto-granted, breaker only steers
  autoOffHours: number | null; // turn itself off after N hours; null = stays on
  keepHardRules: boolean; // your ALWAYS/NEVER rules (no deletes, no policy bypass) still apply
  since?: string;
}
export interface IterationSettings {
  speed: IterationSpeed;
  heartbeatSec: number; // how often idle agents are woken to check their queue
  standupMin: number;
  checkpointEverySteps: number;
}

export interface Account {
  yolo: YoloSettings;
  iteration: IterationSettings;
  name: string;
  email: string;
  workEmail: string;
  timezone: string;
  connections: Connection[];
  notify: { id: string; label: string; on: boolean }[];
}

// Every change you make in the command center becomes an audit entry,
// and the agents it affects receive it as context.
export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  target: string;
  detail: string;
  contextFor: string[];
}

export interface Objective {
  id: string;
  title: string;
  why: string;
  owner: string; // agent id
  cardKeys: string[];
  due?: string;
  health: 'on-track' | 'at-risk' | 'blocked';
}
export interface Win {
  id: string;
  at: string;
  agentId: string;
  title: string;
  detail: string;
}

// What the app needs on this machine. Checked at every start; the setup screen offers to install what is missing.
export type PrereqState = 'ready' | 'installed-not-running' | 'missing' | 'outdated';
export interface Prerequisite {
  id: string;
  name: string;
  why: string;
  level: 'required' | 'recommended' | 'optional';
  state: PrereqState;
  detail: string;
  install?: string; // shell command shown to copy, or run by the core with your approval
  start?: string;
  docs?: string;
}

export interface Snapshot {
  prerequisites: Prerequisite[];
  setupDismissed?: boolean;
  objectives: Objective[];
  wins: Win[];
  me: Account;
  agents: Agent[];
  chats: Chat[];
  messages: Message[];
  notifications: Notification[];
  cards: Card[];
  /** The board's columns in the human's order; only columns the core supports. */
  board: { columns: CardStatus[] };
  activity: ActivityEvent[];
  timelines: Timeline[];
  sources: Source[];
  access: Record<string, Access>; // `${agentId}:${sourceId}`
  engines: Engine[];
  automations: Automation[];
  services: Service[];
  log: LogEvent[];
  terminals: TerminalSession[];
  audit: AuditEntry[];
  /** Home tile sizes, order, hidden tiles and spacing; saved by the core (home.layout). */
  homeLayout?: HomeLayout;
  /** Which update cards Chats hides; saved by the core (chats.view). */
  chatView?: ChatView;
}

export type HomeDensity = 'compact' | 'comfortable' | 'spacious';
export type TileSize = 'sm' | 'md' | 'lg';
export interface HomeLayout {
  density?: HomeDensity;
  order?: string[];
  tiles?: Record<string, { size?: TileSize; hidden?: boolean }>;
}
export interface ChatView {
  hideUpdates?: boolean;
  hiddenIds?: string[];
}
