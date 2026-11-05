import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  query,
  type PermissionMode as ClaudePermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { parseSlashCommand, type AgentStatus, type ModelOption, type PermissionMode, type PlanStep, type PlanUsage, type Settings, type SlashCommand, type ToolKind, type UsageWindow } from '@shared/types'
import { run, which } from '../env'
import type { AgentAdapter, AgentSession, SessionInit, TurnInput } from './base'
import { STALE_SESSION_RE, commandCache, shortPath, truncate, uid, usageBus, withTimeout } from './base'
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

/**
 * The environment Claude Code runs with. Variables that mark a *parent* Claude Code session
 * (set when R-Code itself was started from a Claude Code terminal) make the CLI think it's a
 * nested child, and ELECTRON_RUN_AS_NODE would make every Electron app the agent launches
 * start as plain Node and exit. Same scrub list as T3 Code.
 */
const INHERITED_CLAUDE_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE'
]

export function claudeEnv(): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of INHERITED_CLAUDE_VARS) delete env[k]
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
  return env
}

/**
 * Whether Claude Code still has a transcript for a session id. A session whose transcript is
 * gone (cleaned up, or never got past metadata) can't be resumed: the CLI exits with "No
 * conversation found". Checked up front, like T3 Code, so the first message after that
 * doesn't fail. 'unknown' leaves the decision to the CLI.
 */
function claudeTranscriptState(id: string): 'present' | 'missing' | 'unknown' {
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(base)
  } catch {
    return 'unknown'
  }
  if (!dirs.length) return 'unknown'
  for (const d of dirs) {
    const file = join(base, d, `${id}.jsonl`)
    if (!existsSync(file)) continue
    try {
      return /"type"\s*:\s*"(?:user|assistant)"/.test(readFileSync(file, 'utf8')) ? 'present' : 'missing'
    } catch {
      return 'unknown'
    }
  }
  return 'missing'
}

/** Diagnostic lines Claude Code mixes into result errors; not for the user. */
const cleanErrors = (errors: unknown): string =>
  (Array.isArray(errors) ? errors : [])
    .map(String)
    .filter((e) => e.trim() && !e.startsWith('[ede_diagnostic]'))
    .join('\n')

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
    case 'TaskCreate':
      return { kind: 'todo', title: `Add task: ${input?.subject ?? ''}`.trim() }
    case 'TaskUpdate':
      return { kind: 'todo', title: input?.status === 'completed' ? `Complete task ${input?.taskId ?? ''}`.trim() : `Update task ${input?.taskId ?? ''}`.trim() }
    case 'TaskList':
    case 'TaskGet':
      return { kind: 'todo', title: 'Check tasks' }
    case 'ToolSearch':
      return { kind: 'search', title: 'Load tools', detail: input?.query }
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
  private mainModel: string | undefined
  // Messages sent to Claude that no reply has consumed yet. A message sent while a turn is
  // wrapping up isn't folded into that turn; Claude answers it in a turn of its own right
  // after, so the turn only counts as done once every message has been answered.
  private unanswered = new Set<string>()
  private tracksAnswers = false
  private settleTimer: NodeJS.Timeout | null = null
  private tasks = new Map<string, PlanStep & { id: string }>()
  /** The user pressed stop: whatever the CLI reports next ends the turn as interrupted. */
  private interrupting = false
  /** Last few KB of the CLI's stderr, to explain a crash. */
  private stderrTail = ''
  /** The last message sent and how, so a turn that hit a stale session can be replayed in a fresh one. */
  private lastTurn: { input: TurnInput; content: any[] } | null = null
  /** The saved session couldn't be resumed: the next message starts fresh and carries the whole chat. */
  private needsRecovery = false
  private recoveredOnce = false

  constructor(private init: SessionInit) {
    this.sessionId = init.resumeId
    this.currentMode = init.permissionMode
  }

  private start(input: TurnInput): void {
    const { init } = this
    if (this.sessionId && claudeTranscriptState(this.sessionId) === 'missing') this.dropSession()
    this.input = new InputQueue()
    this.stderrTail = ''
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
        // Only makes "Allow all" available; without it, switching a running chat to it fails.
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: init.instructions },
        pathToClaudeCodeExecutable: claudeExecutable(),
        disallowedTools: ['AskUserQuestion'],
        mcpServers,
        // Headless Claude Code leaves out the task list tools the interactive CLI has (turned on
        // in claudeEnv), and inherited parent-session variables are scrubbed.
        env: claudeEnv(),
        stderr: (data) => {
          this.stderrTail = (this.stderrTail + data).slice(-4000)
          console.error('[claude]', data.trim())
        },
        canUseTool: async (toolName, toolInput, opts) => {
          const toolUseID = (opts as any).toolUseID as string | undefined
          if (toolName.startsWith('mcp__rcode__')) return { behavior: 'allow', updatedInput: toolInput, toolUseID }
          // Nothing is waiting on an answer (the turn ended or was stopped): don't open a card.
          if (!this.turnActive || this.interrupting) return { behavior: 'deny', message: 'The turn was stopped.', toolUseID }
          const info = classifyClaudeTool(toolName, toolInput, init.cwd)
          const decision = await sink.requestApproval({
            title: toolName === 'ExitPlanMode' ? 'Claude finished planning. Start implementing?' : info.title,
            detail: info.detail ?? info.diff,
            // Claude Code aborts this when the turn is interrupted or the request is superseded.
            signal: opts.signal
          })
          if (opts.signal?.aborted) return { behavior: 'deny', message: 'The request was withdrawn.', interrupt: true, toolUseID }
          if (decision === 'deny') return { behavior: 'deny', message: 'The user declined this action.', toolUseID }
          if (toolName === 'ExitPlanMode') {
            this.currentMode = 'acceptEdits'
            this.q?.setPermissionMode('acceptEdits').catch(() => {})
          }
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID,
            // "Always allow in this chat" must stay in this session: Claude Code's suggestions
            // usually target the user's or project's settings files, which would make it permanent.
            updatedPermissions: decision === 'approveSession' ? sessionRules(toolName, opts.suggestions) : undefined
          }
        }
      }
    })

    void this.consume(this.q)
  }

  private async consume(q: Query): Promise<void> {
    let failure: string | undefined
    try {
      for await (const msg of q) {
        if (this.q !== q) break // replaced by a newer query: nothing from this one counts any more
        try {
          this.handle(msg)
        } catch (err) {
          // One malformed message must not end the whole session.
          console.error('[claude] could not handle message', (msg as any)?.type, err)
        }
      }
    } catch (err: any) {
      failure = err?.message ?? String(err)
    } finally {
      if (this.q === q) {
        this.q = null
        this.input = null
        if (this.turnActive) {
          // The CLI went away mid-turn (crash, killed, or it refused to start).
          const why = `${failure ?? ''}\n${this.stderrTail}`
          if (!this.interrupting && STALE_SESSION_RE.test(why) && this.recoverStaleSession()) return
          const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n')
          this.finishTurn(
            this.interrupting ? undefined : `Claude Code stopped unexpectedly${failure ? `: ${failure}` : '.'}${tail && !failure?.includes(tail) ? `\n${tail}` : ''}`
          )
        }
      }
    }
  }

  /** Forget a session that can't be resumed; the next message starts fresh with the whole chat. */
  private dropSession(): void {
    if (!this.sessionId) return
    console.error('[claude] session', this.sessionId, 'cannot be resumed; starting a new one')
    this.sessionId = undefined
    this.needsRecovery = true
    this.init.sink.setSessionId('')
  }

  /** The turn failed because its session is gone: replay it once in a fresh session. */
  private recoverStaleSession(): boolean {
    const last = this.lastTurn
    if (!last || this.recoveredOnce || !this.sessionId) return false
    this.recoveredOnce = true
    this.closeQuery()
    this.dropSession()
    this.init.sink.notice('Claude Code could not resume its earlier session for this chat, so it started a new one with the conversation so far.', 'warn')
    this.turnActive = false
    void this.send(last.input).catch((err) => this.finishTurn(err?.message ?? String(err)))
    return true
  }

  private handle(msg: SDKMessage): void {
    const sink = this.init.sink
    const m = msg as any
    const answering: string[] = m.parent_tool_use_id ? [] : (m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []))
    if (answering.length) {
      this.tracksAnswers = true
      for (const id of answering) this.unanswered.delete(id)
    }
    // A reply is coming in, so a turn we were about to close is still going.
    if (msg.type !== 'result' && (answering.length || ((msg.type === 'assistant' || msg.type === 'stream_event') && !m.parent_tool_use_id))) this.clearSettle()
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
        } else if (m.subtype === 'local_command_output' && typeof m.content === 'string' && m.content.trim()) {
          // What a slash command like /context or /usage printed: shown as Claude's reply.
          sink.upsert({ kind: 'assistant', id: uid('as'), ts: Date.now(), text: m.content, agent: 'claude', model: this.currentModel })
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
        if (!parentId && message.model && message.model !== '<synthetic>') this.mainModel = message.model
        if (message.usage && !parentId) {
          const u = message.usage
          this.lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
          sink.setUsage({ contextTokens: this.lastContext, contextWindow: this.contextWindow })
        }
        for (const block of message.content ?? []) {
          if (block.type === 'tool_use') {
            const info = classifyClaudeTool(block.name, block.input, this.init.cwd)
            if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
              sink.setPlan(block.input.todos.map((t: any) => ({ text: t.content ?? t.activeForm ?? '', active: t.activeForm, status: t.status ?? 'pending' })))
            } else if (block.name === 'TaskCreate') this.taskInputs.set(block.id, block.input)
            else if (block.name === 'TaskUpdate') this.updateTask(block.input)
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
          this.taskCreated(block.tool_use_id, m.tool_use_result, toolResultText(block.content), block.is_error)
          sink.patch(block.tool_use_id, {
            status: block.is_error ? 'error' : 'done',
            output: truncate(toolResultText(block.content), 30000)
          } as any)
        }
        break
      }
      case 'result': {
        const usage = m.usage ?? {}
        // modelUsage also lists small helper models Claude Code calls on the side; use the main one.
        const entries = Object.entries(m.modelUsage ?? {}) as [string, any][]
        const modelUsage = (entries.find(([id]) => this.mainModel && (id === this.mainModel || id.startsWith(this.mainModel) || this.mainModel.startsWith(id))) ??
          entries.sort((a, b) => (b[1]?.contextWindow ?? 0) - (a[1]?.contextWindow ?? 0))[0])?.[1]
        if (modelUsage?.contextWindow) this.contextWindow = modelUsage.contextWindow
        sink.setUsage({
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cachedTokens: usage.cache_read_input_tokens ?? 0,
          costUsd: m.total_cost_usd,
          contextTokens: this.lastContext || undefined,
          contextWindow: this.contextWindow
        })
        const aborted = /^aborted/.test(String(m.terminal_reason ?? '')) || this.interrupting
        const isError = m.subtype !== 'success' || m.is_error || m.api_error_status === 429 || m.api_error_status === 529
        let error = isError && !aborted ? cleanErrors(m.errors) || (typeof m.result === 'string' && m.result.trim() ? m.result : 'Claude reported an error') : undefined
        if (error && STALE_SESSION_RE.test(error) && this.recoverStaleSession()) break
        if (error && /interrupt/i.test(error) && m.subtype !== 'success') error = undefined
        // (CLIs too old to say which messages a reply answered: assume a steer is still pending.)
        if (this.unanswered.size <= (this.tracksAnswers ? 0 : 1)) this.finishTurn(error)
        else {
          // Something the user sent mid-turn still needs its own reply: stay busy until it
          // starts (it follows immediately), and give up if it doesn't.
          this.clearSettle()
          this.settleTimer = setTimeout(() => this.finishTurn(error), this.tracksAnswers ? 8000 : 2500)
        }
        break
      }
      default:
        break
    }
  }

  // Claude Code's task list (TaskCreate / TaskUpdate), shown as the chat's plan checklist.
  private taskInputs = new Map<string, any>() // TaskCreate tool_use id -> its input

  private showTasks(): void {
    this.init.sink.setPlan([...this.tasks.values()].map(({ id: _id, ...step }) => step))
  }

  private taskCreated(toolUseId: string, structured: any, text: string, isError?: boolean): void {
    const input = this.taskInputs.get(toolUseId)
    if (!input) return
    this.taskInputs.delete(toolUseId)
    if (isError) return
    const id = String(structured?.task?.id ?? text.match(/#(\w+)/)?.[1] ?? this.tasks.size + 1)
    this.tasks.set(id, { id, text: input.subject ?? input.description ?? 'Task', active: input.activeForm, status: 'pending' })
    this.showTasks()
  }

  private updateTask(input: any): void {
    const id = String(input?.taskId ?? '')
    const task = this.tasks.get(id)
    if (!task) return
    if (input.status === 'deleted') this.tasks.delete(id)
    else {
      if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') task.status = input.status
      if (input.subject) task.text = input.subject
      if (input.activeForm) task.active = input.activeForm
    }
    this.showTasks()
  }

  private finishTurn(error?: string): void {
    this.clearSettle()
    this.unanswered.clear()
    if (!this.turnActive) return
    this.turnActive = false
    const interrupted = this.interrupting
    this.interrupting = false
    // Per-turn bookkeeping; message ids never repeat, so there's nothing to carry over.
    this.streamedMessages.clear()
    this.blockItems.clear()
    this.thinkingStart.clear()
    this.init.sink.turnDone(interrupted ? { interrupted: true } : error ? { error } : undefined)
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
  }

  /** Feed a user message to Claude, remembering it until a reply consumes it. */
  private push(content: SDKUserMessage['message']['content'], priority?: 'next'): void {
    const uuid = randomUUID()
    this.unanswered.add(uuid)
    this.input!.push({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
      origin: { kind: 'human' }
    } as SDKUserMessage)
  }

  async send(input: TurnInput): Promise<void> {
    if (input.model !== this.currentModel) this.contextWindow = undefined
    const needsRestart =
      this.q && (input.effort !== this.currentEffort || (this.currentModel === 'default') !== (input.model === 'default'))
    if (needsRestart) this.closeQuery()
    if (!this.q) this.start(input)
    else {
      if (input.model !== this.currentModel) {
        const ok = await withTimeout(
          this.q.setModel(input.model === 'default' ? undefined : input.model).then(() => true),
          10000,
          false
        )
        // A model the running CLI won't switch to takes effect by resuming the session with it.
        if (ok) this.currentModel = input.model
        else this.closeQuery()
      }
      if (this.q && input.permissionMode !== this.currentMode) {
        const ok = await withTimeout(
          this.q.setPermissionMode(PERMISSION_MAP[input.permissionMode]).then(
            () => true,
            (err) => (console.error('[claude] setPermissionMode', err?.message ?? err), false)
          ),
          10000,
          false
        )
        // A mode the running CLI refuses takes effect by resuming the session in it.
        if (ok) this.currentMode = input.permissionMode
        else this.closeQuery()
      }
    }
    if (!this.q) this.start(input)
    const content: any[] = []
    for (const img of input.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })
    }
    // A fresh session (the old one couldn't be resumed) gets the whole conversation so far.
    const text = this.needsRecovery && input.recoveryContext ? input.recoveryContext() : input.text
    this.needsRecovery = false
    content.push({ type: 'text', text })
    // Claude Code only runs a slash command sent as plain text, not wrapped in content blocks.
    const message = content.length === 1 && parseSlashCommand(text) ? text : content
    this.lastTurn = { input, content }
    this.clearSettle()
    this.interrupting = false
    this.turnActive = true
    this.push(message as any)
  }

  async steer(text: string): Promise<boolean> {
    if (!this.input || !this.turnActive) return false
    this.clearSettle()
    this.push([{ type: 'text', text }], 'next')
    return true
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive) return
    this.interrupting = true
    this.clearSettle()
    const q = this.q
    if (!q) return this.finishTurn()
    const ok = await withTimeout(q.interrupt().then(() => true), 8000, false)
    // A CLI that won't acknowledge the interrupt is wedged: close it (the next message resumes
    // the session in a new process) and end the turn here.
    if (!ok && this.q === q) {
      this.closeQuery()
      this.finishTurn()
    }
  }

  async compact(): Promise<void> {
    if (!this.q) {
      this.start({ text: '', model: this.currentModel ?? this.init.model, effort: this.init.effort, permissionMode: this.currentMode })
    }
    this.interrupting = false
    this.turnActive = true
    this.input!.push({ type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null } as SDKUserMessage)
  }

  private closeQuery(): void {
    this.clearSettle()
    this.unanswered.clear()
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

/**
 * Rules for "Always allow in this chat": Claude Code's own suggestions, re-targeted at this
 * session only (they usually name a settings file), or a rule allowing the tool if it has none.
 */
function sessionRules(toolName: string, suggestions: any[] | undefined): any[] {
  const rules = (suggestions ?? []).filter((s) => s && typeof s === 'object').map((s) => ({ ...s, destination: 'session' }))
  return rules.length ? rules : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
}

let modelCache: ModelOption[] | null = null
const claudeCommands = commandCache()

/** Claude Code's own commands that need its interactive UI; sent headless they do nothing useful. */
const CLAUDE_INTERACTIVE_ONLY = new Set(['clear', 'heapdump', 'workflow-launch-exec', 'auto-mode-setup', 'config', 'login', 'logout', 'exit', 'quit', 'vim', 'theme', 'terminal-setup', 'ide', 'doctor', 'resume', 'rewind', 'permissions', 'hooks', 'agents', 'mcp', 'plugin', 'plugins', 'model', 'status', 'statusline', 'output-style', 'bashes', 'tasks', 'add-dir', 'export', 'upgrade', 'feedback', 'bug', 'help', 'memory', 'privacy-settings', 'remote-env', 'install-github-app', 'install-slack-app', 'migrate-installer', 'release-notes', 'chrome', 'fast', 'sandbox'])

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
    const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: exe, settingSources: ['user'], cwd: homedir(), env: claudeEnv() } })
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
    const q: any = query({ prompt: input, options: { pathToClaudeCodeExecutable: exe, settingSources: ['user'], cwd: homedir(), env: claudeEnv() } })
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

  listCommands(_settings, cwd): Promise<SlashCommand[]> {
    return claudeCommands(cwd, async () => {
      const exe = claudeExecutable()
      if (!exe) return []
      // Ask Claude Code itself, in the chat's folder, so project commands, skills and plugins show up.
      const input = new InputQueue()
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: exe, settingSources: ['user', 'project', 'local'], cwd, env: claudeEnv(), persistSession: false, settings: { disableAllHooks: true } as any }
      })
      try {
        const list = await Promise.race([q.supportedCommands(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))])
        const seen = new Set<string>()
        const out: SlashCommand[] = []
        for (const c of list) {
          const name = String(c.name ?? '').replace(/^\//, '')
          // (/clear would reset Claude's session behind R-Code's back; start a new chat instead.)
          if (!name || name.startsWith('_') || seen.has(name) || (c.builtin && CLAUDE_INTERACTIVE_ONLY.has(name))) continue
          seen.add(name)
          out.push({ name, description: c.description || undefined, argumentHint: c.argumentHint || undefined, source: c.builtin ? 'built-in' : undefined })
        }
        // Claude Code's own commands first, then skills, plugins and project commands.
        return [...out.filter((c) => c.source === 'built-in'), ...out.filter((c) => c.source !== 'built-in')]
      } finally {
        input.close()
        try {
          q.close?.()
        } catch {
          /* ignore */
        }
      }
    })
  },

  createSession(init: SessionInit): AgentSession {
    return new ClaudeSession(init)
  }
}
