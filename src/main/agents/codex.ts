import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSlashCommand, type AgentStatus, type ModelOption, type PermissionMode, type PlanUsage, type Settings, type SlashCommand, type UsageWindow } from '@shared/types'
import { jsonLines, run, which } from '../env'
import type { AgentAdapter, AgentSession, SessionInit, TurnInput } from './base'
import { STALE_SESSION_RE, commandCache, shortPath, truncate, uid, usageBus } from './base'
import { diffStats } from '@shared/diffstat'
import { describeRcodeTool } from '@shared/rcode-tools'

// Codex is driven through `codex app-server`: newline-delimited JSON-RPC over stdio
// (the "jsonrpc" field is omitted). Same approach as T3 Code.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string }

/** Codex rejects (and never answers) a turn whose text holds a lone UTF-16 surrogate. */
export const wellFormed = (text: string): string => ((text as any).toWellFormed ? (text as any).toWellFormed() : text)

/** The most telling line of Codex's stderr, for error messages. */
function stderrSummary(stderr: string): string {
  const lines = stderr
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const line = [...lines].reverse().find((l) => /^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:/i.test(l)) ?? lines[lines.length - 1] ?? ''
  return line.slice(0, 512)
}

export class CodexRpc {
  proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<string, Pending>()
  /** Server→client requests still being answered, so they can be withdrawn. */
  private inflight = new Map<string, AbortController>()
  onNotification: (method: string, params: any) => void = () => {}
  onRequest: (method: string, params: any, signal: AbortSignal) => Promise<any> = async () => ({})
  onExit: (error: Error) => void = () => {}
  stderr = ''
  /** Set once the process is gone; nothing is written after that (no EPIPE). */
  dead: Error | null = null
  private exitCode: number | null | undefined

  constructor(binary: string) {
    const env: Record<string, string | undefined> = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'R-Code', ...process.env }
    // A literal "~" in CODEX_HOME (common in shell profiles) is rejected by Codex.
    if (env.CODEX_HOME?.startsWith('~')) env.CODEX_HOME = join(homedir(), env.CODEX_HOME.slice(1))
    delete env.ELECTRON_RUN_AS_NODE
    this.proc = spawn(binary, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000)
    })
    // Every way the process can go away funnels into terminate(), exactly once.
    this.proc.on('exit', (code, signal) => {
      this.exitCode = code
      this.terminate(new Error(`Codex exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ''}. ${stderrSummary(this.stderr)}`.trim()))
    })
    this.proc.on('error', (err) => this.terminate(new Error(`Could not run Codex: ${err.message}`)))
    this.proc.stdin.on('error', (err) => this.terminate(new Error(`Lost the connection to Codex: ${err.message}`)))
    this.proc.stdout.on('end', () => {
      // stdout can close a moment before the exit code arrives; give it a beat to say why.
      setTimeout(() => this.terminate(new Error(`Codex closed its output${this.exitCode != null ? ` (exit code ${this.exitCode})` : ''}. ${stderrSummary(this.stderr)}`.trim())), 250)
    })
    jsonLines(this.proc.stdout, (msg) => this.dispatch(msg), (line) => console.error('[codex] unparseable line', line.slice(0, 200)))
  }

  private terminate(error: Error): void {
    if (this.dead) return
    this.dead = error
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
    for (const c of this.inflight.values()) c.abort()
    this.inflight.clear()
    try {
      this.onExit(error)
    } catch (err) {
      console.error('[codex] onExit failed', err)
    }
  }

  private dispatch(msg: any): void {
    if (!msg || typeof msg !== 'object') return
    const hasId = msg.id !== undefined && msg.id !== null // ids can be 0
    if (hasId && msg.method === undefined) {
      const key = String(msg.id)
      const p = this.pending.get(key)
      if (!p) return
      this.pending.delete(key)
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? JSON.stringify(msg.error)), { code: msg.error.code }))
      else p.resolve(msg.result)
    } else if (hasId && msg.method) {
      // Answered off the reader loop, so a slow approval never blocks other messages.
      const key = String(msg.id)
      const ctl = new AbortController()
      this.inflight.set(key, ctl)
      Promise.resolve()
        .then(() => this.onRequest(msg.method, msg.params ?? {}, ctl.signal))
        .then(
          (result) => !ctl.signal.aborted && this.write({ id: msg.id, result: result ?? {} }),
          (err) =>
            !ctl.signal.aborted &&
            this.write({ id: msg.id, error: { code: err?.code ?? -32000, message: String(err?.message ?? err) } })
        )
        .finally(() => this.inflight.get(key) === ctl && this.inflight.delete(key))
    } else if (msg.method) {
      if (msg.method === 'serverRequest/resolved' && msg.params?.requestId !== undefined) {
        // Codex settled this request itself (turn ended or interrupted): withdraw our prompt.
        const key = String(msg.params.requestId)
        this.inflight.get(key)?.abort()
        this.inflight.delete(key)
      }
      try {
        this.onNotification(msg.method, msg.params ?? {})
      } catch (err) {
        console.error('[codex] notification handler failed', msg.method, err)
      }
    }
  }

  private write(obj: unknown): boolean {
    if (this.dead || !this.proc.stdin.writable) return false
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch (err: any) {
      this.terminate(new Error(`Lost the connection to Codex: ${err?.message ?? err}`))
      return false
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    const key = String(id)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(key)) reject(new Error(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      this.pending.set(key, {
        method,
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      if (!this.write({ id, method, params })) {
        this.pending.delete(key)
        clearTimeout(timer)
        reject(this.dead ?? new Error('Codex is not running.'))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  async initialize(): Promise<any> {
    const clientInfo = { name: 'rcode', title: 'R-Code', version: '0.1.0' }
    const res = await this.request('initialize', { clientInfo, capabilities: { experimentalApi: true } }, 30000).catch(async (err) => {
      if (/already initialized/i.test(String(err))) return {}
      // Older builds reject unknown capability fields.
      if (/capabilit|unknown field/i.test(String(err))) return this.request('initialize', { clientInfo, capabilities: null }, 30000)
      throw err
    })
    this.notify('initialized')
    return res
  }

  kill(): void {
    if (this.dead) return
    try {
      this.proc.stdin.end()
      this.proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    // Codex normally exits on SIGTERM; make sure a wedged one doesn't linger.
    const proc = this.proc
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }, 2000).unref()
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
  return { type: 'workspaceWrite', writableRoots: [cwd, ...XCODE_ROOTS.filter(existsSync)], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

// Where xcodebuild and SwiftPM write (DerivedData, simulator data, package caches). Without
// these a sandboxed Codex can't build Apple projects even inside its own workspace.
const XCODE_ROOTS = [
  join(homedir(), 'Library/Developer'),
  join(homedir(), 'Library/Caches/org.swift.swiftpm'),
  join(homedir(), 'Library/org.swift.swiftpm'),
  join(homedir(), 'Library/Caches/com.apple.dt.xcodebuild')
]

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
  /** The running turn's id, once Codex has told us (turn/started or the turn/start reply, whichever is first). */
  private turnId: string | undefined
  /** A turn/start is in flight or its turn is running: R-Code's turn hasn't ended. */
  private turnActive = false
  /** Turns already finished here, so a late or duplicate turn/completed is ignored. */
  private settledTurns = new Set<string>()
  private interrupting = false
  /** A non-retryable `error` notification, reported with the turn's end instead of separately. */
  private turnError: string | undefined
  /** Running command items with their process ids, so an interrupt can stop background shells. */
  private runningCommands = new Map<string, string | undefined>()
  private reasoningItems = new Map<string, string>() // codex item id -> our reasoning item id
  private reasoningStarted = new Map<string, number>()
  private commentary = new Set<string>()
  /** The saved thread couldn't be resumed: the next message starts fresh and carries the whole chat. */
  private needsRecovery = false
  /** A /compact is running; if Codex doesn't wrap it in a turn, its compaction item ends ours. */
  private compacting = false
  private compactTimer: NodeJS.Timeout | undefined

  constructor(private init: SessionInit) {
    this.threadId = init.resumeId
  }

  private finishTurn(result?: { error?: string; interrupted?: boolean }): void {
    if (!this.turnActive) return
    this.turnActive = false
    this.compacting = false
    clearTimeout(this.compactTimer)
    if (this.turnId) this.settledTurns.add(this.turnId)
    this.turnId = undefined
    const interrupted = this.interrupting || result?.interrupted
    this.interrupting = false
    this.turnError = undefined
    this.runningCommands.clear()
    for (const id of this.reasoningItems.values()) this.init.sink.patch(id, { streaming: false } as any)
    this.reasoningItems.clear()
    this.init.sink.turnDone(interrupted ? { interrupted: true } : result?.error ? { error: result.error } : undefined)
  }

  private ensure(input: TurnInput): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const binary = which('codex')
      if (!binary) throw new Error('Codex CLI is not installed. Open Settings → Agents to install it.')
      const rpc = new CodexRpc(binary)
      this.rpc = rpc
      rpc.onNotification = (m, p) => {
        if (this.rpc === rpc) this.onNotification(m, p)
      }
      rpc.onRequest = (m, p, signal) => (this.rpc === rpc ? this.onRequest(m, p, signal) : Promise.reject(new Error('Session closed')))
      rpc.onExit = (err) => {
        if (this.rpc !== rpc) return
        this.rpc = null
        this.ready = null
        // The next message starts a new app-server and resumes the thread.
        this.finishTurn(this.interrupting ? { interrupted: true } : { error: `Codex stopped unexpectedly. ${err.message}` })
      }
      await rpc.initialize()
      const { init } = this
      const policy = policyFor(input.permissionMode, init.settings, init.cwd)
      // R-Code's tools (delegation, built-in browser, iOS Simulator, terminal) over HTTP MCP.
      const config = this.threadConfig()
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
          // Another Codex client (the CLI or the Codex app) has this thread open; starting a
          // second copy would fork the conversation, so say so instead.
          if (/active writer/i.test(String(err))) throw new Error('This Codex thread is open in another Codex window. Close it there, then send your message again.')
          if (/archived|codex unarchive/i.test(String(err))) {
            await rpc.request('thread/unarchive', { threadId: this.threadId }).catch(() => {})
            const res = await rpc.request('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common }).catch(() => null)
            if (res) return
          }
          console.error('[codex] thread/resume failed', String(err))
          init.sink.notice('Codex could not resume its earlier thread for this chat, so it started a new one with the conversation so far.', 'warn')
          this.needsRecovery = true
        }
      }
      const res = await rpc.request('thread/start', common)
      this.threadId = res.thread.id
      init.sink.setSessionId(res.thread.id)
    })()
    const ready = this.ready
    ready.catch(() => {
      if (this.ready !== ready) return
      this.ready = null
      // Don't leave a half-started app-server running; the next message starts a new one.
      const rpc = this.rpc
      this.rpc = null
      rpc?.kill()
    })
    return ready
  }

  private async onRequest(method: string, params: any, signal: AbortSignal): Promise<any> {
    const sink = this.init.sink
    // Codex withdraws a request (serverRequest/resolved) when its turn ends; `signal` closes the card.
    const requestApproval = (req: { title: string; detail?: string }): Promise<'approve' | 'approveSession' | 'deny'> => sink.requestApproval({ ...req, signal })
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const cmd = Array.isArray(params.command) ? params.command.join(' ') : params.command
      const decision = await requestApproval({
        title: params.reason ? `Run command — ${params.reason}` : 'Run command',
        detail: typeof cmd === 'string' ? cmd : JSON.stringify(cmd ?? params, null, 2)
      })
      if (method === 'execCommandApproval') return { decision: decision === 'deny' ? 'denied' : decision === 'approveSession' ? 'approved_for_session' : 'approved' }
      return { decision: decision === 'deny' ? 'decline' : decision === 'approveSession' ? 'acceptForSession' : 'accept' }
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const decision = await requestApproval({ title: params.reason || 'Apply file changes', detail: params.grantRoot ? `Allow writes under ${params.grantRoot}` : undefined })
      if (method === 'applyPatchApproval') return { decision: decision === 'deny' ? 'denied' : 'approved' }
      return { decision: decision === 'deny' ? 'decline' : decision === 'approveSession' ? 'acceptForSession' : 'accept' }
    }
    if (method === 'item/permissions/requestApproval') {
      const decision = await requestApproval({ title: 'Grant additional permissions', detail: JSON.stringify(params.permissions ?? params, null, 2) })
      return decision === 'deny' ? { permissions: {}, scope: 'turn' } : { permissions: params.permissions ?? {}, scope: decision === 'approveSession' ? 'session' : 'turn' }
    }
    if (method === 'mcpServer/elicitation/request' && params.serverName === 'rcode') {
      // R-Code's own tools (browser, simulator, delegation) are safe and visible in the UI.
      return { action: 'accept', content: {} }
    }
    if (method === 'mcpServer/elicitation/request') {
      const decision = await requestApproval({ title: `MCP server ${params.serverName ?? ''} is asking for input`, detail: params.message })
      return { action: decision === 'deny' ? 'decline' : 'accept', content: {} }
    }
    if (method === 'item/tool/requestUserInput') {
      return { answers: {} }
    }
    // Unknown requests get a JSON-RPC "method not found" so Codex never waits on an answer.
    throw Object.assign(new Error(`R-Code does not support ${method}`), { code: -32601 })
  }

  private onNotification(method: string, p: any): void {
    const sink = this.init.sink
    if (method === 'account/rateLimits/updated') {
      usageBus.emit('codex', p?.rateLimits)
      return
    }
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return
    switch (method) {
      case 'turn/started': {
        const id = p.turn?.id
        if (!id || this.settledTurns.has(id) || !this.turnActive) break
        this.turnId = id
        // Stop was pressed while the turn was still queued.
        if (this.interrupting) void this.sendInterrupt()
        break
      }
      case 'thread/closed':
        if (this.turnActive) this.finishTurn(this.interrupting ? { interrupted: true } : { error: 'Codex closed this thread.' })
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
      case 'error': {
        if (p.willRetry) break
        const message = p.error?.message ?? 'Codex error'
        // During a turn the error explains how it ends; report it once, with the turn.
        if (this.turnActive) this.turnError = message
        else sink.notice(message, 'error')
        break
      }
      case 'turn/completed': {
        const turn = p.turn
        const id = turn?.id
        // A late or duplicate completion (an earlier, interrupted turn) isn't this turn's end.
        if (id && (this.settledTurns.has(id) || (this.turnId && id !== this.turnId))) break
        if (!this.turnActive) break
        if (id) this.turnId = id
        if (turn?.status === 'interrupted') this.finishTurn({ interrupted: true })
        else if (turn?.status === 'failed') this.finishTurn({ error: turn.error?.message ?? this.turnError ?? 'Codex turn failed' })
        else this.finishTurn()
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
        if (completed) this.runningCommands.delete(item.id)
        else this.runningCommands.set(item.id, item.processId ?? undefined)
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
        if (completed) {
          sink.upsert({ kind: 'compaction', id: item.id, ts })
          if (this.compacting && !this.turnId) this.finishTurn()
        } else if (this.compacting) clearTimeout(this.compactTimer)
        break
      case 'enteredReviewMode':
        sink.upsert({ kind: 'tool', id: item.id, ts, tool: 'review', toolKind: 'task', title: 'Review the changes', detail: typeof item.review === 'string' ? item.review : undefined, status: completed ? 'done' : 'running' })
        break
      case 'exitedReviewMode':
        // The review itself arrives here, not as an agent message.
        if (completed && typeof item.review === 'string' && item.review.trim()) sink.upsert({ kind: 'assistant', id: item.id, ts, text: item.review, agent: 'codex', model: this.init.model })
        break
      default:
        break
    }
  }

  async send(input: TurnInput): Promise<void> {
    this.turnActive = true
    this.interrupting = false
    this.turnError = undefined
    this.turnId = undefined
    try {
      await this.ensure(input)
      await this.startTurnRecovering(input)
    } catch (err) {
      this.turnActive = false
      throw err
    }
  }

  private async startTurnRecovering(input: TurnInput): Promise<void> {
    try {
      await this.startTurn(input)
    } catch (err) {
      // The thread vanished between resume and the turn: start a fresh one carrying the chat.
      if (!STALE_SESSION_RE.test(String(err)) || !this.rpc || !this.threadId) throw err
      console.error('[codex] turn/start on a stale thread', String(err))
      this.init.sink.notice('Codex lost its earlier thread for this chat, so it started a new one with the conversation so far.', 'warn')
      const res = await this.rpc.request('thread/start', {
        cwd: this.init.cwd,
        model: input.model === 'default' ? undefined : input.model,
        approvalPolicy: policyFor(input.permissionMode, this.init.settings, this.init.cwd).approvalPolicy,
        developerInstructions: this.init.instructions,
        config: this.threadConfig()
      })
      this.threadId = res.thread.id
      this.init.sink.setSessionId(res.thread.id)
      this.needsRecovery = true
      await this.startTurn(input)
    }
  }

  private threadConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = { 'tools.update_plan.enabled': true }
    if (this.init.bridge) {
      config['mcp_servers.rcode'] = {
        url: `${this.init.bridge.url}/mcp/${this.init.threadId}?agent=codex`,
        http_headers: { Authorization: `Bearer ${this.init.bridge.token}` },
        tool_timeout_sec: 3600
      }
    }
    return config
  }

  private async startTurn(input: TurnInput): Promise<void> {
    const rpc = this.rpc
    if (!rpc) throw new Error('Codex is not running.')
    const policy = policyFor(input.permissionMode, this.init.settings, this.init.cwd)
    let text = this.needsRecovery && input.recoveryContext ? input.recoveryContext() : input.text
    this.needsRecovery = false
    const extra: any[] = []
    const cmd = input.images?.length ? null : parseSlashCommand(input.text)
    if (cmd) {
      // Codex's own commands map onto app-server requests; its skills become skill inputs.
      if (cmd.name === 'compact') return this.registerTurn(await rpc.request('thread/compact/start', { threadId: this.threadId }), true)
      if (cmd.name === 'review') return this.registerTurn(await rpc.request('review/start', { threadId: this.threadId, target: reviewTarget(cmd.args), delivery: 'inline' }))
      if (cmd.name === 'init') text = INIT_PROMPT + (cmd.args ? `\n\nAlso: ${cmd.args}` : '')
      else {
        const skill = (await listSkills(rpc, this.init.cwd).catch(() => [])).find((s) => s.name === cmd.name)
        if (skill) {
          text = '$' + skill.name + (cmd.args ? ` ${cmd.args}` : '')
          extra.push({ type: 'skill', name: skill.name, path: skill.path })
        }
      }
    }
    if (input.permissionMode === 'plan') text = `${text}\n\n(Plan only: investigate and propose a plan, do not modify files.)`
    const content: any[] = [{ type: 'text', text: wellFormed(text), text_elements: [] }, ...extra]
    for (const img of input.images ?? []) content.push({ type: 'image', url: `data:${img.mimeType};base64,${img.data}` })
    const res = await rpc.request('turn/start', {
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
    this.registerTurn(res)
  }

  /** Record the turn a request started (turn/started may have beaten the reply, or it may even be over). */
  private registerTurn(res: any, compacting = false): void {
    const id = res?.turn?.id
    if (id && this.turnActive && !this.settledTurns.has(id) && !this.turnId) {
      this.turnId = id
      if (this.interrupting) void this.sendInterrupt()
    }
    // Compaction may run without a turn of its own; then its compaction item ends ours.
    this.compacting = compacting
    if (compacting) {
      clearTimeout(this.compactTimer)
      this.compactTimer = setTimeout(() => {
        if (this.compacting && !this.turnId) this.finishTurn()
      }, 5000)
    }
  }

  async steer(text: string): Promise<boolean> {
    if (!this.rpc || !this.turnId || !this.turnActive) return false
    try {
      await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: wellFormed(text), text_elements: [] }] }, 15000)
      return true
    } catch {
      return false
    }
  }

  private async sendInterrupt(): Promise<void> {
    const rpc = this.rpc
    const turnId = this.turnId
    if (!rpc || !turnId) return
    await rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, 10000).catch(() => {})
    // Commands Codex moved to the background keep running after an interrupt; stop them too.
    for (const processId of this.runningCommands.values()) {
      if (processId) void rpc.request('thread/backgroundTerminals/terminate', { threadId: this.threadId, processId }, 5000).catch(() => {})
    }
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive) return
    this.interrupting = true
    // Without a turn id yet (still queued), the interrupt goes out as soon as Codex names the turn.
    await this.sendInterrupt()
  }

  async compact(): Promise<void> {
    await this.ensure({ text: '', model: this.init.model, permissionMode: this.init.permissionMode })
    await this.rpc!.request('thread/compact/start', { threadId: this.threadId })
  }

  dispose(): void {
    const rpc = this.rpc
    this.rpc = null
    this.ready = null
    this.turnActive = false
    rpc?.kill()
  }
}

let modelCache: ModelOption[] | null = null
const codexCommands = commandCache()

const INIT_PROMPT = `Create an AGENTS.md file at the root of this repository: concise guidance for coding agents working here. Look around first, then cover the project layout, how to build, run and test it, code style and conventions you can infer from the code, and anything non-obvious a newcomer would trip over. Keep it short and specific to this project; if an AGENTS.md already exists, improve it instead of replacing it.`

/** `/review` arguments: nothing for uncommitted changes, "base <branch>", "commit <sha>", or free-form instructions. */
function reviewTarget(args: string): any {
  const base = args.match(/^(?:base|branch)\s+(\S+)$/i)
  if (base) return { type: 'baseBranch', branch: base[1] }
  const commit = args.match(/^commit\s+([0-9a-f]{6,40})$/i)
  if (commit) return { type: 'commit', sha: commit[1] }
  return args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' }
}

async function listSkills(rpc: CodexRpc, cwd: string): Promise<{ name: string; path: string; description?: string; scope?: string }[]> {
  const res: any = await rpc.request('skills/list', { cwds: [cwd] }, 15000)
  const entries: any[] = res?.data ?? []
  const skills = (entries.find((e) => e.cwd === cwd) ?? { skills: entries.flatMap((e) => e.skills ?? []) }).skills ?? []
  return skills
    .filter((s: any) => s?.name && s.path && s.enabled !== false)
    .map((s: any) => ({ name: s.name, path: s.path, description: s.shortDescription ?? s.interface?.shortDescription ?? s.description, scope: s.scope }))
}

const CODEX_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', source: 'built-in' },
  { name: 'review', description: 'Review your uncommitted changes', argumentHint: '[instructions | base <branch> | commit <sha>]', source: 'built-in' },
  { name: 'init', description: 'Create an AGENTS.md with instructions for Codex', source: 'built-in' }
]

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

  listCommands(_settings, cwd): Promise<SlashCommand[]> {
    return codexCommands(cwd, async () => {
      const binary = which('codex')
      if (!binary) return []
      const rpc = new CodexRpc(binary)
      try {
        await rpc.initialize()
        const skills = await listSkills(rpc, cwd).catch(() => [])
        // A skill installed in more than one scope is listed once (Codex runs the closest one).
        const seen = new Set(CODEX_BUILTIN_COMMANDS.map((c) => c.name))
        const unique = skills.filter((s) => !seen.has(s.name) && (seen.add(s.name), true))
        return [...CODEX_BUILTIN_COMMANDS, ...unique.map((s) => ({ name: s.name, description: s.description, source: 'skill' }))]
      } finally {
        rpc.kill()
      }
    })
  },

  createSession(init: SessionInit): AgentSession {
    return new CodexSession(init)
  }
}

export const codexHome = (): string => process.env.CODEX_HOME || `${homedir()}/.codex`
