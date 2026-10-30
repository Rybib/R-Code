import type { AgentId, PlanUsage } from '@shared/types'
import { usageBus } from './agents/base'
import { claudeAdapter } from './agents/claude'
import { codexAdapter, codexUsage } from './agents/codex'

// Subscription usage for the CLI agents (Claude Code's 5-hour / weekly limits, Codex's
// 5-hour / weekly limits). Read from each CLI on demand, cached briefly, refreshed after
// turns, and pushed to the renderer as 'usage' events.

type CliAgent = 'claude' | 'codex'
const READERS: Record<CliAgent, () => Promise<PlanUsage | null>> = {
  claude: () => claudeAdapter.planUsage!(),
  codex: () => codexAdapter.planUsage!()
}

const cache = new Map<CliAgent, PlanUsage | null>()
const inflight = new Map<CliAgent, Promise<PlanUsage | null>>()
const timers = new Map<CliAgent, NodeJS.Timeout>()
const nullAt = new Map<CliAgent, number>() // when a read last found no plan limits
let notify: (usage: { agent: AgentId; usage: PlanUsage | null }) => void = () => {}

const isCli = (agent: AgentId): agent is CliAgent => agent === 'claude' || agent === 'codex'

export function startUsage(send: (channel: string, payload: unknown) => void): void {
  notify = (u) => send('usage', u)
  usageBus.on('refresh', (agent: AgentId) => refreshUsageSoon(agent))
  // Codex streams sparse rolling updates; merge them into the last full read.
  usageBus.on('codex', (snap: unknown) => {
    const next = codexUsage(snap)
    if (!next) return
    const prev = cache.get('codex')
    const windows = prev ? prev.windows.map((w) => next.windows.find((n) => n.id === w.id) ?? w) : next.windows
    for (const w of next.windows) if (!windows.some((x) => x.id === w.id)) windows.push(w)
    const merged: PlanUsage = { ...next, plan: next.plan ?? prev?.plan, windows }
    cache.set('codex', merged)
    notify({ agent: 'codex', usage: merged })
  })
}

/** Cached usage, re-read when older than `maxAgeMs`. Null for Pi and API-key logins. */
export async function getUsage(agent: AgentId, maxAgeMs = 60_000): Promise<PlanUsage | null> {
  if (!isCli(agent)) return null
  if (cache.has(agent) && maxAgeMs > 0) {
    const cached = cache.get(agent)
    // "No plan limits" (API key login, signed out) is remembered a little longer.
    const age = Date.now() - (cached?.fetchedAt ?? nullAt.get(agent) ?? 0)
    if (age < (cached ? maxAgeMs : 5 * 60_000)) return cached ?? null
  }
  let p = inflight.get(agent)
  if (!p) {
    p = READERS[agent]()
      .catch(() => null)
      .then((u) => {
        cache.set(agent, u)
        if (!u) nullAt.set(agent, Date.now())
        notify({ agent, usage: u })
        return u
      })
      .finally(() => inflight.delete(agent))
    inflight.set(agent, p)
  }
  return p
}

/** Re-read usage shortly (debounced), e.g. after a turn finishes. */
export function refreshUsageSoon(agent: AgentId, delayMs = 3000): void {
  if (!isCli(agent)) return
  clearTimeout(timers.get(agent))
  timers.set(
    agent,
    setTimeout(() => void getUsage(agent, 0), delayMs)
  )
}
