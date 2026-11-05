import { EventEmitter } from 'node:events'
import type {
  AgentId,
  AgentStatus,
  ImageAttachment,
  ModelOption,
  PermissionMode,
  SlashCommand,
  PlanStep,
  PlanUsage,
  Settings,
  TimelineItem,
  Usage
} from '@shared/types'

export type ApprovalDecision = 'approve' | 'approveSession' | 'deny'

/** Where an adapter reports everything that happens during a turn. */
export interface TurnSink {
  /** Add an item, or replace the item with the same id. */
  upsert(item: TimelineItem): void
  /** Append streamed text to an item's text/output. */
  append(itemId: string, field: 'text' | 'output', delta: string): void
  /** Shallow-merge fields into an existing item. */
  patch(itemId: string, patch: Partial<TimelineItem>): void
  has(itemId: string): boolean
  setPlan(steps: PlanStep[]): void
  setUsage(usage: Partial<Usage>): void
  setSessionId(id: string): void
  /**
   * `key` groups requests that "Always allow this chat" covers (default: same title and detail).
   * `signal` withdraws the request (the agent gave up on it, e.g. its turn was interrupted): it
   * resolves as 'deny' and the card is closed.
   */
  requestApproval(req: { title: string; detail?: string; parentId?: string; key?: string; signal?: AbortSignal }): Promise<ApprovalDecision>
  /**
   * The agent finished the turn (successfully or not). `interrupted`: it stopped because the
   * user asked it to, so it isn't an error even if the agent reports one.
   */
  turnDone(result?: { error?: string; interrupted?: boolean }): void
  notice(text: string, tone?: 'info' | 'warn' | 'error' | 'success'): void
}

export interface TurnInput {
  text: string
  images?: ImageAttachment[]
  model: string
  effort?: string
  permissionMode: PermissionMode
  /**
   * This message with the whole conversation before it prepended as a context block. An adapter
   * that could not resume its native session (expired, deleted, moved) starts a fresh one and
   * sends this instead of `text`, so the agent doesn't silently lose everything it knew.
   */
  recoveryContext?: () => string
}

/**
 * Errors that mean the agent's saved session can't be resumed (it expired, was deleted, or
 * belongs to another folder). Matched against Claude Code and Codex error text.
 */
export const STALE_SESSION_RE = /no conversation found|session(?: id)? .*not found|thread not found|no rollout found|rollout .*(?:not found|missing)|failed to (?:load|resume) (?:session|thread|rollout)|invalid (?:session|thread) id/i

/** Resolve within `ms`, or fall back to `fallback` (never rejects). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback))
    )
  })
}

export interface AgentSession {
  /** Start a turn. Resolves once the agent accepted it; completion arrives via sink.turnDone. */
  send(input: TurnInput): Promise<void>
  /** Inject a message into the running turn, if the agent supports it. */
  steer?(text: string): Promise<boolean>
  interrupt(): Promise<void>
  compact(): Promise<void>
  dispose(): void
}

/** R-Code's own tools (delegation, new-chat suggestions) exposed to each agent. */
export interface BridgeInfo {
  url: string
  token: string
  mcpScript: string
  piExtension: string
  nodeBinary: string
}

export interface SessionInit {
  threadId: string
  cwd: string
  resumeId?: string
  model: string
  effort?: string
  permissionMode: PermissionMode
  settings: Settings
  sink: TurnSink
  /** Extra system instructions describing R-Code's orchestration tools. */
  instructions?: string
  bridge?: BridgeInfo
  /** Delegated child threads don't get the delegation tools (no infinite recursion). */
  allowDelegation: boolean
}

export interface AgentAdapter {
  id: AgentId
  detect(settings: Settings): Promise<AgentStatus>
  listModels(settings: Settings): Promise<ModelOption[]>
  createSession(init: SessionInit): AgentSession
  /** Subscription rate-limit usage, or null when the agent isn't on a plan with limits. */
  planUsage?(): Promise<PlanUsage | null>
  /** The slash commands this agent's harness offers in `cwd` (project commands depend on the folder). */
  listCommands?(settings: Settings, cwd: string): Promise<SlashCommand[]>
}

/** A small per-folder cache for command lists (each lookup starts a process). */
export function commandCache(ttlMs = 120_000): (cwd: string, load: () => Promise<SlashCommand[]>) => Promise<SlashCommand[]> {
  const cache = new Map<string, { at: number; value: Promise<SlashCommand[]> }>()
  return (cwd, load) => {
    const hit = cache.get(cwd)
    if (hit && Date.now() - hit.at < ttlMs) return hit.value
    const value = load().catch(() => [])
    cache.set(cwd, { at: Date.now(), value })
    // Don't keep an empty answer (the agent may just not be signed in yet) for the full TTL.
    void value.then((v) => !v.length && cache.get(cwd)?.value === value && cache.delete(cwd))
    return value
  }
}

/**
 * Live usage signals from running sessions: 'refresh' (agent id) asks for a re-read,
 * 'codex' carries a rolling Codex rate-limit snapshot.
 */
export const usageBus = new EventEmitter()

let counter = 0
export function uid(prefix = 'i'): string {
  counter = (counter + 1) % 1e6
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters)` : s
}

export function shortPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
  const home = process.env.HOME
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}
