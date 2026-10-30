// Types shared by the main process (agent adapters, persistence) and the renderer (UI).

export type AgentId = 'claude' | 'codex' | 'pi'

export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'pi']

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi'
}

export interface AgentStatus {
  id: AgentId
  installed: boolean
  version?: string
  path?: string
  /** null = unknown */
  authenticated: boolean | null
  authDetail?: string
  linked: boolean
}

export interface ModelOption {
  /** Model id passed to the agent (for Pi: "provider/modelId"). */
  id: string
  label: string
  agent: AgentId
  provider?: string
  description?: string
  efforts?: string[]
  defaultEffort?: string
  contextWindow?: number
  local?: boolean
}

/** Unified permission modes; each adapter maps these onto its agent. */
export type PermissionMode = 'ask' | 'acceptEdits' | 'auto' | 'allowAll' | 'plan'

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask first',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  allowAll: 'Allow all',
  plan: 'Plan only'
}

export type ToolKind = 'command' | 'edit' | 'read' | 'search' | 'web' | 'browser' | 'ios' | 'task' | 'mcp' | 'todo' | 'other'

export interface ImageAttachment {
  name: string
  mimeType: string
  /** base64, no data: prefix */
  data: string
}

interface ItemBase {
  id: string
  ts: number
  /** Claude subagent nesting: id of the Task tool item that spawned this item. */
  parentId?: string
}

export type TimelineItem =
  | (ItemBase & { kind: 'user'; text: string; images?: ImageAttachment[]; agent?: AgentId; queued?: boolean })
  | (ItemBase & { kind: 'assistant'; text: string; agent: AgentId; model?: string; streaming?: boolean })
  | (ItemBase & { kind: 'reasoning'; text: string; streaming?: boolean; durationMs?: number })
  | (ItemBase & {
      kind: 'tool'
      tool: string
      toolKind: ToolKind
      title: string
      detail?: string
      input?: unknown
      output?: string
      diff?: string
      /** Primary file this tool touched (drives the language icon). */
      file?: string
      added?: number
      removed?: number
      /** Per-file breakdown when one tool call touched several files. */
      files?: { path: string; added: number; removed: number }[]
      status: 'running' | 'done' | 'error'
    })
  | (ItemBase & {
      kind: 'approval'
      requestId: string
      title: string
      detail?: string
      status: 'pending' | 'approved' | 'approvedSession' | 'denied'
    })
  | (ItemBase & {
      kind: 'notice'
      text: string
      tone: 'info' | 'warn' | 'error' | 'success'
      /** Optional one-click action, e.g. continue in a fresh chat seeded with a summary. */
      action?: { kind: 'newChatWithSummary' | 'signIn'; label: string; payload: string }
    })
  | (ItemBase & { kind: 'handoff'; from: AgentId; to: AgentId; model?: string })
  | (ItemBase & { kind: 'compaction'; summary?: string; tokensBefore?: number })
  | (ItemBase & {
      kind: 'delegation'
      childThreadId: string
      agent: AgentId
      model?: string
      task: string
      status: 'running' | 'done' | 'error'
      result?: string
    })

export type TimelineItemKind = TimelineItem['kind']

export interface PlanStep {
  text: string
  /** Present-tense label while the step is in progress ("Running the tests"). */
  active?: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  /** Tokens currently in the context window, when the agent reports it. */
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
}

export interface Thread {
  id: string
  title: string
  agent: AgentId
  model: string
  effort?: string
  permissionMode: PermissionMode
  projectPath?: string
  createdAt: number
  updatedAt: number
  /** Native session id per agent, so each agent can resume its own memory. */
  agentSessions: Partial<Record<AgentId, string>>
  /** Index into `items` up to which each agent has seen the conversation. */
  agentSeenUpTo: Partial<Record<AgentId, number>>
  /** Agents whose session was reset (e.g. the chat moved project): their next turn gets the full history. */
  contextResync?: AgentId[]
  parentThreadId?: string
  archived?: boolean
  /** When the chat was settled: done for now, tucked into the sidebar's Settled section. */
  settledAt?: number
  pinned?: boolean
  plan?: PlanStep[]
  usage?: Usage
  /** Context carried into a fresh chat; prepended to the first prompt. */
  seedContext?: string
  items: TimelineItem[]
}

/** One subscription rate-limit window, e.g. Claude's 5-hour session or Codex's weekly limit. */
export interface UsageWindow {
  id: string
  label: string
  /** 0–100 */
  usedPercent: number
  /** Epoch ms when the window resets. */
  resetsAt?: number
}

/** How much of a Claude Code / Codex subscription is used, as their CLIs report it. */
export interface PlanUsage {
  agent: AgentId
  /** e.g. 'Max', 'Pro', 'Plus' */
  plan?: string
  windows: UsageWindow[]
  fetchedAt: number
}

export type ThreadSummary = Omit<Thread, 'items'> & { lastText?: string; running?: boolean }

export interface Project {
  path: string
  name: string
  addedAt: number
}

export type ThemePref = 'system' | 'light' | 'dark'
export type WhisperModel = 'tiny' | 'base' | 'small'

export interface OllamaSettings {
  enabled: boolean
  baseUrl: string
  /** Ollama model names exposed to Pi. */
  models: string[]
}

export interface Settings {
  onboarded: boolean
  theme: ThemePref
  accent: string
  chatFontSize: number
  codeFontFamily: string
  translucent: boolean
  linkedAgents: AgentId[]
  defaultAgent: AgentId
  defaultModels: Partial<Record<AgentId, string>>
  favoriteModels: string[]
  /** `agent:modelId` keys left out of the model switcher. */
  hiddenModels: string[]
  defaultPermissionMode: PermissionMode
  sendWithEnter: boolean
  // orchestration
  shareContextAcrossAgents: boolean
  enableDelegation: boolean
  autoCompact: boolean
  compactThresholdPct: number
  suggestNewChatPct: number
  autoTitle: boolean
  // voice
  whisperModel: WhisperModel
  voiceLanguage: string
  autoSendVoice: boolean
  ttsEnabled: boolean
  ttsAutoRead: boolean
  /** Narrate replies sentence by sentence while the agent is still working. */
  ttsLiveRead: boolean
  ttsVoice: string
  ttsSpeed: number
  // pi
  ollama: OllamaSettings
  piThinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  // codex
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  // web search for the built-in agent
  searchProvider: 'auto' | 'brave' | 'tavily' | 'ollama' | 'searxng'
  searchKeys: { brave?: string; tavily?: string; ollama?: string }
  searxngUrl: string
  // iOS
  iosDevice?: string
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  theme: 'dark',
  accent: '#3773ef',
  chatFontSize: 15,
  codeFontFamily: 'Menlo',
  translucent: false,
  linkedAgents: [],
  defaultAgent: 'claude',
  defaultModels: {},
  favoriteModels: [],
  hiddenModels: [],
  defaultPermissionMode: 'acceptEdits',
  sendWithEnter: true,
  shareContextAcrossAgents: true,
  enableDelegation: true,
  autoCompact: true,
  compactThresholdPct: 85,
  suggestNewChatPct: 70,
  autoTitle: true,
  whisperModel: 'small',
  voiceLanguage: 'english',
  autoSendVoice: false,
  ttsEnabled: true,
  ttsAutoRead: false,
  ttsLiveRead: false,
  ttsVoice: 'af_heart',
  ttsSpeed: 1,
  ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434', models: [] },
  piThinking: 'medium',
  codexSandbox: 'workspace-write',
  searchProvider: 'auto',
  searchKeys: {},
  searxngUrl: ''
}

/** Events pushed from main to the renderer for a thread. */
export type ThreadEvent =
  | { type: 'item'; threadId: string; item: TimelineItem }
  | { type: 'delta'; threadId: string; itemId: string; field: 'text' | 'output'; delta: string }
  | { type: 'thread'; threadId: string; summary: ThreadSummary }
  | { type: 'status'; threadId: string; running: boolean }
  | { type: 'removed'; threadId: string }
  | { type: 'reset'; threadId: string; items: TimelineItem[] }

export interface InstallLogEvent {
  agent: AgentId | 'ollama' | 'node'
  line: string
  done?: boolean
  ok?: boolean
}

export interface SendOptions {
  text: string
  images?: ImageAttachment[]
  agent?: AgentId
  model?: string
  effort?: string
  permissionMode?: PermissionMode
}

export interface NewThreadOptions {
  agent: AgentId
  model: string
  effort?: string
  permissionMode: PermissionMode
  projectPath?: string
  title?: string
  parentThreadId?: string
}
