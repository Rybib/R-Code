import { create } from 'zustand'
import type {
  AgentId,
  AgentStatus,
  ImageAttachment,
  ModelOption,
  PermissionMode,
  Project,
  Settings,
  ThreadEvent,
  ThreadSummary,
  TimelineItem
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from './lib/api'

export type SettingsPage = 'general' | 'agents' | 'models' | 'tools' | 'voice' | 'orchestration' | 'shortcuts' | 'archived' | 'about'

export interface Draft {
  projectPath?: string
  agent: AgentId
  model: string
  effort?: string
  permissionMode: PermissionMode
}

interface State {
  ready: boolean
  version: string
  home: string
  settings: Settings
  projects: Project[]
  threads: Record<string, ThreadSummary>
  items: Record<string, TimelineItem[]>
  agents: AgentStatus[]
  agentsLoading: boolean
  models: Partial<Record<AgentId, ModelOption[]>>
  installLogs: Record<string, string[]>
  installing: Record<string, boolean>

  view: 'chat' | 'settings'
  settingsPage: SettingsPage
  activeId: string | null
  tabs: string[]
  sidebarCollapsed: boolean
  searchOpen: boolean
  draft: Draft
  composerText: Record<string, string>
  composerImages: Record<string, ImageAttachment[]>
  /** Agent/model the user picked in an existing thread's composer (applied on next send). */
  threadSel: Record<string, Partial<Draft>>
  panel: 'browser' | 'simulator' | null
  panelWidth: number
  /** True while any popover is open (the native browser view would cover it). */
  popoverOpen: boolean

  init(): Promise<void>
  refreshAgents(): Promise<void>
  loadModels(agent: AgentId, refresh?: boolean): Promise<ModelOption[]>
  setSettings(patch: Partial<Settings>): Promise<void>
  applyEvent(ev: ThreadEvent): void
  openThread(id: string): Promise<void>
  closeTab(id: string): void
  newConversation(projectPath?: string): void
  setDraft(patch: Partial<Draft>): void
  sendMessage(text: string, images?: ImageAttachment[]): Promise<void>
  openSettings(page?: SettingsPage): void
  addProject(path?: string): Promise<Project | null>
  set(patch: Partial<State>): void
}

const TABS_KEY = 'rcode.tabs'

function loadTabs(): { tabs: string[]; active: string | null } {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY) || '') as { tabs: string[]; active: string | null }
  } catch {
    return { tabs: [], active: null }
  }
}

function saveTabs(tabs: string[], active: string | null): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active }))
  } catch {
    /* ignore */
  }
}

export function defaultModelFor(settings: Settings, agent: AgentId): string {
  return settings.defaultModels[agent] ?? 'default'
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  version: '',
  home: '',
  settings: DEFAULT_SETTINGS,
  projects: [],
  threads: {},
  items: {},
  agents: [],
  agentsLoading: false,
  models: {},
  installLogs: {},
  installing: {},
  view: 'chat',
  settingsPage: 'general',
  activeId: null,
  tabs: [],
  sidebarCollapsed: false,
  searchOpen: false,
  draft: { agent: 'claude', model: 'default', permissionMode: 'acceptEdits' },
  composerText: {},
  composerImages: {},
  threadSel: {},
  panel: null,
  panelWidth: 460,
  popoverOpen: false,

  set: (patch) => set(patch),

  async init() {
    const data = await api.init()
    const threads: Record<string, ThreadSummary> = {}
    for (const t of data.threads) threads[t.id] = t
    const saved = loadTabs()
    const tabs = saved.tabs.filter((id) => threads[id])
    const active = saved.active && threads[saved.active] ? saved.active : null
    const s = data.settings
    const agent = s.linkedAgents.includes(s.defaultAgent) ? s.defaultAgent : s.linkedAgents[0] ?? 'claude'
    set({
      ready: true,
      version: data.version,
      home: data.home,
      settings: s,
      projects: data.projects,
      threads,
      tabs,
      activeId: active,
      draft: {
        agent,
        model: defaultModelFor(s, agent),
        permissionMode: s.defaultPermissionMode,
        projectPath: data.projects[0]?.path
      }
    })
    if (active) void get().openThread(active)
    void get().refreshAgents()
  },

  async refreshAgents() {
    set({ agentsLoading: true })
    try {
      const agents = await api.detectAgents()
      set({ agents })
      for (const a of agents) if (a.installed && (a.linked || !get().settings.onboarded)) void get().loadModels(a.id)
    } finally {
      set({ agentsLoading: false })
    }
  },

  async loadModels(agent, refresh = false) {
    const models = await api.models(agent, refresh)
    set((s) => ({ models: { ...s.models, [agent]: models } }))
    return models
  },

  async setSettings(patch) {
    const settings = await api.updateSettings(patch)
    set({ settings })
  },

  applyEvent(ev) {
    switch (ev.type) {
      case 'thread':
        set((s) => ({ threads: { ...s.threads, [ev.threadId]: ev.summary } }))
        break
      case 'status':
        set((s) => {
          const t = s.threads[ev.threadId]
          return t ? { threads: { ...s.threads, [ev.threadId]: { ...t, running: ev.running } } } : {}
        })
        break
      case 'removed':
        set((s) => {
          const threads = { ...s.threads }
          delete threads[ev.threadId]
          const tabs = s.tabs.filter((t) => t !== ev.threadId)
          const activeId = s.activeId === ev.threadId ? tabs[tabs.length - 1] ?? null : s.activeId
          saveTabs(tabs, activeId)
          return { threads, tabs, activeId }
        })
        break
      case 'reset':
        set((s) => ({ items: { ...s.items, [ev.threadId]: ev.items } }))
        break
      case 'item':
        set((s) => {
          const list = s.items[ev.threadId]
          if (!list) return {}
          const idx = list.findIndex((i) => i.id === ev.item.id)
          const next = idx >= 0 ? list.map((i, k) => (k === idx ? ev.item : i)) : [...list, ev.item]
          return { items: { ...s.items, [ev.threadId]: next } }
        })
        break
      case 'delta':
        set((s) => {
          const list = s.items[ev.threadId]
          if (!list) return {}
          const idx = list.findIndex((i) => i.id === ev.itemId)
          if (idx < 0) return {}
          const cur = list[idx] as any
          const updated = { ...cur, [ev.field]: (cur[ev.field] ?? '') + ev.delta }
          const next = list.slice()
          next[idx] = updated
          return { items: { ...s.items, [ev.threadId]: next } }
        })
        break
    }
  },

  async openThread(id) {
    const s = get()
    const tabs = s.tabs.includes(id) ? s.tabs : [...s.tabs, id]
    set({ activeId: id, tabs, view: 'chat' })
    saveTabs(tabs, id)
    if (!s.items[id]) {
      const t = await api.getThread(id)
      if (t) set((st) => ({ items: { ...st.items, [id]: t.items } }))
    }
  },

  closeTab(id) {
    set((s) => {
      const i = s.tabs.indexOf(id)
      const tabs = s.tabs.filter((t) => t !== id)
      const activeId = s.activeId === id ? tabs[Math.min(i, tabs.length - 1)] ?? null : s.activeId
      saveTabs(tabs, activeId)
      return { tabs, activeId }
    })
  },

  newConversation(projectPath) {
    const s = get()
    set({
      activeId: null,
      view: 'chat',
      draft: { ...s.draft, projectPath: projectPath ?? s.draft.projectPath }
    })
    saveTabs(s.tabs, null)
  },

  setDraft(patch) {
    set((s) => ({ draft: { ...s.draft, ...patch } }))
  },

  async sendMessage(text, images) {
    const s = get()
    let id = s.activeId
    if (!id) {
      const d = s.draft
      const t = await api.createThread({
        agent: d.agent,
        model: d.model,
        effort: d.effort,
        permissionMode: d.permissionMode,
        projectPath: d.projectPath
      })
      id = t.id
      set((st) => ({ items: { ...st.items, [t.id]: [] } }))
      await get().openThread(t.id)
      await api.send(t.id, { text, images, agent: d.agent, model: d.model, effort: d.effort, permissionMode: d.permissionMode })
      return
    }
    const t = s.threads[id]
    const sel = s.threadSel[id] ?? {}
    await api.send(id, {
      text,
      images,
      agent: sel.agent ?? t?.agent,
      model: sel.model ?? t?.model,
      effort: sel.effort ?? t?.effort,
      permissionMode: sel.permissionMode ?? t?.permissionMode
    })
  },

  openSettings(page) {
    set((s) => ({ view: 'settings', settingsPage: page ?? s.settingsPage }))
  },

  async addProject(path) {
    const p = await api.addProject(path)
    if (p) {
      set((s) => ({
        projects: s.projects.some((x) => x.path === p.path) ? s.projects : [...s.projects, p],
        draft: { ...s.draft, projectPath: p.path }
      }))
    }
    return p
  }
}))

// Install-log streaming is global so any page can show progress.
export function wireGlobalEvents(): () => void {
  const offThread = api.onThreadEvent((ev) => useStore.getState().applyEvent(ev))
  const offPanel = window.rcode.on('panel-open', (panel: 'browser' | 'simulator') => useStore.setState({ panel }))
  const offInstall = api.onInstallLog((ev) => {
    useStore.setState((s) => ({
      installLogs: { ...s.installLogs, [ev.agent]: [...(s.installLogs[ev.agent] ?? []).slice(-300), ev.line] },
      installing: ev.done ? { ...s.installing, [ev.agent]: false } : s.installing
    }))
  })
  return () => {
    offThread()
    offInstall()
    offPanel()
  }
}
