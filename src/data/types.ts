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
  /** Recipient agent id when one agent wrote to another (lane e-terminal: agent-to-agent view). */
  to?: string;
  /** Hive act: request, inform, query, done… */
  act?: string;
}

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
export interface Evidence {
  name: string;
  ext: string;
  size: string;
  attachedTo?: string;
}
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
  links: { label: string; href: string }[];
  evidence: Evidence[];
  tokens: number;
  origin: string;
  people: string[];
}

export type ActivityKind = 'message' | 'tool' | 'edit' | 'ticket' | 'breaker' | 'question';
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
}
