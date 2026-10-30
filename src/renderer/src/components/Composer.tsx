import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp, Mic, Paperclip, Square, X, Loader2 } from 'lucide-react'
import { AGENT_LABELS, type AgentId, type ImageAttachment, type PermissionMode } from '@shared/types'
import { useStore } from '../store'
import { api } from '../lib/api'
import { ModelPicker, PermissionPicker, type Selection } from './ModelPicker'
import { EffortControl } from './EffortSlider'
import { cancelRecording, startRecording, stopRecordingAndTranscribe, useVoice } from '../voice/voice'

const NO_IMAGES: ImageAttachment[] = []

export function Composer({
  threadKey,
  selection,
  onSelection,
  mode,
  onMode,
  running,
  onStop,
  autoFocus
}: {
  threadKey: string
  selection: Selection
  onSelection: (s: Selection) => void
  mode: PermissionMode
  onMode: (m: PermissionMode) => void
  running?: boolean
  onStop?: () => void
  autoFocus?: boolean
}): React.JSX.Element {
  const text = useStore((s) => s.composerText[threadKey] ?? '')
  const images = useStore((s) => s.composerImages[threadKey]) ?? NO_IMAGES
  const settings = useStore((s) => s.settings)
  const sendMessage = useStore((s) => s.sendMessage)
  const recording = useVoice((s) => s.recording)
  const transcribing = useVoice((s) => s.transcribing)
  const level = useVoice((s) => s.level)
  const sttStatus = useVoice((s) => s.stt)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [dragging, setDragging] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  const setText = (v: string): void => useStore.setState((s) => ({ composerText: { ...s.composerText, [threadKey]: v } }))
  const setImages = (v: ImageAttachment[]): void => useStore.setState((s) => ({ composerImages: { ...s.composerImages, [threadKey]: v } }))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [text])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus, threadKey])

  const submit = async (override?: string): Promise<void> => {
    const value = (override ?? text).trim()
    if (!value && images.length === 0) return
    setText('')
    setImages([])
    await sendMessage(value || 'Take a look at the attached image.', images.length ? images : undefined)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const send = settings.sendWithEnter ? !e.shiftKey : e.metaKey
      if (send) {
        e.preventDefault()
        void submit()
      }
    }
    if (e.key === 'Escape' && running && onStop) onStop()
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const out: ImageAttachment[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/') || f.size > 15 * 1024 * 1024) continue
      const data = await new Promise<string>((resolve) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
        r.readAsDataURL(f)
      })
      out.push({ name: f.name || 'pasted-image.png', mimeType: f.type, data })
    }
    if (out.length) setImages([...useStore.getState().composerImages[threadKey] ?? [], ...out])
  }

  const toggleMic = async (): Promise<void> => {
    setVoiceError(null)
    if (recording) {
      try {
        const said = await stopRecordingAndTranscribe(settings.whisperModel, settings.voiceLanguage)
        if (!said) return
        const merged = text ? `${text.trimEnd()} ${said}` : said
        if (settings.autoSendVoice) await submit(merged)
        else {
          setText(merged)
          ref.current?.focus()
        }
      } catch (err: any) {
        setVoiceError(err?.message ?? String(err))
      }
      return
    }
    try {
      await startRecording(settings.whisperModel)
    } catch (err: any) {
      setVoiceError(err?.message ?? String(err))
    }
  }

  // ⌥Space toggles dictation anywhere in the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.code === 'Space') {
        e.preventDefault()
        void toggleMic()
      }
      if (e.key === 'Escape' && recording) cancelRecording()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const placeholder = recording
    ? 'Listening… click the mic again when you’re done'
    : transcribing
      ? 'Transcribing…'
      : running
        ? `Steer ${AGENT_LABELS[selection.agent]} or queue a follow-up…`
        : `Ask ${AGENT_LABELS[selection.agent]} something…`

  const canSend = (text.trim().length > 0 || images.length > 0) && !recording && !transcribing

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void addFiles(e.dataTransfer.files)
      }}
      className={clsx(
        'relative rounded-[14px] border bg-field transition-[border-color,box-shadow] duration-150',
        dragging ? 'border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)]' : 'border-field-border focus-within:border-fg-4/60'
      )}
    >
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {images.map((img, i) => (
            <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-lg border border-line">
              <img src={`data:${img.mimeType};base64,${img.data}`} className="h-full w-full object-cover" alt={img.name} />
              <button
                onClick={() => setImages(images.filter((_, k) => k !== i))}
                className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files)
          if (files.length) {
            e.preventDefault()
            void addFiles(files)
          }
        }}
        placeholder={placeholder}
        className="selectable block max-h-[280px] min-h-[46px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14.5px] leading-[1.5] text-fg outline-none placeholder:text-fg-4"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <button
          title="Attach images"
          onClick={async () => setImages([...images, ...(await api.pickImages())])}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-raised-2 hover:text-fg"
        >
          <Paperclip size={14} />
        </button>
        <PermissionPicker value={mode} onChange={onMode} />
        <div className="flex-1" />
        {voiceError && (
          <span className="mr-1 max-w-[260px] truncate text-[11.5px] text-danger" title={voiceError}>
            {voiceError}
          </span>
        )}
        {sttStatus.status === 'loading' && (recording || transcribing) && (
          <span className="mr-1 text-[11.5px] text-fg-3">Loading Whisper {Math.round(sttStatus.progress * 100)}%</span>
        )}
        <ModelPicker value={selection} onChange={onSelection} />
        <EffortControl value={selection} onChange={onSelection} />
        <button
          title={recording ? 'Stop and transcribe (⌥Space)' : 'Dictate with Whisper (⌥Space)'}
          onClick={() => void toggleMic()}
          disabled={transcribing}
          className={clsx(
            'relative flex h-7 w-7 items-center justify-center rounded-full transition-colors',
            recording ? 'recording bg-danger text-white' : 'text-fg-3 hover:bg-raised-2 hover:text-fg'
          )}
          style={recording ? { transform: `scale(${1 + level * 0.18})` } : undefined}
        >
          {transcribing ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
        </button>
        {running && !canSend ? (
          <button title="Stop (Esc)" onClick={onStop} className="flex h-7 w-7 items-center justify-center rounded-full bg-fg text-panel transition-transform active:scale-90">
            <Square size={10} fill="currentColor" />
          </button>
        ) : (
          <button
            title="Send (↵)"
            disabled={!canSend}
            onClick={() => void submit()}
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-full transition-[background-color,transform] duration-150 active:scale-90',
              canSend ? 'bg-accent text-white' : 'bg-fg-4/40 text-panel'
            )}
          >
            <ArrowUp size={15} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  )
}

export type { AgentId }
