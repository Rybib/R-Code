import { useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, ExternalLink, FolderOpen, FolderPlus, GitBranch, Home } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { MenuItem, Popover } from './ui'

// Which project (folder) a chat works in. Click to move the chat to another project, or to
// no project at all; the agents pick up in the new folder with the conversation so far.

export function ProjectSwitcher({ threadId, variant, branch }: { threadId: string; variant: 'toolbar' | 'pill'; branch?: string | null }): React.JSX.Element | null {
  const thread = useStore((s) => s.threads[threadId])
  const projects = useStore((s) => s.projects)
  const addProject = useStore((s) => s.addProject)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  if (!thread) return null

  const current = thread.projectPath
  const name = current ? (projects.find((p) => p.path === current)?.name ?? current.split('/').pop()) : null
  const move = async (path: string | undefined): Promise<void> => {
    setError(null)
    try {
      await api.updateThread(threadId, { projectPath: path ?? '' })
      setOpen(false)
    } catch (err: any) {
      setError(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <>
      <button
        ref={btn}
        onClick={() => (setOpen(!open), setError(null))}
        title={current ? `Project: ${current} — click to change` : 'No project — click to pick one'}
        className={clsx(
          'no-drag flex items-center gap-1.5 rounded-lg transition-colors',
          variant === 'toolbar'
            ? clsx('h-7 max-w-[220px] px-2 text-[12.5px]', open ? 'bg-frame-active text-fg' : 'text-fg-2 hover:bg-frame-hover hover:text-fg')
            : clsx('h-7 max-w-[300px] border px-2.5 text-[11.5px]', open ? 'border-line bg-raised-2 text-fg' : 'border-line-soft bg-raised/50 text-fg-2 hover:border-line hover:text-fg')
        )}
      >
        {current ? <FolderOpen size={variant === 'toolbar' ? 14 : 12} className="shrink-0 text-[#6aa7ff]" /> : <Home size={variant === 'toolbar' ? 14 : 12} className="shrink-0 text-fg-3" />}
        <span className={clsx('truncate', !current && 'text-fg-3')}>{name ?? 'No project'}</span>
        {variant === 'pill' && branch && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-fg-3">
            <GitBranch size={11} />
            {branch}
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 text-fg-4" />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement={variant === 'toolbar' ? 'bottom-end' : 'top-start'} className="w-72">
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-fg-4 uppercase">Move chat to</div>
        {projects.map((p) => (
          <MenuItem
            key={p.path}
            icon={<FolderOpen size={14} />}
            onClick={() => void move(p.path)}
            hint={p.path === current ? <Check size={13} className="text-accent" /> : <span className="max-w-[110px] truncate">{p.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
          >
            {p.name}
          </MenuItem>
        ))}
        <MenuItem icon={<Home size={14} />} onClick={() => void move(undefined)} hint={!current ? <Check size={13} className="text-accent" /> : undefined}>
          No project
        </MenuItem>
        <div className="my-1 h-px bg-line-soft" />
        <MenuItem
          icon={<FolderPlus size={14} />}
          onClick={async () => {
            const p = await addProject()
            if (p) await move(p.path)
          }}
        >
          Add project…
        </MenuItem>
        {current && (
          <MenuItem icon={<ExternalLink size={14} />} onClick={() => (setOpen(false), void api.openPath(current))}>
            Open in Finder
          </MenuItem>
        )}
        {error && <div className="px-2.5 pt-1 pb-1.5 text-[11.5px] text-danger">{error}</div>}
        {thread.running && !error && <div className="px-2.5 pt-1 pb-1.5 text-[11.5px] text-fg-4">You can move the chat once the agent finishes.</div>}
      </Popover>
    </>
  )
}
