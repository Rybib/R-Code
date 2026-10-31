import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import {
  AGENT_LABELS,
  type AgentId,
  type NewThreadOptions,
  type PermissionMode,
  type SendOptions,
  type Thread,
  type ThreadEvent,
  type ThreadSummary,
  type TimelineItem,
  type Usage
} from '@shared/types'
import type { AgentAdapter, AgentSession, ApprovalDecision, BridgeInfo, TurnSink } from './agents/base'
import { truncate, uid } from './agents/base'
import { claudeAdapter } from './agents/claude'
import { codexAdapter } from './agents/codex'
import { piAdapter } from './agents/pi'
import { deleteThreadFile, getSettings, loadAllThreads, saveThread } from './store'
import { diffStats } from '@shared/diffstat'
import type { ToolDef } from './tools/registry'
import { str } from './tools/registry'
import { refreshUsageSoon } from './usage'

function withStats<T extends TimelineItem>(item: T): T {
  if (item.kind === 'tool' && item.diff && item.added === undefined) Object.assign(item, diffStats(item.diff))
  return item
}

export const adapters: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter, pi: piAdapter }

type Emit = (ev: ThreadEvent) => void

interface QueuedMessage {
  opts: SendOptions
  itemId: string
}

// Claude Code and Codex run on their own harness untouched: R-Code adds no system prompt for
// them (its tools describe themselves over MCP, and shared history explains itself where it
// appears). Pi is R-Code's own embedded agent, so it gets a short orientation.
const PI_INSTRUCTIONS = `You are running inside R-Code, a desktop app where the user works with several coding agents (Claude Code, Codex and you, Pi) in one conversation. R-Code gives you extra tools for its built-in browser, the iOS Simulator and delegating to other agents; each tool says when to use it. Work in the current folder by default, but when the user asks, you can read, run and change anything on their computer; R-Code asks them before actions that need approval. Keep answers well-formatted Markdown.`

const CHILD_INSTRUCTIONS = `You are a sub-agent: another agent delegated this one task to you. Do it fully, then end with a concise report of what you did and found. Your final message is returned to the delegating agent.`

export class Orchestrator {
  private threads = new Map<string, Thread>()
  private sessions = new Map<string, Partial<Record<AgentId, AgentSession>>>()
  private running = new Map<string, AgentId>()
  private queues = new Map<string, QueuedMessage[]>()
  private approvals = new Map<string, { resolve: (d: ApprovalDecision) => void; threadId: string; itemId: string }>()
  private turnWaiters = new Map<string, ((error?: string) => void)[]>()
  private pendingDeltas = new Map<string, { threadId: string; itemId: string; field: 'text' | 'output'; delta: string }>()
  private flushTimer: NodeJS.Timeout | null = null
  private sessionAllow = new Map<string, Set<string>>()
  bridge: BridgeInfo | undefined

  constructor(private emit: Emit) {
    for (const t of loadAllThreads()) this.threads.set(t.id, t)
  }

  // ───────────── queries ─────────────

  summaries(): ThreadSummary[] {
    return [...this.threads.values()].map((t) => this.summarize(t)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Thread | undefined {
    return this.threads.get(id)
  }

  private summarize(t: Thread): ThreadSummary {
    const { items, ...rest } = t
    let lastText: string | undefined
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if ((it.kind === 'assistant' || it.kind === 'user') && !it.parentId) {
        lastText = it.text.slice(0, 140)
        break
      }
    }
    return { ...rest, lastText, running: this.running.has(t.id) }
  }

  private touch(t: Thread, persist = true): void {
    t.updatedAt = Date.now()
    if (persist) saveThread(t)
    this.emit({ type: 'thread', threadId: t.id, summary: this.summarize(t) })
  }

  // ───────────── thread lifecycle ─────────────

  createThread(opts: NewThreadOptions): Thread {
    const now = Date.now()
    const t: Thread = {
      id: uid('t'),
      title: opts.title ?? 'New conversation',
      agent: opts.agent,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      projectPath: opts.projectPath,
      createdAt: now,
      updatedAt: now,
      agentSessions: {},
      agentSeenUpTo: {},
      parentThreadId: opts.parentThreadId,
      items: []
    }
    this.threads.set(t.id, t)
    saveThread(t, true)
    this.emit({ type: 'thread', threadId: t.id, summary: this.summarize(t) })
    return t
  }

  update(id: string, patch: Partial<Pick<Thread, 'title' | 'archived' | 'settledAt' | 'pinned' | 'permissionMode' | 'model' | 'effort' | 'agent' | 'projectPath'>>): void {
    const t = this.threads.get(id)
    if (!t) return
    if ('projectPath' in patch) {
      const { projectPath, ...rest } = patch
      this.setProject(id, projectPath || undefined)
      patch = rest
    }
    Object.assign(t, patch)
    this.touch(t)
  }

  /**
   * Move a chat to another project folder (or to none). Agent sessions are tied to the folder
   * they started in, so they're closed here; each agent's next turn starts fresh in the new
   * folder and is handed the whole conversation so far.
   */
  setProject(id: string, projectPath: string | undefined): void {
    const t = this.threads.get(id)
    if (!t || (t.projectPath || undefined) === projectPath) return
    if (this.running.has(id)) throw new Error('Wait for the agent to finish before moving this chat to another project.')
    this.disposeSessions(id)
    const hadContext = [...Object.keys(t.agentSessions), ...Object.keys(t.agentSeenUpTo)] as AgentId[]
    t.contextResync = [...new Set([...(t.contextResync ?? []), ...hadContext])]
    t.agentSessions = {}
    t.agentSeenUpTo = {}
    t.projectPath = projectPath
    const where = projectPath ? `project ${basename(projectPath)}` : 'no project'
    const note: TimelineItem = {
      kind: 'notice',
      id: uid('n'),
      ts: Date.now(),
      tone: 'info',
      text: t.items.length ? `Moved this chat to ${where}. The next reply starts there with the conversation so far.` : `This chat is now in ${where}.`
    }
    t.items.push(note)
    this.emit({ type: 'item', threadId: id, item: note })
    this.touch(t)
  }

  delete(id: string): void {
    void this.interrupt(id)
    this.disposeSessions(id)
    this.threads.delete(id)
    deleteThreadFile(id)
    this.emit({ type: 'removed', threadId: id })
  }

  private disposeSessions(id: string): void {
    const s = this.sessions.get(id)
    if (s) for (const sess of Object.values(s)) sess?.dispose()
    this.sessions.delete(id)
  }

  disposeAll(): void {
    for (const id of this.sessions.keys()) this.disposeSessions(id)
  }

  // ───────────── sink ─────────────

  private findItem(t: Thread, id: string): TimelineItem | undefined {
    for (let i = t.items.length - 1; i >= 0; i--) if (t.items[i].id === id) return t.items[i]
    return undefined
  }

  private flushDeltas(): void {
    this.flushTimer = null
    for (const d of this.pendingDeltas.values()) this.emit({ type: 'delta', ...d })
    this.pendingDeltas.clear()
  }

  private flushDeltasFor(threadId: string, itemId: string): void {
    for (const [key, d] of this.pendingDeltas) {
      if (d.threadId === threadId && d.itemId === itemId) {
        this.emit({ type: 'delta', ...d })
        this.pendingDeltas.delete(key)
      }
    }
  }

  private makeSink(t: Thread, agent: AgentId): TurnSink {
    const self = this
    return {
      upsert(item) {
        withStats(item)
        const idx = t.items.findIndex((i) => i.id === item.id)
        if (idx >= 0) t.items[idx] = item
        else t.items.push(item)
        self.flushDeltasFor(t.id, item.id)
        self.emit({ type: 'item', threadId: t.id, item })
        saveThread(t)
      },
      append(itemId, field, delta) {
        const item = self.findItem(t, itemId) as any
        if (!item) return
        item[field] = (item[field] ?? '') + delta
        const key = `${t.id}:${itemId}:${field}`
        const pending = self.pendingDeltas.get(key)
        if (pending) pending.delta += delta
        else self.pendingDeltas.set(key, { threadId: t.id, itemId, field, delta })
        if (!self.flushTimer) self.flushTimer = setTimeout(() => self.flushDeltas(), 32)
        saveThread(t)
      },
      patch(itemId, patch) {
        const item = self.findItem(t, itemId)
        if (!item) return
        Object.assign(item, patch)
        if ('diff' in patch && item.kind === 'tool') {
          item.added = undefined
          withStats(item)
        }
        self.flushDeltasFor(t.id, itemId)
        self.emit({ type: 'item', threadId: t.id, item })
        saveThread(t)
      },
      has(itemId) {
        return !!self.findItem(t, itemId)
      },
      setPlan(steps) {
        t.plan = steps
        self.touch(t)
      },
      setUsage(u: Partial<Usage>) {
        const clean = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined))
        t.usage = { inputTokens: 0, outputTokens: 0, ...(t.usage ?? {}), ...clean }
        self.touch(t)
      },
      setSessionId(id) {
        t.agentSessions[agent] = id
        self.touch(t)
      },
      async requestApproval(req) {
        const key = req.key ?? `${req.title}\n${req.detail ?? ''}`
        if (self.sessionAllow.get(t.id)?.has(key)) return 'approveSession'
        const requestId = uid('apr')
        const item: TimelineItem = { kind: 'approval', id: requestId, requestId, ts: Date.now(), title: req.title, detail: req.detail, status: 'pending', parentId: req.parentId }
        this.upsert(item)
        const decision = await new Promise<ApprovalDecision>((resolve) => self.approvals.set(requestId, { resolve, threadId: t.id, itemId: requestId }))
        if (decision === 'approveSession') {
          if (!self.sessionAllow.has(t.id)) self.sessionAllow.set(t.id, new Set())
          self.sessionAllow.get(t.id)!.add(key)
        }
        return decision
      },
      turnDone(result) {
        self.onTurnDone(t, agent, result?.error)
      },
      notice(text, tone = 'info') {
        this.upsert({ kind: 'notice', id: uid('n'), ts: Date.now(), text, tone })
      }
    }
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    const a = this.approvals.get(requestId)
    if (!a) return
    this.approvals.delete(requestId)
    const t = this.threads.get(a.threadId)
    const item = t && this.findItem(t, a.itemId)
    if (t && item && item.kind === 'approval') {
      item.status = decision === 'deny' ? 'denied' : decision === 'approveSession' ? 'approvedSession' : 'approved'
      this.emit({ type: 'item', threadId: t.id, item })
      saveThread(t)
    }
    a.resolve(decision)
  }

  private denyPendingApprovals(threadId: string): void {
    for (const [id, a] of this.approvals) if (a.threadId === threadId) this.respondApproval(id, 'deny')
  }

  // ───────────── sending ─────────────

  private session(t: Thread, agent: AgentId, model: string, effort: string | undefined, mode: PermissionMode): AgentSession {
    let map = this.sessions.get(t.id)
    if (!map) this.sessions.set(t.id, (map = {}))
    let s = map[agent]
    if (!s) {
      const settings = getSettings()
      const cwd = t.projectPath && existsSync(t.projectPath) ? t.projectPath : homedir()
      const isChild = !!t.parentThreadId
      s = adapters[agent].createSession({
        threadId: t.id,
        cwd,
        resumeId: t.agentSessions[agent],
        model,
        effort,
        permissionMode: mode,
        settings,
        sink: this.makeSink(t, agent),
        instructions: [agent === 'pi' ? PI_INSTRUCTIONS : '', isChild ? CHILD_INSTRUCTIONS : ''].filter(Boolean).join('\n\n') || undefined,
        bridge: this.bridge,
        allowDelegation: !isChild
      })
      map[agent] = s
    }
    return s
  }

  /** Build a context block of everything this agent hasn't seen yet (other agents' work). */
  private contextFor(t: Thread, agent: AgentId, uptoExclusive: number): string | undefined {
    const settings = getSettings()
    const parts: string[] = []
    if (t.seedContext && !t.agentSeenUpTo[agent] && Object.keys(t.agentSeenUpTo).length === 0) {
      parts.push(`Summary carried over from a previous chat:\n${t.seedContext}`)
    }
    if (t.contextResync?.includes(agent)) {
      // This agent's earlier session was closed (the chat moved project): give it everything.
      const digest = digestItems(t.items.slice(0, uptoExclusive), t.projectPath)
      if (digest.trim()) parts.push(`Conversation so far (this chat just moved to ${t.projectPath ?? 'no project'}, so you are starting a new session there):\n${digest}`)
    } else if (settings.shareContextAcrossAgents) {
      const seen = t.agentSeenUpTo[agent] ?? 0
      const slice = t.items.slice(seen, uptoExclusive)
      const foreign = slice.some((i) => i.kind === 'assistant' && i.agent !== agent)
      if (foreign) {
        const digest = digestItems(slice, t.projectPath)
        if (digest.trim()) parts.push(`Conversation so far (handled by other agents while you were away):\n${digest}`)
      }
    }
    if (!parts.length) return undefined
    return `<conversation-context>\nBackground from this conversation, for reference only. Reply to the user's new message after this block.\n\n${parts.join('\n\n')}\n</conversation-context>`
  }

  /** `queuedItemId`: the queued bubble this message was shown as, which now becomes the sent one. */
  async send(threadId: string, opts: SendOptions, queuedItemId?: string): Promise<void> {
    const t = this.threads.get(threadId)
    if (!t) throw new Error('Thread not found')
    const agent = opts.agent ?? t.agent
    const model = opts.model ?? (agent === t.agent ? t.model : getSettings().defaultModels[agent] ?? 'default')
    const effort = opts.effort ?? (agent === t.agent ? t.effort : undefined)
    const mode = opts.permissionMode ?? t.permissionMode
    // Picking a settled chat back up makes it active work again.
    if (t.settledAt) t.settledAt = undefined

    if (this.running.has(threadId)) {
      // Busy: queue it for when the turn ends (the user can still push it in with "Send now").
      const existing = queuedItemId && t.items.some((i) => i.id === queuedItemId)
      const queued: TimelineItem = { kind: 'user', id: existing ? queuedItemId! : uid('u'), ts: Date.now(), text: opts.text, images: opts.images, agent, queued: true }
      if (!existing) {
        t.items.push(queued)
        this.emit({ type: 'item', threadId, item: queued })
      }
      const q = this.queues.get(threadId) ?? []
      q[existing ? 'unshift' : 'push']({ opts: { ...opts, agent, model, effort, permissionMode: mode }, itemId: queued.id })
      this.queues.set(threadId, q)
      this.touch(t)
      return
    }

    if (agent !== t.agent && t.items.length > 0) {
      const handoff: TimelineItem = { kind: 'handoff', id: uid('h'), ts: Date.now(), from: t.agent, to: agent, model }
      t.items.push(handoff)
      this.emit({ type: 'item', threadId, item: handoff })
    }
    if ((agent !== t.agent || model !== t.model) && t.usage) {
      // Context size belongs to the model; the new one reports its own after its first reply.
      t.usage = { ...t.usage, contextTokens: undefined, contextWindow: undefined }
    }
    t.agent = agent
    t.model = model
    t.effort = effort
    t.permissionMode = mode
    t.plan = t.plan?.every((s) => s.status === 'completed') ? undefined : t.plan

    const contextBlock = this.contextFor(t, agent, t.items.length)
    if (t.contextResync?.includes(agent)) t.contextResync = t.contextResync.filter((a) => a !== agent)
    const wasQueued = queuedItemId ? t.items.findIndex((i) => i.id === queuedItemId) : -1
    if (wasQueued >= 0) t.items.splice(wasQueued, 1)
    const userItem: TimelineItem = { kind: 'user', id: wasQueued >= 0 ? queuedItemId! : uid('u'), ts: Date.now(), text: opts.text, images: opts.images, agent }
    t.items.push(userItem)
    if (wasQueued >= 0) this.emit({ type: 'reset', threadId, items: t.items })
    else this.emit({ type: 'item', threadId, item: userItem })
    if (t.title === 'New conversation' && getSettings().autoTitle) t.title = makeTitle(opts.text)
    this.running.set(threadId, agent)
    this.emit({ type: 'status', threadId, running: true })
    this.touch(t)

    const prompt = contextBlock ? `${contextBlock}\n\n${opts.text}` : opts.text
    try {
      const sess = this.session(t, agent, model, effort, mode)
      await sess.send({ text: prompt, images: opts.images, model, effort, permissionMode: mode })
    } catch (err: any) {
      this.onTurnDone(t, agent, err?.message ?? String(err))
    }
  }

  private onTurnDone(t: Thread, agent: AgentId, error?: string): void {
    refreshUsageSoon(agent)
    if (!this.running.has(t.id)) return
    this.running.delete(t.id)
    this.denyPendingApprovals(t.id)
    for (const item of t.items) {
      if ('streaming' in item && item.streaming) {
        item.streaming = false
        this.emit({ type: 'item', threadId: t.id, item })
      }
      if (item.kind === 'tool' && item.status === 'running') {
        item.status = error ? 'error' : 'done'
        this.emit({ type: 'item', threadId: t.id, item })
      }
    }
    if (error) {
      // Claude reports API errors both as an assistant message and as the result; keep one.
      const last = t.items[t.items.length - 1]
      if (last?.kind === 'assistant' && last.text.trim() === error.trim()) {
        t.items.pop()
        this.emit({ type: 'reset', threadId: t.id, items: t.items })
      }
      const authProblem = /authenticat|oauth|log ?in|logged out|api key|401|unauthorized/i.test(error)
      const n: TimelineItem = {
        kind: 'notice',
        id: uid('n'),
        ts: Date.now(),
        text: authProblem ? `${AGENT_LABELS[agent]} needs you to sign in again. ${error}` : error,
        tone: 'error',
        action: authProblem ? { kind: 'signIn', label: `Sign in to ${AGENT_LABELS[agent]}`, payload: agent } : undefined
      }
      t.items.push(n)
      this.emit({ type: 'item', threadId: t.id, item: n })
    }
    t.agentSeenUpTo[agent] = t.items.length
    this.maybeSuggestFreshStart(t)
    this.emit({ type: 'status', threadId: t.id, running: false })
    this.touch(t)
    saveThread(t, true)
    for (const w of this.turnWaiters.get(t.id) ?? []) w(error)
    this.turnWaiters.delete(t.id)

    const q = this.queues.get(t.id)
    const next = q?.shift()
    if (next) setTimeout(() => void this.send(t.id, next.opts, next.itemId), 50)
  }

  private maybeSuggestFreshStart(t: Thread): void {
    const s = getSettings()
    const u = t.usage
    if (!u?.contextTokens || !u.contextWindow) return
    const pct = (u.contextTokens / u.contextWindow) * 100
    const already = t.items.some((i) => i.kind === 'notice' && i.action?.kind === 'newChatWithSummary' && i.ts > Date.now() - 30 * 60_000)
    if (pct >= s.suggestNewChatPct && !already) {
      const n: TimelineItem = {
        kind: 'notice',
        id: uid('n'),
        ts: Date.now(),
        tone: 'info',
        text: `Context is ${Math.round(pct)}% full. Starting a fresh chat with a summary keeps the agent sharp.`,
        action: { kind: 'newChatWithSummary', label: 'Continue in a fresh chat', payload: '' }
      }
      t.items.push(n)
      this.emit({ type: 'item', threadId: t.id, item: n })
    }
  }

  /**
   * "Send now" on a queued message: hand it to the running agent mid-turn when it can take it,
   * otherwise stop the current turn so the message goes next.
   */
  async sendNow(threadId: string, itemId: string): Promise<void> {
    const t = this.threads.get(threadId)
    const q = this.queues.get(threadId) ?? []
    const idx = q.findIndex((m) => m.itemId === itemId)
    if (!t || idx < 0) return
    const entry = q[idx]
    const runningAgent = this.running.get(threadId)
    if (!runningAgent) return // the turn just ended; it's already being sent
    const sess = this.sessions.get(threadId)?.[runningAgent]
    if (runningAgent === (entry.opts.agent ?? t.agent) && sess?.steer && !entry.opts.images?.length && (await sess.steer(entry.opts.text))) {
      q.splice(idx, 1)
      const pos = t.items.findIndex((i) => i.id === itemId)
      const item = pos >= 0 ? t.items.splice(pos, 1)[0] : undefined
      if (item?.kind === 'user') {
        item.queued = false
        item.ts = Date.now()
        t.items.push(item)
      }
      this.emit({ type: 'reset', threadId, items: t.items })
      this.touch(t)
      return
    }
    q.splice(idx, 1)
    q.unshift(entry)
    await this.interrupt(threadId, true)
  }

  async interrupt(threadId: string, keepQueue = false): Promise<void> {
    const agent = this.running.get(threadId)
    if (!keepQueue) this.dropQueue(threadId)
    if (!agent) return
    this.denyPendingApprovals(threadId)
    const sess = this.sessions.get(threadId)?.[agent]
    await sess?.interrupt()
    // Some agents don't send a terminal event after an abort; make sure we settle.
    setTimeout(() => {
      const t = this.threads.get(threadId)
      if (t && this.running.get(threadId) === agent) this.onTurnDone(t, agent)
    }, 4000)
  }

  /** Stop means stop: queued messages are discarded along with their bubbles. */
  private dropQueue(threadId: string): void {
    const q = this.queues.get(threadId)
    this.queues.delete(threadId)
    const t = this.threads.get(threadId)
    if (!t || !q?.length) return
    const ids = new Set(q.map((m) => m.itemId))
    t.items = t.items.filter((i) => !ids.has(i.id))
    this.emit({ type: 'reset', threadId, items: t.items })
    saveThread(t)
  }

  async compact(threadId: string): Promise<void> {
    const t = this.threads.get(threadId)
    if (!t || this.running.has(threadId)) return
    const sess = this.session(t, t.agent, t.model, t.effort, t.permissionMode)
    if (t.agent === 'claude') {
      this.running.set(threadId, t.agent)
      this.emit({ type: 'status', threadId, running: true })
    }
    try {
      await sess.compact()
    } catch (err: any) {
      const n: TimelineItem = { kind: 'notice', id: uid('n'), ts: Date.now(), text: `Compaction failed: ${err?.message ?? err}`, tone: 'error' }
      t.items.push(n)
      this.emit({ type: 'item', threadId, item: n })
      if (this.running.has(threadId)) this.onTurnDone(t, t.agent)
    }
  }

  /** Fork the conversation into a fresh thread seeded with a summary of this one. */
  continueInNewChat(threadId: string, summary?: string): Thread {
    const t = this.threads.get(threadId)
    if (!t) throw new Error('Thread not found')
    const seed = summary?.trim() || digestItems(t.items, t.projectPath, 16000)
    const n = this.createThread({
      agent: t.agent,
      model: t.model,
      effort: t.effort,
      permissionMode: t.permissionMode,
      projectPath: t.projectPath,
      title: `${t.title} (cont.)`
    })
    n.seedContext = `Previous chat: "${t.title}".\n${seed}`
    const note: TimelineItem = { kind: 'notice', id: uid('n'), ts: Date.now(), tone: 'success', text: `Continuing from “${t.title}”. The summary is shared with whichever agent you message first.` }
    n.items.push(note)
    saveThread(n, true)
    this.touch(n)
    return n
  }

  waitForTurn(threadId: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const list = this.turnWaiters.get(threadId) ?? []
      list.push(resolve)
      this.turnWaiters.set(threadId, list)
    })
  }

  // ───────────── R-Code tools exposed to agents ─────────────

  threadInfo(id: string): { isChild: boolean } {
    return { isChild: !!this.threads.get(id)?.parentThreadId }
  }

  /** Ask the user in a chat's timeline on behalf of one of R-Code's own tools. */
  askUser(threadId: string, agent: AgentId, req: { title: string; detail?: string; key?: string }): Promise<ApprovalDecision> {
    const t = this.threads.get(threadId)
    return t ? this.makeSink(t, agent).requestApproval(req) : Promise.resolve('deny')
  }

  permissionModeFor(threadId: string): PermissionMode {
    return this.threads.get(threadId)?.permissionMode ?? getSettings().defaultPermissionMode
  }

  cwdFor(id: string): string {
    const p = this.threads.get(id)?.projectPath
    return p && existsSync(p) ? p : homedir()
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'delegate_task',
        description:
          'Delegate a self-contained task to another coding agent managed by R-Code — Claude Code, Codex, or the built-in Pi agent (which runs local Ollama models and any other provider). The sub-agent works in its own clean context in the same project and returns its final report. Use it to keep your context clean, get a second opinion, or hand simple work to a cheaper/local model.',
        schema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: ['claude', 'codex', 'pi'], description: 'Which agent runs the task' },
            task: str('Complete, self-contained instructions. The sub-agent sees nothing else.'),
            model: str("Optional model id (see list_agents); omit for that agent's default")
          },
          required: ['agent', 'task']
        },
        topLevelOnly: true,
        enabledBy: 'enableDelegation',
        run: async (ctx, args) => ({ text: await this.delegate({ threadId: ctx.threadId, agent: args.agent, task: args.task, model: args.model }) })
      },
      {
        name: 'list_agents',
        description: 'List the coding agents and models R-Code can delegate to (including local models).',
        schema: { type: 'object', properties: {} },
        topLevelOnly: true,
        enabledBy: 'enableDelegation',
        run: async () => ({ text: await this.listAgents() })
      },
      {
        name: 'suggest_new_chat',
        description:
          'Suggest that the conversation continues in a fresh chat (clean context) seeded with your summary. Use when the context is long or the topic has changed. The user gets a one-click button.',
        schema: { type: 'object', properties: { reason: str('Why a fresh chat helps'), summary: str('Everything the next chat needs to know to continue') }, required: ['reason', 'summary'] },
        topLevelOnly: true,
        run: async (ctx, args) => ({ text: await this.suggestNewChat({ threadId: ctx.threadId, reason: args.reason, summary: args.summary }) })
      }
    ]
  }

  // ───────────── delegation ─────────────

  async delegate(args: { threadId: string; agent: AgentId; task: string; model?: string }): Promise<string> {
    const parent = this.threads.get(args.threadId)
    if (!parent) return 'Error: parent conversation not found.'
    const settings = getSettings()
    if (!settings.enableDelegation) return 'Delegation is disabled in R-Code settings.'
    const agent = args.agent
    if (!adapters[agent]) return `Unknown agent "${agent}". Use claude, codex or pi.`
    if (!settings.linkedAgents.includes(agent)) return `${AGENT_LABELS[agent]} is not linked in R-Code. Linked agents: ${settings.linkedAgents.join(', ') || 'none'}.`
    const model = args.model || settings.defaultModels[agent] || 'default'
    const child = this.createThread({
      agent,
      model,
      permissionMode: parent.permissionMode === 'plan' ? 'plan' : parent.permissionMode === 'ask' ? 'ask' : 'acceptEdits',
      projectPath: parent.projectPath,
      parentThreadId: parent.id,
      title: `↳ ${makeTitle(args.task)}`
    })
    const item: TimelineItem = { kind: 'delegation', id: uid('dg'), ts: Date.now(), childThreadId: child.id, agent, model, task: args.task, status: 'running' }
    parent.items.push(item)
    this.emit({ type: 'item', threadId: parent.id, item })
    saveThread(parent)

    const done = this.waitForTurn(child.id)
    await this.send(child.id, { text: args.task, agent, model })
    const error = await done
    const last = [...child.items].reverse().find((i) => i.kind === 'assistant' && !i.parentId)
    const result = last && last.kind === 'assistant' ? last.text : ''
    const fresh = this.findItem(parent, item.id)
    if (fresh && fresh.kind === 'delegation') {
      fresh.status = error ? 'error' : 'done'
      fresh.result = truncate(result || error || '', 4000)
      this.emit({ type: 'item', threadId: parent.id, item: fresh })
      saveThread(parent)
    }
    if (error) return `The ${AGENT_LABELS[agent]} sub-agent failed: ${error}\n${result}`
    return result || `${AGENT_LABELS[agent]} finished without a written report.`
  }

  async listAgents(): Promise<string> {
    const settings = getSettings()
    const lines: string[] = []
    for (const id of settings.linkedAgents) {
      const models = await adapters[id].listModels(settings).catch(() => [])
      const def = settings.defaultModels[id] ?? 'default'
      lines.push(`- ${id} (${AGENT_LABELS[id]}), default model: ${def}. Models: ${models.slice(0, 25).map((m) => m.id + (m.local ? ' [local]' : '')).join(', ') || 'default'}`)
    }
    return lines.length ? `Agents you can delegate to:\n${lines.join('\n')}` : 'No agents are linked in R-Code.'
  }

  async suggestNewChat(args: { threadId: string; reason: string; summary: string }): Promise<string> {
    const t = this.threads.get(args.threadId)
    if (!t) return 'Conversation not found.'
    const n: TimelineItem = {
      kind: 'notice',
      id: uid('n'),
      ts: Date.now(),
      tone: 'info',
      text: args.reason || 'The agent suggests continuing in a fresh chat.',
      action: { kind: 'newChatWithSummary', label: 'Continue in a fresh chat', payload: args.summary }
    }
    t.items.push(n)
    this.emit({ type: 'item', threadId: t.id, item: n })
    saveThread(t)
    return 'The user has been shown a button to continue in a fresh chat with your summary. Finish your current reply normally.'
  }
}

function makeTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').replace(/[`#*_>]/g, '').trim()
  if (!clean) return 'New conversation'
  const words = clean.split(' ').slice(0, 8).join(' ')
  return words.length > 52 ? words.slice(0, 50) + '…' : words
}

/** A compact, model-readable digest of timeline items, keeping the most recent content. */
export function digestItems(items: TimelineItem[], cwd?: string, budget = 12000): string {
  const lines: string[] = []
  for (const it of items) {
    if (it.parentId) continue
    switch (it.kind) {
      case 'user':
        if (!it.queued) lines.push(`[user${it.agent ? ` → ${it.agent}` : ''}]: ${it.text}`)
        break
      case 'assistant':
        lines.push(`[${it.agent}${it.model && it.model !== 'default' ? ` · ${it.model}` : ''}]: ${it.text}`)
        break
      case 'tool': {
        const what = it.detail && it.toolKind === 'command' ? `${it.title}: \`${it.detail.split('\n')[0].slice(0, 160)}\`` : it.title
        lines.push(`  • ${what}${it.status === 'error' ? ' (failed)' : ''}`)
        break
      }
      case 'handoff':
        lines.push(`— switched from ${it.from} to ${it.to} —`)
        break
      case 'delegation':
        lines.push(`  • Delegated to ${it.agent}: ${it.task.slice(0, 200)}${it.result ? `\n    Result: ${it.result.slice(0, 600)}` : ''}`)
        break
      case 'compaction':
        if (it.summary) lines.push(`[earlier context, summarized]: ${it.summary}`)
        break
      default:
        break
    }
  }
  let out = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = lines[i] + '\n' + out
    if (next.length > budget) {
      out = `(…earlier messages omitted…)\n` + out
      break
    }
    out = next
  }
  return (cwd ? `Project: ${cwd}\n` : '') + out.trim()
}
