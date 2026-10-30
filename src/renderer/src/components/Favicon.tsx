import { useState } from 'react'
import clsx from 'clsx'
import { Globe } from 'lucide-react'
import type { TimelineItem } from '@shared/types'
import { useStore } from '../store'

// Site icons for web activity (searches, page reads, browser visits), so you can see at a
// glance which sites an agent looked at. Icons load straight from each site, never through a
// third-party favicon service.

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

export interface Site {
  host: string
  url: string
}

const SKIP = /(^|\.)(duckduckgo\.com|duck\.ai|google\.[a-z.]+|bing\.com|localhost|127\.0\.0\.1)$/

/** Distinct sites mentioned by a web/browser tool call, in the order they appear. */
export function sitesOf(item: ToolItem, max = 12): Site[] {
  if (item.toolKind !== 'web' && item.toolKind !== 'browser') return []
  const text = [JSON.stringify(item.input ?? ''), item.detail ?? '', item.output ?? ''].join('\n')
  const seen = new Map<string, Site>()
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>()[\]{}\\]+/g)) {
    try {
      const u = new URL(m[0].replace(/[.,;:!?]+$/, ''))
      const host = u.hostname.replace(/^www\./, '')
      if (!host.includes('.') || SKIP.test(host) || seen.has(host)) continue
      seen.set(host, { host, url: u.href })
      if (seen.size >= max) break
    } catch {
      /* not a URL */
    }
  }
  return [...seen.values()]
}

// host -> icon URL found on the site's homepage (null = none), shared across all icons.
const resolved = new Map<string, Promise<string | null>>()

export function Favicon({ host, size = 14, className }: { host: string; size?: number; className?: string }): React.JSX.Element {
  // Try /favicon.ico first; if the site has none, ask the main process for its <link rel="icon">.
  const [src, setSrc] = useState<string | null>(`https://${host}/favicon.ico`)
  const [tried, setTried] = useState(false)
  if (!src) return <Globe size={size} className={clsx('shrink-0 text-fg-3', className)} />
  return (
    <img
      src={src}
      alt=""
      title={host}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        if (tried) return setSrc(null)
        setTried(true)
        if (!resolved.has(host)) resolved.set(host, window.rcode.invoke('favicon:resolve', host).catch(() => null))
        void resolved.get(host)!.then((url) => setSrc(url))
      }}
      className={clsx('shrink-0 rounded-[3px] bg-white/90 object-contain', className)}
      style={{ width: size, height: size }}
    />
  )
}

/** Overlapping row of site icons, e.g. for a search that read several pages. */
export function FaviconStack({ sites, size = 14, max = 4 }: { sites: Site[]; size?: number; max?: number }): React.JSX.Element | null {
  if (!sites.length) return null
  return (
    <span className="flex shrink-0 items-center">
      <span className="flex -space-x-1">
        {sites.slice(0, max).map((s) => (
          <Favicon key={s.host} host={s.host} size={size} className="ring-1 ring-[var(--raised)]" />
        ))}
      </span>
      {sites.length > max && <span className="ml-1 text-[11px] text-fg-4">+{sites.length - max}</span>}
    </span>
  )
}

/** Clickable source list shown when a web tool call is expanded; opens in the built-in browser. */
export function SourceList({ sites }: { sites: Site[] }): React.JSX.Element | null {
  if (!sites.length) return null
  const open = (url: string): void => {
    useStore.setState({ panel: 'browser' })
    void window.rcode.invoke('browser:navigate', url)
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {sites.map((s) => (
        <button
          key={s.host}
          title={s.url}
          onClick={() => open(s.url)}
          className="flex max-w-[260px] items-center gap-1.5 rounded-full border border-line-soft bg-raised px-2 py-0.5 text-[11.5px] text-fg-2 transition-colors hover:border-line hover:text-fg"
        >
          <Favicon host={s.host} size={12} />
          <span className="truncate">{s.host}</span>
        </button>
      ))}
    </div>
  )
}
