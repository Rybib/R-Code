import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Bot, Plus, Square, SquareTerminal, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { IconButton } from './ui'

const r = (): any => (window as any).rcode

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  kind: 'shell' | 'agent'
  command?: string
  threadId?: string
  agent?: string
  running: boolean
  exitCode?: number | null
  createdAt: number
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function themeFromCss(): Record<string, string> {
  return {
    background: cssVar('--code-bg', '#171a1e'),
    foreground: cssVar('--text', '#e7e8ea'),
    cursor: cssVar('--accent', '#3773ef'),
    cursorAccent: cssVar('--code-bg', '#171a1e'),
    selectionBackground: 'rgba(55, 115, 239, 0.35)'
  }
}

export function TerminalPanel(): React.JSX.Element {
  const [terms, setTerms] = useState<TerminalInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const activeTerminal = useStore((s) => s.activeTerminal)
  const set = useStore((s) => s.set)
  const projectPath = useStore((s) => (s.activeId ? s.threads[s.activeId]?.projectPath : s.draft.projectPath))
  const home = useStore((s) => s.home)
  const creating = useRef(false)

  const active = terms.find((t) => t.id === activeTerminal) ?? terms[terms.length - 1]

  const newShell = useCallback(async () => {
    if (creating.current) return
    creating.current = true
    try {
      const res = await r().invoke('terminal:create', { cwd: projectPath || home })
      if (res?.ok) {
        setError(null)
        set({ activeTerminal: res.info.id })
      } else setError(res?.error ?? 'Could not open a terminal.')
    } finally {
      creating.current = false
    }
  }, [projectPath, home, set])

  useEffect(() => {
    let first = true
    void r()
      .invoke('terminal:list')
      .then((list: TerminalInfo[]) => {
        setTerms(list)
        // Opening the panel with nothing in it starts a shell, like any terminal app.
        if (first && list.length === 0) void newShell()
        first = false
      })
    return r().on('terminal-list', (list: TerminalInfo[]) => setTerms(list))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line-soft px-2">
        {terms.map((t) => (
          <div
            key={t.id}
            onClick={() => set({ activeTerminal: t.id })}
            title={`${t.command ?? t.title}\n${t.cwd}`}
            className={clsx(
              'group flex h-7 max-w-[180px] shrink-0 cursor-default items-center gap-1.5 rounded-lg pr-1 pl-2 text-[12px] transition-colors',
              active?.id === t.id ? 'bg-raised-2 text-fg' : 'text-fg-3 hover:text-fg'
            )}
          >
            {t.kind === 'agent' ? <Bot size={12} className="shrink-0" /> : <SquareTerminal size={12} className="shrink-0" />}
            <span className="truncate">{t.title}</span>
            <span className={clsx('size-1.5 shrink-0 rounded-full', t.running ? 'bg-ok' : t.exitCode ? 'bg-danger' : 'bg-fg-4')} />
            <button
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation()
                void r().invoke('terminal:close', t.id)
              }}
              className="flex size-4 shrink-0 items-center justify-center rounded text-fg-4 opacity-0 group-hover:opacity-100 hover:text-fg"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <IconButton title="New terminal" onClick={() => void newShell()}>
          <Plus size={14} />
        </IconButton>
        <div className="flex-1" />
        {active?.running && (
          <IconButton title="Stop the running process" onClick={() => void r().invoke('terminal:kill', active.id)}>
            <Square size={12} />
          </IconButton>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-[var(--code-bg)]">
        {active ? (
          <TerminalView key={active.id} info={active} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-fg-3">
            <SquareTerminal size={22} className="text-fg-4" />
            {error ?? 'No terminals open.'}
            <button onClick={() => void newShell()} className="text-accent hover:underline">
              Open a terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** One xterm bound to one PTY. Remounted per tab; it redraws from the main process's history. */
function TerminalView({ info }: { info: TerminalInfo }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const fontSize = 12.5
  const codeFont = useStore((s) => s.settings.codeFontFamily)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      fontFamily: `${codeFont ? `'${codeFont}', ` : ''}'SF Mono', Menlo, monospace`,
      fontSize,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: themeFromCss()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    // Output that arrives while the history is loading is held, then de-duplicated by offset.
    let shownUpTo = -1
    const early: { start: number; data: string }[] = []
    const show = (start: number, data: string): void => {
      const end = start + data.length
      if (end <= shownUpTo) return
      term.write(start < shownUpTo ? data.slice(shownUpTo - start) : data)
      shownUpTo = end
    }
    const offData = r().on('terminal-data', (ev: { id: string; start: number; data: string }) => {
      if (ev.id !== info.id) return
      if (shownUpTo < 0) early.push(ev)
      else show(ev.start, ev.data)
    })
    void r()
      .invoke('terminal:history', info.id)
      .then((h: { data: string; end: number } | null) => {
        if (h) {
          term.write(h.data)
          shownUpTo = h.end
        } else shownUpTo = 0
        for (const ev of early.splice(0)) show(ev.start, ev.data)
      })

    const input = term.onData((data) => void r().invoke('terminal:write', info.id, data))
    const resize = (): void => {
      if (!el.clientWidth || !el.clientHeight) return
      try {
        fit.fit()
      } catch {
        return
      }
      void r().invoke('terminal:resize', info.id, term.cols, term.rows)
    }
    const ro = new ResizeObserver(() => requestAnimationFrame(resize))
    ro.observe(el)
    requestAnimationFrame(() => {
      resize()
      term.focus()
    })
    // Follow light/dark switches.
    const mo = new MutationObserver(() => (term.options.theme = themeFromCss()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })

    return () => {
      offData()
      input.dispose()
      ro.disconnect()
      mo.disconnect()
      term.dispose()
    }
  }, [info.id, codeFont])

  return <div ref={host} className="absolute inset-0 overflow-hidden py-1 pl-2" />
}
