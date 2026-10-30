import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, Cpu, Search, Star, Gauge, Settings2 } from 'lucide-react'
import { AGENT_IDS, AGENT_LABELS, PERMISSION_LABELS, type AgentId, type ModelOption, type PermissionMode } from '@shared/types'
import { useStore } from '../store'
import { AgentIcon, MenuItem, Popover, Spinner } from './ui'

export interface Selection {
  agent: AgentId
  model: string
  effort?: string
}

export function modelLabel(models: ModelOption[] | undefined, id: string, agent?: AgentId): string {
  if (id === 'default') return agent ? AGENT_LABELS[agent] : 'Default'
  const m = models?.find((x) => x.id === id)
  if (m) return m.label
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(slash + 1) : id
}

export const AGENT_BLURB: Record<AgentId, string> = {
  claude: 'Anthropic · your Claude Code CLI',
  codex: 'OpenAI · your Codex CLI',
  pi: 'Built-in · local & open models, any provider'
}

export function ModelPicker({
  value,
  onChange,
  variant = 'composer',
  placement = 'top-end'
}: {
  value: Selection
  onChange: (sel: Selection) => void
  variant?: 'composer' | 'hero'
  placement?: 'top-end' | 'bottom-start' | 'bottom-end' | 'top-start'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const btn = useRef<HTMLButtonElement>(null)
  const models = useStore((s) => s.models)
  const agents = useStore((s) => s.agents)
  const settings = useStore((s) => s.settings)
  const loadModels = useStore((s) => s.loadModels)
  const setSettings = useStore((s) => s.setSettings)
  const openSettings = useStore((s) => s.openSettings)

  useEffect(() => {
    if (open) for (const a of settings.linkedAgents) if (!models[a]) void loadModels(a)
  }, [open, settings.linkedAgents, models, loadModels])

  const current = models[value.agent]?.find((m) => m.id === value.model)
  const label = modelLabel(models[value.agent], value.model, value.agent)
  const q = query.trim().toLowerCase()

  const groups = useMemo(() => {
    return AGENT_IDS.map((agent) => {
      const list = (models[agent] ?? []).filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.provider ?? '').includes(q))
      return { agent, list }
    })
  }, [models, q])

  const favorites = useMemo(() => {
    const all = AGENT_IDS.flatMap((a) => models[a] ?? [])
    return settings.favoriteModels
      .map((key) => all.find((m) => `${m.agent}:${m.id}` === key))
      .filter((m): m is ModelOption => !!m && (!q || m.label.toLowerCase().includes(q)))
  }, [models, settings.favoriteModels, q])

  const toggleFav = (m: ModelOption): void => {
    const key = `${m.agent}:${m.id}`
    const favs = settings.favoriteModels.includes(key) ? settings.favoriteModels.filter((k) => k !== key) : [...settings.favoriteModels, key]
    void setSettings({ favoriteModels: favs })
  }

  const pick = (m: ModelOption): void => {
    const effort = m.efforts?.includes(value.effort ?? '') ? value.effort : m.defaultEffort
    onChange({ agent: m.agent, model: m.id, effort })
    setOpen(false)
  }

  const row = (m: ModelOption): React.JSX.Element => {
    const selected = m.agent === value.agent && m.id === value.model
    const fav = settings.favoriteModels.includes(`${m.agent}:${m.id}`)
    return (
      <div key={`${m.agent}:${m.id}`} className={clsx('group flex items-center rounded-lg hover:bg-frame-hover', selected && 'bg-frame-hover')}>
        <button onClick={() => pick(m)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left">
          <AgentIcon agent={m.agent} size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-fg">{m.label}</span>
            {m.description && <span className="block truncate text-[11.5px] text-fg-3">{m.description}</span>}
          </span>
          {m.local && <span className="rounded bg-ok/15 px-1.5 py-px text-[10.5px] font-medium text-ok">local</span>}
          {m.agent === 'pi' && m.provider && !m.local && <span className="text-[11px] text-fg-4">{m.provider}</span>}
          {selected && <Check size={14} className="shrink-0 text-accent" />}
        </button>
        <button
          title={fav ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => toggleFav(m)}
          className={clsx('mr-1 flex h-6 w-6 items-center justify-center rounded-md transition-opacity hover:bg-frame-active', fav ? 'text-warn opacity-100' : 'text-fg-4 opacity-0 group-hover:opacity-100')}
        >
          <Star size={12} fill={fav ? 'currentColor' : 'none'} />
        </button>
      </div>
    )
  }

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen(!open)}
        className={clsx(
          'no-drag inline-flex max-w-[280px] items-center gap-1.5 rounded-lg transition-colors duration-100',
          variant === 'hero' ? 'h-8 bg-raised-2/80 px-2.5 text-[15px] text-fg hover:bg-frame-active' : 'h-7 px-2 text-[12.5px] text-fg-2 hover:bg-raised-2 hover:text-fg'
        )}
      >
        <AgentIcon agent={value.agent} size={variant === 'hero' ? 15 : 13} />
        <span className="truncate">{label}</span>
        {value.effort && variant === 'composer' && <span className="text-fg-4">· {value.effort}</span>}
        <ChevronDown size={12} className="shrink-0 text-fg-3" />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement={placement} className="w-[340px]">
        <div className="flex items-center gap-2 border-b border-line-soft px-2.5 pt-1 pb-2">
          <Search size={13} className="text-fg-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="selectable flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4"
          />
        </div>
        <div className="max-h-[420px] overflow-y-auto py-1">
          {favorites.length > 0 && (
            <div className="mb-1">
              <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-fg-4 uppercase">Favorites</div>
              {favorites.map(row)}
            </div>
          )}
          {groups.map(({ agent, list }) => {
            const status = agents.find((a) => a.id === agent)
            const linked = settings.linkedAgents.includes(agent)
            return (
              <div key={agent} className="mb-1">
                <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-1">
                  <span className="text-[11px] font-medium tracking-wide text-fg-4 uppercase">{AGENT_LABELS[agent]}</span>
                  <span className="truncate text-[11px] text-fg-4">{AGENT_BLURB[agent]}</span>
                </div>
                {!linked || !status?.installed ? (
                  <button onClick={() => (setOpen(false), openSettings('agents'))} className="mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg-3 hover:bg-frame-hover hover:text-fg">
                    <Settings2 size={13} />
                    {status?.installed ? `Link ${AGENT_LABELS[agent]}…` : `Set up ${AGENT_LABELS[agent]}…`}
                  </button>
                ) : !models[agent] ? (
                  <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-fg-3">
                    <Spinner size={12} /> Loading models…
                  </div>
                ) : list.length === 0 ? (
                  <button onClick={() => (setOpen(false), openSettings(agent === 'pi' ? 'models' : 'agents'))} className="mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg-3 hover:bg-frame-hover hover:text-fg">
                    <Cpu size={13} />
                    {q ? 'No matches' : agent === 'pi' ? 'Connect Ollama or a provider…' : 'No models found'}
                  </button>
                ) : (
                  list.map(row)
                )}
              </div>
            )
          })}
        </div>
        {current?.efforts && current.efforts.length > 0 && (
          <div className="flex items-center gap-1 border-t border-line-soft px-2 pt-2 pb-1">
            <Gauge size={13} className="mr-1 text-fg-3" />
            <span className="mr-1 text-[12px] text-fg-3">Effort</span>
            <div className="flex flex-1 flex-wrap gap-1">
              {current.efforts.map((e) => (
                <button
                  key={e}
                  onClick={() => onChange({ ...value, effort: e })}
                  className={clsx('rounded-md px-2 py-0.5 text-[12px] transition-colors', (value.effort ?? current.defaultEffort) === e ? 'bg-accent text-white' : 'text-fg-2 hover:bg-frame-hover')}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
      </Popover>
    </>
  )
}

const MODE_DESC: Record<PermissionMode, string> = {
  ask: 'Ask before edits and commands',
  acceptEdits: 'Edit files freely, ask before risky commands',
  auto: 'Let the agent decide what is safe',
  allowAll: 'Never ask — full access',
  plan: 'Read and plan only, no changes'
}

export function PermissionPicker({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen(!open)}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-fg-2 transition-colors hover:bg-raised-2 hover:text-fg"
      >
        <ModeIcon mode={value} />
        <span>{PERMISSION_LABELS[value]}</span>
        <ChevronDown size={12} className="text-fg-3" />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-start" className="w-72">
        {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((m) => (
          <MenuItem key={m} icon={<ModeIcon mode={m} />} active={m === value} onClick={() => (onChange(m), setOpen(false))} hint={m === value ? <Check size={13} className="text-accent" /> : undefined}>
            <span className="block">{PERMISSION_LABELS[m]}</span>
            <span className="block text-[11.5px] text-fg-3">{MODE_DESC[m]}</span>
          </MenuItem>
        ))}
      </Popover>
    </>
  )
}

export function ModeIcon({ mode }: { mode: PermissionMode }): React.JSX.Element {
  const color = mode === 'allowAll' ? '#ef6a7a' : mode === 'auto' ? '#e6a23c' : mode === 'plan' ? '#7aa7ff' : mode === 'acceptEdits' ? '#3fb97f' : '#9aa0a6'
  if (mode === 'allowAll' || mode === 'auto')
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round">
        <path d="M2.5 4l5 4-5 4zM8.5 4l5 4-5 4z" />
      </svg>
    )
  if (mode === 'plan')
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round">
        <path d="M3 4h10M3 8h7M3 12h5" />
      </svg>
    )
  if (mode === 'acceptEdits')
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round">
        <path d="M2.5 4l5 4-5 4z" />
        <path d="M9 12h4.5" strokeLinecap="round" />
      </svg>
    )
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.5v3M8 10.5v.01" strokeLinecap="round" />
    </svg>
  )
}
