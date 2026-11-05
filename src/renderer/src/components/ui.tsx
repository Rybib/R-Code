import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { AgentId } from '@shared/types'
import { useStore } from '../store'

export function Logo({ size = 140, className }: { size?: number; className?: string }): React.JSX.Element {
  // R-Code's mark, flat: the </> from the app icon in glassy blue. Logo3D is the live version.
  const glyphs = 'M60 54 L32 80 L60 106 M91 42 L69 118 M100 54 L128 80 L100 106'
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" className={className} aria-hidden>
      <defs>
        <linearGradient id="rc-fill" x1="24" y1="30" x2="136" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#d9e8ff" />
          <stop offset="0.5" stopColor="#7aa8ff" />
          <stop offset="1" stopColor="#3773ef" />
        </linearGradient>
        <linearGradient id="rc-shine" x1="30" y1="30" x2="120" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.15" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={glyphs} fill="none" stroke="url(#rc-fill)" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" />
      <path d={glyphs} fill="none" stroke="url(#rc-shine)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" transform="translate(-1.5 -2.5)" />
    </svg>
  )
}

export function AgentIcon({ agent, size = 14, className }: { agent: AgentId; size?: number; className?: string }): React.JSX.Element {
  if (agent === 'claude')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Claude Code">
        <g stroke="#d97757" strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
        </g>
      </svg>
    )
  if (agent === 'codex')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Codex">
        <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" opacity="0.14" />
        <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13.2 7.5l-2.4 9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="Pi">
      <circle cx="12" cy="12" r="10.5" fill="#7c6cf2" opacity="0.2" />
      <path d="M6.5 8.5h11M10 8.5v8.5M14.4 8.5v6.6c0 1.2.6 1.9 1.9 1.9" fill="none" stroke="#a99cff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40',
        checked ? 'bg-ok' : 'bg-fg-4/50'
      )}
    >
      <span
        className={clsx(
          'absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200',
          checked && 'translate-x-[14px]'
        )}
      />
    </button>
  )
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  className,
  title
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[background-color,transform,opacity] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3.5 text-[13px]',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'secondary' && 'bg-raised-2 text-fg hover:bg-frame-active',
        variant === 'ghost' && 'text-fg-2 hover:bg-raised-2 hover:text-fg',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
        className
      )}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  onClick,
  title,
  className,
  active,
  disabled
}: {
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
  title?: string
  className?: string
  active?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-3 transition-colors duration-150 hover:bg-frame-hover hover:text-fg disabled:opacity-40',
        active && 'bg-frame-hover text-fg',
        className
      )}
    >
      {children}
    </button>
  )
}

/** Anchored popover rendered in a portal; closes on outside click or Escape. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'bottom-start',
  className,
  offset = 6
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: ReactNode
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  className?: string
  offset?: number
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = (): void => {
      const a = anchor.getBoundingClientRect()
      const el = ref.current
      const w = el?.offsetWidth ?? 0
      const h = el?.offsetHeight ?? 0
      let left = placement.endsWith('end') ? a.right - w : a.left
      let top = placement.startsWith('top') ? a.top - h - offset : a.bottom + offset
      if (placement.startsWith('bottom') && top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - offset)
      if (placement.startsWith('top') && top < 8) top = a.bottom + offset
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      setPos({ left, top, origin: `${placement.endsWith('end') ? 'right' : 'left'} ${placement.startsWith('top') ? 'bottom' : 'top'}` })
    }
    place()
    const ro = new ResizeObserver(place)
    if (ref.current) ro.observe(ref.current)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [open, anchor, placement, offset])

  useEffect(() => {
    if (!open) return
    useStore.setState({ popoverOpen: true })
    return () => useStore.setState({ popoverOpen: false })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, anchor, onClose])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, ['--origin' as any]: pos?.origin }}
      className={clsx('pop-in fixed z-50 rounded-xl border border-line bg-raised p-1 text-[13px] shadow-[var(--shadow)]', className)}
    >
      {children}
    </div>,
    document.body
  )
}

export function MenuItem({
  children,
  onClick,
  active,
  icon,
  hint,
  danger
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  icon?: ReactNode
  hint?: ReactNode
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-frame-hover',
        active && 'bg-frame-hover',
        danger ? 'text-danger' : 'text-fg'
      )}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center text-fg-3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* The hint (a path, a shortcut…) gives way first so the label always shows. */}
      {hint && <span className="flex max-w-[40%] min-w-0 shrink-0 items-center justify-end truncate text-[11.5px] text-fg-3 [&>span]:truncate">{hint}</span>}
    </button>
  )
}

export function Card({ title, subtitle, children, actions }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-raised/60">
      {(title || actions) && (
        <header className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-[13px] font-semibold text-fg">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-[12px] text-fg-3">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Select<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={clsx('h-8 rounded-lg border border-field-border bg-field px-2.5 text-[13px] text-fg outline-none focus:border-accent', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...props}
      className={clsx(
        'selectable h-8 rounded-lg border border-field-border bg-field px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4 focus:border-accent',
        props.className
      )}
    />
  )
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={clsx('animate-spin text-fg-3', className)}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'off' | 'error' }): React.JSX.Element {
  return (
    <span
      className={clsx(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        tone === 'ok' && 'bg-ok',
        tone === 'warn' && 'bg-warn',
        tone === 'error' && 'bg-danger',
        tone === 'off' && 'bg-fg-4'
      )}
    />
  )
}
