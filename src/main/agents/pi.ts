import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseSlashCommand, type AgentStatus, type ModelOption, type PermissionMode, type Settings, type SlashCommand, type ToolKind } from '@shared/types'
import { jsonLines, nodeBinary } from '../env'
import { dataPath } from '../store'
import { piToolsJson } from '../bridge'
import type { AgentAdapter, AgentSession, SessionInit, TurnInput } from './base'
import { commandCache, shortPath, truncate, uid } from './base'
import { currentContents, unifiedDiff } from './diff'
import { describeRcodeTool } from '@shared/rcode-tools'

// Pi is R-Code's built-in agent: the open-source Pi coding agent ships inside the app as
// a dependency and runs on Electron's own Node runtime (ELECTRON_RUN_AS_NODE), so it never
// needs a separate install. It powers every model that isn't Claude Code or Codex —
// Ollama, LM Studio, OpenRouter, API keys, subscriptions. It is driven through
// `--mode rpc` (JSON commands on stdin, JSON events on stdout), and R-Code loads a small
// Pi extension that adds approvals (Pi itself never asks) and the delegation tools.

function piPackageDir(): string {
  // In packaged builds the agent lives in app.asar.unpacked so it can spawn tools freely.
  return join(app.getAppPath(), 'node_modules', '@earendil-works', 'pi-coding-agent').replace(/app\.asar(?=\/|$)/, 'app.asar.unpacked')
}

export function piVersion(): string {
  try {
    return JSON.parse(readFileSync(join(piPackageDir(), 'package.json'), 'utf8')).version
  } catch {
    return 'built-in'
  }
}

/** Command + env to launch the bundled Pi CLI with Electron's Node runtime. */
export function piCommand(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: nodeBinary(),
    args: [join(piPackageDir(), 'dist/bundle/cli.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

export class PiRpc {
  proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<string, Pending>()
  onEvent: (ev: any) => void = () => {}
  onExit: (code: number | null) => void = () => {}
  stderr = ''

  constructor(args: string[], cwd: string, env: Record<string, string> = {}) {
    const cmd = piCommand()
    this.proc = spawn(cmd.command, [...cmd.args, '--mode', 'rpc', ...args], {
      cwd,
      env: { ...process.env, ...cmd.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000)
    })
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`pi exited (${code}). ${this.stderr.slice(-500)}`))
      this.pending.clear()
      this.onExit(code)
    })
    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    jsonLines(this.proc.stdout, (msg) => {
      if (msg.type === 'response' && msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.success) p.resolve(msg.data)
        else p.reject(new Error(msg.error ?? `pi ${msg.command} failed`))
      } else if (msg.type !== 'response') {
        this.onEvent(msg)
      }
    })
  }

  send(cmd: Record<string, unknown>): void {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(cmd) + '\n')
  }

  request<T = any>(cmd: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
    const id = `r${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`pi ${cmd.type} timed out`))
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
      this.send({ ...cmd, id })
    })
  }

  kill(): void {
    try {
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }
}

export function splitPiModel(id: string): { provider?: string; modelId: string } {
  const i = id.indexOf('/')
  return i > 0 ? { provider: id.slice(0, i), modelId: id.slice(i + 1) } : { modelId: id }
}

function classifyPiTool(name: string, args: any, cwd: string): { kind: ToolKind; title: string; detail?: string; diff?: string; file?: string } {
  const p = (v: unknown): string => (typeof v === 'string' ? shortPath(v, cwd) : '')
  const abs = (v: unknown): string | undefined => (typeof v === 'string' ? (v.startsWith('/') ? v : join(cwd, v)) : undefined)
  switch (name) {
    case 'bash':
      return { kind: 'command', title: 'Run command', detail: args?.command }
    case 'read':
      return { kind: 'read', title: `Read ${p(args?.path)}`, file: abs(args?.path) }
    case 'write': {
      const before = currentContents(abs(args?.path))
      return { kind: 'edit', title: `${before ? 'Write' : 'Create'} ${p(args?.path)}`, diff: truncate(unifiedDiff(before, String(args?.content ?? '')), 20000), file: abs(args?.path) }
    }
    case 'edit': {
      const edits: any[] = Array.isArray(args?.edits) ? args.edits : [args ?? {}]
      const diff = edits.map((e) => unifiedDiff(String(e.oldText ?? e.old_string ?? ''), String(e.newText ?? e.new_string ?? ''), 1)).join('\n')
      return { kind: 'edit', title: `Edit ${p(args?.path)}`, diff: truncate(diff, 20000), file: abs(args?.path) }
    }
    case 'grep':
      return { kind: 'search', title: `Search for "${args?.pattern ?? ''}"` }
    case 'find':
      return { kind: 'search', title: `Find ${args?.pattern ?? 'files'}` }
    case 'ls':
      return { kind: 'search', title: `List ${p(args?.path) || '.'}` }
    default: {
      const ours = describeRcodeTool(name, args)
      if (ours) return ours
      return { kind: name.includes('search') || name.includes('web') ? 'web' : 'other', title: name, detail: truncate(JSON.stringify(args ?? {}, null, 2), 4000) }
    }
  }
}

function resultText(result: any): string {
  if (!result) return ''
  const content = result.content ?? result
  if (Array.isArray(content)) return content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n')
  return typeof content === 'string' ? content : JSON.stringify(content)
}

class PiSession implements AgentSession {
  private rpc: PiRpc | null = null
  private ready: Promise<void> | null = null
  private sessionFile: string | undefined
  private currentModel: string | undefined
  private currentThinking: string | undefined
  private running = false
  /** Pi began an agent run for the current prompt (an extension command may not start one). */
  private agentStarted = false
  private msgBlocks = new Map<number, string>() // contentIndex -> item id for the current assistant message
  private thinkingStarted = new Map<string, number>()
  private modeFile: string

  constructor(private init: SessionInit) {
    this.sessionFile = init.resumeId
    this.modeFile = dataPath(`pi-mode-${init.threadId}.json`)
  }

  private writeMode(mode: PermissionMode): void {
    try {
      writeFileSync(this.modeFile, JSON.stringify({ mode }))
    } catch {
      /* ignore */
    }
  }

  private ensure(input: TurnInput): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const { init } = this
      this.writeMode(input.permissionMode)
      const args: string[] = []
      if (this.sessionFile) args.push('--session', this.sessionFile)
      if (input.model && input.model !== 'default') args.push('--model', input.model)
      const thinking = input.effort || init.settings.piThinking
      if (thinking) args.push('--thinking', thinking)
      if (init.instructions) args.push('--append-system-prompt', init.instructions)
      if (init.bridge) args.push('--extension', init.bridge.piExtension)
      const env: Record<string, string> = { RCODE_PI_MODE_FILE: this.modeFile, RCODE_THREAD_ID: init.threadId }
      if (init.bridge) {
        env.RCODE_BRIDGE_URL = init.bridge.url
        env.RCODE_BRIDGE_TOKEN = init.bridge.token
        env.RCODE_TOOLS = piToolsJson(!init.allowDelegation)
      }
      const start = async (extra: string[]): Promise<PiRpc> => {
        const rpc = new PiRpc([...args, ...extra], init.cwd, env)
        this.rpc = rpc
        rpc.onEvent = (ev) => this.onEvent(ev)
        rpc.onExit = () => {
          if (this.rpc !== rpc) return
          this.rpc = null
          this.ready = null
          if (this.running) {
            this.running = false
            init.sink.turnDone({ error: `Pi exited unexpectedly. ${rpc.stderr.slice(-400)}` })
          }
        }
        const state = await rpc.request({ type: 'get_state' }, 30000)
        if (state?.sessionFile) {
          this.sessionFile = state.sessionFile
          init.sink.setSessionId(state.sessionFile)
        }
        return rpc
      }
      let rpc: PiRpc
      try {
        rpc = await start([])
      } catch (err) {
        // A broken third-party extension in ~/.pi makes Pi refuse to start. Run without the
        // user's extensions (R-Code's own still load via --extension) rather than failing the chat.
        const failed = String((err as Error)?.message ?? err).match(/Failed to load extension "([^"]+)"/)
        if (!failed || (init.bridge && failed[1] === init.bridge.piExtension)) throw err
        this.rpc?.kill()
        rpc = await start(['--no-extensions'])
        init.sink.notice(`Pi couldn't load your extension ${shortPath(failed[1])}, so this chat runs without your Pi extensions. R-Code's tools are still available.`, 'warn')
      }
      this.currentModel = input.model
      this.currentThinking = thinking
      await rpc.request({ type: 'set_auto_compaction', enabled: init.settings.autoCompact }).catch(() => {})
    })()
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  private onEvent(ev: any): void {
    const sink = this.init.sink
    switch (ev.type) {
      case 'agent_start':
        this.agentStarted = true
        break
      case 'message_start':
        if (ev.message?.role === 'assistant') this.msgBlocks.clear()
        break
      case 'message_update': {
        const e = ev.assistantMessageEvent
        if (!e) break
        if (e.type === 'text_start' || e.type === 'thinking_start') {
          const id = uid(e.type === 'text_start' ? 'as' : 'th')
          this.msgBlocks.set(e.contentIndex, id)
          if (e.type === 'text_start') sink.upsert({ kind: 'assistant', id, ts: Date.now(), text: '', agent: 'pi', model: this.currentModel, streaming: true })
          else {
            this.thinkingStarted.set(id, Date.now())
            sink.upsert({ kind: 'reasoning', id, ts: Date.now(), text: '', streaming: true })
          }
        } else if (e.type === 'text_delta' || e.type === 'thinking_delta') {
          const id = this.msgBlocks.get(e.contentIndex)
          if (id) sink.append(id, 'text', e.delta)
        } else if (e.type === 'text_end' || e.type === 'thinking_end') {
          const id = this.msgBlocks.get(e.contentIndex)
          if (id) {
            const started = this.thinkingStarted.get(id)
            sink.patch(id, { streaming: false, ...(started ? { durationMs: Date.now() - started } : {}) } as any)
          }
        } else if (e.type === 'error' && e.reason !== 'aborted') {
          sink.notice(e.error?.errorMessage ?? e.errorMessage ?? 'Pi reported an error', 'error')
        }
        break
      }
      case 'message_end': {
        const m = ev.message
        if (m?.role === 'assistant' && m.stopReason === 'error' && m.errorMessage) sink.notice(m.errorMessage, 'error')
        if (m?.role === 'assistant' && m.usage) {
          sink.setUsage({ contextTokens: (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.output ?? 0) })
        }
        break
      }
      case 'tool_execution_start': {
        const info = classifyPiTool(ev.toolName, ev.args, this.init.cwd)
        sink.upsert({
          kind: 'tool',
          id: ev.toolCallId,
          ts: Date.now(),
          tool: ev.toolName,
          toolKind: info.kind,
          title: info.title,
          detail: info.detail,
          diff: info.diff,
          file: info.file,
          input: ev.args,
          status: 'running'
        })
        break
      }
      case 'tool_execution_update':
        if (sink.has(ev.toolCallId)) sink.patch(ev.toolCallId, { output: truncate(resultText(ev.partialResult), 30000) } as any)
        break
      case 'tool_execution_end':
        if (sink.has(ev.toolCallId)) sink.patch(ev.toolCallId, { status: ev.isError ? 'error' : 'done', output: truncate(resultText(ev.result), 30000) } as any)
        break
      case 'compaction_end':
        if (ev.result) sink.upsert({ kind: 'compaction', id: uid('cmp'), ts: Date.now(), summary: ev.result.summary, tokensBefore: ev.result.tokensBefore })
        else if (ev.errorMessage) sink.notice(`Compaction failed: ${ev.errorMessage}`, 'warn')
        break
      case 'auto_retry_start':
        sink.notice(`Retrying (attempt ${ev.attempt}/${ev.maxAttempts}) — ${String(ev.errorMessage ?? '').slice(0, 160)}`, 'warn')
        break
      case 'extension_ui_request':
        void this.onUiRequest(ev)
        break
      case 'extension_error':
        console.error('[pi extension]', ev.error)
        break
      case 'agent_settled':
        // Pi won't continue on its own any more (retries, compaction recovery and queued
        // messages are done), so the turn is over.
        this.running = false
        void this.refreshStats()
        sink.turnDone()
        break
      default:
        break
    }
  }

  private async onUiRequest(ev: any): Promise<void> {
    const sink = this.init.sink
    const rpc = this.rpc
    if (!rpc) return
    switch (ev.method) {
      case 'confirm': {
        const decision = await sink.requestApproval({ title: ev.title ?? 'Allow?', detail: ev.message })
        rpc.send({ type: 'extension_ui_response', id: ev.id, confirmed: decision !== 'deny' })
        break
      }
      case 'select': {
        const options: string[] = ev.options ?? []
        const decision = await sink.requestApproval({ title: ev.title ?? 'Choose', detail: options.join(' / ') })
        rpc.send({ type: 'extension_ui_response', id: ev.id, ...(decision === 'deny' ? { cancelled: true } : { value: options[0] }) })
        break
      }
      case 'input':
      case 'editor':
        rpc.send({ type: 'extension_ui_response', id: ev.id, cancelled: true })
        break
      case 'notify':
        sink.notice(ev.message ?? '', ev.notifyType === 'error' ? 'error' : ev.notifyType === 'warning' ? 'warn' : 'info')
        break
      default:
        break
    }
  }

  private async refreshStats(): Promise<void> {
    try {
      const stats = await this.rpc?.request({ type: 'get_session_stats' }, 10000)
      if (!stats) return
      this.init.sink.setUsage({
        inputTokens: stats.tokens?.input ?? 0,
        outputTokens: stats.tokens?.output ?? 0,
        cachedTokens: stats.tokens?.cacheRead ?? 0,
        costUsd: stats.cost,
        contextTokens: stats.contextUsage?.tokens ?? undefined,
        contextWindow: stats.contextUsage?.contextWindow ?? undefined
      })
    } catch {
      /* ignore */
    }
  }

  async send(input: TurnInput): Promise<void> {
    await this.ensure(input)
    const rpc = this.rpc!
    this.writeMode(input.permissionMode)
    if (input.model && input.model !== this.currentModel && input.model !== 'default') {
      const { provider, modelId } = splitPiModel(input.model)
      await rpc.request({ type: 'set_model', provider, modelId })
      this.currentModel = input.model
    }
    const thinking = input.effort || this.init.settings.piThinking
    if (thinking && thinking !== this.currentThinking) {
      await rpc.request({ type: 'set_thinking_level', level: thinking }).catch(() => {})
      this.currentThinking = thinking
    }
    const cmd = input.images?.length ? null : parseSlashCommand(input.text)
    if (cmd?.name === 'compact') {
      // Pi's /compact is a TUI command; over RPC it's the compact request.
      this.running = true
      try {
        await rpc.request({ type: 'compact', ...(cmd.args ? { customInstructions: cmd.args } : {}) }, 300000)
        void this.refreshStats()
      } finally {
        if (this.running) {
          this.running = false
          this.init.sink.turnDone()
        }
      }
      return
    }
    // Slash commands (extension commands, prompt templates, /skill:name) go through as typed; Pi expands them.
    const text = input.permissionMode === 'plan' && !cmd ? `${input.text}\n\n(Plan only: investigate and propose a plan; do not modify files.)` : input.text
    const images = (input.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
    this.running = true
    this.agentStarted = false
    const res = await rpc.request({ type: 'prompt', message: text, ...(images.length ? { images } : {}) })
    // An extension command that handled itself starts no agent run, so nothing else would end the turn.
    if (res?.disposition === 'handled') {
      setTimeout(() => {
        if (this.running && !this.agentStarted) {
          this.running = false
          this.init.sink.turnDone()
        }
      }, 1500)
    }
  }

  async steer(text: string): Promise<boolean> {
    if (!this.rpc || !this.running) return false
    try {
      await this.rpc.request({ type: 'steer', message: text })
      return true
    } catch {
      return false
    }
  }

  async interrupt(): Promise<void> {
    await this.rpc?.request({ type: 'abort' }, 10000).catch(() => {})
  }

  async compact(): Promise<void> {
    await this.ensure({ text: '', model: this.init.model, permissionMode: this.init.permissionMode })
    this.init.sink.notice('Compacting context…', 'info')
    await this.rpc!.request({ type: 'compact' }, 300000)
    void this.refreshStats()
  }

  dispose(): void {
    this.rpc?.kill()
    this.rpc = null
    this.ready = null
  }
}

let modelCache: ModelOption[] | null = null

export function clearPiModelCache(): void {
  modelCache = null
}

export const piAdapter: AgentAdapter = {
  id: 'pi',

  async detect(settings: Settings): Promise<AgentStatus> {
    const status: AgentStatus = { id: 'pi', installed: true, path: 'built-in', version: piVersion(), authenticated: null, linked: settings.linkedAgents.includes('pi') }
    const models = await piAdapter.listModels(settings)
    status.authenticated = models.length > 0
    status.authDetail = models.length ? `${models.length} model${models.length === 1 ? '' : 's'} available` : 'No providers configured yet'
    return status
  },

  async listModels(): Promise<ModelOption[]> {
    if (modelCache) return modelCache
    const rpc = new PiRpc(['--no-session', '--no-extensions', '--offline'], process.env.HOME || '/')
    try {
      const data = await rpc.request({ type: 'get_available_models' }, 20000)
      modelCache = (data?.models ?? []).map((m: any) => ({
        id: `${m.provider}/${m.id}`,
        label: m.name || m.id,
        agent: 'pi' as const,
        provider: m.provider,
        contextWindow: m.contextWindow,
        efforts: m.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : undefined,
        local: /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(m.baseUrl ?? '') || m.provider === 'ollama' || m.provider === 'lmstudio'
      }))
      return modelCache!
    } catch {
      return []
    } finally {
      rpc.kill()
    }
  },

  listCommands(_settings, cwd): Promise<SlashCommand[]> {
    return piCommands(cwd, async () => {
      // The user's extensions, prompt templates and skills, as Pi would load them in this folder.
      const rpc = new PiRpc(['--no-session', '--offline'], cwd)
      try {
        const data = await rpc.request({ type: 'get_commands' }, 20000)
        const out: SlashCommand[] = [{ name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '[instructions]', source: 'built-in' }]
        for (const c of data?.commands ?? []) {
          const name = String(c?.name ?? '')
          if (!name || name === 'compact') continue
          out.push({ name, description: c.description || undefined, source: c.source === 'skill' ? 'skill' : c.source === 'prompt' ? 'prompt' : c.source === 'extension' ? 'extension' : undefined })
        }
        return out
      } finally {
        rpc.kill()
      }
    })
  },

  createSession(init: SessionInit): AgentSession {
    return new PiSession(init)
  }
}

const piCommands = commandCache()
