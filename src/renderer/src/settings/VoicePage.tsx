import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Check, Download, ExternalLink, Mic, Play, Square, Trash2 } from 'lucide-react'
import type { WhisperModel } from '@shared/types'
import { useStore } from '../store'
import { api } from '../lib/api'
import { Button, Card, Row, Select, Spinner, Toggle } from '../components/ui'
import { PageTitle } from './Settings'
import {
  KOKORO_VOICES,
  TTS_REPO,
  WHISPER_MODELS,
  deleteCached,
  loadTts,
  loadWhisper,
  refreshCache,
  speak,
  startRecording,
  stopRecordingAndTranscribe,
  stopSpeaking,
  useVoice
} from '../voice/voice'

const LANGUAGES = [
  ['auto', 'Detect automatically'],
  ['english', 'English'],
  ['spanish', 'Spanish'],
  ['french', 'French'],
  ['german', 'German'],
  ['italian', 'Italian'],
  ['portuguese', 'Portuguese'],
  ['dutch', 'Dutch'],
  ['japanese', 'Japanese'],
  ['chinese', 'Chinese'],
  ['korean', 'Korean'],
  ['russian', 'Russian'],
  ['hindi', 'Hindi'],
  ['arabic', 'Arabic']
] as const

export function WhisperChooser({ compact }: { compact?: boolean }): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  const stt = useVoice((v) => v.stt)
  const cached = useVoice((v) => v.cached)
  const [downloading, setDownloading] = useState<WhisperModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  const download = async (m: WhisperModel): Promise<void> => {
    setError(null)
    setDownloading(m)
    try {
      await loadWhisper(m)
      await refreshCache()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {WHISPER_MODELS.map((m) => {
        const selected = s.whisperModel === m.id
        const isCached = cached[`whisper-${m.id}`]
        const busy = downloading === m.id
        return (
          <div
            key={m.id}
            onClick={() => void setSettings({ whisperModel: m.id })}
            className={clsx('flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-colors', selected ? 'border-accent/60 bg-accent/[0.06]' : 'border-line hover:border-fg-4/50')}
          >
            <span className={clsx('flex h-4 w-4 items-center justify-center rounded-full border', selected ? 'border-accent bg-accent' : 'border-fg-4')}>
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] text-fg">
                {m.label}
                {m.id === 'small' && <span className="rounded bg-accent/15 px-1.5 py-px text-[10.5px] font-medium text-accent">DEFAULT</span>}
              </div>
              {!compact && (
                <div className="text-[12px] text-fg-3">
                  {m.note} · {m.size} ·{' '}
                  <button
                    className="inline-flex items-center gap-0.5 underline decoration-fg-4 underline-offset-2 hover:text-fg-2"
                    onClick={(e) => {
                      e.stopPropagation()
                      void api.openExternal(`https://huggingface.co/onnx-community/whisper-${m.id}`)
                    }}
                  >
                    onnx-community/whisper-{m.id} <ExternalLink size={10} />
                  </button>
                </div>
              )}
              {busy && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(stt.progress * 100)}%` }} />
                </div>
              )}
            </div>
            {isCached ? (
              <span className="flex items-center gap-1 text-[12px] text-ok">
                <Check size={12} /> Downloaded
                {!compact && (
                  <button
                    title="Delete download"
                    className="ml-1 rounded p-1 text-fg-4 hover:bg-raised-2 hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      void deleteCached(`/whisper-${m.id}/`)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </span>
            ) : (
              <Button
                size="sm"
                variant={selected ? 'primary' : 'secondary'}
                disabled={!!downloading}
                onClick={() => {
                  void setSettings({ whisperModel: m.id })
                  void download(m.id)
                }}
              >
                {busy ? <Spinner size={12} className={selected ? 'text-white' : ''} /> : <Download size={12} />}
                {busy ? `${Math.round(stt.progress * 100)}%` : 'Download'}
              </Button>
            )}
          </div>
        )
      })}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

export function TtsDownload(): React.JSX.Element {
  const tts = useVoice((v) => v.tts)
  const cached = useVoice((v) => v.cached.kokoro)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (cached)
    return (
      <span className="flex items-center gap-1 text-[12px] text-ok">
        <Check size={12} /> Downloaded
      </span>
    )
  return (
    <div className="flex items-center gap-2">
      {error && <span className="max-w-48 truncate text-[11.5px] text-danger">{error}</span>}
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await loadTts()
            await refreshCache()
          } catch (err: any) {
            setError(err?.message ?? String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? <Spinner size={12} className="text-white" /> : <Download size={12} />}
        {busy ? `${Math.round(tts.progress * 100)}%` : 'Download (~90 MB)'}
      </Button>
    </div>
  )
}

export function VoicePage(): React.JSX.Element {
  const s = useStore((st) => st.settings)
  const setSettings = useStore((st) => st.setSettings)
  const stt = useVoice((v) => v.stt)
  const tts = useVoice((v) => v.tts)
  const recording = useVoice((v) => v.recording)
  const transcribing = useVoice((v) => v.transcribing)
  const speakingId = useVoice((v) => v.speakingId)
  const previewError = useVoice((v) => (v.speakError?.id === 'preview' ? v.speakError.message : null))
  const cachedKokoro = useVoice((v) => v.cached.kokoro)
  const [heard, setHeard] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    void refreshCache()
  }, [])

  const testMic = async (): Promise<void> => {
    setTestError(null)
    try {
      if (recording) setHeard(await stopRecordingAndTranscribe(s.whisperModel, s.voiceLanguage))
      else {
        setHeard(null)
        await startRecording(s.whisperModel)
      }
    } catch (err: any) {
      setTestError(err?.message ?? String(err))
    }
  }

  return (
    <>
      <PageTitle title="Voice" subtitle="Talk to your agents and have them talk back. Everything runs on this Mac — audio never leaves your computer." />
      <Card
        title={
          <span className="flex items-center gap-2">
            <Mic size={14} /> Speech to text · OpenAI Whisper
          </span>
        }
        subtitle={`Models download once from Hugging Face and run on ${stt.device === 'webgpu' ? 'your GPU (WebGPU)' : stt.device === 'wasm' ? 'the CPU (WASM)' : 'your GPU when available'}.`}
      >
        <WhisperChooser />
        <Row label="Language">
          <Select value={s.voiceLanguage} options={LANGUAGES.map(([value, label]) => ({ value, label }))} onChange={(v) => void setSettings({ voiceLanguage: v })} />
        </Row>
        <Row label="Send automatically after dictation" hint="Otherwise the transcript lands in the composer so you can edit it first.">
          <Toggle checked={s.autoSendVoice} onChange={(v) => void setSettings({ autoSendVoice: v })} />
        </Row>
        <Row label="Try it" hint={heard !== null ? `Heard: “${heard || '(nothing)'}”` : testError ?? 'Press ⌥Space in any chat to dictate.'}>
          <Button size="sm" variant={recording ? 'danger' : 'secondary'} disabled={transcribing} onClick={() => void testMic()}>
            {transcribing ? <Spinner size={12} /> : recording ? <Square size={11} /> : <Mic size={12} />}
            {transcribing ? 'Transcribing…' : recording ? 'Stop' : 'Record a test'}
          </Button>
        </Row>
      </Card>
      <Card
        title={
          <span className="flex items-center gap-2">
            <Play size={14} /> Text to speech · Kokoro
          </span>
        }
        subtitle={
          <span>
            Kokoro-82M is a small, open-weight (Apache-2.0) voice model that sounds natural and runs in real time on-device.{' '}
            <button className="inline-flex items-center gap-0.5 underline decoration-fg-4 underline-offset-2 hover:text-fg-2" onClick={() => void api.openExternal(`https://huggingface.co/${TTS_REPO}`)}>
              {TTS_REPO} <ExternalLink size={10} />
            </button>
          </span>
        }
        actions={<TtsDownload />}
      >
        <Row label="Enable read-aloud" hint="Adds a speaker button to every agent reply.">
          <Toggle checked={s.ttsEnabled} onChange={(v) => void setSettings({ ttsEnabled: v })} />
        </Row>
        <Row
          label="Read replies aloud"
          hint={
            s.ttsLiveRead
              ? 'Narrates as the agent works: each update is read as soon as it’s written, then the final answer.'
              : s.ttsAutoRead
                ? 'Reads the final reply once the agent finishes.'
                : 'Only when you press play on a message.'
          }
        >
          <Select
            value={s.ttsLiveRead ? 'live' : s.ttsAutoRead ? 'finished' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'finished', label: 'When a reply finishes' },
              { value: 'live', label: 'As it works' }
            ]}
            onChange={(v) => void setSettings({ ttsLiveRead: v === 'live', ttsAutoRead: v === 'finished' })}
          />
        </Row>
        <Row label="Voice">
          <Select value={s.ttsVoice} options={KOKORO_VOICES.map((v) => ({ value: v.id, label: v.label }))} onChange={(v) => void setSettings({ ttsVoice: v })} />
        </Row>
        <Row label="Speed">
          <div className="flex items-center gap-2">
            <input type="range" min={0.6} max={1.6} step={0.05} value={s.ttsSpeed} onChange={(e) => void setSettings({ ttsSpeed: Number(e.target.value) })} className="w-36 accent-[var(--accent)]" />
            <span className="w-10 text-right text-[12px] text-fg-3">{s.ttsSpeed.toFixed(2)}×</span>
          </div>
        </Row>
        <Row label="Preview" hint={
            tts.status === 'loading' ? (
              `Loading Kokoro… ${Math.round(tts.progress * 100)}%`
            ) : previewError || tts.error ? (
              <span className="text-danger">{previewError ?? tts.error}</span>
            ) : cachedKokoro ? undefined : (
              'Downloads the model on first use.'
            )
          }
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              speakingId === 'preview'
                ? stopSpeaking()
                : void speak('preview', "Hi, I'm your R-Code voice. Tell me what to build and I'll get the agents on it.", s.ttsVoice, s.ttsSpeed).catch(() => {})
            }
          >
            {speakingId === 'preview' ? <Square size={11} /> : <Play size={12} />}
            {speakingId === 'preview' ? 'Stop' : 'Play sample'}
          </Button>
        </Row>
      </Card>
    </>
  )
}
