import { useEffect, useState } from 'react'
import { Check, Download, Globe, Search, Smartphone } from 'lucide-react'
import { useStore } from '../store'
import { Button, Card, Row, Select, Spinner, StatusDot, TextInput } from '../components/ui'
import { PageTitle } from './Settings'

const r = (): any => (window as any).rcode

export function ToolsPage(): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  const set = useStore((st) => st.set)
  const [xcode, setXcode] = useState<string | null>(null)
  const [hasAxe, setHasAxe] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [devices, setDevices] = useState<{ udid: string; name: string; runtime: string }[]>([])

  useEffect(() => {
    void r().invoke('ios:hasAxe').then(setHasAxe)
    void r().invoke('ios:xcodeVersion').then(setXcode)
    void r().invoke('ios:devices').then(setDevices)
  }, [])

  const key = (k: 'brave' | 'tavily' | 'ollama'): React.JSX.Element => (
    <TextInput
      type="password"
      defaultValue={s.searchKeys?.[k] ?? ''}
      placeholder="API key"
      onBlur={(e) => void setSettings({ searchKeys: { ...s.searchKeys, [k]: e.target.value.trim() || undefined } })}
      className="w-64"
    />
  )

  return (
    <>
      <PageTitle title="Browser, iOS & Web" subtitle="Tools R-Code gives every agent: a built-in browser, the iOS Simulator with Xcode, and web search for the built-in agent." />
      <Card
        title={
          <span className="flex items-center gap-2">
            <Globe size={14} /> Built-in browser
          </span>
        }
        subtitle="Agents use browser_open, browser_click, browser_type, browser_screenshot, browser_eval and browser_console. Their activity appears in the side panel."
        actions={
          <Button size="sm" variant="secondary" onClick={() => set({ view: 'chat', panel: 'browser' })}>
            Open browser
          </Button>
        }
      >
        <p className="pb-1 text-[12.5px] text-fg-3">Cookies and logins live in a separate R-Code browser profile, apart from your other browsers.</p>
      </Card>
      <Card
        title={
          <span className="flex items-center gap-2">
            <Smartphone size={14} /> iOS Simulator & Xcode
          </span>
        }
        subtitle="Agents build your Xcode project, run it in the Simulator, look at it and tap through it — like a QA engineer."
        actions={
          <Button size="sm" variant="secondary" onClick={() => set({ view: 'chat', panel: 'simulator' })}>
            Open Simulator
          </Button>
        }
      >
        <Row label="Xcode" hint={xcode ?? 'Checking…'}>
          <StatusDot tone={xcode && !/not found|error/i.test(xcode) ? 'ok' : 'warn'} />
        </Row>
        <Row label="AXe (UI automation)" hint="Open-source CLI that lets agents tap, swipe, type and read the accessibility tree. Installed with Homebrew.">
          {hasAxe === null ? (
            <Spinner size={12} />
          ) : hasAxe ? (
            <span className="flex items-center gap-1 text-[12.5px] text-ok">
              <Check size={12} /> Installed
            </span>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={installing}
              onClick={async () => {
                setInstalling(true)
                setHasAxe(await r().invoke('ios:installAxe'))
                setInstalling(false)
              }}
            >
              {installing ? <Spinner size={12} className="text-white" /> : <Download size={12} />} Install AXe
            </Button>
          )}
        </Row>
        <Row label="Default simulator">
          <Select
            value={s.iosDevice ?? ''}
            options={[{ value: '', label: 'Most recently booted' }, ...devices.map((d) => ({ value: d.udid, label: `${d.name} · ${d.runtime}` }))]}
            onChange={(v) => void setSettings({ iosDevice: v || undefined })}
          />
        </Row>
      </Card>
      <Card
        title={
          <span className="flex items-center gap-2">
            <Search size={14} /> Web search for the built-in agent
          </span>
        }
        subtitle="Claude Code and Codex have their own web search. Pi uses search_web / fetch_url: with a search API key below, or a normal search in the built-in browser when none is set."
      >
        <Row label="Provider">
          <Select
            value={s.searchProvider}
            options={[
              { value: 'auto', label: 'Automatic (first configured)' },
              { value: 'brave', label: 'Brave Search API' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'ollama', label: 'Ollama web search' },
              { value: 'searxng', label: 'SearXNG (self-hosted)' }
            ]}
            onChange={(v) => void setSettings({ searchProvider: v as any })}
          />
        </Row>
        <Row label="Brave Search" hint="Free tier available at brave.com/search/api">
          {key('brave')}
        </Row>
        <Row label="Tavily" hint="tavily.com">
          {key('tavily')}
        </Row>
        <Row label="Ollama web search" hint="ollama.com/settings/keys">
          {key('ollama')}
        </Row>
        <Row label="SearXNG URL" hint="Your own instance, e.g. http://localhost:8888">
          <TextInput defaultValue={s.searxngUrl} placeholder="http://localhost:8888" onBlur={(e) => void setSettings({ searxngUrl: e.target.value.trim() })} className="w-64 font-mono" />
        </Row>
      </Card>
    </>
  )
}
