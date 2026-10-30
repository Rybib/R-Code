import { useRef, useState } from 'react'
import clsx from 'clsx'
import { Gauge } from 'lucide-react'
import type { ModelOption } from '@shared/types'
import { useStore } from '../store'
import { Popover } from './ui'
import type { Selection } from './ModelPicker'

// Reasoning effort as a slider. The stops come from the selected model (Claude, Codex and Pi
// models each support different levels), so it always offers exactly what the model accepts.

const LABELS: Record<string, string> = { xhigh: 'X-High', max: 'Max', none: 'None', off: 'Off' }

export function effortLabel(e: string): string {
  return LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1)
}

/** Steps the effort by `delta` stops when the mouse wheel moves far enough; returns a wheel handler. */
function useWheelStep(efforts: string[], value: string, onChange: (e: string) => void): (e: React.WheelEvent) => void {
  const acc = useRef(0)
  return (e) => {
    acc.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? -e.deltaY : e.deltaX
    if (Math.abs(acc.current) < 40) return
    const dir = Math.sign(acc.current)
    acc.current = 0
    const i = Math.min(efforts.length - 1, Math.max(0, efforts.indexOf(value) + dir))
    if (efforts[i] !== value) onChange(efforts[i])
  }
}

export function EffortSlider({ efforts, value, onChange }: { efforts: string[]; value: string; onChange: (effort: string) => void }): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(false) // read by pointermove before React re-renders
  const n = efforts.length
  const idx = Math.max(0, efforts.indexOf(value))
  const pctOf = (i: number): number => (n > 1 ? (i / (n - 1)) * 100 : 50)
  const onWheel = useWheelStep(efforts, value, onChange)

  const stopAt = (clientX: number): number => {
    const r = track.current!.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return Math.round(t * (n - 1))
  }
  const set = (i: number): void => {
    const e = efforts[Math.min(n - 1, Math.max(0, i))]
    if (e !== value) onChange(e)
  }

  return (
    <div className="px-1 select-none" onWheel={onWheel}>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={idx}
        aria-valuetext={effortLabel(efforts[idx])}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* synthetic pointer */
          }
          drag.current = true
          setDragging(true)
          set(stopAt(e.clientX))
        }}
        onPointerMove={(e) => drag.current && set(stopAt(e.clientX))}
        onPointerUp={() => ((drag.current = false), setDragging(false))}
        onPointerCancel={() => ((drag.current = false), setDragging(false))}
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]
          if (step) set(idx + step)
          else if (e.key === 'Home') set(0)
          else if (e.key === 'End') set(n - 1)
          else return
          e.preventDefault()
        }}
        className="group relative mx-2 flex h-6 cursor-pointer items-center rounded-full outline-none"
      >
        <div className="absolute inset-x-0 h-[5px] rounded-full bg-raised-2" />
        <div
          className={clsx('absolute left-0 h-[5px] rounded-full bg-accent', !dragging && 'transition-[width] duration-150 ease-out')}
          style={{ width: `${pctOf(idx)}%` }}
        />
        {efforts.map((e, i) => (
          <span
            key={e}
            className={clsx('absolute h-[7px] w-[7px] -translate-x-1/2 rounded-full transition-colors', i <= idx ? 'bg-accent' : 'bg-fg-4/50')}
            style={{ left: `${pctOf(i)}%` }}
          />
        ))}
        <span
          className={clsx(
            'absolute h-4 w-4 -translate-x-1/2 rounded-full border-2 border-accent bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)] group-focus-visible:ring-2 group-focus-visible:ring-accent/50',
            dragging ? 'scale-110' : 'transition-[left,transform] duration-150 ease-out'
          )}
          style={{ left: `${pctOf(idx)}%` }}
        />
      </div>
      <div className="relative mx-2 mt-1 h-4">
        {efforts.map((e, i) => (
          <button
            key={e}
            tabIndex={-1}
            onClick={() => set(i)}
            className={clsx(
              'absolute top-0 text-[11px] whitespace-nowrap transition-colors',
              i === 0 ? 'left-0' : i === n - 1 ? 'right-0' : '-translate-x-1/2',
              i === idx ? 'font-medium text-fg' : 'text-fg-4 hover:text-fg-2'
            )}
            style={i === 0 || i === n - 1 ? undefined : { left: `${pctOf(i)}%` }}
          >
            {effortLabel(e)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Small level meter: one bar per stop, filled up to the current level. */
function Meter({ n, idx }: { n: number; idx: number }): React.JSX.Element {
  return (
    <span className="flex h-3 items-end gap-[2px]">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={clsx('w-[3px] rounded-[1px] transition-colors', i <= idx ? 'bg-accent' : 'bg-fg-4/40')} style={{ height: `${35 + (65 * i) / Math.max(1, n - 1)}%` }} />
      ))}
    </span>
  )
}

/** Composer chip: shows the current effort, opens the slider, and scrolls through levels on hover. */
export function EffortControl({ value, onChange }: { value: Selection; onChange: (sel: Selection) => void }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const current: ModelOption | undefined = useStore((s) => s.models[value.agent]?.find((m) => m.id === value.model))
  const efforts = current?.efforts ?? []
  const effort = value.effort && efforts.includes(value.effort) ? value.effort : (current?.defaultEffort ?? efforts[Math.floor(efforts.length / 2)])
  const change = (e: string): void => onChange({ ...value, effort: e })
  const onWheel = useWheelStep(efforts, effort ?? '', change)
  if (efforts.length < 2 || !effort) return null
  const idx = efforts.indexOf(effort)

  return (
    <>
      <button
        ref={btn}
        title="Reasoning effort — click to adjust, or scroll over it"
        onClick={() => setOpen(!open)}
        onWheel={onWheel}
        className={clsx('no-drag inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-fg-2 transition-colors hover:bg-raised-2 hover:text-fg', open && 'bg-raised-2 text-fg')}
      >
        <Meter n={efforts.length} idx={idx} />
        <span>{effortLabel(effort)}</span>
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-end" className="w-[300px]">
        <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2.5">
          <Gauge size={13} className="text-fg-3" />
          <span className="text-[12.5px] font-medium text-fg">Effort</span>
          <span className="ml-auto truncate text-[11.5px] text-fg-4">{current?.label}</span>
        </div>
        <EffortSlider efforts={efforts} value={effort} onChange={change} />
        <div className="px-2.5 pt-2 pb-1 text-[11px] text-fg-4">Higher effort thinks longer: better on hard problems, slower and pricier.</div>
      </Popover>
    </>
  )
}
