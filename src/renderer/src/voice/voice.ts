import { create } from 'zustand'
import type { WhisperModel } from '@shared/types'
import { api } from '../lib/api'

export const WHISPER_MODELS: { id: WhisperModel; label: string; size: string; note: string }[] = [
  { id: 'tiny', label: 'Whisper Tiny', size: '~75 MB', note: 'Fastest, least accurate' },
  { id: 'base', label: 'Whisper Base', size: '~150 MB', note: 'Quick and decent' },
  { id: 'small', label: 'Whisper Small', size: '~480 MB', note: 'Best balance — recommended' }
]

export const TTS_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX'

export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'af_nicole', label: 'Nicole (US, female)' },
  { id: 'af_sarah', label: 'Sarah (US, female)' },
  { id: 'af_sky', label: 'Sky (US, female)' },
  { id: 'af_nova', label: 'Nova (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_adam', label: 'Adam (US, male)' },
  { id: 'am_eric', label: 'Eric (US, male)' },
  { id: 'am_liam', label: 'Liam (US, male)' },
  { id: 'am_onyx', label: 'Onyx (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bf_isabella', label: 'Isabella (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
  { id: 'bm_lewis', label: 'Lewis (UK, male)' },
  { id: 'bm_fable', label: 'Fable (UK, male)' }
]

type EngineStatus = 'idle' | 'loading' | 'ready' | 'error'

interface VoiceState {
  stt: { status: EngineStatus; model?: string; device?: string; progress: number; error?: string }
  tts: { status: EngineStatus; device?: string; progress: number; error?: string }
  recording: boolean
  transcribing: boolean
  level: number
  speakingId: string | null
  cached: Record<string, boolean>
}

export const useVoice = create<VoiceState>(() => ({
  stt: { status: 'idle', progress: 0 },
  tts: { status: 'idle', progress: 0 },
  recording: false,
  transcribing: false,
  level: 0,
  speakingId: null,
  cached: {}
}))

// ───────────── workers ─────────────

let sttWorker: Worker | null = null
let ttsWorker: Worker | null = null
let reqId = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

function progressTracker(kind: 'stt' | 'tts'): (msg: any) => void {
  const files = new Map<string, { loaded: number; total: number }>()
  return (msg) => {
    if (msg.type === 'progress') {
      files.set(msg.file, { loaded: msg.loaded, total: msg.total })
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      useVoice.setState((s) => ({ [kind]: { ...s[kind], progress: total ? loaded / total : 0 } }) as any)
    } else if (msg.type === 'status') {
      if (msg.status === 'loading') files.clear()
      useVoice.setState((s) => ({
        [kind]: { ...s[kind], status: msg.status, device: msg.device ?? s[kind].device, model: msg.model ?? (s[kind] as any).model, error: msg.error, progress: msg.status === 'ready' ? 1 : s[kind].progress }
      }) as any)
      if (msg.status === 'ready') void refreshCache()
    }
  }
}

function settle(msg: any): void {
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.type === 'error') p.reject(new Error(msg.error))
  else p.resolve(msg)
}

function stt(): Worker {
  if (!sttWorker) {
    sttWorker = new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' })
    const track = progressTracker('stt')
    sttWorker.onmessage = (e) => {
      track(e.data)
      if (e.data.id !== undefined) settle(e.data)
    }
  }
  return sttWorker
}

function tts(): Worker {
  if (!ttsWorker) {
    ttsWorker = new Worker(new URL('./tts-worker.ts', import.meta.url), { type: 'module' })
    const track = progressTracker('tts')
    ttsWorker.onmessage = (e) => {
      track(e.data)
      if (e.data.id !== undefined) settle(e.data)
    }
  }
  return ttsWorker
}

function call(worker: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...msg, id }, transfer)
  })
}

export function loadWhisper(model: WhisperModel): Promise<void> {
  return call(stt(), { type: 'load', model }).then(() => undefined)
}

export function loadTts(): Promise<void> {
  return call(tts(), { type: 'load' }).then(() => undefined)
}

// ───────────── model cache (Hugging Face downloads live in Cache Storage) ─────────────

export async function refreshCache(): Promise<void> {
  const cached: Record<string, boolean> = {}
  try {
    const cache = await caches.open('transformers-cache')
    const keys = (await cache.keys()).map((r) => r.url)
    for (const m of WHISPER_MODELS) cached[`whisper-${m.id}`] = keys.some((u) => u.includes(`/whisper-${m.id}/`) && u.includes('.onnx'))
    cached.kokoro = keys.some((u) => u.includes('Kokoro-82M') && u.includes('.onnx'))
  } catch {
    /* Cache Storage unavailable */
  }
  useVoice.setState({ cached })
}

export async function deleteCached(match: string): Promise<void> {
  try {
    const cache = await caches.open('transformers-cache')
    for (const req of await cache.keys()) if (req.url.includes(match)) await cache.delete(req)
  } catch {
    /* ignore */
  }
  if (match.includes('whisper')) {
    sttWorker?.terminate()
    sttWorker = null
    useVoice.setState({ stt: { status: 'idle', progress: 0 } })
  } else {
    ttsWorker?.terminate()
    ttsWorker = null
    useVoice.setState({ tts: { status: 'idle', progress: 0 } })
  }
  await refreshCache()
}

// ───────────── recording ─────────────

let media: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let meterRaf = 0
let meterCtx: AudioContext | null = null

export async function startRecording(model: WhisperModel): Promise<void> {
  if (useVoice.getState().recording) return
  const ok = await api.requestMic()
  if (!ok) throw new Error('Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone.')
  // Warm up the model while the user speaks.
  void loadWhisper(model).catch(() => {})
  media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  chunks = []
  recorder = new MediaRecorder(media)
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  recorder.start(250)
  meterCtx = new AudioContext()
  const analyser = meterCtx.createAnalyser()
  analyser.fftSize = 512
  meterCtx.createMediaStreamSource(media).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  const tick = (): void => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    useVoice.setState({ level: Math.min(1, Math.sqrt(sum / buf.length) * 4) })
    meterRaf = requestAnimationFrame(tick)
  }
  tick()
  useVoice.setState({ recording: true })
}

function cleanupRecording(): void {
  cancelAnimationFrame(meterRaf)
  void meterCtx?.close()
  meterCtx = null
  media?.getTracks().forEach((t) => t.stop())
  media = null
  recorder = null
  useVoice.setState({ recording: false, level: 0 })
}

export function cancelRecording(): void {
  try {
    recorder?.stop()
  } catch {
    /* ignore */
  }
  cleanupRecording()
}

export async function stopRecordingAndTranscribe(model: WhisperModel, language: string): Promise<string> {
  const rec = recorder
  if (!rec) return ''
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()))
  rec.stop()
  await stopped
  const blob = new Blob(chunks, { type: rec.mimeType })
  cleanupRecording()
  useVoice.setState({ transcribing: true })
  try {
    // An AudioContext at 16 kHz decodes and resamples to exactly what Whisper expects.
    const ctx = new AudioContext({ sampleRate: 16000 })
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    const audio = decoded.getChannelData(0).slice()
    void ctx.close()
    if (audio.length < 16000 * 0.3) return ''
    const res = await call(stt(), { type: 'transcribe', model, language, audio }, [audio.buffer])
    return res.text as string
  } finally {
    useVoice.setState({ transcribing: false })
  }
}

// ───────────── speaking ─────────────

let playCtx: AudioContext | null = null
let playing: AudioBufferSourceNode | null = null
let speakToken = 0

/** Markdown → speakable plain text (skip code, keep prose). */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function chunkText(text: string, max = 260): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*[\n]*/g) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim())
      cur = ''
    }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function stopSpeaking(): void {
  speakToken++
  try {
    playing?.stop()
  } catch {
    /* ignore */
  }
  playing = null
  useVoice.setState({ speakingId: null })
}

export async function speak(id: string, markdown: string, voice: string, speed: number): Promise<void> {
  stopSpeaking()
  const token = ++speakToken
  useVoice.setState({ speakingId: id })
  const parts = chunkText(speakableText(markdown))
  playCtx ??= new AudioContext()
  // Generate the next chunk while the current one plays.
  let next = parts.length ? call(tts(), { type: 'speak', text: parts[0], voice, speed }) : null
  try {
    for (let i = 0; i < parts.length && next; i++) {
      const res = await next
      if (token !== speakToken) return
      next = i + 1 < parts.length ? call(tts(), { type: 'speak', text: parts[i + 1], voice, speed }) : null
      const buffer = playCtx.createBuffer(1, res.samples.length, res.sampleRate)
      buffer.copyToChannel(res.samples, 0)
      await new Promise<void>((resolve) => {
        const src = playCtx!.createBufferSource()
        src.buffer = buffer
        src.connect(playCtx!.destination)
        src.onended = () => resolve()
        playing = src
        src.start()
      })
      if (token !== speakToken) return
    }
  } finally {
    if (token === speakToken) useVoice.setState({ speakingId: null })
  }
}

/** Generate speech without playing it (used for diagnostics). */
export async function synthesize(text: string, voice: string, speed = 1): Promise<{ samples: number; sampleRate: number; ms: number; audio: Float32Array }> {
  const t0 = performance.now()
  const res = await call(tts(), { type: 'speak', text, voice, speed })
  return { samples: res.samples.length, sampleRate: res.sampleRate, ms: Math.round(performance.now() - t0), audio: res.samples }
}

/** Resample mono audio to 16 kHz for Whisper. */
export async function to16k(audio: Float32Array, rate: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil((audio.length * 16000) / rate), 16000)
  const buf = ctx.createBuffer(1, audio.length, rate)
  buf.copyToChannel(audio as Float32Array<ArrayBuffer>, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start()
  return (await ctx.startRendering()).getChannelData(0).slice()
}

/** Transcribe a Float32Array of 16 kHz mono audio (used for diagnostics). */
export async function transcribe(audio: Float32Array, model: WhisperModel, language: string): Promise<string> {
  const res = await call(stt(), { type: 'transcribe', model, language, audio }, [audio.buffer])
  return res.text as string
}
