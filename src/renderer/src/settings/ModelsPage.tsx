import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Check, Download, KeyRound, Plus, Play, RefreshCw, Trash2, Server, Cpu } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { Button, Card, Row, Select, Spinner, StatusDot, TextInput, Toggle } from '../components/ui'
import { PageTitle } from './Settings'

type OllamaInfo = Awaited<ReturnType<typeof api.ollamaStatus>>

const SUGGESTED = ['qwen3-coder:30b', 'qwen3.5:9b', 'gpt-oss:20b', 'gemma4:12b', 'devstral:24b', 'llama3.2:3b']

export function useOllama(): { info: OllamaInfo | null; exposed: string[]; refresh: () => Promise<void>; setExposed: (m: string[]) => Promise<void>; syncing: boolean } {
  const [info, setInfo] = useState<OllamaInfo | null>(null)
  const [exposed, setExposedState] = useState<string[]>([])
  const [syncing, setSyncing] = useState(false)
  const loadModels = useStore((s) => s.loadModels)
  const refresh = useCallback(async () => {
    const [st, ex] = await Promise.all([api.ollamaStatus(), api.ollamaPiModels()])
    setInfo(st)
    setExposedState(ex)
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const setExposed = async (models: string[]): Promise<void> => {
    setExposedState(models)
    setSyncing(true)
    try {
      await api.syncOllama(models)
      useStore.setState((s) => ({ settings: { ...s.settings, ollama: { ...s.settings.ollama, models, enabled: models.length > 0 } } }))
      await loadModels('pi', true)
    } finally {
      setSyncing(false)
    }
  }
  return { info, exposed, refresh, setExposed, syncing }
}

export function OllamaCard(): React.JSX.Element {
  const { info, exposed, refresh, setExposed, syncing } = useOllama()
  const logs = useStore((s) => s.installLogs.ollama)
  const [pullName, setPullName] = useState('')
  const [pulling, setPulling] = useState(false)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)

  const pull = async (name: string): Promise<void> => {
    if (!name.trim()) return
    setPulling(true)
    useStore.setState((s) => ({ installLogs: { ...s.installLogs, ollama: [] } }))
    const ok = await api.pullOllama(name.trim())
    setPulling(false)
    await refresh()
    if (ok) await setExposed([...new Set([...exposed, name.trim()])])
  }

  const fmt = (n: number): string => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)
  const lastLog = logs?.[logs.length - 1]

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Server size={14} /> Ollama · local models
        </span>
      }
      subtitle="Run open models on this Mac. Pick which ones the built-in Pi agent can use — they then show up in every model picker."
      actions={
        <button onClick={() => void refresh()} className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 hover:bg-raised-2 hover:text-fg" title="Refresh">
          <RefreshCw size={13} />
        </button>
      }
    >
      {!info ? (
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-fg-3">
          <Spinner size={12} /> Checking Ollama…
        </div>
      ) : !info.running ? (
        <div className="flex items-center gap-3 py-1.5">
          <StatusDot tone={info.installed ? 'warn' : 'off'} />
          <span className="flex-1 text-[13px] text-fg-2">{info.installed ? 'Ollama is installed but not running.' : 'Ollama is not installed.'}</span>
          {info.installed ? (
            <Button size="sm" variant="primary" onClick={async () => (await api.startOllama(), setTimeout(() => void refresh(), 2500))}>
              <Play size={12} /> Start Ollama
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={async () => (await api.installOllama(), void refresh())}>
              <Download size={12} /> Install Ollama
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 pb-2 text-[12.5px] text-fg-3">
            <StatusDot tone="ok" /> Running{info.version ? ` · v${info.version}` : ''} · {settings.ollama.baseUrl}
            {syncing && <Spinner size={11} className="ml-1" />}
          </div>
          <div className="flex flex-col gap-px">
            {info.models.length === 0 && <p className="py-2 text-[12.5px] text-fg-3">No models pulled yet — pull one below.</p>}
            {info.models.map((m) => {
              const on = exposed.includes(m.name)
              return (
                <label key={m.name} className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-raised-2/50">
                  <Toggle checked={on} onChange={(v) => void setExposed(v ? [...exposed, m.name] : exposed.filter((x) => x !== m.name))} />
                  <Cpu size={13} className="text-fg-3" />
                  <span className="flex-1 font-mono text-[12.5px] text-fg">{m.name}</span>
                  <span className="text-[11.5px] text-fg-4">
                    {m.parameterSize ? `${m.parameterSize} · ` : ''}
                    {fmt(m.size)}
                  </span>
                </label>
              )
            })}
            {exposed
              .filter((e) => !info.models.some((m) => m.name === e))
              .map((e) => (
                <div key={e} className="flex items-center gap-3 px-1 py-1.5 text-[12.5px] text-fg-4">
                  <span className="flex-1 font-mono">{e}</span>
                  <span>configured in Pi but not pulled</span>
                  <button onClick={() => void setExposed(exposed.filter((x) => x !== e))} className="text-fg-3 hover:text-danger">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-line-soft pt-3">
            <TextInput
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void pull(pullName)}
              placeholder="Pull a model, e.g. qwen3-coder:30b"
              className="flex-1 font-mono"
            />
            <Button size="sm" variant="primary" disabled={pulling || !pullName.trim()} onClick={() => void pull(pullName)}>
              {pulling ? <Spinner size={12} className="text-white" /> : <Download size={12} />} Pull
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTED.filter((s) => !info.models.some((m) => m.name === s)).map((s) => (
              <button key={s} onClick={() => setPullName(s)} className="rounded-md bg-raised-2 px-2 py-0.5 font-mono text-[11.5px] text-fg-3 hover:text-fg">
                {s}
              </button>
            ))}
          </div>
          {pulling && lastLog && <p className="mt-2 font-mono text-[11.5px] text-fg-3">{lastLog}</p>}
        </>
      )}
      <Row label="Server URL" hint="Change this to use Ollama on another machine (e.g. over Tailscale).">
        <TextInput
          defaultValue={settings.ollama.baseUrl}
          onBlur={(e) => e.target.value !== settings.ollama.baseUrl && void setSettings({ ollama: { ...settings.ollama, baseUrl: e.target.value.replace(/\/$/, '') } }).then(refresh)}
          className="w-64 font-mono"
        />
      </Row>
    </Card>
  )
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  xai: 'xAI',
  cerebras: 'Cerebras',
  together: 'Together AI',
  fireworks: 'Fireworks',
  huggingface: 'Hugging Face'
}

function KeysCard(): React.JSX.Element {
  const [keys, setKeys] = useState<{ provider: string; hasKey: boolean }[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const loadModels = useStore((s) => s.loadModels)
  const refresh = async (): Promise<void> => setKeys(await api.piKeys())
  useEffect(() => {
    void refresh()
  }, [])
  const save = async (provider: string, key: string | null): Promise<void> => {
    await api.setPiKey(provider, key)
    setEditing(null)
    setValue('')
    await refresh()
    await loadModels('pi', true)
  }
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <KeyRound size={14} /> Cloud providers
        </span>
      }
      subtitle="API keys for the built-in Pi agent, stored in ~/.pi/agent/auth.json (readable only by you). Subscriptions (Claude Pro/Max, ChatGPT, Copilot) can be connected with Sign in on the Agents page."
    >
      {keys.map((k) => (
        <div key={k.provider} className="flex h-10 items-center gap-3 border-b border-line-soft last:border-0">
          <span className="w-36 text-[13px] text-fg">{PROVIDER_LABELS[k.provider] ?? k.provider}</span>
          {editing === k.provider ? (
            <>
              <TextInput
                autoFocus
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(k.provider, value.trim())}
                placeholder="Paste API key"
                className="flex-1"
              />
              <Button size="sm" variant="primary" disabled={!value.trim()} onClick={() => void save(k.provider, value.trim())}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className={clsx('flex flex-1 items-center gap-1.5 text-[12.5px]', k.hasKey ? 'text-ok' : 'text-fg-4')}>
                {k.hasKey ? (
                  <>
                    <Check size={12} /> Connected
                  </>
                ) : (
                  'Not set'
                )}
              </span>
              <Button size="sm" variant="ghost" onClick={() => (setEditing(k.provider), setValue(''))}>
                {k.hasKey ? 'Replace' : 'Add key'}
              </Button>
              {k.hasKey && (
                <Button size="sm" variant="ghost" onClick={() => void save(k.provider, null)}>
                  <Trash2 size={12} />
                </Button>
              )}
            </>
          )}
        </div>
      ))}
    </Card>
  )
}

interface EndpointDraft {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string
}

function EndpointsCard(): React.JSX.Element {
  const [data, setData] = useState<any>(null)
  const [draft, setDraft] = useState<EndpointDraft | null>(null)
  const loadModels = useStore((s) => s.loadModels)
  const refresh = async (): Promise<void> => setData(await api.piModelsJson())
  useEffect(() => {
    void refresh()
  }, [])
  const providers = useMemo(() => Object.entries<any>(data?.providers ?? {}).filter(([id]) => id !== 'ollama'), [data])

  const save = async (): Promise<void> => {
    if (!draft || !draft.id.trim() || !draft.baseUrl.trim()) return
    const next = { ...(data ?? {}), providers: { ...(data?.providers ?? {}) } }
    const prev = next.providers[draft.id] ?? {}
    const prevModels = new Map<string, any>((prev.models ?? []).map((m: any) => [m.id, m]))
    next.providers[draft.id.trim()] = {
      ...prev,
      name: draft.name || undefined,
      api: prev.api ?? 'openai-completions',
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim() || prev.apiKey || 'none',
      models: draft.models
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter(Boolean)
        .map((id) => prevModels.get(id) ?? { id, contextWindow: 131072, input: ['text'] })
    }
    await api.writePiModelsJson(next)
    setDraft(null)
    await refresh()
    await loadModels('pi', true)
  }

  const remove = async (id: string): Promise<void> => {
    const next = { ...data, providers: { ...data.providers } }
    delete next.providers[id]
    await api.writePiModelsJson(next)
    await refresh()
    await loadModels('pi', true)
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Server size={14} /> Custom endpoints
        </span>
      }
      subtitle="Any OpenAI-compatible server — LM Studio, llama.cpp, vLLM, a GPU box on your network. Saved to ~/.pi/agent/models.json."
      actions={
        <Button size="sm" variant="secondary" onClick={() => setDraft({ id: '', name: '', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', models: '' })}>
          <Plus size={12} /> Add
        </Button>
      }
    >
      {providers.length === 0 && !draft && <p className="py-2 text-[12.5px] text-fg-3">No custom endpoints yet.</p>}
      {providers.map(([id, p]) => (
        <div key={id} className="flex items-center gap-3 border-b border-line-soft py-2 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-fg">{p.name ?? id}</div>
            <div className="truncate font-mono text-[11.5px] text-fg-3">
              {p.baseUrl} · {(p.models ?? []).map((m: any) => m.id).join(', ') || 'no models'}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft({ id, name: p.name ?? '', baseUrl: p.baseUrl ?? '', apiKey: '', models: (p.models ?? []).map((m: any) => m.id).join('\n') })}
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void remove(id)}>
            <Trash2 size={12} />
          </Button>
        </div>
      ))}
      {draft && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-line-soft p-3">
          <div className="flex gap-2">
            <TextInput placeholder="id (e.g. lmstudio)" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.replace(/\s/g, '-').toLowerCase() })} className="w-40" />
            <TextInput placeholder="Display name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="flex-1" />
          </div>
          <TextInput placeholder="Base URL, e.g. http://127.0.0.1:1234/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} className="font-mono" />
          <TextInput type="password" placeholder="API key (optional; leave blank to keep)" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          <textarea
            placeholder="Model ids, one per line"
            value={draft.models}
            onChange={(e) => setDraft({ ...draft, models: e.target.value })}
            className="selectable min-h-20 rounded-lg border border-field-border bg-field p-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Save endpoint
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

export function ModelsPage(): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  const piModels = useStore((st) => st.models.pi)
  const loadModels = useStore((st) => st.loadModels)
  return (
    <>
      <PageTitle title="Models & Providers" subtitle="Everything that isn't Claude Code or Codex runs through R-Code's built-in Pi agent — local models, your own servers, and any cloud provider." />
      <OllamaCard />
      <KeysCard />
      <EndpointsCard />
      <Card
        title="Built-in agent models"
        subtitle={`${piModels?.length ?? 0} models available to Pi right now.`}
        actions={
          <button onClick={() => void loadModels('pi', true)} className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 hover:bg-raised-2 hover:text-fg" title="Refresh">
            <RefreshCw size={13} />
          </button>
        }
      >
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto pb-2">
          {(piModels ?? []).map((m) => (
            <span key={m.id} className={clsx('rounded-md px-2 py-0.5 font-mono text-[11.5px]', m.local ? 'bg-ok/10 text-ok' : 'bg-raised-2 text-fg-2')}>
              {m.id}
            </span>
          ))}
        </div>
        <Row label="Default thinking level" hint="For reasoning-capable models used through Pi.">
          <Select
            value={s.piThinking}
            options={(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const).map((v) => ({ value: v, label: v }))}
            onChange={(v) => void setSettings({ piThinking: v })}
          />
        </Row>
        <Row label="Codex sandbox" hint="What Codex may touch when it is allowed to edit (Allow-all mode always gets full access).">
          <Select
            value={s.codexSandbox}
            options={[
              { value: 'workspace-write', label: 'Project folder' },
              { value: 'read-only', label: 'Read only' },
              { value: 'danger-full-access', label: 'Full access' }
            ]}
            onChange={(v) => void setSettings({ codexSandbox: v as any })}
          />
        </Row>
      </Card>
    </>
  )
}
