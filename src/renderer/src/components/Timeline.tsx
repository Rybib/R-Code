import { memo, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  Copy,
  FileEdit,
  FileText,
  Globe,
  Info,
  Layers,
  ListTodo,
  Plug,
  Search,
  ShieldQuestion,
  Sparkles,
  SquareTerminal,
  Users,
  Volume2,
  VolumeX,
  Wrench,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Scissors,
  Smartphone
} from 'lucide-react'
import { AGENT_LABELS, type TimelineItem, type ToolKind } from '@shared/types'
import { Markdown } from './Markdown'
import { AgentIcon, Spinner } from './ui'
import { api } from '../lib/api'
import { useStore } from '../store'
import { speak, stopSpeaking, useVoice } from '../voice/voice'
import { DiffCounts, FileIcon } from './FileIcon'
import { FaviconStack, SourceList, sitesOf, type Site } from './Favicon'
import { diffStats } from '@shared/diffstat'

function statsOf(t: ToolItem): { added: number; removed: number } {
  return t.added !== undefined ? { added: t.added, removed: t.removed ?? 0 } : diffStats(t.diff)
}

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>
type ReasoningItem = Extract<TimelineItem, { kind: 'reasoning' }>

type AssistantItem = Extract<TimelineItem, { kind: 'assistant' }>
type WorkEntry = ToolItem | ReasoningItem

/** A stretch of work between written replies: tool calls plus the thinking around them. */
type Block = { type: 'item'; item: TimelineItem } | { type: 'work'; id: string; entries: WorkEntry[] }

function buildBlocks(items: TimelineItem[]): Block[] {
  const blocks: Block[] = []
  for (const it of items) {
    if (it.parentId) continue
    // A delegation card already represents R-Code's delegate_task call.
    if (it.kind === 'tool' && /delegate_task$/.test(it.tool)) continue
    if (it.kind === 'tool' || it.kind === 'reasoning') {
      if (it.kind === 'reasoning' && !it.text.trim() && !it.streaming) continue
      const last = blocks[blocks.length - 1]
      if (last?.type === 'work') last.entries.push(it)
      else blocks.push({ type: 'work', id: it.id, entries: [it] })
    } else if (it.kind === 'assistant' && !it.text.trim() && !it.streaming) {
      continue
    } else {
      blocks.push({ type: 'item', item: it })
    }
  }
  return blocks
}

/** What a finished task did, shown on its final reply. */
interface FinalInfo {
  tools: ToolItem[]
  startTs: number
  endTs: number
}

/** The closing reply of each completed task that did real work (tools), keyed by item id. */
function finalReplies(items: TimelineItem[], running: boolean): Map<string, FinalInfo> {
  const out = new Map<string, FinalInfo>()
  let start = 0
  let tools: ToolItem[] = []
  let last: AssistantItem | undefined
  const close = (): void => {
    if (last && tools.length) out.set(last.id, { tools, startTs: start, endTs: Math.max(last.ts, ...tools.map((t) => t.ts)) })
  }
  for (const it of items) {
    if (it.parentId) continue
    if (it.kind === 'user' && !it.queued) {
      close()
      start = it.ts
      tools = []
      last = undefined
    } else if (it.kind === 'tool' && !/delegate_task$/.test(it.tool)) {
      tools.push(it)
      last = undefined // a reply followed by more work isn't the final one
    } else if (it.kind === 'assistant' && it.text.trim()) last = it
  }
  if (!running) close()
  return out
}

export function Timeline({ threadId, items, running }: { threadId: string; items: TimelineItem[]; running: boolean }): React.JSX.Element {
  const blocks = useMemo(() => buildBlocks(items), [items])
  const finals = useMemo(() => finalReplies(items, running), [items, running])
  const children = useMemo(() => {
    const map: Record<string, TimelineItem[]> = {}
    for (const it of items) if (it.parentId) (map[it.parentId] ??= []).push(it)
    return map
  }, [items])

  const last = blocks[blocks.length - 1]
  const waiting = running && (!last || (last.type === 'item' && (last.item.kind === 'user' || last.item.kind === 'handoff')) || (last.type === 'item' && last.item.kind === 'assistant' && !last.item.streaming))

  let lastAgent: string | undefined
  return (
    <div className="flex flex-col gap-3 pb-6">
      {blocks.map((b, i) => {
        if (b.type === 'work') {
          const live = running && i === blocks.length - 1
          if (!b.entries.some((e) => e.kind === 'tool')) return b.entries.map((e) => <Thought key={e.id} item={e as ReasoningItem} />)
          return <ToolGroup key={b.id} entries={b.entries} childMap={children} live={live} />
        }
        const it = b.item
        if (it.kind === 'assistant') {
          const showLabel = it.agent !== lastAgent
          lastAgent = it.agent
          return <AssistantMessage key={it.id} item={it} showLabel={showLabel} final={finals.get(it.id)} />
        }
        if (it.kind === 'handoff') lastAgent = undefined
        return <ItemView key={it.id} item={it} threadId={threadId} />
      })}
      {waiting && (
        <div className="fade-up flex items-center gap-2 py-1 text-[13px]">
          <span className="shimmer-text font-medium">Working…</span>
        </div>
      )}
    </div>
  )
}

const ItemView = memo(function ItemView({ item, threadId }: { item: TimelineItem; threadId: string }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />
    case 'approval':
      return <ApprovalCard item={item} />
    case 'notice':
      return <Notice item={item} threadId={threadId} />
    case 'handoff':
      return (
        <Divider icon={<ArrowRightLeft size={12} />}>
          Switched from {AGENT_LABELS[item.from]} to <span className="text-fg-2">{AGENT_LABELS[item.to]}</span> — context carried over
        </Divider>
      )
    case 'compaction':
      return (
        <Divider icon={<Scissors size={12} />}>
          Context compacted{item.tokensBefore ? ` (was ${Math.round(item.tokensBefore / 1000)}k tokens)` : ''}
        </Divider>
      )
    case 'delegation':
      return <DelegationCard item={item} />
    default:
      return null
  }
})

function Divider({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1 text-[12px] text-fg-3">
      <div className="h-px flex-1 bg-line-soft" />
      <span className="flex items-center gap-1.5">
        {icon}
        {children}
      </span>
      <div className="h-px flex-1 bg-line-soft" />
    </div>
  )
}

function UserBubble({ item }: { item: Extract<TimelineItem, { kind: 'user' }> }): React.JSX.Element {
  return (
    <div className="fade-up flex justify-end pt-2 pl-16">
      <div className="flex max-w-full flex-col items-end gap-1.5">
        {item.images && item.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {item.images.map((img, i) => (
              <img key={i} src={`data:${img.mimeType};base64,${img.data}`} className="max-h-40 rounded-xl border border-line object-cover" alt={img.name} />
            ))}
          </div>
        )}
        <div
          className={clsx(
            'selectable rounded-[18px] rounded-tr-md px-3.5 py-2 text-[length:var(--chat-font-size)] leading-[1.5] whitespace-pre-wrap text-white',
            item.queued ? 'bg-bubble/50' : 'bg-bubble'
          )}
          style={{ wordBreak: 'break-word' }}
        >
          {item.text}
        </div>
        {item.queued && <span className="text-[11px] text-fg-4">Queued — sends when the agent finishes</span>}
      </div>
    </div>
  )
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

/** Header strip of the finished-task card: time taken, files changed (+/−), commands run. */
function FinalHeader({ final }: { final: FinalInfo }): React.JSX.Element {
  const edits = editedFiles(final.tools)
  const commands = final.tools.filter((t) => t.toolKind === 'command').length
  const failed = final.tools.filter((t) => t.status === 'error').length
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-ok/15 px-3.5 py-2 text-[12px] text-fg-3">
      <span className="flex items-center gap-1.5 font-medium text-ok">
        <CheckCircle2 size={14} />
        Done
      </span>
      <span>worked for {duration(final.endTs - final.startTs)}</span>
      <span className="ml-auto flex items-center gap-2.5">
        <EditSummary files={edits} />
        {commands > 0 && <span>{commands === 1 ? '1 command' : `${commands} commands`}</span>}
        {failed > 0 && <span className="text-danger/80">{failed} failed</span>}
      </span>
    </div>
  )
}

function AssistantMessage({ item, showLabel, final }: { item: AssistantItem; showLabel: boolean; final?: FinalInfo }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const speakingId = useVoice((s) => s.speakingId)
  const speakError = useVoice((s) => (s.speakError?.id === item.id ? s.speakError.message : null))
  const ttsLoading = useVoice((s) => (s.speakingId === item.id && s.tts.status === 'loading' ? s.tts.progress : null))
  const ttsEnabled = useStore((s) => s.settings.ttsEnabled)
  const voice = useStore((s) => s.settings.ttsVoice)
  const speed = useStore((s) => s.settings.ttsSpeed)
  const models = useStore((s) => s.models[item.agent])
  const modelName = item.model && item.model !== 'default' ? (models?.find((m) => m.id === item.model)?.label ?? item.model.split('/').pop()) : undefined
  const speaking = speakingId === item.id
  return (
    <div className="group fade-up">
      {showLabel && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-fg-3">
          <AgentIcon agent={item.agent} size={12} />
          <span>{AGENT_LABELS[item.agent]}</span>
          {modelName && <span className="text-fg-4">· {modelName}</span>}
        </div>
      )}
      {final ? (
        <div className="overflow-hidden rounded-xl border border-ok/25 bg-ok/[0.035] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
          <FinalHeader final={final} />
          <div className="px-3.5 pt-2.5 pb-1">
            <Markdown text={item.text} />
          </div>
        </div>
      ) : (
        <Markdown text={item.text} />
      )}
      {item.streaming && <span className="ml-0.5 inline-block h-[1.1em] w-[7px] translate-y-[3px] animate-pulse rounded-[2px] bg-fg-3" />}
      {!item.streaming && item.text && (
        <div className={clsx('mt-1 flex h-6 items-center gap-0.5 transition-opacity duration-150 group-hover:opacity-100', speaking || speakError ? 'opacity-100' : 'opacity-0')}>
          <button
            title="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(item.text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-3 hover:bg-raised-2 hover:text-fg"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {ttsEnabled && (
            <button
              title={speaking ? 'Stop reading' : 'Read aloud'}
              onClick={() => (speaking ? stopSpeaking() : void speak(item.id, item.text, voice, speed).catch(() => {}))}
              className={clsx('flex h-6 w-6 items-center justify-center rounded-md hover:bg-raised-2 hover:text-fg', speaking ? 'text-accent' : 'text-fg-3')}
            >
              {speaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
          )}
          {ttsLoading !== null && <span className="ml-1 text-[11.5px] text-fg-3">Loading voice {Math.round(ttsLoading * 100)}%…</span>}
          {speakError && !speaking && (
            <span className="ml-1 max-w-[420px] truncate text-[11.5px] text-danger" title={speakError}>
              Couldn’t read aloud: {speakError}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function Thought({ item, nested }: { item: ReasoningItem; nested?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const secs = item.durationMs ? Math.max(1, Math.round(item.durationMs / 1000)) : null
  return (
    <div className={nested ? 'px-2.5 py-1' : 'fade-up'}>
      <button onClick={() => setOpen(!open)} className={clsx('flex items-center gap-2 py-0.5 text-fg-3 transition-colors hover:text-fg-2', nested ? 'text-[12.5px]' : 'text-[13px]')}>
        {nested ? <Sparkles size={12} className="text-fg-4" /> : <span className="tracking-[0.2em]">···</span>}
        <span className={clsx(item.streaming && 'shimmer-text')}>{item.streaming ? 'Thinking' : secs ? `Thought for ${secs}s` : 'Thought'}</span>
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="selectable mt-1 ml-1 border-l-2 border-line pl-3.5 text-[13px] leading-relaxed whitespace-pre-wrap text-fg-3">{item.text}</div>
      )}
    </div>
  )
}

const KIND_ICON: Record<ToolKind, React.ComponentType<{ size?: number; className?: string }>> = {
  command: SquareTerminal,
  edit: FileEdit,
  read: FileText,
  search: Search,
  web: Globe,
  task: Users,
  browser: Globe,
  ios: Smartphone,
  mcp: Plug,
  todo: ListTodo,
  other: Wrench
}

function summarize(items: ToolItem[], skipEdits = false): string {
  const counts: Partial<Record<ToolKind, number>> = {}
  const edited = new Set<string>()
  for (const t of items) {
    if (t.toolKind === 'edit') edited.add(t.title.replace(/^(Edit|Write|Create|Delete)\s+/, ''))
    else counts[t.toolKind] = (counts[t.toolKind] ?? 0) + 1
  }
  const parts: string[] = []
  const plural = (n: number, s: string, p = s + 's'): string => `${n} ${n === 1 ? s : p}`
  if (edited.size) parts.push(`edited ${plural(edited.size, 'file')}`)
  if (edited.size && skipEdits) parts.pop()
  if (counts.command) parts.push(`ran ${plural(counts.command, 'command')}`)
  if (counts.read) parts.push(`read ${plural(counts.read, 'file')}`)
  if (counts.search) parts.push(`searched ${plural(counts.search, 'time')}`)
  if (counts.web) parts.push(`searched the web ${plural(counts.web, 'time')}`)
  if (counts.browser) parts.push(`used the browser ${plural(counts.browser, 'time')}`)
  if (counts.ios) parts.push(`used the Simulator ${plural(counts.ios, 'time')}`)
  if (counts.task) parts.push(`ran ${plural(counts.task, 'subagent')}`)
  if (counts.mcp) parts.push(`used ${plural(counts.mcp, 'tool')}`)
  if (counts.todo) parts.push('updated the plan')
  if (counts.other) parts.push(`used ${plural(counts.other, 'tool')}`)
  const s = parts.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Edited files in a group with their summed +/- counts, in first-touched order. */
function editedFiles(items: ToolItem[]): { file: string; added: number; removed: number }[] {
  const map = new Map<string, { file: string; added: number; removed: number }>()
  for (const t of items) {
    if (t.toolKind !== 'edit') continue
    if (t.files?.length) {
      for (const f of t.files) {
        const cur = map.get(f.path) ?? { file: f.path, added: 0, removed: 0 }
        cur.added += f.added
        cur.removed += f.removed
        map.set(f.path, cur)
      }
      continue
    }
    const file = t.file ?? t.title.replace(/^(Edit|Write|Create|Delete)\s+/, '')
    const cur = map.get(file) ?? { file, added: 0, removed: 0 }
    const st = statsOf(t)
    cur.added += st.added
    cur.removed += st.removed
    map.set(file, cur)
  }
  return [...map.values()]
}

function EditSummary({ files }: { files: { file: string; added: number; removed: number }[] }): React.JSX.Element | null {
  if (!files.length) return null
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span>Edited</span>
      {files.length === 1 ? (
        <span className="flex items-center gap-1 text-fg-2">
          <FileIcon path={files[0].file} size={13} />
          {files[0].file.split('/').pop()}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-fg-2">
          <span className="flex -space-x-1">
            {files.slice(0, 4).map((f) => (
              <FileIcon key={f.file} path={f.file} size={13} className="rounded-sm ring-1 ring-[var(--panel)]" />
            ))}
          </span>
          {files.length} files
        </span>
      )}
      <DiffCounts added={added} removed={removed} />
    </span>
  )
}

function ToolGroup({ entries, childMap, live }: { entries: WorkEntry[]; childMap: Record<string, TimelineItem[]>; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const items = useMemo(() => entries.filter((e): e is ToolItem => e.kind === 'tool'), [entries])
  const running = items.some((t) => t.status === 'running')
  const failed = items.filter((t) => t.status === 'error').length
  const current = [...items].reverse().find((t) => t.status === 'running')
  const lastEntry = entries[entries.length - 1]
  const thinking = live && lastEntry?.kind === 'reasoning' && lastEntry.streaming
  const edits = editedFiles(items)
  const rest = summarize(items, true)
  const sites = useMemo(() => {
    const all = new Map<string, Site>()
    for (const t of items) for (const site of sitesOf(t)) if (!all.has(site.host)) all.set(site.host, site)
    return [...all.values()]
  }, [items])
  const busy = live && (running || thinking)
  return (
    <div className="fade-up">
      <button onClick={() => setOpen(!open)} className="group flex w-full items-center gap-2 py-0.5 text-left text-[13px] text-fg-3 transition-colors hover:text-fg-2">
        <span className="tracking-[0.2em]">···</span>
        {/* The running tally stays visible and grows as the agent works: "Ran 3 commands". */}
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          <EditSummary files={edits} />
          {rest && <span>{edits.length ? `· ${rest.charAt(0).toLowerCase()}${rest.slice(1)}` : rest}</span>}
          {!busy && <FaviconStack sites={sites} size={13} max={5} />}
        </span>
        {busy && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-fg-4">·</span>
            {current?.file && <FileIcon path={current.file} size={13} />}
            <span className="shimmer-text truncate">{current ? current.title : 'Thinking'}</span>
          </span>
        )}
        {failed > 0 && !running && <span className="shrink-0 text-danger/80">· {failed} failed</span>}
        {busy ? <div className="squiggle ml-1 min-w-8 flex-1" /> : <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-0.5 rounded-xl border border-line-soft bg-raised/50 p-1">
          {entries.map((e) =>
            e.kind === 'tool' ? <ToolRow key={e.id} item={e} childItems={childMap[e.id]} childMap={childMap} /> : <Thought key={e.id} item={e} nested />
          )}
        </div>
      )}
    </div>
  )
}

function ToolRow({ item, childItems, childMap }: { item: ToolItem; childItems?: TimelineItem[]; childMap: Record<string, TimelineItem[]> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = KIND_ICON[item.toolKind] ?? Wrench
  const sites = useMemo(() => sitesOf(item), [item])
  const hasBody = !!(item.output || item.diff || (item.detail && item.detail.includes('\n')) || childItems?.length)
  return (
    <div className="rounded-lg">
      <button
        onClick={() => hasBody && setOpen(!open)}
        className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px]', hasBody && 'hover:bg-raised-2')}
      >
        {item.status === 'running' ? (
          <Spinner size={13} />
        ) : item.files?.length ? (
          <span className="flex -space-x-1">
            {item.files.slice(0, 4).map((f) => (
              <FileIcon key={f.path} path={f.path} size={14} className="rounded-sm ring-1 ring-[var(--raised)]" />
            ))}
          </span>
        ) : item.file && (item.toolKind === 'edit' || item.toolKind === 'read') ? (
          <FileIcon path={item.file} size={14} className={item.status === 'error' ? 'opacity-50' : ''} />
        ) : sites.length && item.status !== 'error' ? (
          <FaviconStack sites={sites} size={14} max={3} />
        ) : (
          <Icon size={13} className={item.status === 'error' ? 'text-danger' : 'text-fg-3'} />
        )}
        <span className="shrink-0 text-fg-2">{item.title}</span>
        {item.toolKind === 'edit' && <DiffCounts {...statsOf(item)} />}
        {item.detail && item.toolKind === 'command' && <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">{item.detail.split('\n')[0]}</code>}
        {!(item.detail && item.toolKind === 'command') && <span className="flex-1" />}
        {childItems?.length ? <span className="text-[11px] text-fg-4">{childItems.filter((c) => c.kind === 'tool').length} steps</span> : null}
        {hasBody && <ChevronRight size={12} className={clsx('shrink-0 text-fg-4 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="mx-2.5 mb-2 flex flex-col gap-2">
          <SourceList sites={sites} />
          {item.detail && (item.toolKind !== 'command' || item.detail.includes('\n')) && item.toolKind !== 'task' && (
            <pre className="selectable max-h-48 overflow-auto rounded-lg bg-[var(--code-bg)] p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-fg-2">{item.detail}</pre>
          )}
          {item.toolKind === 'task' && item.detail && <div className="selectable rounded-lg bg-[var(--code-bg)] p-2.5 text-[12px] whitespace-pre-wrap text-fg-2">{item.detail}</div>}
          {childItems && childItems.length > 0 && (
            <div className="rounded-lg border border-line-soft p-1">
              {childItems.map((c) =>
                c.kind === 'tool' ? (
                  <ToolRow key={c.id} item={c} childItems={childMap[c.id]} childMap={childMap} />
                ) : c.kind === 'assistant' && c.text.trim() ? (
                  <div key={c.id} className="px-2.5 py-1.5 text-[12.5px] text-fg-2">
                    <Markdown text={c.text} />
                  </div>
                ) : null
              )}
            </div>
          )}
          {item.diff && <DiffView diff={item.diff} />}
          {item.output && (
            <pre className="selectable max-h-72 overflow-auto rounded-lg bg-[var(--code-bg)] p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-fg-3">{item.output}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n').slice(0, 800)
  return (
    <div className="selectable max-h-80 overflow-auto rounded-lg bg-[var(--code-bg)] py-1.5 font-mono text-[11.5px] leading-[1.55]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={clsx(
            'px-2.5 whitespace-pre',
            l.startsWith('+') && !l.startsWith('+++') && 'bg-ok/10 text-ok',
            l.startsWith('-') && !l.startsWith('---') && 'bg-danger/10 text-danger',
            (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++')) && 'text-fg-4'
          )}
        >
          {l || ' '}
        </div>
      ))}
    </div>
  )
}

function ApprovalCard({ item }: { item: Extract<TimelineItem, { kind: 'approval' }> }): React.JSX.Element {
  const pending = item.status === 'pending'
  return (
    <div className={clsx('fade-up overflow-hidden rounded-xl border', pending ? 'border-warn/40 bg-warn/[0.06]' : 'border-line-soft bg-raised/40')}>
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <ShieldQuestion size={15} className={clsx('mt-0.5 shrink-0', pending ? 'text-warn' : 'text-fg-4')} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{item.title}</div>
          {item.detail && <pre className="selectable mt-1.5 max-h-48 overflow-auto rounded-lg bg-[var(--code-bg)] p-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg-2">{item.detail}</pre>}
        </div>
      </div>
      {pending ? (
        <div className="flex items-center justify-end gap-1.5 border-t border-warn/20 px-3 py-2">
          <button onClick={() => void api.respondApproval(item.requestId, 'deny')} className="h-7 rounded-lg px-3 text-[12.5px] text-fg-2 hover:bg-raised-2">
            Deny
          </button>
          <button onClick={() => void api.respondApproval(item.requestId, 'approveSession')} className="h-7 rounded-lg bg-raised-2 px-3 text-[12.5px] text-fg hover:bg-frame-active">
            Always allow this chat
          </button>
          <button onClick={() => void api.respondApproval(item.requestId, 'approve')} className="h-7 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110">
            Allow
          </button>
        </div>
      ) : (
        <div className="border-t border-line-soft px-3.5 py-1.5 text-[11.5px] text-fg-3">
          {item.status === 'denied' ? 'Denied' : item.status === 'approvedSession' ? 'Allowed for this chat' : 'Allowed'}
        </div>
      )}
    </div>
  )
}

function Notice({ item, threadId }: { item: Extract<TimelineItem, { kind: 'notice' }>; threadId: string }): React.JSX.Element {
  const openThread = useStore((s) => s.openThread)
  const [busy, setBusy] = useState(false)
  const Icon = item.tone === 'error' ? AlertTriangle : item.tone === 'warn' ? AlertTriangle : item.tone === 'success' ? CheckCircle2 : Info
  return (
    <div
      className={clsx(
        'fade-up flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px]',
        item.tone === 'error' && 'border-danger/30 bg-danger/[0.07] text-fg',
        item.tone === 'warn' && 'border-warn/30 bg-warn/[0.06] text-fg',
        item.tone === 'info' && 'border-line-soft bg-raised/40 text-fg-2',
        item.tone === 'success' && 'border-ok/25 bg-ok/[0.06] text-fg-2'
      )}
    >
      <Icon size={14} className={clsx('mt-0.5 shrink-0', item.tone === 'error' ? 'text-danger' : item.tone === 'warn' ? 'text-warn' : item.tone === 'success' ? 'text-ok' : 'text-fg-3')} />
      <div className="selectable min-w-0 flex-1 whitespace-pre-wrap" style={{ wordBreak: 'break-word' }}>
        {item.text}
      </div>
      {item.action?.kind === 'signIn' && (
        <button
          onClick={() => void api.loginAgent(item.action!.payload as any)}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110"
        >
          {item.action.label}
        </button>
      )}
      {item.action?.kind === 'newChatWithSummary' && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const t = await api.continueFresh(threadId, item.action!.payload || undefined)
            await openThread(t.id)
          }}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          <Sparkles size={12} />
          {item.action.label}
        </button>
      )}
    </div>
  )
}

function DelegationCard({ item }: { item: Extract<TimelineItem, { kind: 'delegation' }> }): React.JSX.Element {
  const openThread = useStore((s) => s.openThread)
  const [open, setOpen] = useState(false)
  return (
    <div className="fade-up overflow-hidden rounded-xl border border-line-soft bg-raised/50">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <Layers size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] text-fg">
            Delegated to <AgentIcon agent={item.agent} size={12} /> {AGENT_LABELS[item.agent]}
            {item.model && item.model !== 'default' && <span className="text-fg-3">· {item.model.split('/').pop()}</span>}
            {item.status === 'running' && <Spinner size={12} className="ml-1" />}
            {item.status === 'done' && <CheckCircle2 size={13} className="ml-1 text-ok" />}
            {item.status === 'error' && <AlertTriangle size={13} className="ml-1 text-danger" />}
          </div>
          <button onClick={() => setOpen(!open)} className="mt-0.5 block w-full truncate text-left text-[12px] text-fg-3 hover:text-fg-2">
            {item.task}
          </button>
        </div>
        <button onClick={() => void openThread(item.childThreadId)} className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[12px] text-fg-2 hover:bg-raised-2 hover:text-fg">
          Open <ExternalLink size={11} />
        </button>
      </div>
      {open && (
        <div className="border-t border-line-soft px-3.5 py-2.5">
          <div className="selectable text-[12.5px] whitespace-pre-wrap text-fg-2">{item.task}</div>
          {item.result && (
            <div className="mt-2 border-t border-line-soft pt-2">
              <Markdown text={item.result} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
