import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, systemPreferences } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { AGENT_IDS, type AgentId, type InstallLogEvent, type NewThreadOptions, type Project, type SendOptions, type Settings, type ThreadEvent } from '@shared/types'
import { loadShellEnv, run, which } from './env'
import { getProjects, getSettings, initStore, saveProjects, updateSettings, flushAll } from './store'
import { Orchestrator, adapters } from './orchestrator'
import { startBridge } from './bridge'
import {
  getPiKeys,
  installAgent,
  installOllama,
  openLoginTerminal,
  piOllamaModels,
  pullOllamaModel,
  readPiModelsJson,
  setPiKey,
  startOllama,
  syncOllamaToPi,
  ollamaStatus,
  writePiModelsJson
} from './installer'
import { clearPiModelCache } from './agents/pi'
import { startDevAutomation } from './dev-automation'
import { registerTools } from './tools/registry'
import { BrowserController, browserTools } from './tools/browser'
import { webTools } from './tools/web'
import { axePath, bootDevice, buildAndRun, installAxe, iosTools, listDevices, pressHome, screenshot as simScreenshot, shutdownDevice, tap as simTap } from './tools/ios'

app.setName('R-Code')

// One R-Code at a time: opening it again (Dock, Finder, Spotlight) focuses the existing window.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) {
    if (app.isReady()) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

process.on('uncaughtException', (err) => console.error('[main] uncaught', err))
process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection', err))

let win: BrowserWindow | null = null
let orchestrator: Orchestrator
let browser: BrowserController

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow(): void {
  const settings = getSettings()
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'R-Code',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: settings.translucent ? '#00000000' : nativeTheme.shouldUseDarkColors || settings.theme === 'dark' ? '#18191c' : '#f6f6f7',
    vibrancy: settings.translucent ? 'sidebar' : undefined,
    visualEffectState: 'followWindow',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  // Never leave the user without a window, even if the first paint is slow.
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  }, 4000)
  // Recover from crashes instead of sitting on a blank window.
  const wc = win.webContents
  wc.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone', details.reason)
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => win && !win.isDestroyed() && loadRenderer(win), 500)
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    console.error('[main] load failed', code, desc, url)
    setTimeout(() => win && !win.isDestroyed() && loadRenderer(win), 1000)
  })
  win.on('unresponsive', () => console.error('[main] window unresponsive'))
  if (!app.isPackaged) {
    win.webContents.on('console-message', (e: any) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
    })
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
  loadRenderer(win)
}

function loadRenderer(w: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

// A GPU process crash can leave the compositor showing nothing; repaint by reloading.
app.on('child-process-gone', (_e, details) => {
  if (details.type !== 'GPU' || details.reason === 'clean-exit') return
  console.error('[main] GPU process gone', details.reason)
  if (win && !win.isDestroyed()) setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 800)
})

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'R-Code',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Conversation', accelerator: 'Cmd+N', click: () => send('menu', 'new') },
        { label: 'Add Project…', accelerator: 'Cmd+O', click: () => send('menu', 'addProject') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => send('menu', 'toggleSidebar') },
        { label: 'Search Conversations', accelerator: 'Cmd+K', click: () => send('menu', 'search') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: any[]) => any): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...args))
  }
  const installLog = (ev: InstallLogEvent): void => send('install-log', ev)

  handle('app:init', () => ({
    settings: getSettings(),
    threads: orchestrator.summaries(),
    projects: getProjects(),
    version: app.getVersion(),
    home: app.getPath('home')
  }))

  handle('settings:update', (patch: Partial<Settings>) => {
    const s = updateSettings(patch)
    if ('theme' in patch) nativeTheme.themeSource = s.theme
    return s
  })

  handle('agents:detect', async () => {
    const settings = getSettings()
    return Promise.all(AGENT_IDS.map((id) => adapters[id].detect(settings).catch(() => ({ id, installed: false, authenticated: null, linked: false }))))
  })
  handle('agents:models', async (agent: AgentId, refresh?: boolean) => {
    if (refresh && agent === 'pi') clearPiModelCache()
    return adapters[agent].listModels(getSettings()).catch(() => [])
  })
  handle('agents:install', async (agent: AgentId) => {
    const ok = await installAgent(agent, installLog)
    if (ok) await loadShellEnvFresh()
    return ok
  })
  handle('agents:login', (agent: AgentId) => openLoginTerminal(agent))

  handle('threads:list', () => orchestrator.summaries())
  handle('threads:get', (id: string) => orchestrator.get(id) ?? null)
  handle('threads:create', (opts: NewThreadOptions) => {
    const t = orchestrator.createThread(opts)
    return t
  })
  handle('threads:update', (id: string, patch: any) => orchestrator.update(id, patch))
  handle('threads:delete', (id: string) => orchestrator.delete(id))
  handle('threads:send', (id: string, opts: SendOptions) => orchestrator.send(id, opts))
  handle('threads:interrupt', (id: string) => orchestrator.interrupt(id))
  handle('threads:compact', (id: string) => orchestrator.compact(id))
  handle('threads:continueFresh', (id: string, summary?: string) => orchestrator.continueInNewChat(id, summary))
  handle('approvals:respond', (requestId: string, decision: 'approve' | 'approveSession' | 'deny') => orchestrator.respondApproval(requestId, decision))

  handle('projects:add', async (path?: string) => {
    let dir = path
    if (!dir) {
      const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Add a project folder' })
      if (res.canceled || !res.filePaths[0]) return null
      dir = res.filePaths[0]
    }
    const projects = getProjects()
    let p = projects.find((x) => x.path === dir)
    if (!p) {
      p = { path: dir, name: basename(dir), addedAt: Date.now() }
      saveProjects([...projects, p])
    }
    return p
  })
  handle('projects:remove', (path: string) => saveProjects(getProjects().filter((p: Project) => p.path !== path)))
  handle('projects:list', () => getProjects())

  handle('git:branch', async (cwd: string) => {
    if (!cwd || !which('git')) return null
    const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 4000 })
    return r.code === 0 ? r.stdout.trim() : null
  })

  handle('shell:openPath', (p: string) => shell.openPath(p))
  handle('shell:openExternal', (url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined))
  handle('shell:showInFolder', (p: string) => shell.showItemInFolder(p))

  handle('dialog:pickImages', async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (res.canceled) return []
    return res.filePaths
      .filter((f) => statSync(f).size < 15 * 1024 * 1024)
      .map((f) => {
        const ext = extname(f).slice(1).toLowerCase()
        return { name: basename(f), mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, data: readFileSync(f).toString('base64') }
      })
  })

  handle('voice:requestMic', async () => {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  // Built-in browser panel
  handle('browser:bounds', (b: Electron.Rectangle | null) => browser.setBounds(b))
  handle('browser:navigate', (url: string) => browser.navigate(url).catch((e) => String(e)))
  handle('browser:back', () => browser.back())
  handle('browser:forward', () => browser.forward())
  handle('browser:reload', () => browser.reload())
  handle('browser:state', () => browser.state())
  handle('browser:devtools', () => browser.view?.webContents.openDevTools({ mode: 'detach' }))

  // iOS Simulator panel
  handle('ios:devices', () => listDevices())
  handle('ios:boot', (udid: string) => bootDevice(udid))
  handle('ios:shutdown', (udid: string) => shutdownDevice(udid))
  handle('ios:screenshot', async (udid: string) => {
    try {
      return await simScreenshot(udid, 900)
    } catch {
      return null
    }
  })
  handle('ios:tap', (udid: string, x: number, y: number) => simTap(udid, x, y))
  handle('ios:home', (udid: string) => pressHome(udid))
  handle('ios:hasAxe', () => !!axePath())
  handle('ios:xcodeVersion', async () => {
    const r = await run('xcodebuild', ['-version'], { timeoutMs: 15000 })
    return r.code === 0 ? r.stdout.trim().replace(/\n/g, ' · ') : 'Xcode not found — install it from the App Store'
  })
  handle('ios:installAxe', () => installAxe((line) => send('ios-log', line)))
  handle('ios:buildRun', (cwd: string, udid?: string) => buildAndRun({ cwd, device: udid }, (line) => send('ios-log', line)))
  handle('ios:openSimulatorApp', () => run('/usr/bin/open', ['-a', 'Simulator']))

  handle('pi:keys', () => getPiKeys())
  handle('pi:setKey', (provider: string, key: string | null) => {
    setPiKey(provider, key)
    clearPiModelCache()
  })
  handle('pi:modelsJson', () => readPiModelsJson())
  handle('pi:writeModelsJson', (data: any) => {
    writePiModelsJson(data)
    clearPiModelCache()
  })

  handle('ollama:status', () => ollamaStatus(getSettings().ollama.baseUrl))
  handle('ollama:install', () => installOllama(installLog))
  handle('ollama:start', () => startOllama(installLog))
  handle('ollama:pull', (name: string) => pullOllamaModel(getSettings().ollama.baseUrl, name, installLog))
  handle('ollama:piModels', () => piOllamaModels())
  handle('ollama:sync', async (models: string[]) => {
    const s = getSettings()
    const n = await syncOllamaToPi(s.ollama.baseUrl, models)
    updateSettings({ ollama: { ...s.ollama, models, enabled: models.length > 0 } })
    clearPiModelCache()
    return n
  })
}

async function loadShellEnvFresh(): Promise<void> {
  // A fresh install may have changed PATH (e.g. ~/.local/bin); re-read the login shell.
  const shellPath = process.env.SHELL || '/bin/zsh'
  const r = await run(shellPath, ['-ilc', 'echo -n "$PATH"'], { timeoutMs: 8000 })
  if (r.stdout.trim()) {
    const merged = new Set([...r.stdout.trim().split(':'), ...(process.env.PATH ?? '').split(':')])
    process.env.PATH = [...merged].filter(Boolean).join(':')
  }
}

app.whenReady().then(async () => {
  // Each step is guarded so a failure in one subsystem never stops the window from opening.
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      console.error(`[main] startup step "${name}" failed`, err)
    }
  }
  await step('shell env', () => loadShellEnv())
  await step('store', () => initStore())
  await step('theme', () => (nativeTheme.themeSource = getSettings().theme))

  orchestrator = new Orchestrator((ev: ThreadEvent) => send('thread-event', ev))
  browser = new BrowserController(() => win, send)
  await step('tools', () =>
    registerTools([
      ...orchestrator.tools(),
      ...browserTools(browser, send),
      ...webTools(getSettings, browser, send),
      ...iosTools(send, (id) => orchestrator.cwdFor(id))
    ])
  )
  await step('bridge', async () => {
    orchestrator.bridge = await startBridge((id) => orchestrator.threadInfo(id))
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')

  registerIpc()
  buildMenu()
  createWindow()
  if (!app.isPackaged && process.env.RCODE_AUTOMATION_PORT) startDevAutomation(() => win, Number(process.env.RCODE_AUTOMATION_PORT), () => browser.view)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  })
})

app.on('before-quit', () => {
  try {
    flushAll((orchestrator as any)?.threads?.values?.() ?? [])
    orchestrator?.disposeAll()
  } catch {
    /* ignore */
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
