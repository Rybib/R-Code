import clsx from 'clsx'
import { Pause, Play, Square } from 'lucide-react'
import { useStore } from '../store'
import { pauseSpeaking, resumeSpeaking, stopSpeaking, useVoice } from '../voice/voice'

// Floating control shown whenever something is being read aloud, wherever you are in the app:
// which chat is speaking (click to jump there), pause/resume, and stop.

export function NowReading(): React.JSX.Element | null {
  const speakingId = useVoice((s) => s.speakingId)
  const paused = useVoice((s) => s.paused)
  const loading = useVoice((s) => s.tts.status === 'loading')
  // The chat that owns the message being read.
  const threadId = useStore((s) => {
    if (!speakingId) return null
    for (const [id, items] of Object.entries(s.items)) if (items.some((i) => i.id === speakingId)) return id
    return null
  })
  const title = useStore((s) => (threadId ? s.threads[threadId]?.title : null))
  const here = useStore((s) => s.activeId === threadId && s.view === 'chat')
  if (!speakingId) return null

  const label = speakingId === 'preview' ? 'Voice preview' : (title ?? 'A reply')
  return (
    <div className="pop-in fixed top-[54px] left-1/2 z-30 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-full border border-line bg-raised/95 py-1 pr-1 pl-3 shadow-[var(--shadow)] backdrop-blur">
        <SoundBars active={!paused && !loading} />
        <button
          onClick={() => threadId && !here && void useStore.getState().openThread(threadId)}
          title={threadId && !here ? 'Go to this chat' : undefined}
          className={clsx('ml-1.5 flex max-w-[280px] items-baseline gap-1.5 text-[12.5px]', threadId && !here ? 'hover:text-fg' : 'cursor-default')}
        >
          <span className="shrink-0 font-medium text-fg">{paused ? 'Paused' : loading ? 'Preparing voice' : 'Reading'}</span>
          <span className="truncate text-fg-3">{label}</span>
        </button>
        <button
          title={paused ? 'Resume' : 'Pause'}
          onClick={() => (paused ? resumeSpeaking() : pauseSpeaking())}
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-fg-2 hover:bg-raised-2 hover:text-fg"
        >
          {paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
        </button>
        <button title="Stop reading" onClick={stopSpeaking} className="flex h-7 w-7 items-center justify-center rounded-full text-fg-2 hover:bg-raised-2 hover:text-fg">
          <Square size={11} fill="currentColor" />
        </button>
      </div>
    </div>
  )
}

function SoundBars({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={clsx('w-[3px] rounded-full bg-accent', active ? 'sound-bar' : 'h-[35%] opacity-60')}
          style={active ? { animationDelay: `${i * 0.13}s` } : undefined}
        />
      ))}
    </span>
  )
}
