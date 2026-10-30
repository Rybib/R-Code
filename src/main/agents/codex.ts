import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import type { AgentStatus, ModelOption, PermissionMode, PlanUsage, Settings, UsageWindow } from '@shared/types'
import { jsonLines, run, which } from '../env'
import type { AgentAdapter, AgentSession, SessionInit, TurnInput } from './base'
import { shortPath, truncate, uid, usageBus } from './base'
import { diffStats } from '@shared/diffstat'
import { describeRcodeTool } from '@shared/rcode-tools'

// Codex is driven through `codex app-server`: newline-delimited JSON-RPC over stdio
// (the "jsonrpc" field is omitted). Same approach as T3 Code.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

export class CodexRpc {
  proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  onNotification: (method: string, params: any) => void = () => {}
  onRequest: (method: string, params: any) => Promise<any> = async () => ({})
  onExit: (code: number | null) => void = () => {}
  stderr = ''

  constructor(binary: string) {
    this.proc = spawn(binary, ['app-server'], {
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'R-Code' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000)
    })
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code}). ${this.stderr.slice(-500)}`))
      this.pending.clear()
      this.onExit(code)
    })
    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    jsonLines(this.proc.stdout, (msg) => this.dispatch(msg))
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    } else if (msg.id !== undefined && msg.method) {
      this.onRequest(msg.method, msg.params)
        .then((result) => this.write({ id: msg.id, result }))
        .catch((err) => this.write({ id: msg.id, error: { code: -32000, message: String(err?.message ?? err) } }))
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params)
    }
  }

  private write(obj: unknown): void {
    if (!this.proc.stdin.writable) return
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`codex ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  async initialize(): Promise<any> {
    const res = await this.request('initialize', {
      clientInfo: { name: 'rcode', title: 'R-Code', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    }).catch(async (err) => {
      // Older builds reject unknown capability fields.
      if (/capabilit|unknown field/i.test(String(err))) {
        return this.request('initialize', { clientInfo: { name: 'rcode', title: 'R-Code', version: '0.1.0' }, capabilities: null })
      }
      throw err
    })
    this.notify('initialized')
    return res
  }

  kill(): void {
    try {
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }
}

function policyFor(mode: PermissionMode, settings: Settings, cwd: string): { approvalPolicy: string; sandboxPolicy: any; approvalsReviewer: string } {
  switch (mode) {
    case 'ask':
      return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' }
    case 'plan':
      return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: true }, approvalsReviewer: 'user' }
    case 'allowAll':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, approvalsReviewer: 'user' }
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: workspaceWrite(settings, cwd),
        approvalsReviewer: 'auto_review'
      }
    case 'acceptEdits':
    default:
      return { approvalPolicy: 'on-request', sandboxPolicy: workspaceWrite(settings, cwd), approvalsReviewer: 'user' }
  }
}

function workspaceWrite(settings: Settings, cwd: string): any {
  if (settings.codexSandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (settings.codexSandbox === 'read-only') return { type: 'readOnly', networkAccess: true }
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

/** Codex sends unified hunks for updates but may send raw contents for adds/deletes. */
function normalizeChangeDiff(c: { kind?: { type?: string }; diff?: string }): string {
  const d = c.diff ?? ''
  if (/^@@ /m.test(d)) return d
  const prefix = c.kind?.type === 'delete' ? '-' : c.kind?.type === 'add' ? '+' : ''
  return prefix ? d.split('\n').filter((l, i, a) => i < a.length - 1 || l).map((l) => prefix + l).join('\n') : d
}

class CodexSession implements AgentSession {
  private rpc: CodexRpc | null = null
  private ready: Promise<void> | null = null
  private threadId: string | undefined
  private turnId: string | undefined
  private reasoningItems = new Map<string, string>() // codex item id -> our reasoning item id
  private reasoningStarted = new Map<string, number>()
  private commentary = new Set<string>()

  constructor(private init: SessionInit) {
    this.threadId = init.resumeId
  }

  private ensure(input: TurnInput): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const binary = which('codex')
      if (!binary) throw new Error('Codex CLI is not installed. Open Settings → Agents to install it.')
      const rpc = new CodexRpc(binary)
      this.rpc = rpc
      rpc.onNotification = (m, p) => this.onNotification(m, p)
      rpc.onRequest = (m, p) => this.onRequest(m, p)
      rpc.onExit = () => {
        if (this.rpc === rpc) {
          this.rpc = null
          this.ready = null
          if (this.turnId) {
            this.turnId = undefined
            this.init.sink.turnDone({ error: `Codex exited unexpectedly. ${rpc.stderr.slice(-300)}` })
          }
        }
      }
      await rpc.initialize()
      const { init } = this
      const policy = policyFor(input.permissionMode, init.settings, init.cwd)
      const config: Record<string, unknown> = { 'tools.update_plan.enabled': true }
      if (init.bridge) {
        // R-Code's tools (delegation, built-in browser, iOS Simulator) over HTTP MCP.
        config['mcp_servers.rcode'] = {
          url: `${init.bridge.url}/mcp/${init.threadId}?agent=codex`,
          http_headers: { Authorization: `Bearer ${init.bridge.token}` },
          tool_timeout_sec: 3600
        }
      }
      const common = {
        cwd: init.cwd,
        model: input.model === 'default' ? undefined : input.model,
        approvalPolicy: policy.approvalPolicy,
        developerInstructions: init.instructions,
        config
      }
      if (this.threadId) {
        try {
          const res = await rpc.request('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common })
          this.threadId = res.thread?.id ?? this.threadId
          return
        } catch (err) {
          if (/archived/i.test(String(err))) {
            await rpc.request('thread/unarchive', { threadId: this.threadId }).catch(() => {})
            const res = await rpc.request('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common }).catch(() => null)
            if (res) return
          }
          init.sink.notice('Could not resume the previous Codex thread; starting a fresh one with the shared context.', 'warn')
        }
      }
      const res = await rpc.request('thread/start', common)
      this.threadId = res.thread.id
      init.sink.setSessionId(res.thread.id)
    })()
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  private async onRequest(method: string, params: any): Promise<any> {
    const sink = this.init.sink
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const cmd = params.command ?? (Array.isArray(params.command) ? params.command.join(' ') : undefined)
      const decision = await sink.requestApproval({
        title: params.reason ? `Run command — ${params.reason}` : 'Run command',
        detail: typeof cmd === 'string' ? cmd : JSON.stringify(cmd ?? params, null, 2)
      })
      if (method === 'execCommandApproval') return { decision: decision === 'deny' ? 'denied' : decision === 'approveSession' ? 'approved_for_session' : 'approved' }
      return { decision: decision === 'deny' ? 'decline' : decision === 'approveSession' ? 'acceptForSession' : 'accept' }
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const decision = await sink.requestApproval({ title: params.reason || 'Apply file changes', detail: params.grantRoot ? `Allow writes under ${params.grantRoot}` : undefined })
      if (method === 'applyPatchApproval') return { decision: decision === 'deny' ? 'denied' : 'approved' }
      return { decision: decision === 'deny' ? 'decline' : decision === 'approveSession' ? 'acceptForSession' : 'accept' }
    }
    if (method === 'item/permissions/requestApproval') {
      const decision = await sink.requestApproval({ title: 'Grant additional permissions', detail: JSON.stringify(params.permissions ?? params, null, 2) })
      return decision === 'deny' ? { permissions: {}, scope: 'turn' } : { permissions: params.permissions ?? {}, scope: decision === 'approveSession' ? 'session' : 'turn' }
    }
    if (method === 'mcpServer/elicitation/request' && params.serverName === 'rcode') {
      // R-Code's own tools (browser, simulator, delegation) are safe and visible in the UI.
      return { action: 'accept', content: {} }
    }
    if (method === 'mcpServer/elicitation/request') {
      const decision = await sink.requestApproval({ title: `MCP server ${params.serverName ?? ''} is asking for input`, detail: params.message })
      return { action: decision === 'deny' ? 'decline' : 'accept', content: {} }
    }
    if (method === 'item/tool/requestUserInput') {
      return { answers: {} }
    }
    throw new Error(`Unsupported request ${method}`)
  }

  private onNotification(method: string, p: any): void {
    const sink = this.init.sink
    if (method === 'account/rateLimits/updated') {
      usageBus.emit('codex', p?.rateLimits)
      return
    }
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id ?? this.turnId
        break
      case 'item/started':
        this.onItem(p.item, false)
        break
      case 'item/completed':
        this.onItem(p.item, true)
        break
      case 'item/agentMessage/delta':
        if (sink.has(p.itemId)) sink.append(p.itemId, 'text', p.delta)
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        let id = this.reasoningItems.get(p.itemId)
        if (!id) {
          id = uid('th')
          this.reasoningItems.set(p.itemId, id)
          this.reasoningStarted.set(id, Date.now())
          sink.upsert({ kind: 'reasoning', id, ts: Date.now(), text: '', streaming: true })
        }
        sink.append(id, 'text', p.delta)
        break
      }
      case 'item/reasoning/summaryPartAdded': {
        const id = this.reasoningItems.get(p.itemId)
        if (id) sink.append(id, 'text', '\n\n')
        break
      }
      case 'item/commandExecution/outputDelta':
        if (sink.has(p.itemId)) sink.append(p.itemId, 'output', p.delta)
        break
      case 'turn/plan/updated':
        sink.setPlan(
          (p.plan ?? []).map((s: any) => ({
            text: s.step,
            status: s.status === 'completed' ? 'completed' : s.status === 'inProgress' || s.status === 'in_progress' ? 'in_progress' : 'pending'
          }))
        )
        break
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage
        sink.setUsage({
          inputTokens: u.total.inputTokens,
          outputTokens: u.total.outputTokens,
          cachedTokens: u.total.cachedInputTokens,
          contextTokens: u.last.totalTokens,
          contextWindow: u.modelContextWindow ?? undefined
        })
        break
      }
      case 'thread/compacted':
        sink.upsert({ kind: 'compaction', id: uid('cmp'), ts: Date.now() })
        break
      case 'error':
        if (!p.willRetry) sink.notice(p.error?.message ?? 'Codex error', 'error')
        break
      case 'turn/completed': {
        this.turnId = undefined
        for (const id of this.reasoningItems.values()) sink.patch(id, { streaming: false } as any)
        this.reasoningItems.clear()
        const turn = p.turn
        if (turn?.status === 'failed') sink.turnDone({ error: turn.error?.message ?? 'Codex turn failed' })
        else sink.turnDone()
        break
      }
      default:
        break
    }
  }

  private onItem(item: any, completed: boolean): void {
    const sink = this.init.sink
    const cwd = this.init.cwd
    const ts = Date.now()
    switch (item.type) {
      case 'agentMessage':
        if (!completed) {
          sink.upsert({ kind: 'assistant', id: item.id, ts, text: item.text ?? '', agent: 'codex', model: this.init.model, streaming: true })
          if (item.phase === 'commentary') this.commentary.add(item.id)
        } else {
          sink.patch(item.id, { text: item.text, streaming: false } as any)
        }
        break
      case 'reasoning': {
        const id = this.reasoningItems.get(item.id)
        if (completed && id) {
          const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n\n')
          const started = this.reasoningStarted.get(id)
          sink.patch(id, { streaming: false, ...(text ? { text } : {}), durationMs: started ? ts - started : undefined } as any)
        }
        break
      }
      case 'commandExecution': {
        const actions: any[] = item.commandActions ?? []
        const first = actions[0]
        let title = 'Run command'
        let toolKind: 'command' | 'read' | 'search' = 'command'
        let file: string | undefined
        if (actions.length === 1 && first?.type === 'read') {
          title = `Read ${first.name ?? shortPath(first.path ?? '', cwd)}`
          toolKind = 'read'
          file = first.path
        } else if (actions.length === 1 && (first?.type === 'search' || first?.type === 'listFiles')) {
          title = first.query ? `Search for "${first.query}"` : `List ${first.path ? shortPath(first.path, cwd) : 'files'}`
          toolKind = 'search'
        }
        const command = String(item.command ?? '').replace(/^\/bin\/(zsh|bash|sh) -lc '(.*)'$/s, '$2')
        sink.upsert({
          kind: 'tool',
          id: item.id,
          ts,
          tool: 'shell',
          toolKind,
          title,
          detail: command,
          file,
          output: completed ? truncate(item.aggregatedOutput ?? '', 30000) : undefined,
          status: !completed ? 'running' : item.status === 'completed' && (item.exitCode ?? 0) === 0 ? 'done' : 'error'
        })
        break
      }
      case 'fileChange': {
        const changes: any[] = item.changes ?? []
        const title =
          changes.length === 1
            ? `${changes[0].kind?.type === 'add' ? 'Create' : changes[0].kind?.type === 'delete' ? 'Delete' : 'Edit'} ${shortPath(changes[0].path, cwd)}`
            : `Edit ${changes.length} files`
        sink.upsert({
          kind: 'tool',
          id: item.id,
          ts,
          tool: 'apply_patch',
          toolKind: 'edit',
          title,
          detail: changes.map((c) => shortPath(c.path, cwd)).join('\n'),
          diff: truncate(changes.map((c) => `--- ${shortPath(c.path, cwd)}\n${normalizeChangeDiff(c)}`).join('\n'), 30000),
          file: changes[0]?.path,
          files: changes.length > 1 ? changes.map((c) => ({ path: c.path, ...diffStats(normalizeChangeDiff(c)) })) : undefined,
          status: !completed ? 'running' : item.status === 'completed' ? 'done' : 'error'
        })
        break
      }
      case 'mcpToolCall': {
        const output = item.result?.content?.map((c: any) => c.text ?? '').join('\n') ?? item.error?.message
        const ours = item.server === 'rcode' ? describeRcodeTool(item.tool, item.arguments) : null
        sink.upsert({
          kind: 'tool',
          id: item.id,
          ts,
          tool: `${item.server}.${item.tool}`,
          toolKind: ours?.kind ?? 'mcp',
          title: ours?.title ?? `${item.server}: ${item.tool}`,
          detail: ours ? ours.detail : truncate(JSON.stringify(item.arguments ?? {}, null, 2), 4000),
          output: output ? truncate(output, 20000) : undefined,
          status: !completed ? 'running' : item.error ? 'error' : 'done'
        })
        break
      }
      case 'webSearch':
        sink.upsert({ kind: 'tool', id: item.id, ts, tool: 'web_search', toolKind: 'web', title: item.query ? `Search the web for "${item.query}"` : 'Search the web', status: completed ? 'done' : 'running' })
        break
      case 'collabAgentToolCall':
        sink.upsert({
          kind: 'tool',
          id: item.id,
          ts,
          tool: 'subagent',
          toolKind: 'task',
          title: item.prompt ? `Subagent: ${String(item.prompt).slice(0, 80)}` : 'Subagent',
          detail: item.prompt,
          status: completed ? 'done' : 'running'
        })
        break
      case 'contextCompaction':
        if (completed) sink.upsert({ kind: 'compaction', id: item.id, ts })
        break
      default:
        break
    }
  }

  async send(input: TurnInput): Promise<void> {
    await this.ensure(input)
    const policy = policyFor(input.permissionMode, this.init.settings, this.init.cwd)
    const content: any[] = [{ type: 'text', text: input.permissionMode === 'plan' ? `${input.text}\n\n(Plan only: investigate and propose a plan, do not modify files.)` : input.text, text_elements: [] }]
    for (const img of input.images ?? []) content.push({ type: 'image', url: `data:${img.mimeType};base64,${img.data}` })
    const res = await this.rpc!.request('turn/start', {
      threadId: this.threadId,
      input: content,
      cwd: this.init.cwd,
      model: input.model === 'default' ? undefined : input.model,
      effort: input.effort || undefined,
      summary: 'auto',
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandboxPolicy: policy.sandboxPolicy
    })
    this.turnId = res.turn?.id
  }

  async steer(text: string): Promise<boolean> {
    if (!this.rpc || !this.turnId) return false
    try {
      await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text, text_elements: [] }] })
      return true
    } catch {
      return false
    }
  }

  async interrupt(): Promise<void> {
    if (this.rpc && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10000).catch(() => {})
  }

  async compact(): Promise<void> {
    await this.ensure({ text: '', model: this.init.model, permissionMode: this.init.permissionMode })
    await this.rpc!.request('thread/compact/start', { threadId: this.threadId })
  }

  dispose(): void {
    this.rpc?.kill()
    this.rpc = null
    this.ready = null
  }
}

let modelCache: ModelOption[] | null = null

/** A Codex RateLimitSnapshot as R-Code usage windows (primary is usually 5 hours, secondary weekly). */
export function codexUsage(snap: any): PlanUsage | null {
  if (!snap) return null
  const windows: UsageWindow[] = []
  const add = (id: string, w: any): void => {
    if (!w || typeof w.usedPercent !== 'number') return
    const mins = w.windowDurationMins
    const label = mins === 300 ? '5-hour limit' : mins === 10080 ? 'Weekly limit' : mins ? (mins % 1440 === 0 ? `${mins / 1440}-day limit` : `${Math.round(mins / 60)}-hour limit`) : id === 'primary' ? 'Current limit' : 'Longer-term limit'
    windows.push({ id, label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : undefined })
  }
  add('primary', snap.primary)
  add('secondary', snap.secondary)
  if (!windows.length) return null
  const plan = typeof snap.planType === 'string' ? snap.planType.charAt(0).toUpperCase() + snap.planType.slice(1) : undefined
  return { agent: 'codex', plan, windows, fetchedAt: Date.now() }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',

  async detect(settings: Settings): Promise<AgentStatus> {
    const path = which('codex')
    const status: AgentStatus = { id: 'codex', installed: !!path, path, authenticated: null, linked: settings.linkedAgents.includes('codex') }
    if (!path) return status
    const v = await run(path, ['--version'], { timeoutMs: 15000 })
    status.version = v.stdout.trim().replace(/^codex-cli\s*/, '')
    const auth = await run(path, ['login', 'status'], { timeoutMs: 15000 })
    const out = (auth.stdout + auth.stderr).trim()
    status.authenticated = auth.code === 0 && !/not logged in/i.test(out)
    status.authDetail = out.split('\n')[0]
    return status
  },

  async listModels(): Promise<ModelOption[]> {
    if (modelCache) return modelCache
    const binary = which('codex')
    if (!binary) return []
    const rpc = new CodexRpc(binary)
    try {
      await rpc.initialize()
      const out: ModelOption[] = []
      let cursor: string | null = null
      do {
        const res: any = await rpc.request('model/list', cursor ? { cursor } : {}, 20000)
        for (const m of res.data ?? []) {
          if (m.hidden) continue
          out.push({
            id: m.model ?? m.id,
            label: m.displayName ?? m.id,
            agent: 'codex',
            provider: 'openai',
            description: m.description,
            efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort),
            defaultEffort: m.defaultReasoningEffort
          })
        }
        cursor = res.nextCursor ?? null
      } while (cursor)
      modelCache = out
      return out
    } catch {
      return [{ id: 'default', label: 'Default', agent: 'codex', provider: 'openai' }]
    } finally {
      rpc.kill()
    }
  },

  async planUsage(): Promise<PlanUsage | null> {
    const binary = which('codex')
    if (!binary) return null
    const rpc = new CodexRpc(binary)
    try {
      await rpc.initialize()
      const res: any = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 20000)
      return codexUsage(res?.rateLimits)
    } catch {
      return null
    } finally {
      rpc.kill()
    }
  },

  createSession(init: SessionInit): AgentSession {
    return new CodexSession(init)
  }
}

export const codexHome = (): string => process.env.CODEX_HOME || `${homedir()}/.codex`
