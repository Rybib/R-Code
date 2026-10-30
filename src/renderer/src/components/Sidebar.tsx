import { useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Archive,
  CircleCheck,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  PanelLeft,
  Pin,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
  Bot,
  FolderClosed,
  RotateCcw,
  X
} from 'lucide-react'
import type { ThreadSummary } from '@shared/types'
import { useStore } from '../store'
import { api } from '../lib/api'
import { AgentIcon, IconButton, MenuItem, Popover, Spinner } from './ui'

const CHAT_LIMIT = 6

export function Sidebar(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeId)
  const view = useStore((s) => s.view)
  const set = useStore((s) => s.set)
  const newConversation = useStore((s) => s.newConversation)
  const openSettings = useStore((s) => s.openSettings)
  const addProject = useStore((s) => s.addProject)
  const [chatsOpen, setChatsOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [settledOpen, setSettledOpen] = useState(false)

  const { chats, byProject, settled } = useMemo(() => {
    const all = Object.values(threads).filter((t) => !t.archived && !t.parentThreadId)
    const settled = all.filter((t) => t.settledAt).sort((a, b) => b.settledAt! - a.settledAt!)
    const visible = all
      .filter((t) => !t.settledAt)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
    const projectPaths = new Set(projects.map((p) => p.path))
    const byProject: Record<string, ThreadSummary[]> = {}
    const chats: ThreadSummary[] = []
    for (const t of visible) {
      if (t.projectPath && projectPaths.has(t.projectPath)) (byProject[t.projectPath] ??= []).push(t)
      else chats.push(t)
    }
    return { chats, byProject, settled }
  }, [threads, projects])
  const projectName = (path?: string): string | undefined => projects.find((p) => p.path === path)?.name

  const shownChats = showAll ? chats : chats.slice(0, CHAT_LIMIT)

  return (
    <aside className="flex h-full w-[236px] shrink-0 flex-col">
      <div className="drag flex h-[46px] shrink-0 items-center pl-[86px]">
        <IconButton title="Hide sidebar (⌘B)" onClick={() => set({ sidebarCollapsed: true })}>
          <PanelLeft size={15} />
        </IconButton>
      </div>

      <nav className="flex flex-col gap-px px-2">
        <NavButton icon={<SquarePen size={15} />} label="New conversation" onClick={() => newConversation()} active={view === 'chat' && !activeId} />
        <NavButton icon={<Bot size={15} />} label="Agents" onClick={() => openSettings('agents')} active={view === 'settings'} />
        <NavButton icon={<Search size={15} />} label="Search" onClick={() => set({ searchOpen: true })} hint="⌘K" />
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SectionHeader label="Chats" open={chatsOpen} onToggle={() => setChatsOpen(!chatsOpen)} action={{ title: 'New chat', icon: <SquarePen size={13} />, onClick: () => newConversation(undefined) }} />
        {chatsOpen && (
          <div className="mt-0.5 flex flex-col gap-px">
            {shownChats.map((t) => (
              <ThreadRow key={t.id} t={t} active={t.id === activeId && view === 'chat'} />
            ))}
            {chats.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-fg-4">No chats yet</p>}
            {chats.length > CHAT_LIMIT && (
              <button className="rounded-md px-2.5 py-1 text-left text-[12.5px] text-fg-3 hover:text-fg" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show less' : `Show ${chats.length - CHAT_LIMIT} more`}
              </button>
            )}
          </div>
        )}

        <div className="mt-4">
          <SectionHeader label="Projects" open={projectsOpen} onToggle={() => setProjectsOpen(!projectsOpen)} action={{ title: 'Add project', icon: <FolderPlus size={13} />, onClick: () => void addProject() }} />
          {projectsOpen && (
            <div className="mt-0.5 flex flex-col gap-px">
              {projects.length === 0 && (
                <button onClick={() => void addProject()} className="rounded-md px-2.5 py-1.5 text-left text-[12px] text-fg-4 hover:text-fg-2">
                  Add a folder to start coding…
                </button>
              )}
              {projects.map((p) => {
                const list = byProject[p.path] ?? []
                const collapsed = collapsedProjects[p.path]
                return (
                  <div key={p.path}>
                    <ProjectRow
                      name={p.name}
                      path={p.path}
                      collapsed={!!collapsed}
                      onToggle={() => setCollapsedProjects((c) => ({ ...c, [p.path]: !c[p.path] }))}
                      running={list.some((t) => t.running)}
                    />
                    {!collapsed && list.length > 0 && (
                      <div className="ml-[17px] flex flex-col gap-px border-l border-line-soft pl-1.5">
                        {list.map((t) => (
                          <ThreadRow key={t.id} t={t} active={t.id === activeId && view === 'chat'} nested />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {settled.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setSettledOpen(!settledOpen)}
              className="flex h-7 w-full items-center gap-1.5 px-2.5 text-[12.5px] font-medium text-fg-3 hover:text-fg-2"
            >
              <CircleCheck size={12} />
              {settledOpen ? 'Hide settled' : 'Show settled'}
              <span className="font-normal text-fg-4">{settled.length}</span>
              <ChevronDown size={12} className={clsx('ml-auto transition-transform duration-150', !settledOpen && '-rotate-90')} />
            </button>
            {settledOpen && (
              <div className="mt-0.5 flex flex-col gap-px">
                {settled.map((t) => (
                  <ThreadRow key={t.id} t={t} active={t.id === activeId && view === 'chat'} hint={projectName(t.projectPath)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-2 pb-3">
        <NavButton icon={<SettingsIcon size={15} />} label="Settings" onClick={() => openSettings('general')} active={view === 'settings'} hint="⌘," />
      </div>
    </aside>
  )
}

function NavButton({ icon, label, onClick, active, hint }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; hint?: string }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'group flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg transition-colors duration-100 hover:bg-frame-hover',
        active && 'bg-frame-hover'
      )}
    >
      <span className="text-fg-2">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {hint && <span className="text-[11px] text-fg-4 opacity-0 transition-opacity group-hover:opacity-100">{hint}</span>}
    </button>
  )
}

function SectionHeader({ label, open, onToggle, action }: { label: string; open: boolean; onToggle: () => void; action?: { title: string; icon: React.ReactNode; onClick: () => void } }): React.JSX.Element {
  return (
    <div className="group flex h-7 items-center pr-1">
      <button onClick={onToggle} className="flex flex-1 items-center gap-1 px-2.5 text-[12.5px] font-medium text-fg-3 hover:text-fg-2">
        {label}
        <ChevronDown size={12} className={clsx('transition-transform duration-150', !open && '-rotate-90')} />
      </button>
      {action && (
        <IconButton title={action.title} onClick={action.onClick} className="h-6 w-6">
          {action.icon}
        </IconButton>
      )}
    </div>
  )
}

function ProjectRow({ name, path, collapsed, onToggle, running }: { name: string; path: string; collapsed: boolean; onToggle: () => void; running: boolean }): React.JSX.Element {
  const newConversation = useStore((s) => s.newConversation)
  const set = useStore((s) => s.set)
  const [menu, setMenu] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="group flex h-[30px] items-center rounded-lg pr-1 hover:bg-frame-hover">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-[13.5px] text-fg" title={path}>
        {collapsed ? <FolderClosed size={15} className="shrink-0 text-fg-2" /> : <FolderOpen size={15} className="shrink-0 text-fg-2" />}
        <span className="truncate">{name}</span>
        {running && <Spinner size={11} />}
      </button>
      <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton title={`New chat in ${name}`} className="h-6 w-6" onClick={() => newConversation(path)}>
          <SquarePen size={13} />
        </IconButton>
        <button ref={moreRef} onClick={() => setMenu(true)} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-3 hover:bg-frame-active hover:text-fg">
          <MoreHorizontal size={14} />
        </button>
      </div>
      <Popover anchor={moreRef.current} open={menu} onClose={() => setMenu(false)} placement="bottom-end" className="w-52">
        <MenuItem icon={<FolderOpen size={14} />} onClick={() => (setMenu(false), void api.openPath(path))}>
          Open in Finder
        </MenuItem>
        <MenuItem
          icon={<X size={14} />}
          onClick={() => {
            setMenu(false)
            void api.removeProject(path)
            set({ projects: useStore.getState().projects.filter((p) => p.path !== path) })
          }}
        >
          Remove from sidebar
        </MenuItem>
      </Popover>
    </div>
  )
}

function setSettled(t: ThreadSummary, settled: boolean): void {
  void api.updateThread(t.id, { settledAt: settled ? Date.now() : 0 })
  // Settling tidies away its tab too, unless you're looking at it right now.
  const s = useStore.getState()
  if (settled && s.activeId !== t.id && s.tabs.includes(t.id)) s.closeTab(t.id)
}

function ThreadRow({ t, active, nested, hint }: { t: ThreadSummary; active: boolean; nested?: boolean; hint?: string }): React.JSX.Element {
  const openThread = useStore((s) => s.openThread)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  return (
    <div
      className={clsx(
        'group relative flex h-[30px] items-center rounded-lg pr-1 transition-colors duration-100',
        active ? 'bg-accent/90 text-white' : 'hover:bg-frame-hover'
      )}
    >
      <button onClick={() => void openThread(t.id)} className={clsx('flex min-w-0 flex-1 items-center gap-2 text-[13.5px]', nested ? 'px-2' : 'px-2.5')} title={t.title}>
        {t.running ? <Spinner size={13} className={active ? 'text-white' : ''} /> : <AgentIcon agent={t.agent} size={13} className={clsx('shrink-0', active ? 'opacity-100' : 'opacity-80')} />}
        {renaming ? (
          <input
            autoFocus
            defaultValue={t.title}
            className="selectable min-w-0 flex-1 rounded bg-field px-1 text-fg outline-none"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false)
              if (e.target.value.trim()) void api.updateThread(t.id, { title: e.target.value.trim() })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className={clsx('truncate', active ? 'text-white' : t.settledAt ? 'text-fg-2' : 'text-fg')}>{t.title}</span>
        )}
        {t.pinned && <Pin size={10} className="shrink-0 opacity-50" />}
        {hint && !renaming && <span className={clsx('ml-auto shrink-0 truncate text-[11px]', active ? 'text-white/70' : 'text-fg-4')}>{hint}</span>}
      </button>
      {!t.running && (
        <button
          title={t.settledAt ? 'Unsettle — move back to your chats' : 'Settle — done for now, tuck it away'}
          onClick={() => setSettled(t, !t.settledAt)}
          className={clsx(
            'hidden h-6 w-6 shrink-0 items-center justify-center rounded-md group-hover:flex',
            active ? 'text-white/80 hover:bg-white/15' : 'text-fg-3 hover:bg-frame-active hover:text-fg'
          )}
        >
          {t.settledAt ? <RotateCcw size={13} /> : <CircleCheck size={14} />}
        </button>
      )}
      <button
        ref={moreRef}
        onClick={() => setMenu(true)}
        className={clsx(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100',
          active ? 'text-white/80 hover:bg-white/15' : 'text-fg-3 hover:bg-frame-active hover:text-fg',
          menu && 'opacity-100'
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      <Popover anchor={moreRef.current} open={menu} onClose={() => setMenu(false)} placement="bottom-end" className="w-48">
        <MenuItem icon={<SquarePen size={14} />} onClick={() => (setMenu(false), setRenaming(true))}>
          Rename
        </MenuItem>
        <MenuItem icon={<Pin size={14} />} onClick={() => (setMenu(false), void api.updateThread(t.id, { pinned: !t.pinned }))}>
          {t.pinned ? 'Unpin' : 'Pin'}
        </MenuItem>
        <MenuItem icon={t.settledAt ? <RotateCcw size={14} /> : <CircleCheck size={14} />} onClick={() => (setMenu(false), setSettled(t, !t.settledAt))}>
          {t.settledAt ? 'Unsettle' : 'Settle'}
        </MenuItem>
        <MenuItem icon={<Archive size={14} />} onClick={() => (setMenu(false), void api.updateThread(t.id, { archived: true }), useStore.getState().closeTab(t.id))}>
          Archive
        </MenuItem>
        <MenuItem icon={<Trash2 size={14} />} danger onClick={() => (setMenu(false), void api.deleteThread(t.id))}>
          Delete
        </MenuItem>
      </Popover>
    </div>
  )
}
