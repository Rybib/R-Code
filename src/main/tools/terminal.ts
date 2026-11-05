import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IPty } from 'node-pty'
import type { AgentId, PermissionMode } from '@shared/types'
import type { ApprovalDecision } from '../agents/base'
import type { ToolDef, ToolResult } from './registry'
import { bool, num, str } from './registry'

// R-Code's terminal panel: real PTYs (node-pty, as in T3 Code) shown with xterm.js in the side
// panel. The user opens shells there; agents get their own tabs through the terminal_* tools,
// so long-running work (dev servers, watchers, builds) stays visible and stoppable.

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  /** 'shell': an interactive shell the user opened. 'agent': a command an agent started. */
  kind: 'shell' | 'agent'
  command?: string
  threadId?: string
  agent?: AgentId
  running: boolean
  exitCode?: number | null
  createdAt: number
}

interface Term {
  info: TerminalInfo
  pty: IPty
  /** Tail of everything the terminal printed, so a reopened panel can redraw it. */
  history: string
  /** Absolute offset (in string units) of the first character still in `history`. */
  historyStart: number
  /** Absolute offset just past the last character printed. */
  total: number
  exited: Promise<void>
}

type Notify = (channel: string, payload: unknown) => void

const HISTORY_LIMIT = 512 * 1024
const MAX_TERMINALS = 24

let ptyModule: typeof import('node-pty') | null = null
let ptyLoadError: string | null = null

/** Load node-pty lazily, making its spawn helper executable first (npm and packaging can drop the bit). */
function loadPty(): typeof import('node-pty') {
  if (ptyModule) return ptyModule
  if (ptyLoadError) throw new Error(ptyLoadError)
  const req = createRequire(import.meta.url)
  try {
    const pkgDir = dirname(req.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked')
    for (const helper of [
      join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(pkgDir, 'build', 'Release', 'spawn-helper')
    ]) {
      try {
        if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
      } catch (err) {
        console.error('[terminal] could not make spawn-helper executable', err)
      }
    }
    ptyModule = req('node-pty') as typeof import('node-pty')
    return ptyModule
  } catch (err: any) {
    ptyLoadError = `The terminal is unavailable: node-pty failed to load (${err?.message ?? err}).`
    throw new Error(ptyLoadError)
  }
}

/** Strip ANSI escapes and carriage-return redraws so agents read plain text. */
export function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[^\n]*\r(?!\n)/g, '') // a line redrawn with \r keeps only its last version
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Variables that only make sense for R-Code's own process.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k]
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'R-Code'
  env.LANG ||= 'en_US.UTF-8'
  return env
}

export class TerminalManager {
  private terms = new Map<string, Term>()
  private seq = 0
  private pending = new Map<string, { start: number; data: string }>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private notify: Notify) {}

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }))
  }

  get(id: string): TerminalInfo | undefined {
    const t = this.terms.get(id)
    return t && { ...t.info }
  }

  private broadcast(): void {
    this.notify('terminal-list', this.list())
  }

  create(opts: { cwd?: string; command?: string; title?: string; kind?: 'shell' | 'agent'; threadId?: string; agent?: AgentId; cols?: number; rows?: number }): TerminalInfo {
    const pty = loadPty()
    if (this.terms.size >= MAX_TERMINALS) {
      // Make room by forgetting the oldest finished terminal; refuse if everything is still running.
      const done = [...this.terms.values()].filter((t) => !t.info.running).sort((a, b) => a.info.createdAt - b.info.createdAt)[0]
      if (!done) throw new Error(`Too many terminals are open (${MAX_TERMINALS}). Close some first.`)
      this.terms.delete(done.info.id)
    }
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
    const kind = opts.kind ?? (opts.command ? 'agent' : 'shell')
    const args = opts.command ? ['-lc', opts.command] : ['-l']
    const id = `term${++this.seq}`
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cwd,
      env: shellEnv(),
      cols: Math.max(20, Math.floor(opts.cols ?? 100)),
      rows: Math.max(5, Math.floor(opts.rows ?? 30))
    })
    let resolveExit!: () => void
    const term: Term = {
      info: {
        id,
        title: opts.title || (opts.command ? opts.command.split('\n')[0].slice(0, 40) : shell.split('/').pop() || 'shell'),
        cwd,
        kind,
        command: opts.command,
        threadId: opts.threadId,
        agent: opts.agent,
        running: true,
        createdAt: Date.now()
      },
      pty: proc,
      history: '',
      historyStart: 0,
      total: 0,
      exited: new Promise<void>((r) => (resolveExit = r))
    }
    this.terms.set(id, term)
    proc.onData((data) => this.onData(term, data))
    proc.onExit(({ exitCode, signal }) => {
      term.info.running = false
      term.info.exitCode = signal ? null : exitCode
      const note = `\r\n\x1b[2m[${signal ? `stopped (signal ${signal})` : `exited with code ${exitCode}`}]\x1b[0m\r\n`
      this.onData(term, note)
      this.flush()
      resolveExit()
      this.notify('terminal-exit', { id, exitCode: term.info.exitCode })
      this.broadcast()
    })
    this.broadcast()
    return { ...term.info }
  }

  private onData(term: Term, data: string): void {
    const start = term.total
    term.total += data.length
    term.history += data
    if (term.history.length > HISTORY_LIMIT) {
      const cut = term.history.length - HISTORY_LIMIT
      term.history = term.history.slice(cut)
      term.historyStart += cut
    }
    // Coalesce output into ~60 IPC messages a second per terminal instead of one per chunk.
    const p = this.pending.get(term.info.id)
    if (p) p.data += data
    else this.pending.set(term.info.id, { start, data })
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 16)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const [id, p] of this.pending) this.notify('terminal-data', { id, start: p.start, data: p.data })
    this.pending.clear()
  }

  /** Everything still buffered, with its absolute end offset (to line up with live events). */
  history(id: string): { data: string; end: number } | null {
    const t = this.terms.get(id)
    if (!t) return null
    return { data: t.history, end: t.total }
  }

  /** Plain-text tail of a terminal's output for agents. */
  output(id: string, maxChars = 30000): string {
    const t = this.terms.get(id)
    if (!t) return ''
    const text = plainText(t.history)
    return text.length > maxChars ? `… (earlier output omitted)\n${text.slice(-maxChars)}` : text
  }

  write(id: string, data: string): boolean {
    const t = this.terms.get(id)
    if (!t || !t.info.running) return false
    try {
      t.pty.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    if (!t || !t.info.running || !(cols > 0) || !(rows > 0)) return
    try {
      t.pty.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
    } catch {
      /* the process just exited */
    }
  }

  /** Stop a terminal's process: SIGHUP like closing a terminal window, SIGKILL if it ignores that. */
  kill(id: string): Promise<void> {
    const t = this.terms.get(id)
    if (!t || !t.info.running) return Promise.resolve()
    try {
      t.pty.kill('SIGHUP')
    } catch {
      /* gone */
    }
    const timer = setTimeout(() => {
      if (!t.info.running) return
      try {
        process.kill(t.pty.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, 2000)
    return t.exited.finally(() => clearTimeout(timer))
  }

  /** Close a tab: stop its process and forget it. */
  close(id: string): void {
    void this.kill(id)
    this.terms.delete(id)
    this.pending.delete(id)
    this.broadcast()
  }

  /** Wait until the terminal's process exits or `ms` passes; true if it exited. */
  async waitForExit(id: string, ms: number): Promise<boolean> {
    const t = this.terms.get(id)
    if (!t) return true
    if (!t.info.running) return true
    let timer: NodeJS.Timeout | undefined
    const exited = await Promise.race([t.exited.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))])
    if (timer) clearTimeout(timer)
    return exited
  }

  disposeAll(): void {
    for (const t of this.terms.values()) {
      if (!t.info.running) continue
      try {
        t.pty.kill('SIGHUP')
      } catch {
        /* gone */
      }
    }
  }
}

export interface TerminalToolDeps {
  cwdFor: (threadId: string) => string
  ask: (threadId: string, agent: AgentId, req: { title: string; detail?: string; key?: string }) => Promise<ApprovalDecision>
  modeFor: (threadId: string) => PermissionMode
}

export function terminalTools(tm: TerminalManager, notify: Notify, deps: TerminalToolDeps): ToolDef[] {
  const show = (id: string): void => {
    notify('panel-open', 'terminal')
    notify('terminal-focus', id)
  }
  const describe = (info: TerminalInfo): string =>
    `${info.id} — ${info.kind === 'agent' ? 'agent' : 'user shell'} — ${info.running ? 'running' : `exited (${info.exitCode ?? 'signal'})`} — ${info.command ?? info.title} — ${info.cwd}`
  // R-Code's own tools aren't covered by the agents' permission prompts, so commands follow the
  // chat's permission mode here: plan never runs, ask/accept-edits ask first, auto/allow-all run.
  const permit = async (ctx: { threadId: string; agent: AgentId }, title: string, detail: string, key: string): Promise<ToolResult | null> => {
    const mode = deps.modeFor(ctx.threadId)
    if (mode === 'plan') return { text: 'Plan mode: running commands is disabled. Describe the command in your plan instead.', isError: true }
    if (mode === 'auto' || mode === 'allowAll') return null
    const d = await deps.ask(ctx.threadId, ctx.agent, { title, detail, key })
    return d === 'deny' ? { text: 'The user declined this.', isError: true } : null
  }
  const report = (id: string, finished: boolean, maxChars: number): string => {
    const info = tm.get(id)
    const out = tm.output(id, maxChars).trim()
    const status = !info ? 'closed' : finished || !info.running ? `exited with code ${info.exitCode ?? '(killed)'}` : 'still running'
    return `Terminal ${id}: ${status}.\n\n${out || '(no output yet)'}`
  }
  return [
    {
      name: 'terminal_run',
      description:
        "Run a shell command in a new tab of R-Code's terminal panel, which the user can watch and stop. Waits until it exits or `wait_seconds` pass, then returns its output; a command still running (dev servers, watchers) keeps running in its tab — check it with terminal_read and stop it with terminal_kill. Use it for long-running or interactive work the user should see; for quick one-off commands your own shell tool is fine.",
      schema: {
        type: 'object',
        properties: {
          command: str('Shell command (runs in a login shell in the project folder)'),
          cwd: str('Optional working directory (defaults to the project folder)'),
          wait_seconds: num('How long to wait for it to finish before returning (default 30, max 600). Use ~5 for servers.'),
          title: str('Optional short tab title')
        },
        required: ['command']
      },
      async run(ctx, args) {
        const command = String(args.command ?? '').trim()
        if (!command) return { text: 'command is required.', isError: true }
        const denied = await permit(ctx, 'Run in terminal', command, `terminal_run\n${command}`)
        if (denied) return denied
        const cwd = args.cwd ? String(args.cwd).replace(/^~(?=$|\/)/, homedir()) : deps.cwdFor(ctx.threadId)
        const info = tm.create({ cwd, command, title: args.title, kind: 'agent', threadId: ctx.threadId, agent: ctx.agent })
        show(info.id)
        const wait = Math.min(Math.max(Number(args.wait_seconds) || 30, 1), 600)
        const finished = await tm.waitForExit(info.id, wait * 1000)
        return { text: report(info.id, finished, 30000), isError: finished && (tm.get(info.id)?.exitCode ?? 0) !== 0 }
      }
    },
    {
      name: 'terminal_read',
      description: "Read recent output (plain text) of a terminal in R-Code's terminal panel, including the user's own shells. Use terminal_list to find ids.",
      schema: { type: 'object', properties: { id: str('Terminal id like term3'), max_chars: num('Most characters to return (default 20000)') }, required: ['id'] },
      async run(_ctx, args) {
        const id = String(args.id ?? '')
        if (!tm.get(id)) return { text: `No terminal ${id}. Call terminal_list.`, isError: true }
        return { text: report(id, false, Math.min(Number(args.max_chars) || 20000, 100000)) }
      }
    },
    {
      name: 'terminal_write',
      description:
        'Send input to a running terminal: answer a prompt, type into a REPL, or send keys. Text is sent as-is; set enter to press Return after it. Send "\\u0003" for Ctrl-C. Returns the output that follows.',
      schema: {
        type: 'object',
        properties: { id: str('Terminal id'), text: str('Text or control characters to send'), enter: bool('Press Return afterwards'), wait_seconds: num('How long to collect output afterwards (default 2)') },
        required: ['id', 'text']
      },
      async run(ctx, args) {
        const id = String(args.id ?? '')
        const info = tm.get(id)
        if (!info) return { text: `No terminal ${id}. Call terminal_list.`, isError: true }
        if (!info.running) return { text: `Terminal ${id} has exited.`, isError: true }
        const text = String(args.text ?? '') + (args.enter ? '\r' : '')
        // Typing into the user's own shell, or into another chat's command, always asks (unless allow-all).
        const foreign = info.kind === 'shell' || info.threadId !== ctx.threadId
        if (foreign && deps.modeFor(ctx.threadId) !== 'allowAll') {
          if (deps.modeFor(ctx.threadId) === 'plan') return { text: 'Plan mode: sending input to terminals is disabled.', isError: true }
          const d = await deps.ask(ctx.threadId, ctx.agent, { title: `Type into terminal ${info.title}`, detail: JSON.stringify(text), key: `terminal_write\n${id}` })
          if (d === 'deny') return { text: 'The user declined this.', isError: true }
        } else {
          const denied = await permit(ctx, `Type into terminal ${info.title}`, JSON.stringify(text), `terminal_write\n${id}`)
          if (denied) return denied
        }
        const before = tm.history(id)?.end ?? 0
        if (!tm.write(id, text)) return { text: `Could not write to ${id}.`, isError: true }
        show(id)
        await tm.waitForExit(id, Math.min(Math.max(Number(args.wait_seconds) || 2, 0.2), 60) * 1000)
        const h = tm.history(id)
        const fresh = h ? h.data.slice(Math.max(0, h.data.length - (h.end - before))) : ''
        return { text: `Sent. New output:\n${plainText(fresh).trim() || '(none yet)'}` }
      }
    },
    {
      name: 'terminal_kill',
      description: 'Stop the process running in a terminal tab (like closing it). Use it to stop dev servers you started.',
      schema: { type: 'object', properties: { id: str('Terminal id') }, required: ['id'] },
      async run(ctx, args) {
        const id = String(args.id ?? '')
        const info = tm.get(id)
        if (!info) return { text: `No terminal ${id}.`, isError: true }
        if (info.kind === 'shell' && deps.modeFor(ctx.threadId) !== 'allowAll') {
          const d = await deps.ask(ctx.threadId, ctx.agent, { title: `Stop terminal ${info.title}`, detail: info.cwd, key: `terminal_kill\n${id}` })
          if (d === 'deny') return { text: 'The user declined this.', isError: true }
        }
        await tm.kill(id)
        return { text: report(id, true, 4000) }
      }
    },
    {
      name: 'terminal_list',
      description: "List the terminals in R-Code's terminal panel (ids, status, command, folder).",
      schema: { type: 'object', properties: {} },
      async run() {
        const all = tm.list()
        return { text: all.length ? all.map(describe).join('\n') : 'No terminals are open.' }
      }
    }
  ]
}
