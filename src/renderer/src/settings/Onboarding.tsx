import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ArrowRight, Check, ChevronLeft } from 'lucide-react'
import { AGENT_IDS, AGENT_LABELS } from '@shared/types'
import { useStore, defaultModelFor } from '../store'
import { AgentCard } from './AgentCard'
import { OllamaCard } from './ModelsPage'
import { WhisperChooser, TtsDownload } from './VoicePage'
import { DefaultModel } from './Settings'
import { AgentIcon, Button, Row, Toggle } from '../components/ui'
import { Logo3D } from '../components/Logo3D'

const STEPS = ['Welcome', 'Agents', 'Models', 'Voice', 'Ready'] as const

export function Onboarding(): React.JSX.Element {
  const [step, setStep] = useState(0)
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const setSettings = useStore((s) => s.setSettings)
  const setDraft = useStore((s) => s.setDraft)
  const linked = settings.linkedAgents

  // Pre-link whatever is already installed and the built-in agent.
  useEffect(() => {
    if (step !== 1 || linked.length || !agents.length) return
    const ready = agents.filter((a) => a.installed).map((a) => a.id)
    if (ready.length) void setSettings({ linkedAgents: ready, defaultAgent: ready.includes('claude') ? 'claude' : ready[0] })
  }, [step, agents, linked.length, setSettings])

  const finish = async (): Promise<void> => {
    const agent = linked.includes(settings.defaultAgent) ? settings.defaultAgent : linked[0] ?? 'pi'
    await setSettings({ onboarded: true, defaultAgent: agent, linkedAgents: linked.length ? linked : ['pi'] })
    setDraft({ agent, model: defaultModelFor(useStore.getState().settings, agent) })
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-frame">
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <div className="hero-grid pointer-events-none absolute inset-0 opacity-70" />
      <div className="relative m-auto flex max-h-[92vh] w-[680px] flex-col">
        <div className="mb-6 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className={clsx('h-1.5 rounded-full transition-all duration-300', i === step ? 'w-8 bg-accent' : i < step ? 'w-4 bg-accent/50' : 'w-4 bg-fg-4/40')} />
          ))}
        </div>
        <div key={step} className="fade-up min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-panel p-8 shadow-[var(--shadow)]">
          {step === 0 && (
            <div className="flex flex-col items-center py-6 text-center">
              <Logo3D size={128} />
              <h1 className="mt-6 text-[28px] font-semibold tracking-tight text-fg">Welcome to R-Code</h1>
              <p className="mt-3 max-w-md text-[14px] leading-relaxed text-fg-2">
                One calm home for your coding agents. Use <b>Claude Code</b> and <b>Codex</b> straight from their CLIs, and R-Code&apos;s <b>built-in Pi agent</b> for local Ollama models and any other provider — all in the same chat, sharing context.
              </p>
              <div className="mt-6 flex items-center gap-4">
                {AGENT_IDS.map((a) => (
                  <div key={a} className="flex items-center gap-1.5 text-[13px] text-fg-3">
                    <AgentIcon agent={a} size={16} /> {AGENT_LABELS[a]}
                  </div>
                ))}
              </div>
            </div>
          )}
          {step === 1 && (
            <>
              <h2 className="text-[20px] font-semibold text-fg">Link your agents</h2>
              <p className="mt-1 mb-5 text-[13px] text-fg-3">Missing a CLI? Press Install and R-Code sets it up for you. Sign-in opens a Terminal window for the agent&apos;s own login.</p>
              <div className="flex flex-col gap-2.5">
                {AGENT_IDS.map((a) => (
                  <AgentCard key={a} agent={a} />
                ))}
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <h2 className="text-[20px] font-semibold text-fg">Pick your models</h2>
              <p className="mt-1 mb-4 text-[13px] text-fg-3">Choose a default for each agent. You can switch models — and agents — any time from the composer.</p>
              <div className="rounded-xl border border-line px-4 py-1">
                {linked.map((a) => (
                  <Row key={a} label={<span className="flex items-center gap-2"><AgentIcon agent={a} size={14} /> {AGENT_LABELS[a]}</span>}>
                    <DefaultModel agent={a} />
                  </Row>
                ))}
                <Row label="Start new chats with">
                  <div className="flex gap-1">
                    {linked.map((a) => (
                      <button key={a} onClick={() => void setSettings({ defaultAgent: a })} className={clsx('flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px]', settings.defaultAgent === a ? 'bg-raised-2 text-fg' : 'text-fg-3 hover:text-fg')}>
                        <AgentIcon agent={a} size={12} /> {AGENT_LABELS[a]}
                      </button>
                    ))}
                  </div>
                </Row>
              </div>
              {linked.includes('pi') && (
                <div className="mt-4">
                  <OllamaCard />
                </div>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <h2 className="text-[20px] font-semibold text-fg">Voice</h2>
              <p className="mt-1 mb-4 text-[13px] text-fg-3">Dictate with OpenAI Whisper and hear replies with Kokoro — both run privately on your Mac. Downloading now is optional; they also download on first use.</p>
              <WhisperChooser compact />
              <div className="mt-4 rounded-xl border border-line px-4 py-1">
                <Row label="Kokoro text-to-speech" hint="Natural voice for reading replies aloud.">
                  <TtsDownload />
                </Row>
                <Row label="Read replies aloud automatically">
                  <Toggle checked={settings.ttsAutoRead} onChange={(v) => void setSettings({ ttsAutoRead: v })} />
                </Row>
              </div>
            </>
          )}
          {step === 4 && (
            <div className="flex flex-col items-center py-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ok/15 text-ok">
                <Check size={28} />
              </div>
              <h2 className="mt-5 text-[22px] font-semibold text-fg">You&apos;re all set</h2>
              <ul className="mt-4 flex max-w-md flex-col gap-2 text-left text-[13px] text-fg-2">
                <li>• Pick any agent and model from the composer — switch mid-chat and the new agent gets the full context.</li>
                <li>• Agents can delegate side-quests to each other (even to local models) and suggest a fresh chat when context gets heavy.</li>
                <li>• Press <kbd className="rounded bg-raised-2 px-1.5 text-[12px]">⌥Space</kbd> to dictate, and the speaker icon to hear a reply.</li>
              </ul>
            </div>
          )}
        </div>
        <div className="mt-5 flex items-center justify-between">
          <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} className={clsx(step === 0 && 'invisible')}>
            <ChevronLeft size={14} /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={step === 1 && linked.length === 0} onClick={() => setStep(step + 1)}>
              {step === 0 ? 'Get started' : 'Continue'} <ArrowRight size={14} />
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void finish()}>
              Start coding <ArrowRight size={14} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
