import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Globe, Smartphone, ChevronDown, CircleCheck, Circle, FolderOpen, GitBranch, PanelLeft, Plus, X, Loader, Sparkles, FolderPlus, Home, ChevronUp } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { useStore, defaultModelFor } from '../store'
import { api } from '../lib/api'
import { Composer } from './Composer'
import { Timeline } from './Timeline'
import { ContextMeter, UsageMeter } from './Metrics'
import { ModelPicker, type Selection } from './ModelPicker'
import { AgentIcon, IconButton, Logo, MenuItem, Popover } from './ui'

export function TabBar(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeId)
  const view = useStore((s) => s.view)
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const set = useStore((s) => s.set)
  const activeTab = useStore((s) => s.activeTab)
  const selectTab = useStore((s) => s.selectTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const active = activeId ? threads[activeId] : undefined
  const panel = useStore((s) => s.panel)

  return (
    <div className={clsx('drag flex h-[46px] shrink-0 items-end gap-1 pr-2', collapsed ? 'pl-[86px]' : 'pl-1')}>
      {collapsed && (
        <IconButton title="Show sidebar (⌘B)" className="mb-2" onClick={() => set({ sidebarCollapsed: false })}>
          <PanelLeft size={15} />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden">
        {view === 'settings' ? (
          <div className="mb-[11px] ml-3 flex items-center gap-2 text-[13px] text-fg-2">
            <span className="font-semibold text-fg">Settings</span>
          </div>
        ) : (
          <>
            {tabs.map((id, i) => {
              const t = id ? threads[id] : undefined
              const isActive = i === activeTab
              return (
                <div
                  key={`${i}:${id ?? 'new'}`}
                  onMouseDown={(e) => {
                    if (e.button === 1) closeTab(i)
                  }}
                  className={clsx(
                    'no-drag group relative flex h-[34px] max-w-[220px] min-w-[120px] items-center gap-2 rounded-t-[10px] pr-1.5 pl-3 text-[12.5px] transition-colors duration-100',
                    isActive ? 'bg-panel text-fg' : 'text-fg-3 hover:bg-frame-hover hover:text-fg-2'
                  )}
                >
                  <button className="flex min-w-0 flex-1 items-center gap-2" onClick={() => selectTab(i)}>
                    {t ? (
                      t.running ? <Loader size={12} className="shrink-0 animate-spin" /> : <AgentIcon agent={t.agent} size={12} className="shrink-0" />
                    ) : (
                      <Sparkles size={12} className={clsx('shrink-0', isActive ? 'text-accent' : '')} />
                    )}
                    <span className="truncate">{t ? t.title : 'New conversation'}</span>
                  </button>
                  {(tabs.length > 1 || t) && (
                    <button
                      title="Close tab (⌘W)"
                      onClick={() => closeTab(i)}
                      className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-frame-active hover:text-fg', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              )
            })}
            <IconButton title="New tab (⌘T)" className="mb-[3px] ml-1" onClick={() => newTab()}>
              <Plus size={15} />
            </IconButton>
          </>
        )}
      </div>
      {view === 'chat' && (
        <div className="mb-[7px] flex items-center gap-0.5">
          {active?.projectPath && (
            <IconButton title="Open project in Finder" onClick={() => void api.openPath(active.projectPath!)}>
              <FolderOpen size={15} />
            </IconButton>
          )}
          <IconButton title="Built-in browser" active={panel === 'browser'} onClick={() => set({ panel: panel === 'browser' ? null : 'browser' })}>
            <Globe size={15} />
          </IconButton>
          <IconButton title="iOS Simulator" active={panel === 'simulator'} onClick={() => set({ panel: panel === 'simulator' ? null : 'simulator' })}>
            <Smartphone size={15} />
          </IconButton>
        </div>
      )}
    </div>
  )
}

export function Hero(): React.JSX.Element {
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const projects = useStore((s) => s.projects)
  const addProject = useStore((s) => s.addProject)
  const settings = useStore((s) => s.settings)
  const [menu, setMenu] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const project = projects.find((p) => p.path === draft.projectPath)

  // Keep the draft on a linked agent once onboarding links some.
  useEffect(() => {
    if (settings.linkedAgents.length && !settings.linkedAgents.includes(draft.agent)) {
      const agent = settings.linkedAgents.includes(settings.defaultAgent) ? settings.defaultAgent : settings.linkedAgents[0]
      setDraft({ agent, model: defaultModelFor(settings, agent) })
    }
  }, [settings, draft.agent, setDraft])

  const sel: Selection = { agent: draft.agent, model: draft.model, effort: draft.effort }
  return (
    <div className="relative flex h-full flex-col">
      <div className="hero-grid pointer-events-none absolute inset-0" />
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-8">
        <Logo size={150} className="mb-10 drop-shadow-[0_20px_40px_rgba(91,95,240,0.25)]" />
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-[17px] text-fg-2">
          <span>Start a new conversation in</span>
          <button ref={btn} onClick={() => setMenu(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-raised-2/80 px-2.5 text-[15px] text-fg transition-colors hover:bg-frame-active">
            {project ? <FolderOpen size={15} className="text-[#6aa7ff]" /> : <Home size={14} className="text-fg-3" />}
            <span className="max-w-[220px] truncate">{project?.name ?? 'Home'}</span>
            <ChevronDown size={12} className="text-fg-3" />
          </button>
          <span>using</span>
          <ModelPicker variant="hero" placement="bottom-start" value={sel} onChange={(s) => setDraft({ agent: s.agent, model: s.model, effort: s.effort })} />
        </div>
        <Popover anchor={btn.current} open={menu} onClose={() => setMenu(false)} className="w-64">
          <MenuItem icon={<Home size={14} />} active={!draft.projectPath} onClick={() => (setDraft({ projectPath: undefined }), setMenu(false))}>
            Home (no project)
          </MenuItem>
          {projects.map((p) => (
            <MenuItem key={p.path} icon={<FolderOpen size={14} />} active={p.path === draft.projectPath} onClick={() => (setDraft({ projectPath: p.path }), setMenu(false))} hint={<span className="max-w-[90px] truncate">{p.path.replace(/^\/Users\/[^/]+/, '~')}</span>}>
              {p.name}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-line-soft" />
          <MenuItem icon={<FolderPlus size={14} />} onClick={() => (setMenu(false), void addProject())}>
            Add a project folder…
          </MenuItem>
        </Popover>
      </div>
      <div className="relative mx-auto w-full max-w-[760px] px-6 pb-7">
        <div className="mb-2 flex justify-end empty:hidden">
          <UsageMeter agent={sel.agent} />
        </div>
        <Composer
          threadKey="new"
          autoFocus
          selection={sel}
          onSelection={(s) => setDraft({ agent: s.agent, model: s.model, effort: s.effort })}
          mode={draft.permissionMode}
          onMode={(m) => setDraft({ permissionMode: m })}
        />
        <p className="mt-2 text-center text-[11.5px] text-fg-4">⌥Space to dictate · Switch agents any time — context follows the conversation</p>
      </div>
    </div>
  )
}

export function ChatView({ threadId }: { threadId: string }): React.JSX.Element {
  const thread = useStore((s) => s.threads[threadId])
  const items = useStore((s) => s.items[threadId])
  const sel = useStore((s) => s.threadSel[threadId])
  const set = useStore((s) => s.set)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    if (thread?.projectPath) void api.gitBranch(thread.projectPath).then(setBranch)
    else setBranch(null)
  }, [thread?.projectPath, thread?.running])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
  }, [threadId])

  if (!thread) return <div />
  const selection: Selection = { agent: sel?.agent ?? thread.agent, model: sel?.model ?? thread.model, effort: sel?.effort ?? thread.effort }
  const mode: PermissionMode = sel?.permissionMode ?? thread.permissionMode
  const setSel = (patch: Partial<Selection & { permissionMode: PermissionMode }>): void =>
    set({ threadSel: { ...useStore.getState().threadSel, [threadId]: { ...selection, permissionMode: mode, ...patch } } })

  const usage = thread.usage
  const pct = usage?.contextTokens && usage.contextWindow ? Math.min(100, (usage.contextTokens / usage.contextWindow) * 100) : null

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[760px] px-6 pt-6">
          {items ? <Timeline threadId={threadId} items={items} running={!!thread.running} /> : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[760px] px-6 pb-5">
        {thread.plan && thread.plan.length > 0 && <PlanCard threadId={threadId} />}
        <div className="mb-2 flex items-center gap-2">
          {(branch || thread.projectPath) && (
            <div className="flex h-7 items-center gap-1.5 rounded-lg border border-line-soft bg-raised/50 px-2.5 font-mono text-[11.5px] text-fg-2">
              <GitBranch size={12} className="text-fg-3" />
              {branch ?? thread.projectPath?.split('/').pop()}
            </div>
          )}
          <div className="flex-1" />
          <UsageMeter agent={selection.agent} />
          {pct !== null && <ContextMeter pct={pct} tokens={usage!.contextTokens!} window={usage!.contextWindow!} threadId={threadId} running={!!thread.running} cost={usage?.costUsd} />}
        </div>
        <Composer
          threadKey={threadId}
          autoFocus
          selection={selection}
          onSelection={(s) => setSel(s)}
          mode={mode}
          onMode={(m) => setSel({ permissionMode: m })}
          running={thread.running}
          onStop={() => void api.interrupt(threadId)}
        />
      </div>
    </div>
  )
}

function PlanCard({ threadId }: { threadId: string }): React.JSX.Element {
  const plan = useStore((s) => s.threads[threadId]?.plan) ?? []
  const [open, setOpen] = useState(true)
  const done = plan.filter((p) => p.status === 'completed').length
  const current = plan.find((p) => p.status === 'in_progress')
  return (
    <div className="fade-up mb-2 overflow-hidden rounded-xl border border-line-soft bg-raised/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-fg-2">
        {open ? <ChevronDown size={13} className="text-fg-3" /> : <ChevronUp size={13} className="text-fg-3" />}
        <CircleCheck size={13} className={done === plan.length ? 'text-ok' : 'text-fg-3'} />
        <span className="font-medium">
          {done === plan.length ? `Completed ${done} of ${plan.length} steps` : current ? current.text : `${done} of ${plan.length} steps done`}
        </span>
        {done < plan.length && (
          <span className="ml-auto text-fg-4">
            {done}/{plan.length}
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-44 overflow-y-auto px-3 pb-2">
          {plan.map((p, i) => (
            <div key={i} className="flex items-start gap-2 py-[3px] text-[12.5px]">
              {p.status === 'completed' ? (
                <CircleCheck size={13} className="mt-[2px] shrink-0 text-fg-4" />
              ) : p.status === 'in_progress' ? (
                <Loader size={13} className="mt-[2px] shrink-0 animate-spin text-accent" />
              ) : (
                <Circle size={13} className="mt-[2px] shrink-0 text-fg-4" />
              )}
              <span className={clsx(p.status === 'completed' ? 'text-fg-4 line-through' : p.status === 'in_progress' ? 'text-fg' : 'text-fg-2')}>{p.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
