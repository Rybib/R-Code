import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Globe,
  Hammer,
  Home,
  Power,
  RotateCw,
  Smartphone,
  X,
  ExternalLink,
  Download,
  Terminal
} from 'lucide-react'
import { useStore } from '../store'
import { Button, IconButton, Spinner } from './ui'

const r = (): any => (window as any).rcode

export type PanelKind = 'browser' | 'simulator'

export function SidePanel(): React.JSX.Element | null {
  const panel = useStore((s) => s.panel)
  const width = useStore((s) => s.panelWidth)
  const set = useStore((s) => s.set)
  const dragging = useRef(false)

  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragging.current) return
      const w = Math.min(Math.max(window.innerWidth - e.clientX - 8, 320), window.innerWidth - 520)
      set({ panelWidth: w })
    }
    const up = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [set])

  if (!panel) return null
  return (
    <div className="relative flex h-full shrink-0 flex-col border-l border-line-soft" style={{ width }}>
      <div
        onMouseDown={() => {
          dragging.current = true
          document.body.style.cursor = 'col-resize'
        }}
        className="absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line-soft px-2">
        <PanelTab icon={<Globe size={13} />} label="Browser" active={panel === 'browser'} onClick={() => set({ panel: 'browser' })} />
        <PanelTab icon={<Smartphone size={13} />} label="Simulator" active={panel === 'simulator'} onClick={() => set({ panel: 'simulator' })} />
        <div className="flex-1" />
        <IconButton title="Close panel" onClick={() => set({ panel: null })}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">{panel === 'browser' ? <BrowserPanel /> : <SimulatorPanel />}</div>
    </div>
  )
}

function PanelTab({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} className={clsx('flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors', active ? 'bg-raised-2 text-fg' : 'text-fg-3 hover:text-fg')}>
      {icon}
      {label}
    </button>
  )
}

interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

function BrowserPanel(): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false })
  const [input, setInput] = useState('')
  const overlay = useStore((s) => s.searchOpen || !s.settings.onboarded || s.popoverOpen)

  useEffect(() => {
    void r().invoke('browser:state').then((s: BrowserState) => {
      setState(s)
      setInput(s.url === 'about:blank' ? '' : s.url)
    })
    return r().on('browser-state', (s: BrowserState) => {
      setState(s)
      setInput(s.url === 'about:blank' ? '' : s.url)
    })
  }, [])

  const report = useCallback(() => {
    const el = viewport.current
    if (!el || overlay) {
      void r().invoke('browser:bounds', null)
      return
    }
    const b = el.getBoundingClientRect()
    void r().invoke('browser:bounds', { x: b.left, y: b.top, width: b.width, height: b.height })
  }, [overlay])

  useLayoutEffect(() => {
    report()
    const ro = new ResizeObserver(report)
    if (viewport.current) ro.observe(viewport.current)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      void r().invoke('browser:bounds', null)
    }
  }, [report])

  const empty = !state.url || state.url === 'about:blank'
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line-soft px-2">
        <IconButton title="Back" disabled={!state.canGoBack} onClick={() => void r().invoke('browser:back')}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton title="Forward" disabled={!state.canGoForward} onClick={() => void r().invoke('browser:forward')}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton title="Reload" onClick={() => void r().invoke('browser:reload')}>
          {state.loading ? <Spinner size={13} /> : <RotateCw size={13} />}
        </IconButton>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) void r().invoke('browser:navigate', input.trim())
          }}
          onFocus={(e) => e.target.select()}
          placeholder="localhost:3000 or search…"
          className="selectable h-7 min-w-0 flex-1 rounded-lg border border-field-border bg-field px-2.5 font-mono text-[12px] text-fg outline-none placeholder:font-sans placeholder:text-fg-4 focus:border-accent"
        />
        <IconButton title="Developer tools" onClick={() => void r().invoke('browser:devtools')}>
          <Bug size={13} />
        </IconButton>
        <IconButton title="Open in default browser" disabled={empty} onClick={() => void r().invoke('shell:openExternal', state.url)}>
          <ExternalLink size={13} />
        </IconButton>
      </div>
      <div ref={viewport} className="relative min-h-0 flex-1 bg-white">
        {empty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-panel text-center text-[12.5px] text-fg-3">
            <Globe size={22} className="text-fg-4" />
            <div>Built-in browser</div>
            <div className="max-w-[260px] text-fg-4">Open a local dev server or any page. Agents can drive this browser too — they’ll show their work here.</div>
          </div>
        )}
      </div>
    </div>
  )
}

interface SimDevice {
  udid: string
  name: string
  state: string
  runtime: string
}

function SimulatorPanel(): React.JSX.Element {
  const [devices, setDevices] = useState<SimDevice[]>([])
  const [udid, setUdid] = useState<string>('')
  const [shot, setShot] = useState<{ data: string; width: number; height: number; scale: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [hasAxe, setHasAxe] = useState(true)
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const activeId = useStore((s) => s.activeId)
  const projectPath = useStore((s) => (s.activeId ? s.threads[s.activeId]?.projectPath : s.draft.projectPath))
  const device = devices.find((d) => d.udid === udid)
  const booted = device?.state === 'Booted'

  const refresh = useCallback(async () => {
    const list: SimDevice[] = await r().invoke('ios:devices')
    setDevices(list)
    setUdid((cur) => (cur && list.some((d) => d.udid === cur) ? cur : (list.find((d) => d.state === 'Booted') ?? list[0])?.udid ?? ''))
  }, [])

  useEffect(() => {
    void refresh()
    void r().invoke('ios:hasAxe').then(setHasAxe)
    return r().on('ios-log', (line: string) => setLog((l) => [...l.slice(-200), line]))
  }, [refresh])

  // Live view: poll screenshots while a booted device is shown.
  useEffect(() => {
    if (!booted) {
      setShot(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async (): Promise<void> => {
      const s = await r().invoke('ios:screenshot', udid)
      if (!alive) return
      if (s) setShot(s)
      timer = setTimeout(tick, document.hidden ? 2000 : 650)
    }
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [booted, udid])

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const onScreenClick = (e: React.MouseEvent<HTMLImageElement>): void => {
    if (!shot || !hasAxe) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * (shot.width / shot.scale)
    const y = ((e.clientY - rect.top) / rect.height) * (shot.height / shot.scale)
    void r().invoke('ios:tap', udid, x, y)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
        <select
          value={udid}
          onChange={(e) => setUdid(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded-lg border border-field-border bg-field px-2 text-[12px] text-fg outline-none focus:border-accent"
        >
          {devices.map((d) => (
            <option key={d.udid} value={d.udid}>
              {d.state === 'Booted' ? '● ' : ''}
              {d.name} · {d.runtime}
            </option>
          ))}
        </select>
        <IconButton title={booted ? 'Shut down' : 'Boot'} disabled={!udid || !!busy} onClick={() => void act(booted ? 'Shutting down' : 'Booting', () => r().invoke(booted ? 'ios:shutdown' : 'ios:boot', udid))}>
          <Power size={13} className={booted ? 'text-ok' : ''} />
        </IconButton>
        <IconButton title="Home" disabled={!booted || !hasAxe} onClick={() => void r().invoke('ios:home', udid)}>
          <Home size={13} />
        </IconButton>
        <IconButton title="Open Simulator app" onClick={() => void r().invoke('ios:openSimulatorApp')}>
          <ExternalLink size={13} />
        </IconButton>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-2 py-1.5">
        <Button
          size="sm"
          variant="primary"
          disabled={!projectPath || !!busy}
          title={projectPath ? `Build and run the Xcode project in ${projectPath}` : 'Open a project to build it'}
          onClick={() => {
            setShowLog(true)
            setLog([])
            void act('Building', async () => {
              const res = await r().invoke('ios:buildRun', projectPath, udid)
              setLog((l) => [...l, res.text])
            })
          }}
        >
          <Hammer size={12} /> Build & Run
        </Button>
        {busy && (
          <span className="flex items-center gap-1.5 text-[12px] text-fg-3">
            <Spinner size={11} /> {busy}…
          </span>
        )}
        <div className="flex-1" />
        <IconButton title="Build log" active={showLog} onClick={() => setShowLog(!showLog)}>
          <Terminal size={13} />
        </IconButton>
      </div>
      {!hasAxe && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-warn/[0.06] px-3 py-2 text-[12px] text-fg-2">
          <span className="flex-1">Install AXe to tap, type and inspect the simulator (you and the agents).</span>
          <Button size="sm" variant="secondary" onClick={() => void act('Installing AXe', async () => setHasAxe(await r().invoke('ios:installAxe')))}>
            <Download size={12} /> Install
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--code-bg)] p-4">
        {shot ? (
          <img
            src={`data:image/png;base64,${shot.data}`}
            onClick={onScreenClick}
            className={clsx('max-h-full max-w-full rounded-[28px] shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)] ring-1 ring-white/10', hasAxe && 'cursor-pointer')}
            alt="Simulator screen"
            draggable={false}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-center text-[12.5px] text-fg-3">
            <Smartphone size={26} className="text-fg-4" />
            {devices.length === 0 ? 'No simulators found — install one from Xcode.' : booted ? 'Loading screen…' : 'Simulator is off. Press the power button or Build & Run.'}
            {!activeId && !projectPath && <span className="text-fg-4">Tip: pick a project so Build & Run knows what to build.</span>}
          </div>
        )}
      </div>
      {showLog && (
        <pre className="selectable max-h-40 shrink-0 overflow-auto border-t border-line-soft p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-3">{log.join('\n') || 'No build output yet.'}</pre>
      )}
    </div>
  )
}
