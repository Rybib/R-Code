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
  /** Read-aloud is paused (the current clip holds its place). */
  paused: boolean
  /** Why the last read-aloud failed, shown next to the play button. */
  speakError: { id: string; message: string } | null
  cached: Record<string, boolean>
}

export const useVoice = create<VoiceState>(() => ({
  stt: { status: 'idle', progress: 0 },
  tts: { status: 'idle', progress: 0 },
  recording: false,
  transcribing: false,
  level: 0,
  speakingId: null,
  paused: false,
  speakError: null,
  cached: {}
}))

// ───────────── workers ─────────────

let sttWorker: Worker | null = null
let ttsWorker: Worker | null = null
let reqId = 0
const pending = new Map<number, { worker: Worker; resolve: (v: any) => void; reject: (e: Error) => void }>()

/** Fail everything waiting on a worker and drop it, so the next request starts a fresh one. */
function resetWorker(kind: 'stt' | 'tts', reason: string): void {
  const worker = kind === 'stt' ? sttWorker : ttsWorker
  if (!worker) return
  for (const [id, p] of pending) {
    if (p.worker !== worker) continue
    pending.delete(id)
    p.reject(new Error(reason))
  }
  worker.terminate()
  if (kind === 'stt') sttWorker = null
  else ttsWorker = null
  useVoice.setState((s) => ({ [kind]: { ...s[kind], status: 'idle', progress: 0 } }) as any)
}

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
    sttWorker.onerror = (e) => resetWorker('stt', `Whisper stopped unexpectedly${e.message ? `: ${e.message}` : ''}`)
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
    ttsWorker.onerror = (e) => resetWorker('tts', `The voice engine stopped unexpectedly${e.message ? `: ${e.message}` : ''}`)
  }
  return ttsWorker
}

function call(worker: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { worker, resolve, reject })
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
let meterAnalyser: AnalyserNode | null = null

/** Live analyser for the microphone while recording (null otherwise); used to draw the waveform. */
export function getAnalyser(): AnalyserNode | null {
  return meterAnalyser
}

// Dev builds only: drive the recording UI from any audio source (e.g. a test tone) without a mic.
if (import.meta.env.DEV) {
  ;(window as any).__voiceTest = {
    start: (analyser: AnalyserNode) => ((meterAnalyser = analyser), useVoice.setState({ recording: true })),
    stop: () => ((meterAnalyser = null), useVoice.setState({ recording: false, level: 0 })),
    playback: () => playCtx,
    killTts: () => ttsWorker?.terminate()
  }
}

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
  meterAnalyser = analyser
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
  meterAnalyser = null
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
    // Emoji sound odd spoken ("rocket", "check mark button"): drop them, keep the words.
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u200D\uFE0F\u20E3]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
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
  narration.length = 0
  if (pausedAt) resumeSpeaking()
  try {
    playing?.stop()
  } catch {
    /* ignore */
  }
  playing = null
  useVoice.setState({ speakingId: null })
}

// Pause/resume: the playback context is suspended in place; time spent paused doesn't count
// toward the stalled-clip watchdog, and the next clip waits until you resume.
let pausedAt = 0
let pausedTotal = 0

export function pauseSpeaking(): void {
  if (pausedAt || !useVoice.getState().speakingId) return
  pausedAt = Date.now()
  void playCtx?.suspend().catch(() => {})
  useVoice.setState({ paused: true })
}

export function resumeSpeaking(): void {
  if (!pausedAt) return
  pausedTotal += Date.now() - pausedAt
  pausedAt = 0
  void playCtx?.resume().catch(() => {})
  useVoice.setState({ paused: false })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A running AudioContext for playback. macOS can suspend or interrupt a long-lived context
 * (after the mic was used, the output device changed, or the Mac slept); audio sent to it is
 * silently dropped. Resume it if possible, otherwise start a fresh one.
 */
async function playbackContext(): Promise<AudioContext> {
  if (playCtx && playCtx.state !== 'closed') {
    if (playCtx.state !== 'running') await Promise.race([playCtx.resume().catch(() => {}), sleep(500)])
    if (playCtx.state === 'running') return playCtx
    void playCtx.close().catch(() => {})
  }
  playCtx = new AudioContext()
  if (playCtx.state !== 'running') await Promise.race([playCtx.resume().catch(() => {}), sleep(500)])
  return playCtx
}

// Follow the system output (AirPods, speakers, displays) by rebuilding the context on change.
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (playing || !playCtx) return
  void playCtx.close().catch(() => {})
  playCtx = null
})

/** Generate one chunk, giving up (and restarting the engine) if it stalls once loaded. */
async function generate(text: string, voice: string, speed: number): Promise<any> {
  const worker = tts()
  const req = call(worker, { type: 'speak', text, voice, speed })
  for (;;) {
    const res = await Promise.race([req.then((r) => ({ r })), sleep(45000).then(() => null)])
    if (res) return res.r
    // Still downloading the model: keep waiting. Otherwise the engine is stuck.
    if (useVoice.getState().tts.status !== 'loading') {
      resetWorker('tts', 'The voice engine stopped responding. Try again.')
      return req
    }
  }
}

/** Play one generated clip to the end (or until speech is stopped). */
async function playClip(res: { samples: Float32Array<ArrayBuffer>; sampleRate: number }, token: number): Promise<void> {
  while (pausedAt && token === speakToken) await sleep(150)
  const ctx = await playbackContext()
  if (token !== speakToken) return
  const buffer = ctx.createBuffer(1, res.samples.length, res.sampleRate)
  buffer.copyToChannel(res.samples, 0)
  const ended = await new Promise<boolean>((resolve) => {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    playing = src
    src.start()
    // If the clip never reports finishing (and isn't paused), the context is stuck: move on.
    const limit = buffer.duration * 1000 + 2000
    const started = Date.now()
    const pausedBefore = pausedTotal
    const watchdog = setInterval(() => {
      const pausedNow = pausedTotal - pausedBefore + (pausedAt ? Date.now() - pausedAt : 0)
      if (Date.now() - started - pausedNow > limit) finish(false)
    }, 500)
    const finish = (ok: boolean): void => {
      clearInterval(watchdog)
      resolve(ok)
    }
    src.onended = () => finish(true)
  })
  if (!ended && playCtx === ctx) {
    void ctx.close().catch(() => {})
    playCtx = null
  }
}

export async function speak(id: string, markdown: string, voice: string, speed: number): Promise<void> {
  stopSpeaking()
  const token = ++speakToken
  useVoice.setState({ speakingId: id, speakError: null })
  const parts = chunkText(speakableText(markdown))
  // Generate the next chunk while the current one plays.
  let next = parts.length ? generate(parts[0], voice, speed) : null
  next?.catch(() => {})
  try {
    for (let i = 0; i < parts.length && next; i++) {
      const res = await next
      if (token !== speakToken) return
      next = i + 1 < parts.length ? generate(parts[i + 1], voice, speed) : null
      next?.catch(() => {})
      await playClip(res, token)
      if (token !== speakToken) return
    }
  } catch (err: any) {
    if (token === speakToken) useVoice.setState({ speakError: { id, message: err?.message ?? String(err) } })
    throw err
  } finally {
    if (token === speakToken) useVoice.setState({ speakingId: null })
  }
}

// Live narration: text is queued as the agent writes it and spoken in order, with the next
// sentence generated while the current one plays.
const narration: { id: string; text: string }[] = []
let narrating = false

export function narrate(id: string, markdown: string, voice: string, speed: number): void {
  const text = speakableText(markdown)
  if (!text) return
  for (const part of chunkText(text)) narration.push({ id, text: part })
  if (!narrating) void runNarration(voice, speed)
}

async function runNarration(voice: string, speed: number): Promise<void> {
  narrating = true
  const token = speakToken
  let ahead: { item: { id: string; text: string }; clip: Promise<any> } | null = null
  let current: { id: string; text: string } | undefined
  try {
    for (;;) {
      const item = ahead?.item ?? narration.shift()
      if (!item || token !== speakToken) break
      current = item
      useVoice.setState({ speakingId: item.id })
      const clip = await (ahead?.clip ?? generate(item.text, voice, speed))
      ahead = null
      if (token !== speakToken) break
      const next = narration.shift()
      if (next) {
        ahead = { item: next, clip: generate(next.text, voice, speed) }
        ahead.clip.catch(() => {})
      }
      useVoice.setState({ speakingId: item.id, speakError: null })
      await playClip(clip, token)
    }
  } catch (err: any) {
    if (token === speakToken && current) useVoice.setState({ speakError: { id: current.id, message: err?.message ?? String(err) } })
  } finally {
    narrating = false
    if (token === speakToken) {
      useVoice.setState({ speakingId: null })
      if (narration.length) void runNarration(voice, speed)
    }
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
