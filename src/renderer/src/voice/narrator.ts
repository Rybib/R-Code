import type { TimelineItem } from '@shared/types'
import { useStore } from '../store'
import { narrate, speak } from './voice'

// Reads replies aloud. "As it works" speaks each of the agent's messages as soon as it has
// finished writing it, so you hear "Let me look at the tests…" while it works and the final
// answer once it's complete (never half-written). "When finished" reads only the closing reply.

type Assistant = Extract<TimelineItem, { kind: 'assistant' }>

export function startNarrator(): () => void {
  const startedAt = Date.now()
  const spoken = new Set<string>() // assistant messages already queued for reading
  const wasRunning = new Map<string, boolean>()

  let following: string | null = null // the chat being narrated keeps being followed if you switch away

  return useStore.subscribe((st) => {
    const { settings } = st
    const threadId = st.activeId
    if (!settings.ttsEnabled) return

    if (settings.ttsLiveRead) {
      if (following && !st.threads[following]?.running && following !== threadId) following = null
      for (const id of new Set([threadId, following])) {
        if (!id) continue
        for (const it of st.items[id] ?? []) {
          if (it.kind !== 'assistant' || it.parentId || it.ts < startedAt) continue
          const a = it as Assistant
          if (a.streaming || spoken.has(a.id) || !a.text.trim()) continue
          spoken.add(a.id)
          following = id
          narrate(a.id, a.text, settings.ttsVoice, settings.ttsSpeed)
        }
      }
      return
    }

    if (!threadId) return
    const items = st.items[threadId] ?? []

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
