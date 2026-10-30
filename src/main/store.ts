import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Project, type Settings, type Thread } from '@shared/types'

// Plain JSON files under ~/Library/Application Support/R-Code. No native modules,
// so the app builds and packages without any rebuild step.

const root = (): string => app.getPath('userData')
const threadsDir = (): string => join(root(), 'threads')

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

export function initStore(): void {
  mkdirSync(threadsDir(), { recursive: true })
}

let settingsCache: Settings | null = null

export function getSettings(): Settings {
  if (!settingsCache) {
    const saved = readJson<Partial<Settings>>(join(root(), 'settings.json'), {})
    // The default accent moved from indigo to blue; installs still on the old default follow it.
    if (saved.accent === '#5b6cff') delete saved.accent
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...saved,
      ollama: { ...DEFAULT_SETTINGS.ollama, ...(saved.ollama ?? {}) },
      defaultModels: { ...DEFAULT_SETTINGS.defaultModels, ...(saved.defaultModels ?? {}) }
    }
  }
  return settingsCache
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settingsCache = { ...getSettings(), ...patch }
  writeJsonAtomic(join(root(), 'settings.json'), settingsCache)
  return settingsCache
}

export function getProjects(): Project[] {
  return readJson<Project[]>(join(root(), 'projects.json'), []).filter((p) => existsSync(p.path))
}

export function saveProjects(projects: Project[]): void {
  writeJsonAtomic(join(root(), 'projects.json'), projects)
}

export function loadAllThreads(): Thread[] {
  const out: Thread[] = []
  for (const f of readdirSync(threadsDir())) {
    if (!f.endsWith('.json')) continue
    const t = readJson<Thread | null>(join(threadsDir(), f), null)
    if (t && t.id && Array.isArray(t.items)) {
      // Anything that was streaming when the app quit is no longer streaming.
      for (const item of t.items) {
        if ('streaming' in item && item.streaming) item.streaming = false
        if (item.kind === 'tool' && item.status === 'running') item.status = 'error'
        if (item.kind === 'approval' && item.status === 'pending') item.status = 'denied'
        if (item.kind === 'delegation' && item.status === 'running') item.status = 'error'
      }
      t.agentSessions ??= {}
      t.agentSeenUpTo ??= {}
      out.push(t)
    }
  }
  return out
}

const pendingWrites = new Map<string, NodeJS.Timeout>()

export function saveThread(thread: Thread, immediate = false): void {
  const write = (): void => {
    pendingWrites.delete(thread.id)
    try {
      writeJsonAtomic(join(threadsDir(), `${thread.id}.json`), thread)
    } catch (err) {
      console.error('saveThread failed', err)
    }
  }
  const existing = pendingWrites.get(thread.id)
  if (existing) clearTimeout(existing)
  if (immediate) write()
  else pendingWrites.set(thread.id, setTimeout(write, 400))
}

export function deleteThreadFile(id: string): void {
  const t = pendingWrites.get(id)
  if (t) clearTimeout(t)
  pendingWrites.delete(id)
  rmSync(join(threadsDir(), `${id}.json`), { force: true })
}

export function flushAll(threads: Iterable<Thread>): void {
  for (const t of threads) if (pendingWrites.has(t.id)) saveThread(t, true)
}

export function dataPath(...parts: string[]): string {
  return join(root(), ...parts)
}
