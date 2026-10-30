import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  query,
  type PermissionMode as ClaudePermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentStatus, ModelOption, PermissionMode, PlanUsage, Settings, ToolKind, UsageWindow } from '@shared/types'
import { run, which } from '../env'
import type { AgentAdapter, AgentSession, SessionInit, TurnInput } from './base'
import { shortPath, truncate, uid, usageBus } from './base'
import { currentContents, unifiedDiff } from './diff'
import { describeRcodeTool } from '@shared/rcode-tools'

const PERMISSION_MAP: Record<PermissionMode, ClaudePermissionMode> = {
  ask: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  allowAll: 'bypassPermissions',
  plan: 'plan'
}

const FALLBACK_MODELS: ModelOption[] = [
  { id: 'default', label: 'Default (recommended)', agent: 'claude', provider: 'anthropic' },
  { id: 'opus', label: 'Opus', agent: 'claude', provider: 'anthropic', description: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet', agent: 'claude', provider: 'anthropic', description: 'Fast and capable' },
  { id: 'haiku', label: 'Haiku', agent: 'claude', provider: 'anthropic', description: 'Fastest' }
]

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function claudeExecutable(): string | undefined {
  const installed = which('claude') ?? [join(homedir(), '.local/bin/claude'), join(homedir(), '.claude/local/claude')].find(existsSync)
  if (installed) return installed
  // Fall back to the binary bundled with the SDK (unpacked from the asar in packaged builds).
  try {
    const pkg = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-darwin-${process.arch}/package.json`)
    const bin = join(pkg, '..', 'claude').replace('app.asar', 'app.asar.unpacked')
    if (existsSync(bin)) return bin
  } catch {
    /* not available */
  }
  return undefined
}

export function classifyClaudeTool(name: string, input: any, cwd: string): { kind: ToolKind; title: string; detail?: string; diff?: string; file?: string } {
  const p = (v: unknown): string => (typeof v === 'string' ? shortPath(v, cwd) : '')
  switch (name) {
    case 'Bash':
      return { kind: 'command', title: input?.description || 'Run command', detail: input?.command }
    case 'BashOutput':
    case 'KillShell':
      return { kind: 'command', title: name === 'KillShell' ? 'Stop background shell' : 'Read background output' }
    case 'Edit':
    case 'MultiEdit': {
      const edits = name === 'MultiEdit' ? input?.edits ?? [] : [input ?? {}]
      const diff = edits.map((e: any) => unifiedDiff(String(e.old_string ?? ''), String(e.new_string ?? ''), 1)).join('\n')
      return { kind: 'edit', title: `Edit ${p(input?.file_path)}`, diff: truncate(diff, 20000), file: input?.file_path }
    }
    case 'Write': {
      const before = currentContents(input?.file_path)
      return {
        kind: 'edit',
        title: `${before ? 'Write' : 'Create'} ${p(input?.file_path)}`,
        diff: truncate(unifiedDiff(before, String(input?.content ?? '')), 20000),
        file: input?.file_path
      }
    }
    case 'NotebookEdit':
      return { kind: 'edit', title: `Edit notebook ${p(input?.notebook_path)}`, file: input?.notebook_path }
    case 'Read':
      return { kind: 'read', title: `Read ${p(input?.file_path)}`, file: input?.file_path }
    case 'Grep':
      return { kind: 'search', title: `Search for "${input?.pattern ?? ''}"`, detail: input?.path ? p(input.path) : undefined }
    case 'Glob':
      return { kind: 'search', title: `Find files ${input?.pattern ?? ''}` }
    case 'LS':
      return { kind: 'search', title: `List ${p(input?.path)}` }
    case 'WebFetch':
      return { kind: 'web', title: `Fetch ${input?.url ?? ''}` }
    case 'WebSearch':
      return { kind: 'web', title: `Search the web for "${input?.query ?? ''}"` }
    case 'Task':
    case 'Agent':
      return { kind: 'task', title: input?.description || 'Run subagent', detail: input?.prompt }
    case 'TodoWrite':
      return { kind: 'todo', title: 'Update plan' }
    case 'ExitPlanMode':
      return { kind: 'other', title: 'Plan ready', detail: input?.plan }
    default:
      if (name.startsWith('mcp__rcode__')) {
        const ours = describeRcodeTool(name.slice('mcp__rcode__'.length), input)
        if (ours) return ours
      }
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__')
        return { kind: 'mcp', title: `${server}: ${rest.join('__')}`, detail: truncate(JSON.stringify(input ?? {}, null, 2), 4000) }
      }
      return { kind: 'other', title: name, detail: truncate(JSON.stringify(input ?? {}, null, 2), 4000) }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  return content == null ? '' : JSON.stringify(content)
}

/** A push-based async iterable feeding user messages into a long-lived query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false
  push(msg: SDKUserMessage): void {
    const w = this.waiters.shift()
    if (w) w({ value: msg, done: false })
    else this.items.push(msg)
  }
  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

class ClaudeSession implements AgentSession {
  private q: Query | null = null
  private input: InputQueue | null = null
  private sessionId: string | undefined
  private currentModel: string | undefined
  private currentEffort: string | undefined
  private currentMode: PermissionMode
  private turnActive = false
  private streamedMessages = new Set<string>()
  private blockItems = new Map<string, string>() // `${messageId}:${index}` -> item id
  private currentMessageId: string | null = null
  private thinkingStart = new Map<string, number>()
  private lastContext = 0
  private contextWindow: number | undefined

  constructor(private init: SessionInit) {
    this.sessionId = init.resumeId
    this.currentMode = init.permissionMode
  }

  private start(input: TurnInput): void {
    const { init } = this
    this.input = new InputQueue()
    this.currentModel = input.model
    this.currentEffort = input.effort
    this.currentMode = input.permissionMode
    const sink = init.sink
    const mcpServers: Record<string, any> = {}
    if (init.bridge) {
      // R-Code's tools (delegation, built-in browser, iOS Simulator) over HTTP MCP.
      mcpServers.rcode = {
        type: 'http',
        url: `${init.bridge.url}/mcp/${init.threadId}?agent=claude`,
        headers: { Authorization: `Bearer ${init.bridge.token}` }
      }
    }

    this.q = query({
      prompt: this.input,
      options: {
        cwd: init.cwd,
        model: input.model === 'default' ? undefined : input.model,
        effort: (CLAUDE_EFFORTS.includes(input.effort ?? '') ? input.effort : undefined) as any,
        resume: this.sessionId,
        permissionMode: PERMISSION_MAP[input.permissionMode],
        allowDangerouslySkipPermissions: input.permissionMode === 'allowAll',
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: init.instructions },
        pathToClaudeCodeExecutable: claudeExecutable(),
        disallowedTools: ['AskUserQuestion'],
        mcpServers,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } as Record<string, string>,
        stderr: (data) => console.error('[claude]', data.trim()),
        canUseTool: async (toolName, toolInput, opts) => {
          if (toolName.startsWith('mcp__rcode__')) return { behavior: 'allow', updatedInput: toolInput }
          const info = classifyClaudeTool(toolName, toolInput, init.cwd)
          const decision = await sink.requestApproval({
            title: toolName === 'ExitPlanMode' ? 'Claude finished planning. Start implementing?' : info.title,
            detail: info.detail ?? info.diff
          })
          if (decision === 'deny') return { behavior: 'deny', message: 'The user declined this action.' }
          if (toolName === 'ExitPlanMode') {
            this.currentMode = 'acceptEdits'
            this.q?.setPermissionMode('acceptEdits').catch(() => {})
          }
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            updatedPermissions: decision === 'approveSession' ? opts.suggestions : undefined
          }
        }
      }
    })

    void this.consume(this.q)
  }

  private async consume(q: Query): Promise<void> {
    const sink = this.init.sink
    try {
      for await (const msg of q) this.handle(msg)
    } catch (err: any) {
      if (this.turnActive) sink.turnDone({ error: err?.message ?? String(err) })
      this.turnActive = false
    } finally {
      if (this.q === q) {
        this.q = null
        this.input = null
        if (this.turnActive) {
          this.turnActive = false
          sink.turnDone()
        }
      }
    }
  }

  private handle(msg: SDKMessage): void {
    const sink = this.init.sink
    const m = msg as any
    switch (msg.type) {
      case 'rate_limit_event':
        usageBus.emit('refresh', 'claude')
        break
      case 'system': {
        if (m.subtype === 'init') {
          this.sessionId = m.session_id
          sink.setSessionId(m.session_id)
        } else if (m.subtype === 'compact_boundary') {
          sink.upsert({ kind: 'compaction', id: uid('cmp'), ts: Date.now(), tokensBefore: m.compact_metadata?.pre_tokens })
        } else if (m.subtype === 'informational' && m.message) {
          sink.notice(String(m.message), 'info')
        }
        break
      }
      case 'stream_event': {
        if (m.parent_tool_use_id) break
        const ev = m.event
        if (ev.type === 'message_start') {
          this.currentMessageId = ev.message.id
          this.streamedMessages.add(ev.message.id)
        } else if (ev.type === 'content_block_start') {
          const key = `${this.currentMessageId}:${ev.index}`
          const block = ev.content_block
          if (block.type === 'text') {
            const id = uid('as')
            this.blockItems.set(key, id)
            sink.upsert({ kind: 'assistant', id, ts: Date.now(), text: block.text ?? '', agent: 'claude', model: this.currentModel, streaming: true })
          } else if (block.type === 'thinking') {
            const id = uid('th')
            this.blockItems.set(key, id)
            this.thinkingStart.set(id, Date.now())
            sink.upsert({ kind: 'reasoning', id, ts: Date.now(), text: block.thinking ?? '', streaming: true })
          }
        } else if (ev.type === 'content_block_delta') {
          const id = this.blockItems.get(`${this.currentMessageId}:${ev.index}`)
          if (!id) break
          if (ev.delta.type === 'text_delta') sink.append(id, 'text', ev.delta.text)
          else if (ev.delta.type === 'thinking_delta') sink.append(id, 'text', ev.delta.thinking)
        } else if (ev.type === 'content_block_stop') {
          const id = this.blockItems.get(`${this.currentMessageId}:${ev.index}`)
          if (id) {
            const started = this.thinkingStart.get(id)
            sink.patch(id, started ? ({ streaming: false, durationMs: Date.now() - started } as any) : ({ streaming: false } as any))
          }
        }
        break
      }
      case 'assistant': {
        const parentId = m.parent_tool_use_id ?? undefined
        const message = m.message
        const streamed = !parentId && this.streamedMessages.has(message.id)
        if (message.usage && !parentId) {
          const u = message.usage
          this.lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
          sink.setUsage({ contextTokens: this.lastContext, contextWindow: this.contextWindow })
        }
        for (const block of message.content ?? []) {
          if (block.type === 'tool_use') {
            const info = classifyClaudeTool(block.name, block.input, this.init.cwd)
            if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
              sink.setPlan(block.input.todos.map((t: any) => ({ text: t.content ?? t.activeForm ?? '', status: t.status ?? 'pending' })))
            }
            sink.upsert({
              kind: 'tool',
              id: block.id,
              ts: Date.now(),
              parentId,
              tool: block.name,
              toolKind: info.kind,
              title: info.title,
              detail: info.detail,
              diff: info.diff,
              file: info.file,
              input: block.input,
              status: 'running'
            })
          } else if (!streamed && block.type === 'text' && block.text?.trim()) {
            sink.upsert({ kind: 'assistant', id: uid('as'), ts: Date.now(), parentId, text: block.text, agent: 'claude', model: this.currentModel })
          } else if (!streamed && block.type === 'thinking' && block.thinking?.trim()) {
            sink.upsert({ kind: 'reasoning', id: uid('th'), ts: Date.now(), parentId, text: block.thinking })
          }
        }
        break
      }
      case 'user': {
        const content = m.message?.content
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block?.type !== 'tool_result') continue
          if (!sink.has(block.tool_use_id)) continue
          sink.patch(block.tool_use_id, {
            status: block.is_error ? 'error' : 'done',
            output: truncate(toolResultText(block.content), 30000)
          } as any)
        }
        break
      }
      case 'result': {
        const usage = m.usage ?? {}
        const modelUsage = m.modelUsage ? (Object.values(m.modelUsage)[0] as any) : undefined
        if (modelUsage?.contextWindow) this.contextWindow = modelUsage.contextWindow
        sink.setUsage({
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cachedTokens: usage.cache_read_input_tokens ?? 0,
          costUsd: m.total_cost_usd,
          contextTokens: this.lastContext || undefined,
          contextWindow: this.contextWindow
        })
        this.turnActive = false
        const isError = m.subtype !== 'success' || m.is_error
        sink.turnDone(isError ? { error: m.errors?.join?.('\n') || (typeof m.result === 'string' ? m.result : 'Claude reported an error') } : undefined)
        break
      }
      default:
        break
    }
  }

  async send(input: TurnInput): Promise<void> {
    const needsRestart =
      this.q && (input.effort !== this.currentEffort || (this.currentModel === 'default') !== (input.model === 'default'))
    if (needsRestart) this.closeQuery()
    if (!this.q) this.start(input)
    else {
      if (input.model !== this.currentModel) {
        await this.q.setModel(input.model === 'default' ? undefined : input.model).catch(() => {})
        this.currentModel = input.model
      }
      if (input.permissionMode !== this.currentMode) {
        await this.q.setPermissionMode(PERMISSION_MAP[input.permissionMode]).catch(() => {})
        this.currentMode = input.permissionMode
      }
    }
    const content: any[] = []
    for (const img of input.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })
    }
    content.push({ type: 'text', text: input.text })
    this.turnActive = true
    this.input!.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      origin: { kind: 'human' }
    } as SDKUserMessage)
  }

  async steer(text: string): Promise<boolean> {
    if (!this.input) return false
    this.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      priority: 'next',
      origin: { kind: 'human' }
    } as SDKUserMessage)
    return true
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => {})
  }

  async compact(): Promise<void> {
    if (!this.q) {
      this.start({ text: '', model: this.currentModel ?? this.init.model, effort: this.init.effort, permissionMode: this.currentMode })
    }
    this.turnActive = true
    this.input!.push({ type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null } as SDKUserMessage)
  }

  private closeQuery(): void {
    this.input?.close()
    try {
      this.q?.close?.()
    } catch {
      /* ignore */
    }
    this.q = null
    this.input = null
  }

  dispose(): void {
    this.closeQuery()
  }
}

let modelCache: ModelOption[] | null = null

export const claudeAdapter: AgentAdapter = {
  id: 'claude',

  async detect(settings: Settings): Promise<AgentStatus> {
    const path = which('claude')
    const status: AgentStatus = { id: 'claude', installed: !!path, path, authenticated: null, linked: settings.linkedAgents.includes('claude') }
    if (!path) return status
    const v = await run(path, ['--version'], { timeoutMs: 15000 })
    status.version = v.stdout.trim().split(/\s/)[0]
    const auth = await run(path, ['auth', 'status'], { timeoutMs: 15000 })
    if (auth.code === 0 && auth.stdout.trim()) {
      const out = auth.stdout.trim()
      try {
        const j = JSON.parse(out)
        status.authenticated = !!(j.loggedIn ?? j.authenticated ?? j.logged_in)
        status.authDetail = j.email ?? j.account?.email ?? j.authMethod ?? undefined
      } catch {
        status.authenticated = !/not (logged|signed) in|unauthenticated/i.test(out)
        status.authDetail = out.split('\n')[0]
      }
    } else if (process.env.ANTHROPIC_API_KEY) {
      status.authenticated = true
      status.authDetail = 'ANTHROPIC_API_KEY'
    } else {
      const keychain = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeoutMs: 5000 })
      status.authenticated = keychain.code === 0 || existsSync(join(homedir(), '.claude/.credentials.json'))
    }
    return status
  },

  async listModels(): Promise<ModelOption[]> {
    if (modelCache) return modelCache
    const exe = claudeExecutable()
    if (!exe) return FALLBACK_MODELS
    // Ask Claude Code itself which models this account can use.
    const input = new InputQueue()
    const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: exe, settingSources: ['user'], cwd: homedir() } })
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
      ])
      modelCache = models.map((m: any) => ({
        id: m.value,
        label: m.displayName || m.value,
        agent: 'claude' as const,
        provider: 'anthropic',
        description: m.description,
        efforts: m.supportedEffortLevels ?? (m.supportsEffort ? CLAUDE_EFFORTS : undefined)
      }))
      if (!modelCache.length) modelCache = FALLBACK_MODELS
    } catch {
      return FALLBACK_MODELS
    } finally {
      input.close()
      try {
        q.close?.()
      } catch {
        /* ignore */
      }
    }
    return modelCache
  },

  async planUsage(): Promise<PlanUsage | null> {
    const exe = claudeExecutable()
    if (!exe) return null
    // The same data Claude Code's /usage shows (experimental in the SDK, so read defensively).
    const input = new InputQueue()
    const q: any = query({ prompt: input, options: { pathToClaudeCodeExecutable: exe, settingSources: ['user'], cwd: homedir() } })
    try {
      const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof read !== 'function') return null
      const res: any = await Promise.race([read.call(q, { skipBehaviors: true }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))])
      const rl = res?.rate_limits
      if (!res?.rate_limits_available || !rl) return null
      const windows: UsageWindow[] = []
      const add = (id: string, label: string, w: any): void => {
        if (w && typeof w.utilization === 'number') windows.push({ id, label, usedPercent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined })
      }
      add('five_hour', 'Current session', rl.five_hour)
      add('seven_day', 'Current week (all models)', rl.seven_day)
      if (Array.isArray(rl.model_scoped)) for (const m of rl.model_scoped) add(`model:${m.display_name}`, `Current week (${m.display_name})`, m)
      else {
        add('seven_day_opus', 'Current week (Opus)', rl.seven_day_opus)
        add('seven_day_sonnet', 'Current week (Sonnet)', rl.seven_day_sonnet)
      }
      if (!windows.length) return null
      const plan = typeof res.subscription_type === 'string' ? res.subscription_type.charAt(0).toUpperCase() + res.subscription_type.slice(1) : undefined
      return { agent: 'claude', plan, windows, fetchedAt: Date.now() }
    } catch {
      return null
    } finally {
      input.close()
      try {
        q.close?.()
      } catch {
        /* ignore */
      }
    }
  },

  createSession(init: SessionInit): AgentSession {
    return new ClaudeSession(init)
  }
}
