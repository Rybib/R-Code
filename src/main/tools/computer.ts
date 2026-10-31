import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage, shell } from 'electron'
import { AGENT_LABELS, type AgentId, type PermissionMode } from '@shared/types'
import type { ApprovalDecision } from '../agents/base'
import { run } from '../env'
import { dataPath } from '../store'
import { describeComputerAction } from '@shared/computer-action'
import type { ToolDef, ToolResult } from './registry'
import { num, str } from './registry'

// Computer control: lets agents see the screen and use the mouse and keyboard to work in native
// Mac apps. Off until the user turns it on in Settings. The native helper (native/rcode-computer.swift)
// posts the events and refuses any input aimed at R-Code itself, so an agent can't approve its
// own requests; each chat also asks the user before an agent first takes control.

export interface ComputerStatus {
  available: boolean
  accessibility: boolean
  screenRecording: boolean
  display?: { width: number; height: number; scale: number }
  frontmost?: { name: string; bundleId: string; pid: number }
}

export function computerHelperPath(): string | undefined {
  const bin = app.isPackaged ? join(process.resourcesPath, 'rcode-computer') : join(app.getAppPath(), 'vendor', 'rcode-computer', 'rcode-computer')
  return existsSync(bin) ? bin : undefined
}

class HelperError extends Error {
  constructor(
    message: string,
    readonly needs?: 'accessibility' | 'screen'
  ) {
    super(message)
  }
}

async function helper(args: string[]): Promise<any> {
  const bin = computerHelperPath()
  if (!bin) throw new HelperError('Computer control is unavailable: this R-Code build is missing its rcode-computer helper (`npm run build:computer` builds it).')
  const r = await run(bin, [...args, '--deny-pid', String(process.pid)], { timeoutMs: 30000 })
  let out: any
  try {
    out = JSON.parse(r.stdout.trim().split('\n').pop() || '')
  } catch {
    throw new HelperError(r.stderr.trim() || `rcode-computer exited with code ${r.code}`)
  }
  if (out.error) throw new HelperError(out.error, out.needs)
  return out
}

export async function computerStatus(): Promise<ComputerStatus> {
  if (!computerHelperPath()) return { available: false, accessibility: false, screenRecording: false }
  try {
    return { available: true, ...(await helper(['status'])) }
  } catch {
    return { available: false, accessibility: false, screenRecording: false }
  }
}

/** Show macOS's permission prompts (or list R-Code in System Settings so the user can switch it on). */
export async function requestComputerAccess(): Promise<ComputerStatus> {
  await helper(['request']).catch(() => {})
  return computerStatus()
}

export function openPrivacySettings(pane: 'accessibility' | 'screen'): void {
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'}`)
}

// Screenshots are scaled so their longest side is at most this many pixels, and agents give
// coordinates in screenshot pixels. Points = pixels × factor.
const MAX_EDGE = 1440

function frame(display: { width: number; height: number }): { width: number; height: number; factor: number } {
  const s = Math.min(1, MAX_EDGE / Math.max(display.width, display.height))
  const width = Math.round(display.width * s)
  return { width, height: Math.round(display.height * s), factor: display.width / width }
}

const PERMISSION_HELP = {
  accessibility:
    'R-Code needs Accessibility permission to use the mouse and keyboard. Ask the user to switch on R-Code in System Settings → Privacy & Security → Accessibility (R-Code just opened the prompt), then try again.',
  screen:
    'R-Code needs Screen Recording permission to see the screen. Ask the user to switch on R-Code in System Settings → Privacy & Security → Screen & System Audio Recording (R-Code just opened the prompt), then try again.'
}

let prompted = false
async function permissionError(needs: 'accessibility' | 'screen'): Promise<ToolResult> {
  // Raise the macOS prompt once per launch; after that the agent just relays the instructions.
  if (!prompted) {
    prompted = true
    await helper(['request']).catch(() => {})
  }
  return { text: PERMISSION_HELP[needs], isError: true }
}

async function screenshot(note: string): Promise<ToolResult> {
  const st = await helper(['status'])
  if (!st.screenRecording) return permissionError('screen')
  const file = dataPath(`screen-${process.pid}-${Date.now()}.png`)
  try {
    const r = await run('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', file], { timeoutMs: 20000 })
    if (r.code !== 0 || !existsSync(file)) throw new HelperError(r.stderr.trim() || 'screencapture failed')
    const f = frame(st.display)
    const img = nativeImage.createFromPath(file).resize({ width: f.width, height: f.height, quality: 'good' })
    const front = st.frontmost?.name ? ` Frontmost app: ${st.frontmost.name}.` : ''
    return {
      text: `${note}${front}\n(Screenshot ${f.width}×${f.height}. Give x/y in these pixels; the top-left corner is 0,0.)`,
      image: { data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' }
    }
  } finally {
    rmSync(file, { force: true })
  }
}

const ACTIONS = ['screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'open_app', 'wait'] as const
type Action = (typeof ACTIONS)[number]
const LOOKS = new Set<Action>(['screenshot', 'wait'])

export function computerTools(deps: {
  ask(threadId: string, agent: AgentId, req: { title: string; detail?: string; key: string }): Promise<ApprovalDecision>
  modeFor(threadId: string): PermissionMode
}): ToolDef[] {
  return [
    {
      name: 'computer',
      description: [
        "See this Mac's screen and use its mouse and keyboard, to work in native apps (Finder, System Settings, Xcode's windows, any desktop app). For web pages use the browser_* tools, and for the iOS Simulator the ios_* tools: they're faster and more reliable. Prefer the shell for anything it can do.",
        'Start with action "screenshot". Every other action returns a fresh screenshot. x/y are pixels in the latest screenshot (top-left is 0,0); only the main display is visible.',
        'Actions: screenshot · click / double_click / right_click (x, y) · move (x, y) · drag (x, y → to_x, to_y) · scroll (x, y, direction, amount) · type (text, into the focused field; "\\n" presses Return) · key (keys, e.g. "cmd+t", "return", "cmd+shift+4"; space-separate several) · open_app (app name or bundle id; also brings it to the front) · wait (seconds).',
        "Bring an app forward with open_app before typing into it; keyboard shortcuts beat hunting for icons. You can't click or type into R-Code's own window. The user approves computer control per chat and can stop you at any time."
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS], description: 'What to do' },
          x: num('Screenshot x for click, move, drag start and scroll'),
          y: num('Screenshot y for click, move, drag start and scroll'),
          to_x: num('Drag end x'),
          to_y: num('Drag end y'),
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default down)' },
          amount: num('Scroll distance in lines (default 5)'),
          text: str('Text for type'),
          keys: str('Key combination(s) for key, e.g. "cmd+c" or "cmd+a delete"'),
          app: str('App name or bundle id for open_app, e.g. "Notes" or "com.apple.Notes"'),
          seconds: num('How long to wait (default 1, max 10)')
        },
        required: ['action']
      },
      enabledBy: 'enableComputerControl',
      topLevelOnly: true,
      async run(ctx, args) {
        const action = String(args.action ?? '') as Action
        if (!ACTIONS.includes(action)) return { text: `Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`, isError: true }
        const acts = !LOOKS.has(action)
        const mode = deps.modeFor(ctx.threadId)
        if (mode === 'plan' && acts) return { text: 'Plan mode: you can look at the screen but not click or type. Put these steps in your plan instead.', isError: true }

        if (mode !== 'allowAll') {
          const decision = await deps.ask(ctx.threadId, ctx.agent, {
            title: `Let ${AGENT_LABELS[ctx.agent]} see your screen and use your mouse and keyboard?`,
            detail: `Next: ${describeComputerAction(args)}\n\n“Always allow this chat” lets it keep going without asking. Stop the chat at any time to take back control.`,
            key: 'computer-control'
          })
          if (decision === 'deny') return { text: 'The user declined computer control for this step. Ask them how to proceed instead of retrying.', isError: true }
        }

        try {
          return await perform(action, args)
        } catch (err) {
          if (err instanceof HelperError && err.needs) return permissionError(err.needs)
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
      }
    }
  ]
}

async function perform(action: Action, a: any): Promise<ToolResult> {
  if (action === 'screenshot') return screenshot('Screenshot of the main display.')
  if (action === 'wait') {
    await sleep(Math.min(10, Math.max(0, Number(a.seconds) || 1)) * 1000)
    return screenshot('Waited.')
  }
  if (action === 'open_app') {
    const name = String(a.app ?? '').trim()
    if (!name) return { text: 'open_app needs app, e.g. "Notes".', isError: true }
    const byId = /^[\w-]+(\.[\w-]+)+$/.test(name) && !/\s/.test(name)
    const r = await run('/usr/bin/open', [byId ? '-b' : '-a', name], { timeoutMs: 30000 })
    if (r.code !== 0) return { text: `Couldn't open "${name}": ${r.stderr.trim() || 'no such app'}.`, isError: true }
    await sleep(1200)
    return screenshot(`Opened ${name}.`)
  }

  const st = await helper(['status'])
  if (!st.accessibility) return permissionError('accessibility')
  const f = frame(st.display)
  const pt = (x: unknown, y: unknown, label = 'x/y'): [string, string] => {
    const px = Number(x)
    const py = Number(y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new HelperError(`${action} needs ${label} as numbers.`)
    if (px < 0 || py < 0 || px > f.width || py > f.height) throw new HelperError(`(${px}, ${py}) is outside the ${f.width}×${f.height} screenshot.`)
    return [String(Math.round(px * f.factor)), String(Math.round(py * f.factor))]
  }

  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      await helper(['click', ...pt(a.x, a.y), '--button', action === 'right_click' ? 'right' : 'left', '--count', action === 'double_click' ? '2' : '1'])
      break
    case 'move':
      await helper(['move', ...pt(a.x, a.y)])
      break
    case 'drag':
      await helper(['drag', ...pt(a.x, a.y), ...pt(a.to_x, a.to_y, 'to_x/to_y')])
      break
    case 'scroll': {
      const lines = Math.max(1, Math.min(50, Math.round(Number(a.amount) || 5)))
      const dir = String(a.direction ?? 'down')
      const dx = dir === 'left' ? lines : dir === 'right' ? -lines : 0
      const dy = dir === 'up' ? lines : dir === 'down' ? -lines : 0
      await helper(['scroll', ...pt(a.x, a.y), String(dx), String(dy)])
      break
    }
    case 'type':
      if (typeof a.text !== 'string' || !a.text) return { text: 'type needs text.', isError: true }
      await helper(['type', a.text])
      break
    case 'key':
      if (typeof a.keys !== 'string' || !a.keys.trim()) return { text: 'key needs keys, e.g. "cmd+t".', isError: true }
      await helper(['key', a.keys.trim()])
      break
  }
  await sleep(action === 'type' || action === 'key' ? 400 : 600)
  return screenshot(`Done: ${describeComputerAction(a)}.`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
