import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Search } from 'lucide-react'
import { useStore, wireGlobalEvents } from './store'
import { api } from './lib/api'
import { Sidebar } from './components/Sidebar'
import { ChatView, Hero, TabBar } from './components/Main'
import { SettingsView } from './settings/Settings'
import { Onboarding } from './settings/Onboarding'
import { AgentIcon } from './components/ui'
import { SidePanel } from './components/SidePanel'
import { refreshCache, speak } from './voice/voice'
import { CrashScreen } from './components/ErrorBoundary'

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const settings = useStore((s) => s.settings)
  const view = useStore((s) => s.view)
  const activeId = useStore((s) => s.activeId)
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const searchOpen = useStore((s) => s.searchOpen)
  const [initError, setInitError] = useState<string | null>(null)

  useEffect(() => {
    const off = wireGlobalEvents()
    // The main process may still be finishing startup; retry briefly before giving up.
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await useStore.getState().init()
          return
        } catch (err) {
          if (attempt >= 4) return setInitError(String((err as Error)?.stack ?? err))
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        }
      }
    })()
    void refreshCache().catch(() => {})
    const offMenu = api.onMenu((cmd) => {
      const s = useStore.getState()
      if (cmd === 'new') s.newConversation()
      if (cmd === 'settings') s.openSettings()
      if (cmd === 'toggleSidebar') s.set({ sidebarCollapsed: !s.sidebarCollapsed })
      if (cmd === 'search') s.set({ searchOpen: true })
      if (cmd === 'addProject') void s.addProject()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useStore.getState().set({ searchOpen: true })
      }
      if (e.metaKey && e.key === 'w') {
        const s = useStore.getState()
        if (s.activeId && s.view === 'chat') {
          e.preventDefault()
          s.closeTab(s.activeId)
        }
      }
      if (e.metaKey && /^[1-9]$/.test(e.key)) {
        const s = useStore.getState()
        const id = s.tabs[Number(e.key) - 1]
        if (id) {
          e.preventDefault()
          void s.openThread(id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      offMenu()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Read finished replies aloud when enabled (hands-free mode with dictation).
  useEffect(() => {
    const wasRunning = new Map<string, boolean>()
    return useStore.subscribe((st) => {
      for (const t of Object.values(st.threads)) {
        const before = wasRunning.get(t.id)
        wasRunning.set(t.id, !!t.running)
        if (before && !t.running && st.settings.ttsEnabled && st.settings.ttsAutoRead && t.id === st.activeId) {
          const items = st.items[t.id] ?? []
          const last = [...items].reverse().find((i) => i.kind === 'assistant' && !i.parentId)
          if (last && last.kind === 'assistant' && last.text.trim()) void speak(last.id, last.text, st.settings.ttsVoice, st.settings.ttsSpeed).catch(() => {})
        }
      }
    })
  }, [])

  // Theme, accent and font size live on <html> as CSS variables.
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      root.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    root.dataset.translucent = String(settings.translucent)
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--chat-font-size', `${settings.chatFontSize}px`)
    root.style.setProperty('--code-font', `'${settings.codeFontFamily}', 'SF Mono', Menlo, monospace`)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme, settings.accent, settings.chatFontSize, settings.codeFontFamily, settings.translucent])

  if (initError) return <CrashScreen message="R-Code couldn't load its data." detail={initError} />
  if (!ready) return <div className="drag h-full bg-frame" />

  return (
    <div className="flex h-full">
      {!collapsed && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <div className={clsx('relative mr-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-[10px] border border-panel-border bg-panel', collapsed && 'ml-1.5')}>
          {view === 'settings' ? (
            <SettingsView />
          ) : (
            <div className="flex h-full">
              <div className="min-w-0 flex-1">{activeId ? <ChatView key={activeId} threadId={activeId} /> : <Hero />}</div>
              <SidePanel />
            </div>
          )}
        </div>
      </main>
      {searchOpen && <SearchPalette />}
      {!settings.onboarded && <Onboarding />}
    </div>
  )
}

function SearchPalette(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const set = useStore((s) => s.set)
  const openThread = useStore((s) => s.openThread)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return Object.values(threads)
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || (t.lastText ?? '').toLowerCase().includes(needle) || (t.projectPath ?? '').toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40)
  }, [threads, q])
  const close = (): void => set({ searchOpen: false })
  const go = (id: string): void => {
    close()
    void openThread(id)
  }
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[14vh]" onMouseDown={close}>
      <div className="pop-in w-[560px] overflow-hidden rounded-2xl border border-line bg-raised shadow-[var(--shadow)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4">
          <Search size={15} className="text-fg-3" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(i + 1, results.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)))
              if (e.key === 'Enter' && results[idx]) go(results[idx].id)
            }}
            placeholder="Search conversations…"
            className="selectable h-12 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-4"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-fg-3">No conversations found</div>}
          {results.map((t, i) => (
            <button
              key={t.id}
              onMouseEnter={() => setIdx(i)}
              onClick={() => go(t.id)}
              className={clsx('flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left', i === idx && 'bg-frame-hover')}
            >
              <AgentIcon agent={t.agent} size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-fg">{t.title}</div>
                {t.lastText && <div className="truncate text-[12px] text-fg-3">{t.lastText}</div>}
              </div>
              <span className="shrink-0 text-[11px] text-fg-4">{new Date(t.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
