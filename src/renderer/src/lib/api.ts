import type {
  AgentId,
  AgentStatus,
  ImageAttachment,
  InstallLogEvent,
  ModelOption,
  NewThreadOptions,
  Project,
  SendOptions,
  Settings,
  Thread,
  ThreadEvent,
  ThreadSummary
} from '@shared/types'

interface RCodeBridge {
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, cb: (payload: any) => void): () => void
  pathForFile(file: File): string
  platform: string
}

declare global {
  interface Window {
    rcode: RCodeBridge
  }
}

const r = (): RCodeBridge => window.rcode

export const api = {
  init: () => r().invoke<{ settings: Settings; threads: ThreadSummary[]; projects: Project[]; version: string; home: string }>('app:init'),
  updateSettings: (patch: Partial<Settings>) => r().invoke<Settings>('settings:update', patch),

  detectAgents: () => r().invoke<AgentStatus[]>('agents:detect'),
  models: (agent: AgentId, refresh = false) => r().invoke<ModelOption[]>('agents:models', agent, refresh),
  installAgent: (agent: AgentId) => r().invoke<boolean>('agents:install', agent),
  loginAgent: (agent: AgentId) => r().invoke<void>('agents:login', agent),

  getThread: (id: string) => r().invoke<Thread | null>('threads:get', id),
  createThread: (opts: NewThreadOptions) => r().invoke<Thread>('threads:create', opts),
  updateThread: (id: string, patch: Partial<Thread>) => r().invoke<void>('threads:update', id, patch),
  deleteThread: (id: string) => r().invoke<void>('threads:delete', id),
  send: (id: string, opts: SendOptions) => r().invoke<void>('threads:send', id, opts),
  interrupt: (id: string) => r().invoke<void>('threads:interrupt', id),
  compact: (id: string) => r().invoke<void>('threads:compact', id),
  continueFresh: (id: string, summary?: string) => r().invoke<Thread>('threads:continueFresh', id, summary),
  respondApproval: (requestId: string, decision: 'approve' | 'approveSession' | 'deny') => r().invoke<void>('approvals:respond', requestId, decision),

  addProject: (path?: string) => r().invoke<Project | null>('projects:add', path),
  removeProject: (path: string) => r().invoke<void>('projects:remove', path),
  gitBranch: (cwd: string) => r().invoke<string | null>('git:branch', cwd),

  openPath: (p: string) => r().invoke('shell:openPath', p),
  openExternal: (url: string) => r().invoke('shell:openExternal', url),
  showInFolder: (p: string) => r().invoke('shell:showInFolder', p),
  pickImages: () => r().invoke<ImageAttachment[]>('dialog:pickImages'),
  requestMic: () => r().invoke<boolean>('voice:requestMic'),

  piKeys: () => r().invoke<{ provider: string; hasKey: boolean }[]>('pi:keys'),
  setPiKey: (provider: string, key: string | null) => r().invoke<void>('pi:setKey', provider, key),
  piModelsJson: () => r().invoke<any>('pi:modelsJson'),
  writePiModelsJson: (data: any) => r().invoke<void>('pi:writeModelsJson', data),

  ollamaStatus: () =>
    r().invoke<{ installed: boolean; running: boolean; version?: string; models: { name: string; size: number; family?: string; parameterSize?: string }[] }>('ollama:status'),
  installOllama: () => r().invoke<boolean>('ollama:install'),
  startOllama: () => r().invoke<void>('ollama:start'),
  pullOllama: (name: string) => r().invoke<boolean>('ollama:pull', name),
  ollamaPiModels: () => r().invoke<string[]>('ollama:piModels'),
  syncOllama: (models: string[]) => r().invoke<number>('ollama:sync', models),

  onThreadEvent: (cb: (ev: ThreadEvent) => void) => r().on('thread-event', cb),
  onInstallLog: (cb: (ev: InstallLogEvent) => void) => r().on('install-log', cb),
  onMenu: (cb: (cmd: string) => void) => r().on('menu', cb),
  pathForFile: (f: File) => r().pathForFile(f)
}
