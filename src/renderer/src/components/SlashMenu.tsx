import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { AGENT_LABELS, type AgentId, type SlashCommand } from '@shared/types'
import { api } from '../lib/api'

// The "/" menu: each agent's own slash commands (Claude Code's commands and skills, Codex's
// built-ins and skills, Pi's templates and extensions), fetched from the harness for the chat's folder.

const cache = new Map<string, { at: number; value: Promise<SlashCommand[]> }>()

function loadCommands(agent: AgentId, cwd: string | undefined): Promise<SlashCommand[]> {
  const key = `${agent}|${cwd ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = api.commands(agent, cwd).catch(() => [] as SlashCommand[])
  cache.set(key, { at: Date.now(), value })
  return value
}

/** The command name being typed, while the text is still just "/partial". */
export function slashQuery(text: string): string | null {
  const m = text.match(/^\/([\w:.-]*)$/)
  return m ? m[1] : null
}

export function useSlashCommands(agent: AgentId, cwd: string | undefined, active: boolean): { commands: SlashCommand[]; loading: boolean } {
  const [state, setState] = useState<{ key: string; commands: SlashCommand[]; loading: boolean }>({ key: '', commands: [], loading: false })
  const key = `${agent}|${cwd ?? ''}`
  useEffect(() => {
    if (!active) return
    let alive = true
    setState((s) => (s.key === key ? s : { key, commands: [], loading: true }))
    void loadCommands(agent, cwd).then((commands) => alive && setState({ key, commands, loading: false }))
    return () => {
      alive = false
    }
  }, [agent, cwd, key, active])
  return state.key === key ? state : { commands: [], loading: active }
}

export function filterCommands(commands: SlashCommand[], q: string): SlashCommand[] {
  const query = q.toLowerCase()
  if (!query) return commands
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(query))
  // Descriptions only count once the query is specific enough to mean something.
  const contains = commands.filter((c) => !starts.includes(c) && (c.name.toLowerCase().includes(query) || (query.length >= 3 && c.description?.toLowerCase().includes(query))))
  return [...starts, ...contains]
}

export function SlashMenu({
  agent,
  items,
  loading,
  index,
  onPick,
  onHover
}: {
  agent: AgentId
  items: SlashCommand[]
  loading: boolean
  index: number
  onPick: (c: SlashCommand) => void
  onHover: (i: number) => void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])
  const label = useMemo(() => AGENT_LABELS[agent], [agent])
  return (
    <div className="fade-up absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-xl border border-line bg-panel shadow-[var(--shadow)]">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5 text-[11.5px] text-fg-4">
        <span>{label} commands</span>
        <span className="ml-auto">↑↓ to choose · Tab to complete · Enter to run</span>
      </div>
      <div ref={list} className="max-h-[260px] overflow-x-hidden overflow-y-auto py-1">
        {items.map((c, i) => (
          <button
            key={`${c.source ?? ''}:${c.name}`}
            data-i={i}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault() // keep focus in the text box
              onPick(c)
            }}
            className={clsx('flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px]', i === index ? 'bg-raised-2' : 'hover:bg-raised')}
          >
            <span className="shrink-0 font-mono text-fg">/{c.name}</span>
            {c.argumentHint && (
              <span title={c.argumentHint} className="max-w-[38%] shrink-0 truncate font-mono text-[12px] text-fg-4">
                {c.argumentHint}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{c.description}</span>
            {c.source && c.source !== 'built-in' && <span className="shrink-0 rounded bg-raised-2 px-1.5 py-px text-[10.5px] text-fg-4">{c.source}</span>}
          </button>
        ))}
        {!items.length && (
          <div className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-fg-4">
            {loading ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Loading {label}'s commands…
              </>
            ) : (
              `No matching ${label} commands`
            )}
          </div>
        )}
      </div>
    </div>
  )
}
