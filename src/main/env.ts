import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

// GUI apps on macOS launch with a minimal PATH, so the CLIs the user installed via
// Homebrew, npm or the native installers are invisible. Like T3 Code, we read the
// login shell's environment once at startup and merge it into process.env.

const EXTRA_PATHS = [
  join(homedir(), '.local/bin'),
  join(homedir(), '.claude/local'),
  join(homedir(), '.npm-global/bin'),
  join(homedir(), '.bun/bin'),
  join(homedir(), '.volta/bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

let loaded = false

export async function loadShellEnv(): Promise<void> {
  if (loaded) return
  loaded = true
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__RCODE_ENV__'
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        shell,
        ['-ilc', `echo ${marker}; env; echo ${marker}`],
        { timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
        (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))
      )
    })
    const body = out.split(marker)[1] ?? ''
    for (const line of body.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      if (key === 'PWD' || key === 'SHLVL' || key === '_' || key === 'OLDPWD') continue
      process.env[key] = line.slice(eq + 1)
    }
  } catch {
    // fall through to the static PATH additions below
  }
  ensurePathEntries()
}

export function ensurePathEntries(): void {
  const parts = (process.env.PATH || '').split(':').filter(Boolean)
  for (const p of EXTRA_PATHS) if (!parts.includes(p)) parts.push(p)
  process.env.PATH = parts.join(':')
}

/**
 * Binary for running Node scripts with ELECTRON_RUN_AS_NODE. On macOS a process started from
 * the app's main executable checks in as a foreground app, which puts a bouncing icon in the
 * Dock. The Helper executable is marked LSUIElement, so it runs invisibly (VS Code does the same).
 */
export function nodeBinary(): string {
  if (process.platform !== 'darwin') return process.execPath
  const exe = basename(process.execPath)
  const helper = join(process.execPath, '../../Frameworks', `${exe} Helper.app`, 'Contents/MacOS', `${exe} Helper`)
  return existsSync(helper) ? helper : process.execPath
}

export function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const p = join(dir, cmd)
    if (existsSync(p)) return p
  }
  return undefined
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run a command with the user's environment and collect its output. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { env: process.env, ...opts, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) })
      return
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM')
        }, opts.timeoutMs)
      : undefined
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    else child.stdin?.end()
  })
}

/** Run a shell snippet in a login shell, streaming each output line. */
export function runShellStreaming(script: string, onLine: (line: string) => void, cwd?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const child = spawn(shell, ['-lc', script], {
      env: { ...process.env, NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1', CI: '1' },
      cwd: cwd || homedir()
    })
    const pump = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLine(line)
    }
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    child.on('error', (err) => {
      onLine(String(err))
      resolve(-1)
    })
    child.on('close', (code) => resolve(code))
  })
}

/**
 * Splits a byte stream into JSON lines on "\n" only (Node's readline also splits on
 * U+2028/U+2029, which are legal inside JSON strings — Pi's RPC docs call this out).
 */
export function jsonLines(stream: NodeJS.ReadableStream, onMessage: (msg: any) => void, onBadLine?: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line.trim()) continue
      parse(line)
    }
  })
  // A final message without a trailing newline still counts.
  stream.on('end', () => {
    const rest = buffer.trim()
    buffer = ''
    if (rest) parse(rest)
  })
  function parse(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      onBadLine?.(line)
      return
    }
    try {
      onMessage(msg)
    } catch (err) {
      console.error('[jsonLines] message handler failed', err)
    }
  }
}
