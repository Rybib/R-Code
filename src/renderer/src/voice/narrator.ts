import type { TimelineItem } from '@shared/types'
import { useStore } from '../store'
import { narrate, speak } from './voice'

// Reads replies aloud. "As it works" speaks each sentence of the agent's messages as soon as it
// is written (so you hear "Let me look at the tests…" while it works, then the next update);
// "When finished" reads the closing reply once the agent is done.

type Assistant = Extract<TimelineItem, { kind: 'assistant' }>

/** End of the last complete sentence in `text` at or after `from`, outside code fences; -1 if none. */
function sentenceEnd(text: string, from: number): number {
  let end = -1
  const re = /[.!?…:](?=\s|$)|\n\s*\n/g
  re.lastIndex = from
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cut = m.index + m[0].length
    // Don't cut inside an unfinished ``` block; code is skipped when spoken anyway.
    if ((text.slice(0, cut).match(/```/g)?.length ?? 0) % 2 === 0) end = cut
  }
  return end
}

export function startNarrator(): () => void {
  const startedAt = Date.now()
  const spoken = new Map<string, number>() // assistant item id -> characters already queued
  const wasRunning = new Map<string, boolean>()

  return useStore.subscribe((st) => {
    const { settings } = st
    const threadId = st.activeId
    if (!settings.ttsEnabled || !threadId) return
    const items = st.items[threadId] ?? []

    if (settings.ttsLiveRead) {
      for (const it of items) {
        if (it.kind !== 'assistant' || it.parentId || it.ts < startedAt) continue
        const a = it as Assistant
        const done = spoken.get(a.id) ?? 0
        const upto = a.streaming ? sentenceEnd(a.text, done) : a.text.length
        if (upto > done) {
          spoken.set(a.id, upto)
          narrate(a.id, a.text.slice(done, upto), settings.ttsVoice, settings.ttsSpeed)
        }
      }
      return
    }

    if (settings.ttsAutoRead) {
      const t = st.threads[threadId]
      const before = wasRunning.get(threadId)
      wasRunning.set(threadId, !!t?.running)
      if (before && !t?.running) {
        const last = [...items].reverse().find((i): i is Assistant => i.kind === 'assistant' && !i.parentId)
        if (last?.text.trim()) void speak(last.id, last.text, settings.ttsVoice, settings.ttsSpeed).catch(() => {})
      }
    }
  })
}
