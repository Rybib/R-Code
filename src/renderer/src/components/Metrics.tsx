import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Minimize2, RefreshCw, Sparkles } from 'lucide-react'
import { AGENT_LABELS, type AgentId, type PlanUsage } from '@shared/types'
import { useStore } from '../store'
import { api } from '../lib/api'
import { MenuItem, Popover } from './ui'

// The two glanceable boxes above the composer: plan Usage (Claude Code / Codex subscriptions)
// and the chat's Context window. Each shows a ring + percent; click for details and actions.

const levelColor = (pct: number): string => (pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)')

function Ring({ pct, size = 15 }: { pct: number; size?: number }): React.JSX.Element {
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" className="shrink-0 -rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.4" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke={levelColor(pct)}
        strokeWidth="2.4"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)}
        strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  )
}

const MetricButton = ({ label, pct, open, onClick, btn, title }: { label: string; pct: number; open: boolean; onClick: () => void; btn: React.RefObject<HTMLButtonElement | null>; title: string }): React.JSX.Element => (
  <button
    ref={btn}
    onClick={onClick}
    title={title}
    className={clsx(
      'flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] transition-colors',
      open ? 'border-line bg-raised-2 text-fg' : 'border-line-soft bg-raised/50 text-fg-3 hover:border-line hover:text-fg-2'
    )}
  >
    <span>{label}</span>
    <Ring pct={pct} />
    <span className="font-medium text-fg-2 tabular-nums">{Math.round(pct)}%</span>
  </button>
)

function Bar({ pct }: { pct: number }): React.JSX.Element {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, pct)}%`, background: levelColor(pct) }} />
    </div>
  )
}

function resetText(at?: number): string | null {
  if (!at) return null
  const ms = at - Date.now()
  if (ms <= 0) return 'Resets now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `Resets in ${mins}m`
  if (mins < 24 * 60) return `Resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  return `Resets ${new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

/** Subscription usage for Claude Code or Codex. Hidden for Pi and for API-key logins. */
export function UsageMeter({ agent }: { agent: AgentId }): React.JSX.Element | null {
  const usage: PlanUsage | null | undefined = useStore((s) => s.planUsage[agent])
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const cli = agent === 'claude' || agent === 'codex'

  useEffect(() => {
    if (cli) void api.usage(agent).then((u) => useStore.setState((s) => ({ planUsage: { ...s.planUsage, [agent]: u } })))
  }, [agent, cli])

  if (!cli || !usage || !usage.windows.length) return null
  const session = usage.windows[0]
  const refresh = async (force = true): Promise<void> => {
    setRefreshing(true)
    try {
      const u = await api.usage(agent, force)
      useStore.setState((s) => ({ planUsage: { ...s.planUsage, [agent]: u } }))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      <MetricButton
        label="Usage"
        pct={session.usedPercent}
        open={open}
        onClick={() => (setOpen(!open), open || void refresh(false))}
        btn={btn}
        title={`${AGENT_LABELS[agent]} plan usage — ${session.label}: ${Math.round(session.usedPercent)}% used`}
      />
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-end" className="w-80 p-3.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-fg">Plan usage</span>
          <span className="text-[12px] text-fg-3">{AGENT_LABELS[agent]}</span>
          {usage.plan && <span className="ml-auto rounded-md bg-accent/15 px-1.5 py-px text-[11px] font-medium text-accent">{usage.plan}</span>}
        </div>
        <div className="mt-3 flex flex-col gap-3.5">
          {usage.windows.map((w) => (
            <div key={w.id}>
              <div className="mb-1.5 flex items-baseline gap-2 text-[12px]">
                <span className="text-fg-2">{w.label}</span>
                <span className="ml-auto font-medium text-fg tabular-nums">{Math.round(w.usedPercent)}% used</span>
              </div>
              <Bar pct={w.usedPercent} />
              {resetText(w.resetsAt) && <div className="mt-1 text-[11px] text-fg-4">{resetText(w.resetsAt)}</div>}
            </div>
          ))}
        </div>
        <div className="mt-3.5 flex items-center border-t border-line-soft pt-2.5 text-[11px] text-fg-4">
          Updated {ago(usage.fetchedAt)}
          <button onClick={() => void refresh()} title="Refresh" className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-fg-3 hover:bg-raised-2 hover:text-fg">
            <RefreshCw size={12} className={clsx(refreshing && 'animate-spin')} />
          </button>
        </div>
      </Popover>
    </>
  )
}

/** How full this chat's context window is, with compaction / fresh-chat actions. */
export function ContextMeter({ pct, tokens, window, threadId, running, cost }: { pct: number; tokens: number; window: number; threadId: string; running: boolean; cost?: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const openThread = useStore((s) => s.openThread)
  return (
    <>
      <MetricButton label="Context" pct={pct} open={open} onClick={() => setOpen(!open)} btn={btn} title={`Context window: ${Math.round(pct)}% used`} />
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-end" className="w-72 p-3.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg">Context window</span>
          <span className="ml-auto text-[12px] font-medium text-fg tabular-nums">{Math.round(pct)}%</span>
        </div>
        <div className="mt-1 text-[12px] text-fg-3">
          {Math.round(tokens / 1000)}k of {Math.round(window / 1000)}k tokens{cost ? ` · $${cost.toFixed(2)} this chat` : ''}
        </div>
        <div className="mt-2.5">
          <Bar pct={pct} />
        </div>
        <div className="mt-3 flex flex-col gap-1">
          <MenuItem icon={<Minimize2 size={14} />} onClick={() => (setOpen(false), void api.compact(threadId))}>
            <span className={clsx(running && 'opacity-50')}>Compact now</span>
          </MenuItem>
          <MenuItem
            icon={<Sparkles size={14} />}
            onClick={async () => {
              setOpen(false)
              const t = await api.continueFresh(threadId)
              await openThread(t.id)
            }}
          >
            Continue in a fresh chat
          </MenuItem>
        </div>
      </Popover>
    </>
  )
}
