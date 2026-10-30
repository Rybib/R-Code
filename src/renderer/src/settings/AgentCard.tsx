import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, Download, LogIn, RefreshCw, Terminal } from 'lucide-react'
import { AGENT_LABELS, type AgentId } from '@shared/types'
import { useStore } from '../store'
import { api } from '../lib/api'
import { AgentIcon, Button, Spinner, StatusDot, Toggle } from '../components/ui'
import { AGENT_BLURB } from '../components/ModelPicker'

export function useAgentActions(agent: AgentId): { install: () => Promise<boolean>; login: () => Promise<void>; link: (on: boolean) => Promise<void> } {
  const refreshAgents = useStore((s) => s.refreshAgents)
  const setSettings = useStore((s) => s.setSettings)
  return {
    async install() {
      useStore.setState((s) => ({ installing: { ...s.installing, [agent]: true }, installLogs: { ...s.installLogs, [agent]: [] } }))
      const ok = await api.installAgent(agent)
      useStore.setState((s) => ({ installing: { ...s.installing, [agent]: false } }))
      await refreshAgents()
      return ok
    },
    async login() {
      await api.loginAgent(agent)
    },
    async link(on) {
      const cur = useStore.getState().settings.linkedAgents
      const linkedAgents = on ? [...new Set([...cur, agent])] : cur.filter((a) => a !== agent)
      const patch: any = { linkedAgents }
      const s = useStore.getState().settings
      if (on && !linkedAgents.includes(s.defaultAgent)) patch.defaultAgent = agent
      if (!on && s.defaultAgent === agent && linkedAgents[0]) patch.defaultAgent = linkedAgents[0]
      await setSettings(patch)
      if (on) void useStore.getState().loadModels(agent)
    }
  }
}

export function AgentCard({ agent, compact }: { agent: AgentId; compact?: boolean }): React.JSX.Element {
  const status = useStore((s) => s.agents.find((a) => a.id === agent))
  const loading = useStore((s) => s.agentsLoading)
  const settings = useStore((s) => s.settings)
  const installing = useStore((s) => s.installing[agent])
  const logs = useStore((s) => s.installLogs[agent])
  const refreshAgents = useStore((s) => s.refreshAgents)
  const { install, login, link } = useAgentActions(agent)
  const linked = settings.linkedAgents.includes(agent)
  const builtIn = agent === 'pi'
  const logRef = useRef<HTMLPreElement>(null)
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])
  useEffect(() => {
    if (installing) setShowLog(true)
  }, [installing])

  const authTone = !status ? 'off' : !status.installed ? 'off' : status.authenticated === false ? 'warn' : 'ok'
  const statusText = !status
    ? 'Checking…'
    : !status.installed
      ? 'Not installed'
      : builtIn
        ? `Built in · v${status.version}${status.authDetail ? ` · ${status.authDetail}` : ''}`
        : `${status.version ? `v${status.version}` : 'Installed'}${status.authenticated === false ? ' · not signed in' : status.authDetail ? ` · ${status.authDetail}` : ''}`

  return (
    <div className={clsx('rounded-xl border transition-colors', linked ? 'border-accent/40 bg-accent/[0.05]' : 'border-line bg-raised/50')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised-2">
          <AgentIcon agent={agent} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium text-fg">
            {AGENT_LABELS[agent]}
            {builtIn && <span className="rounded bg-accent/15 px-1.5 py-px text-[10.5px] font-medium text-accent">BUILT-IN</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-3">
            {loading && !status ? <Spinner size={10} /> : <StatusDot tone={authTone} />}
            <span className="truncate">{statusText}</span>
          </div>
          {!compact && <div className="mt-0.5 text-[12px] text-fg-4">{AGENT_BLURB[agent]}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status && !status.installed && !builtIn && (
            <Button size="sm" variant="primary" disabled={installing} onClick={() => void install().then(async (ok) => { if (ok) await link(true) })}>
              {installing ? <Spinner size={12} className="text-white" /> : <Download size={13} />}
              {installing ? 'Installing…' : 'Install'}
            </Button>
          )}
          {status?.installed && status.authenticated === false && (
            <Button size="sm" variant={builtIn ? 'secondary' : 'primary'} onClick={() => void login()} title={builtIn ? 'Sign in to a subscription or add an API key in the built-in Pi' : undefined}>
              <LogIn size={13} />
              {builtIn ? 'Sign in…' : 'Sign in'}
            </Button>
          )}
          {status?.installed && (
            <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
              {linked ? 'Linked' : 'Link'}
              <Toggle checked={linked} onChange={(v) => void link(v)} />
            </label>
          )}
          <button title="Re-check" onClick={() => void refreshAgents()} className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 hover:bg-raised-2 hover:text-fg">
            <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
          </button>
        </div>
      </div>
      {logs && logs.length > 0 && (
        <div className="border-t border-line-soft px-4 py-2">
          <button onClick={() => setShowLog(!showLog)} className="flex items-center gap-1.5 text-[11.5px] text-fg-3 hover:text-fg-2">
            <Terminal size={12} /> {installing ? 'Installing…' : 'Install log'} {!installing && status?.installed && <Check size={12} className="text-ok" />}
          </button>
          {showLog && (
            <pre ref={logRef} className="selectable mt-1.5 max-h-36 overflow-auto rounded-lg bg-[var(--code-bg)] p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-3">
              {logs.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
