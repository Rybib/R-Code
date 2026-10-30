import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import type { AgentId, InstallLogEvent } from '@shared/types'
import { run, runShellStreaming, which } from './env'
import { dataPath } from './store'
import { piCommand } from './agents/pi'

type Log = (ev: InstallLogEvent) => void

const PI_DIR = join(homedir(), '.pi', 'agent')

// ───────────── installing agents ─────────────

async function ensureNode(log: Log, agent: AgentId): Promise<boolean> {
  if (which('npm')) return true
  log({ agent, line: 'Node.js (npm) not found — installing it first…' })
  if (which('brew')) {
    const code = await runShellStreaming('brew install node', (line) => log({ agent, line }))
    if (code === 0 && which('npm')) return true
  }
  log({ agent, line: 'Could not install Node.js automatically. Install it from https://nodejs.org (LTS), then press Install again.' })
  void shell.openExternal('https://nodejs.org/en/download')
  return false
}

async function npmGlobalInstall(pkg: string, agent: AgentId, log: Log): Promise<boolean> {
  if (!(await ensureNode(log, agent))) return false
  let code = await runShellStreaming(`npm install -g ${pkg}`, (line) => log({ agent, line }))
  if (code !== 0) {
    // Typical cause: a root-owned global prefix. Switch to a user prefix and retry.
    log({ agent, line: 'Retrying with a user-level npm prefix (~/.npm-global)…' })
    await runShellStreaming('mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global', (line) => log({ agent, line }))
    code = await runShellStreaming(`npm install -g ${pkg}`, (line) => log({ agent, line }))
    if (code === 0) ensureShellPath('$HOME/.npm-global/bin')
  }
  return code === 0
}

/** Make sure future terminals also see a PATH entry we relied on. */
function ensureShellPath(entry: string): void {
  const rc = join(homedir(), '.zshrc')
  try {
    const cur = existsSync(rc) ? readFileSync(rc, 'utf8') : ''
    if (!cur.includes(entry)) writeFileSync(rc, cur + `\n# Added by R-Code\nexport PATH="${entry}:$PATH"\n`)
  } catch {
    /* non-fatal */
  }
}

export async function installAgent(agent: AgentId, log: Log): Promise<boolean> {
  let ok = false
  try {
    switch (agent) {
      case 'claude': {
        log({ agent, line: 'Installing Claude Code with the official native installer…' })
        const code = await runShellStreaming('curl -fsSL https://claude.ai/install.sh | bash', (line) => log({ agent, line }))
        ok = code === 0
        if (!ok) {
          log({ agent, line: 'Native installer failed; trying npm…' })
          ok = await npmGlobalInstall('@anthropic-ai/claude-code', agent, log)
        }
        ensureShellPath('$HOME/.local/bin')
        break
      }
      case 'codex': {
        log({ agent, line: 'Installing OpenAI Codex CLI…' })
        if (which('npm')) ok = await npmGlobalInstall('@openai/codex', agent, log)
        if (!ok && which('brew')) ok = (await runShellStreaming('brew install --cask codex', (line) => log({ agent, line }))) === 0
        if (!ok && !which('npm')) ok = await npmGlobalInstall('@openai/codex', agent, log)
        break
      }
      case 'pi': {
        // Pi is built into R-Code; nothing to install.
        mkdirSync(PI_DIR, { recursive: true })
        log({ agent, line: 'Pi is built into R-Code — nothing to install.' })
        ok = true
        break
      }
    }
  } catch (err) {
    log({ agent, line: String(err) })
    ok = false
  }
  log({ agent, line: ok ? 'Installed ✓' : 'Installation failed', done: true, ok })
  return ok
}

/** Open a Terminal window running a login command (sign-in flows need a real TTY/browser). */
export async function openLoginTerminal(agent: AgentId): Promise<void> {
  const cmds: Record<AgentId, string> = {
    claude: 'claude auth login',
    codex: 'codex login',
    pi: (() => {
      const c = piCommand()
      const env = Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(' ')
      const cmd = [c.command, ...c.args].map((a) => `"${a}"`).join(' ')
      return `echo "This is R-Code's built-in Pi agent. Type /login and pick a provider (Claude Pro/Max, ChatGPT, Copilot, or an API key), then return to R-Code."; ${env} ${cmd}`
    })()
  }
  const file = dataPath(`login-${agent}.command`)
  writeFileSync(
    file,
    `#!/bin/zsh -l\nclear\necho "R-Code · signing in to ${agent}"\necho\n${cmds[agent]}\necho\necho "Done. You can close this window and press Re-check in R-Code."\n`
  )
  chmodSync(file, 0o755)
  await shell.openPath(file)
}

// ───────────── Pi configuration ─────────────

export interface PiProviderKey {
  provider: string
  hasKey: boolean
}

const PI_KEY_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'cerebras', 'together', 'fireworks', 'huggingface']

export function getPiKeys(): PiProviderKey[] {
  let auth: Record<string, any> = {}
  try {
    auth = JSON.parse(readFileSync(join(PI_DIR, 'auth.json'), 'utf8'))
  } catch {
    /* none yet */
  }
  const providers = new Set([...PI_KEY_PROVIDERS, ...Object.keys(auth)])
  return [...providers].map((p) => ({ provider: p, hasKey: !!auth[p] }))
}

export function setPiKey(provider: string, key: string | null): void {
  mkdirSync(PI_DIR, { recursive: true })
  const file = join(PI_DIR, 'auth.json')
  let auth: Record<string, any> = {}
  try {
    auth = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* new file */
  }
  if (key) auth[provider] = { type: 'api_key', key }
  else delete auth[provider]
  writeFileSync(file, JSON.stringify(auth, null, 2), { mode: 0o600 })
}

export function readPiModelsJson(): any {
  try {
    return JSON.parse(readFileSync(join(PI_DIR, 'models.json'), 'utf8'))
  } catch {
    return { providers: {} }
  }
}

export function writePiModelsJson(data: any): void {
  mkdirSync(PI_DIR, { recursive: true })
  const file = join(PI_DIR, 'models.json')
  if (existsSync(file)) writeFileSync(file + '.rcode-backup', readFileSync(file))
  writeFileSync(file, JSON.stringify(data, null, 2))
}

// ───────────── Ollama ─────────────

export interface OllamaModel {
  name: string
  size: number
  family?: string
  parameterSize?: string
  contextLength?: number
  capabilities?: string[]
}

export interface OllamaStatus {
  installed: boolean
  running: boolean
  version?: string
  models: OllamaModel[]
}

export async function ollamaStatus(baseUrl: string): Promise<OllamaStatus> {
  const installed = !!which('ollama') || existsSync('/Applications/Ollama.app')
  try {
    const [tags, ver] = await Promise.all([
      fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
      fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .catch(() => ({}))
    ])
    const models: OllamaModel[] = (tags.models ?? []).map((m: any) => ({
      name: m.name,
      size: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size
    }))
    return { installed: true, running: true, version: ver.version, models }
  } catch {
    return { installed, running: false, models: [] }
  }
}

async function ollamaShow(baseUrl: string, name: string): Promise<{ contextLength?: number; capabilities?: string[] }> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5000) })
    const j = await res.json()
    const info = j.model_info ?? {}
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'))
    return { contextLength: ctxKey ? info[ctxKey] : undefined, capabilities: j.capabilities }
  } catch {
    return {}
  }
}

export async function startOllama(log: Log): Promise<void> {
  if (existsSync('/Applications/Ollama.app')) {
    await run('/usr/bin/open', ['-a', 'Ollama'])
  } else if (which('ollama')) {
    runShellStreaming('nohup ollama serve >/dev/null 2>&1 &', (line) => log({ agent: 'ollama', line }))
  }
  log({ agent: 'ollama', line: 'Starting Ollama…', done: true, ok: true })
}

export async function installOllama(log: Log): Promise<boolean> {
  if (which('brew')) {
    log({ agent: 'ollama', line: 'Installing Ollama with Homebrew…' })
    const code = await runShellStreaming('brew install --cask ollama-app || brew install ollama', (line) => log({ agent: 'ollama', line }))
    const ok = code === 0
    log({ agent: 'ollama', line: ok ? 'Installed ✓' : 'Install failed', done: true, ok })
    return ok
  }
  void shell.openExternal('https://ollama.com/download')
  log({ agent: 'ollama', line: 'Opened ollama.com/download — install it, then press Re-check.', done: true, ok: false })
  return false
}

export async function pullOllamaModel(baseUrl: string, name: string, log: Log): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }) })
    if (!res.body) throw new Error('no response body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let lastPct = -1
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const j = JSON.parse(line)
        if (j.error) throw new Error(j.error)
        if (j.total && j.completed) {
          const pct = Math.floor((j.completed / j.total) * 100)
          if (pct !== lastPct) {
            lastPct = pct
            log({ agent: 'ollama', line: `${j.status} ${pct}%` })
          }
        } else if (j.status) log({ agent: 'ollama', line: j.status })
      }
    }
    log({ agent: 'ollama', line: `Pulled ${name} ✓`, done: true, ok: true })
    return true
  } catch (err: any) {
    log({ agent: 'ollama', line: `Pull failed: ${err?.message ?? err}`, done: true, ok: false })
    return false
  }
}

/**
 * Register the chosen Ollama models with Pi by merging an "ollama" provider into
 * ~/.pi/agent/models.json (other providers and per-model tweaks are preserved).
 */
export async function syncOllamaToPi(baseUrl: string, modelNames: string[]): Promise<number> {
  const data = readPiModelsJson()
  data.providers ??= {}
  const existing = data.providers.ollama ?? {}
  const byId = new Map<string, any>((existing.models ?? []).map((m: any) => [m.id, m]))
  const models: any[] = []
  for (const name of modelNames) {
    const info = await ollamaShow(baseUrl, name)
    const prev = byId.get(name) ?? {}
    models.push({
      ...prev,
      id: name,
      contextWindow: prev.contextWindow ?? Math.min(info.contextLength ?? 32768, 262144),
      input: prev.input ?? (info.capabilities?.includes('vision') ? ['text', 'image'] : ['text']),
      reasoning: prev.reasoning ?? !!info.capabilities?.includes('thinking')
    })
  }
  data.providers.ollama = {
    ...existing,
    api: existing.api ?? 'openai-completions',
    apiKey: existing.apiKey ?? 'ollama',
    baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
    models
  }
  if (!models.length) delete data.providers.ollama
  writePiModelsJson(data)
  return models.length
}

export function piOllamaModels(): string[] {
  const data = readPiModelsJson()
  return (data.providers?.ollama?.models ?? []).map((m: any) => m.id)
}
