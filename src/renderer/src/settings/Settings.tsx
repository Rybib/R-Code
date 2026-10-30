import clsx from 'clsx'
import {
  ArrowLeft,
  Bot,
  Boxes,
  Archive,
  Info,
  Keyboard,
  Mic,
  Network,
  Settings2,
  Monitor,
  Sun,
  Moon,
  Trash2,
  RotateCcw,
  Wrench
} from 'lucide-react'
import { AGENT_IDS, AGENT_LABELS, PERMISSION_LABELS, type AgentId, type PermissionMode } from '@shared/types'
import { useStore, type SettingsPage } from '../store'
import { api } from '../lib/api'
import { AgentCard } from './AgentCard'
import { ModelsPage } from './ModelsPage'
import { VoicePage } from './VoicePage'
import { ToolsPage } from './ToolsPage'
import { AgentIcon, Button, Card, Logo, Row, Select, Toggle } from '../components/ui'
import { ModelPicker } from '../components/ModelPicker'

const PAGES: { id: SettingsPage; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'models', label: 'Models & Providers', icon: Boxes },
  { id: 'tools', label: 'Browser, iOS & Web', icon: Wrench },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'orchestration', label: 'Context & Orchestration', icon: Network },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
  { id: 'archived', label: 'Archived Chats', icon: Archive },
  { id: 'about', label: 'About', icon: Info }
]

export function SettingsView(): React.JSX.Element {
  const page = useStore((s) => s.settingsPage)
  const set = useStore((s) => s.set)
  return (
    <div className="flex h-full">
      <nav className="flex w-[220px] shrink-0 flex-col gap-px border-r border-line-soft p-2">
        <button onClick={() => set({ view: 'chat' })} className="mb-2 flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-fg-2 hover:bg-raised-2 hover:text-fg">
          <ArrowLeft size={14} /> Back
        </button>
        {PAGES.map((p) => (
          <button
            key={p.id}
            onClick={() => set({ settingsPage: p.id })}
            className={clsx(
              'flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
              page === p.id ? 'bg-raised-2 text-fg' : 'text-fg-2 hover:bg-raised-2/60 hover:text-fg'
            )}
          >
            <p.icon size={14} />
            {p.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div key={page} className="fade-up mx-auto flex max-w-[760px] flex-col gap-4 px-8 py-7">
          {page === 'general' && <GeneralPage />}
          {page === 'agents' && <AgentsPage />}
          {page === 'models' && <ModelsPage />}
          {page === 'voice' && <VoicePage />}
          {page === 'tools' && <ToolsPage />}
          {page === 'orchestration' && <OrchestrationPage />}
          {page === 'shortcuts' && <ShortcutsPage />}
          {page === 'archived' && <ArchivedPage />}
          {page === 'about' && <AboutPage />}
        </div>
      </div>
    </div>
  )
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }): React.JSX.Element {
  return (
    <div className="mb-1">
      <h1 className="text-[20px] font-semibold tracking-tight text-fg">{title}</h1>
      {subtitle && <p className="mt-1 text-[13px] text-fg-3">{subtitle}</p>}
    </div>
  )
}

const ACCENTS = ['#3773ef', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4']

function GeneralPage(): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  return (
    <>
      <PageTitle title="General" />
      <Card title="Appearance">
        <div className="flex gap-1 pb-2">
          {(
            [
              ['system', 'System', Monitor],
              ['light', 'Light', Sun],
              ['dark', 'Dark', Moon]
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => void setSettings({ theme: id })}
              className={clsx('flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] transition-colors', s.theme === id ? 'bg-raised-2 text-fg' : 'text-fg-3 hover:text-fg')}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <Row label="Translucent window" hint="Lets the desktop show through the sidebar (applies after restart).">
          <Toggle checked={s.translucent} onChange={(v) => void setSettings({ translucent: v })} />
        </Row>
        <Row label="Accent color">
          <div className="flex gap-1.5">
            {ACCENTS.map((c) => (
              <button
                key={c}
                onClick={() => void setSettings({ accent: c })}
                className={clsx('h-5 w-5 rounded-full transition-transform hover:scale-110', s.accent === c && 'ring-2 ring-fg/70 ring-offset-2 ring-offset-[var(--raised)]')}
                style={{ background: c }}
              />
            ))}
          </div>
        </Row>
      </Card>
      <Card title="Chat">
        <Row label="Chat font size">
          <Select
            value={String(s.chatFontSize)}
            options={[13, 14, 15, 16, 17, 18].map((n) => ({ value: String(n), label: `${n} px` }))}
            onChange={(v) => void setSettings({ chatFontSize: Number(v) })}
          />
        </Row>
        <Row label="Code font">
          <Select
            value={s.codeFontFamily}
            options={['Menlo', 'SF Mono', 'Monaco', 'JetBrains Mono', 'Fira Code'].map((f) => ({ value: f, label: f }))}
            onChange={(v) => void setSettings({ codeFontFamily: v })}
          />
        </Row>
        <Row label="Send with Enter" hint={s.sendWithEnter ? 'Enter sends, Shift+Enter adds a new line.' : 'Enter adds a new line, ⌘Enter sends.'}>
          <Toggle checked={s.sendWithEnter} onChange={(v) => void setSettings({ sendWithEnter: v })} />
        </Row>
        <Row label="Default permission mode" hint="How much agents may do without asking, for new chats.">
          <Select<PermissionMode>
            value={s.defaultPermissionMode}
            options={(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((m) => ({ value: m, label: PERMISSION_LABELS[m] }))}
            onChange={(v) => void setSettings({ defaultPermissionMode: v })}
          />
        </Row>
        <Row label="Name chats automatically" hint="Titles new chats from your first message.">
          <Toggle checked={s.autoTitle} onChange={(v) => void setSettings({ autoTitle: v })} />
        </Row>
      </Card>
    </>
  )
}

function AgentsPage(): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  const setDraft = useStore((st) => st.setDraft)
  return (
    <>
      <PageTitle title="Agents" subtitle="R-Code drives the Claude Code and Codex CLIs on your Mac, plus its own built-in Pi agent for every other model — local or cloud." />
      <div className="flex flex-col gap-2.5">
        {AGENT_IDS.map((a) => (
          <AgentCard key={a} agent={a} />
        ))}
      </div>
      <Card title="Defaults" subtitle="Used for new conversations and when an agent delegates work.">
        <Row label="Default agent">
          <div className="flex gap-1">
            {s.linkedAgents.map((a) => (
              <button
                key={a}
                onClick={() => {
                  void setSettings({ defaultAgent: a })
                  setDraft({ agent: a, model: s.defaultModels[a] ?? 'default' })
                }}
                className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px]', s.defaultAgent === a ? 'bg-raised-2 text-fg' : 'text-fg-3 hover:text-fg')}
              >
                <AgentIcon agent={a} size={13} /> {AGENT_LABELS[a]}
              </button>
            ))}
            {s.linkedAgents.length === 0 && <span className="text-[12.5px] text-fg-4">Link an agent first</span>}
          </div>
        </Row>
        {s.linkedAgents.map((a) => (
          <Row key={a} label={`${AGENT_LABELS[a]} default model`}>
            <DefaultModel agent={a} />
          </Row>
        ))}
      </Card>
    </>
  )
}

export function DefaultModel({ agent }: { agent: AgentId }): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  const setDraft = useStore((st) => st.setDraft)
  const draft = useStore((st) => st.draft)
  return (
    <ModelPicker
      placement="bottom-end"
      value={{ agent, model: s.defaultModels[agent] ?? 'default' }}
      onChange={(sel) => {
        void setSettings({ defaultModels: { ...s.defaultModels, [sel.agent]: sel.model } })
        if (draft.agent === sel.agent) setDraft({ model: sel.model, effort: sel.effort })
      }}
    />
  )
}

function OrchestrationPage(): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  return (
    <>
      <PageTitle title="Context & Orchestration" subtitle="How R-Code keeps context clean and lets your agents work together." />
      <Card title="Shared context">
        <Row label="Share context across agents" hint="When you switch agents mid-chat, the new agent receives a digest of everything the other agents and you did, so it picks up seamlessly.">
          <Toggle checked={s.shareContextAcrossAgents} onChange={(v) => void setSettings({ shareContextAcrossAgents: v })} />
        </Row>
      </Card>
      <Card title="Delegation & sub-agents">
        <Row
          label="Let agents delegate to each other"
          hint="Gives every agent R-Code tools: delegate_task (hand a self-contained job to Claude, Codex, or a local model via Pi), list_agents, and suggest_new_chat. Delegated work runs in its own clean chat that you can open."
        >
          <Toggle checked={s.enableDelegation} onChange={(v) => void setSettings({ enableDelegation: v })} />
        </Row>
        <p className="pb-2 text-[12px] text-fg-4">Claude Code&apos;s own sub-agents (the Task tool) and Codex&apos;s sub-agents keep working as usual and appear nested in the timeline.</p>
      </Card>
      <Card title="Context window">
        <Row label="Automatic compaction" hint="Agents summarize older context automatically as the window fills (built into Claude Code and Codex; enabled for Pi).">
          <Toggle checked={s.autoCompact} onChange={(v) => void setSettings({ autoCompact: v })} />
        </Row>
        <Row label="Suggest a fresh chat at" hint="Shows a one-click “Continue in a fresh chat” with a summary once the context is this full.">
          <Select
            value={String(s.suggestNewChatPct)}
            options={[50, 60, 70, 80, 90, 101].map((n) => ({ value: String(n), label: n > 100 ? 'Never' : `${n}%` }))}
            onChange={(v) => void setSettings({ suggestNewChatPct: Number(v) })}
          />
        </Row>
      </Card>
    </>
  )
}

function ShortcutsPage(): React.JSX.Element {
  const rows: [string, string][] = [
    ['New conversation (in this tab)', '⌘N'],
    ['New tab', '⌘T'],
    ['Search conversations', '⌘K'],
    ['Toggle sidebar', '⌘B'],
    ['Settings', '⌘,'],
    ['Add project', '⌘O'],
    ['Close tab', '⌘W'],
    ['Switch to tab 1–9', '⌘1 … ⌘9'],
    ['Dictate (start / stop)', '⌥Space'],
    ['Send message', '↵'],
    ['New line', '⇧↵'],
    ['Stop the agent', 'Esc']
  ]
  return (
    <>
      <PageTitle title="Keyboard Shortcuts" />
      <Card>
        {rows.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between border-b border-line-soft py-2 text-[13px] last:border-0">
            <span className="text-fg-2">{label}</span>
            <kbd className="rounded-md bg-raised-2 px-2 py-0.5 font-sans text-[12px] text-fg-2">{keys}</kbd>
          </div>
        ))}
      </Card>
    </>
  )
}

function ArchivedPage(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const archived = Object.values(threads)
    .filter((t) => t.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <>
      <PageTitle title="Archived Chats" />
      <Card>
        {archived.length === 0 && <p className="py-4 text-center text-[13px] text-fg-3">Nothing archived.</p>}
        {archived.map((t) => (
          <div key={t.id} className="flex items-center gap-3 border-b border-line-soft py-2 last:border-0">
            <AgentIcon agent={t.agent} size={14} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{t.title}</span>
            <Button size="sm" variant="ghost" onClick={() => void api.updateThread(t.id, { archived: false })}>
              <RotateCcw size={12} /> Restore
            </Button>
            <Button size="sm" variant="danger" onClick={() => void api.deleteThread(t.id)}>
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
      </Card>
    </>
  )
}

function AboutPage(): React.JSX.Element {
  const version = useStore((s) => s.version)
  const agents = useStore((s) => s.agents)
  return (
    <>
      <div className="flex flex-col items-center py-6 text-center">
        <Logo size={96} />
        <h1 className="mt-4 text-[22px] font-semibold text-fg">R-Code</h1>
        <p className="mt-1 text-[13px] text-fg-3">Version {version}</p>
        <p className="mt-3 max-w-md text-[13px] text-fg-2">One calm place for Claude Code, Codex and a built-in Pi agent — with shared context, delegation, and on-device voice.</p>
      </div>
      <Card title="Components">
        {agents.map((a) => (
          <Row key={a.id} label={AGENT_LABELS[a.id]} hint={a.path}>
            <span className="text-[12.5px] text-fg-3">{a.installed ? a.version || 'installed' : 'not installed'}</span>
          </Row>
        ))}
        <Row label="Speech to text" hint="OpenAI Whisper via transformers.js (on-device)">
          <span className="text-[12.5px] text-fg-3">onnx-community/whisper</span>
        </Row>
        <Row label="Text to speech" hint="Kokoro-82M, Apache-2.0 (on-device)">
          <span className="text-[12.5px] text-fg-3">onnx-community/Kokoro-82M</span>
        </Row>
      </Card>
    </>
  )
}
