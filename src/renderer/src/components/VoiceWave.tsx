import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { getAnalyser, useVoice } from '../voice/voice'

// While dictating, the composer becomes a live waveform of your voice, so you can see at a
// glance that the mic is hearing you and whether Whisper is still loading or listening.

const BAR = 3 // bar width (css px)
const GAP = 2
const STEP_MS = 45 // a new bar every STEP_MS; bars scroll smoothly in between

function levelOf(an: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  an.getByteTimeDomainData(buf)
  let sum = 0
  for (const v of buf) sum += ((v - 128) / 128) ** 2
  const rms = Math.sqrt(sum / buf.length)
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.006)) * 1.35)
}

export function VoiceWave({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const recording = useVoice((s) => s.recording)
  const transcribing = useVoice((s) => s.transcribing)
  const stt = useVoice((s) => s.stt)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!recording) return
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(t)
  }, [recording])

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')!
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b5ff0'
    const bars: number[] = []
    let buf: Uint8Array<ArrayBuffer> | null = null
    let last = performance.now()
    let raf = 0

    const draw = (now: number): void => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      const an = getAnalyser()
      const live = !!an
      if (an && now - last >= STEP_MS) {
        buf ??= new Uint8Array(an.fftSize)
        bars.push(levelOf(an, buf))
        last = now
        const max = Math.ceil(w / (BAR + GAP)) + 2
        if (bars.length > max) bars.splice(0, bars.length - max)
      }
      // Slide left between samples so the motion is continuous, not steppy.
      const shift = live ? Math.min(1, (now - last) / STEP_MS) * (BAR + GAP) : 0

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = accent
      const mid = h / 2
      for (let i = bars.length - 1, k = 0; i >= 0; i--, k++) {
        const x = w - (k + 1) * (BAR + GAP) - shift
        if (x < -BAR) break
        const bh = Math.max(3, bars[i] * (h - 6))
        // Fade the oldest bars out toward the left edge.
        ctx.globalAlpha = (live ? 1 : 0.35) * Math.min(1, Math.max(0.15, x / (w * 0.25)))
        ctx.beginPath()
        ctx.roundRect(x, mid - bh / 2, BAR, bh, BAR / 2)
        ctx.fill()
      }
      // Faint baseline where there's no audio yet, so the whole box reads as a waveform.
      ctx.globalAlpha = 0.18
      for (let x = w - (bars.length + 1) * (BAR + GAP) - shift; x > -BAR; x -= BAR + GAP) {
        ctx.beginPath()
        ctx.roundRect(x, mid - 1.5, BAR, 3, 1.5)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const loading = stt.status === 'loading'
  const status = transcribing
    ? loading
      ? `Loading Whisper ${Math.round(stt.progress * 100)}%…`
      : 'Transcribing…'
    : loading
      ? `Loading Whisper ${Math.round(stt.progress * 100)}% — keep talking`
      : 'Listening'
  const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div className="flex min-h-[58px] items-center gap-3 px-3.5 pt-2.5 pb-1">
      <div className="flex w-[92px] shrink-0 flex-col">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg tabular-nums">
          <span className={clsx('h-2 w-2 rounded-full', recording ? 'animate-pulse bg-danger' : 'bg-fg-4')} />
          {time}
        </span>
        <span className={clsx('truncate text-[11px]', transcribing || loading ? 'shimmer text-fg-3' : 'text-ok')} title={status}>
          {status}
        </span>
      </div>
      <canvas ref={canvas} className="h-10 min-w-0 flex-1" aria-label="Live microphone waveform" />
      {recording && (
        <button title="Cancel dictation (Esc)" onClick={onCancel} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-raised-2 hover:text-fg">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
