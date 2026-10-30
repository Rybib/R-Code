import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { nativeImage, shell } from 'electron'
import { run, runShellStreaming, which } from '../env'
import { dataPath, getSettings, updateSettings } from '../store'
import type { ToolDef, ToolResult } from './registry'
import { num, str } from './registry'

// iOS Simulator + Xcode integration: list/boot simulators, build & run an Xcode project,
// screenshot, and drive the UI (tap/swipe/type/describe) through the open-source AXe CLI.
// The same functions back the Simulator side panel and the agents' ios_* tools.

export interface SimDevice {
  udid: string
  name: string
  state: string
  runtime: string
}

export async function listDevices(): Promise<SimDevice[]> {
  const r = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: 20000 })
  if (r.code !== 0) return []
  const j = JSON.parse(r.stdout)
  const out: SimDevice[] = []
  for (const [runtime, devices] of Object.entries<any[]>(j.devices ?? {})) {
    const rt = runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ')
    for (const d of devices) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: rt })
  }
  // Booted first, then iPhones, newest runtime first.
  return out.sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted') || Number(b.name.startsWith('iPhone')) - Number(a.name.startsWith('iPhone')) || b.runtime.localeCompare(a.runtime))
}

/** Resolve a device by udid or (partial) name; default to the booted one, then the last used. */
export async function resolveDevice(query?: string): Promise<SimDevice | undefined> {
  const devices = await listDevices()
  if (query) {
    const q = query.toLowerCase()
    return devices.find((d) => d.udid.toLowerCase() === q) ?? devices.find((d) => d.name.toLowerCase() === q) ?? devices.find((d) => d.name.toLowerCase().includes(q))
  }
  const last = getSettings().iosDevice
  return devices.find((d) => d.state === 'Booted') ?? devices.find((d) => d.udid === last) ?? devices.find((d) => d.name.startsWith('iPhone'))
}

export async function bootDevice(udid: string): Promise<string> {
  const r = await run('xcrun', ['simctl', 'boot', udid], { timeoutMs: 120000 })
  if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) return r.stderr.trim()
  await run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: 180000 })
  updateSettings({ iosDevice: udid })
  return 'booted'
}

export async function shutdownDevice(udid: string): Promise<void> {
  await run('xcrun', ['simctl', 'shutdown', udid], { timeoutMs: 60000 })
}

export async function screenshot(udid: string, maxWidth = 900): Promise<{ data: string; width: number; height: number; scale: number }> {
  const file = dataPath(`sim-${udid}.png`)
  const r = await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file], { timeoutMs: 20000 })
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'screenshot failed')
  const img = nativeImage.createFromPath(file)
  const size = img.getSize()
  const scaled = size.width > maxWidth ? img.resize({ width: maxWidth, quality: 'good' }) : img
  rmSync(file, { force: true })
  return { data: scaled.toPNG().toString('base64'), width: size.width, height: size.height, scale: size.width > 1000 ? 3 : 2 }
}

export const axePath = (): string | undefined => which('axe')

async function axe(args: string[], udid: string): Promise<ToolResult> {
  const bin = axePath()
  if (!bin) return { text: 'UI automation needs the AXe CLI. Ask the user to install it from R-Code → Settings → iOS & Xcode (or run: brew install cameroncooke/axe/axe).', isError: true }
  const r = await run(bin, [...args, '--udid', udid], { timeoutMs: 30000 })
  return { text: (r.stdout || r.stderr || 'ok').trim().slice(0, 30000), isError: r.code !== 0 }
}

export async function tap(udid: string, x: number, y: number): Promise<ToolResult> {
  return axe(['tap', '-x', String(Math.round(x)), '-y', String(Math.round(y))], udid)
}

export async function pressHome(udid: string): Promise<ToolResult> {
  return axe(['button', 'home'], udid)
}

export async function installAxe(log: (line: string) => void): Promise<boolean> {
  if (!which('brew')) {
    log('Homebrew is required to install AXe. Opening the AXe project page…')
    void shell.openExternal('https://github.com/cameroncooke/AXe')
    return false
  }
  const code = await runShellStreaming('brew install cameroncooke/axe/axe', log)
  return code === 0
}

// ───────────── Xcode build & run ─────────────

function findXcodeContainer(dir: string, depth = 2): { kind: 'workspace' | 'project'; path: string } | undefined {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const ws = entries.find((e) => e.endsWith('.xcworkspace') && !e.startsWith('.'))
  if (ws) return { kind: 'workspace', path: join(dir, ws) }
  const proj = entries.find((e) => e.endsWith('.xcodeproj'))
  if (proj) return { kind: 'project', path: join(dir, proj) }
  if (depth <= 0) return undefined
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules' || e === 'Pods' || e === 'build' || e === 'DerivedData') continue
    const p = join(dir, e)
    try {
      if (statSync(p).isDirectory()) {
        const found = findXcodeContainer(p, depth - 1)
        if (found) return found
      }
    } catch {
      /* skip */
    }
  }
  return undefined
}

export async function buildAndRun(opts: { cwd: string; path?: string; scheme?: string; device?: string; configuration?: string }, log: (line: string) => void): Promise<ToolResult> {
  if (!which('xcodebuild')) return { text: 'Xcode command line tools are not available (xcodebuild not found).', isError: true }
  const root = opts.path ? (opts.path.startsWith('/') ? opts.path : join(opts.cwd, opts.path)) : opts.cwd
  const container = root.endsWith('.xcodeproj') ? { kind: 'project' as const, path: root } : root.endsWith('.xcworkspace') ? { kind: 'workspace' as const, path: root } : findXcodeContainer(root)
  if (!container) return { text: `No .xcodeproj or .xcworkspace found under ${root}.`, isError: true }
  const flag = container.kind === 'workspace' ? '-workspace' : '-project'

  let scheme = opts.scheme
  if (!scheme) {
    const list = await run('xcodebuild', ['-list', '-json', flag, container.path], { timeoutMs: 60000 })
    try {
      const j = JSON.parse(list.stdout)
      const schemes: string[] = j.workspace?.schemes ?? j.project?.schemes ?? []
      const name = container.path.split('/').pop()!.replace(/\.(xcodeproj|xcworkspace)$/, '')
      scheme = schemes.find((s) => s === name) ?? schemes.find((s) => !/tests?$/i.test(s)) ?? schemes[0]
    } catch {
      /* fall through */
    }
  }
  if (!scheme) return { text: 'Could not determine a scheme; pass one explicitly.', isError: true }

  const device = await resolveDevice(opts.device)
  if (!device) return { text: 'No iOS simulator available. Install one in Xcode → Settings → Components.', isError: true }
  if (device.state !== 'Booted') {
    log(`Booting ${device.name}…`)
    await bootDevice(device.udid)
  }
  const derived = dataPath('DerivedData', createHash('sha1').update(container.path).digest('hex').slice(0, 12))
  mkdirSync(derived, { recursive: true })
  log(`Building ${scheme} for ${device.name}…`)
  const errors: string[] = []
  let lastLines: string[] = []
  const args = [flag, container.path, '-scheme', scheme, '-configuration', opts.configuration ?? 'Debug', '-destination', `id=${device.udid}`, '-derivedDataPath', derived, 'build']
  const code = await runShellStreaming(`xcodebuild ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, (line) => {
    if (/error:|warning: .*deprecated/.test(line) && errors.length < 40 && /error:/.test(line)) errors.push(line.trim())
    lastLines = [...lastLines.slice(-15), line]
    if (/^(CompileSwift|Ld |CodeSign|ProcessInfoPlistFile|\*\* BUILD)/.test(line)) log(line.slice(0, 160))
  })
  if (code !== 0) {
    return { text: `Build failed for scheme ${scheme}.\n\n${errors.join('\n') || lastLines.join('\n')}`, isError: true }
  }
  const products = join(derived, 'Build', 'Products', `${opts.configuration ?? 'Debug'}-iphonesimulator`)
  const app = existsSync(products) ? readdirSync(products).find((f) => f.endsWith('.app')) : undefined
  if (!app) return { text: `Build succeeded but no .app was found in ${products}.`, isError: true }
  const appPath = join(products, app)
  let bundleId = ''
  try {
    const plist = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', join(appPath, 'Info.plist')])
    bundleId = plist.stdout.trim()
  } catch {
    /* ignore */
  }
  log(`Installing ${app}…`)
  const inst = await run('xcrun', ['simctl', 'install', device.udid, appPath], { timeoutMs: 120000 })
  if (inst.code !== 0) return { text: `Install failed: ${inst.stderr}`, isError: true }
  const launch = await run('xcrun', ['simctl', 'launch', '--terminate-running-process', device.udid, bundleId], { timeoutMs: 60000 })
  log(launch.code === 0 ? `Launched ${bundleId} ✓` : `Launch failed: ${launch.stderr}`)
  return {
    text: `Built ${scheme} and launched ${bundleId || app} on ${device.name} (${device.runtime}).${errors.length ? `\nWarnings/errors:\n${errors.join('\n')}` : ''}`,
    isError: launch.code !== 0
  }
}

export function iosTools(notify: (c: string, p: unknown) => void, cwdFor: (threadId: string) => string): ToolDef[] {
  const show = (): void => notify('panel-open', 'simulator')
  const dev = async (q?: string): Promise<{ device?: (SimDevice & { booted: boolean }) | undefined; error?: ToolResult }> => {
    const d = await resolveDevice(q)
    if (!d) return { error: { text: 'No matching simulator. Call ios_list_simulators.', isError: true } }
    return { device: { ...d, booted: d.state === 'Booted' } }
  }
  const withShot = async (udid: string, text: string): Promise<ToolResult> => {
    await new Promise((r) => setTimeout(r, 600))
    const s = await screenshot(udid, 600)
    return { text: `${text}\n(Screenshot ${s.width}×${s.height}px at ${s.scale}x — tap coordinates are in points: ≈${Math.round(s.width / s.scale)}×${Math.round(s.height / s.scale)})`, image: { data: s.data, mimeType: 'image/png' } }
  }
  return [
    {
      name: 'ios_list_simulators',
      description: 'List available iOS simulators (name, UDID, runtime, state).',
      schema: { type: 'object', properties: {} },
      async run() {
        const d = await listDevices()
        return { text: d.map((x) => `${x.state === 'Booted' ? '● ' : '  '}${x.name} — ${x.runtime} — ${x.udid} (${x.state})`).join('\n') || 'No simulators found.' }
      }
    },
    {
      name: 'ios_boot_simulator',
      description: 'Boot an iOS simulator (by name or UDID; defaults to the most recently used iPhone). It appears in R-Code’s Simulator panel.',
      schema: { type: 'object', properties: { device: str('Simulator name or UDID') } },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        show()
        const res = await bootDevice(device!.udid)
        return withShot(device!.udid, res === 'booted' ? `${device!.name} is booted.` : res)
      }
    },
    {
      name: 'ios_build_and_run',
      description:
        'Build the Xcode project/workspace in the current project with xcodebuild, install it on an iOS simulator and launch it. Returns compiler errors on failure, or a screenshot of the running app.',
      schema: {
        type: 'object',
        properties: {
          path: str('Optional path to the .xcodeproj/.xcworkspace or its folder (defaults to the project root)'),
          scheme: str('Optional scheme name'),
          device: str('Optional simulator name or UDID'),
          configuration: str('Debug (default) or Release')
        }
      },
      async run(ctx, args) {
        show()
        const res = await buildAndRun({ cwd: cwdFor(ctx.threadId), ...args }, (line) => notify('ios-log', line))
        if (res.isError) return res
        const d = await resolveDevice(args.device)
        return d ? withShot(d.udid, res.text) : res
      }
    },
    {
      name: 'ios_screenshot',
      description: 'Screenshot the booted iOS simulator so you can see the app.',
      schema: { type: 'object', properties: { device: str('Optional simulator name or UDID') } },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        if (!device!.booted) return { text: `${device!.name} is not booted. Call ios_boot_simulator first.`, isError: true }
        show()
        return withShot(device!.udid, `Screenshot of ${device!.name}.`)
      }
    },
    {
      name: 'ios_describe_ui',
      description: 'Dump the accessibility tree of the simulator screen (labels, roles and frames in points). Best way to find tap targets.',
      schema: { type: 'object', properties: { device: str('Optional simulator name or UDID') } },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        return axe(['describe-ui'], device!.udid)
      }
    },
    {
      name: 'ios_tap',
      description: 'Tap the simulator screen at (x, y) in points (use ios_describe_ui frames). Returns a fresh screenshot.',
      schema: { type: 'object', properties: { x: num('x in points'), y: num('y in points'), device: str('Optional simulator') }, required: ['x', 'y'] },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        show()
        const r = await tap(device!.udid, Number(args.x), Number(args.y))
        return r.isError ? r : withShot(device!.udid, `Tapped (${args.x}, ${args.y}).`)
      }
    },
    {
      name: 'ios_swipe',
      description: 'Swipe on the simulator from (x1,y1) to (x2,y2) in points (scrolling, dismissing sheets).',
      schema: { type: 'object', properties: { x1: num('start x'), y1: num('start y'), x2: num('end x'), y2: num('end y'), device: str('Optional simulator') }, required: ['x1', 'y1', 'x2', 'y2'] },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        show()
        const r = await axe(['swipe', '--start-x', String(args.x1), '--start-y', String(args.y1), '--end-x', String(args.x2), '--end-y', String(args.y2)], device!.udid)
        return r.isError ? r : withShot(device!.udid, 'Swiped.')
      }
    },
    {
      name: 'ios_type_text',
      description: 'Type text into the focused field in the simulator.',
      schema: { type: 'object', properties: { text: str('Text to type'), device: str('Optional simulator') }, required: ['text'] },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        const r = await axe(['type', String(args.text)], device!.udid)
        return r.isError ? r : withShot(device!.udid, 'Typed.')
      }
    },
    {
      name: 'ios_open_url',
      description: 'Open a URL or deep link in the simulator (Safari for http(s), or your app’s URL scheme).',
      schema: { type: 'object', properties: { url: str('URL or deep link'), device: str('Optional simulator') }, required: ['url'] },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        show()
        const r = await run('xcrun', ['simctl', 'openurl', device!.udid, String(args.url)], { timeoutMs: 30000 })
        return r.code === 0 ? withShot(device!.udid, `Opened ${args.url}.`) : { text: r.stderr, isError: true }
      }
    },
    {
      name: 'ios_app_logs',
      description: 'Recent unified-log output from the simulator, optionally filtered to one process (your app’s executable name).',
      schema: { type: 'object', properties: { process: str('Process/executable name to filter on'), seconds: num('How far back (default 60)'), device: str('Optional simulator') } },
      async run(_ctx, args) {
        const { device, error } = await dev(args.device)
        if (error) return error
        const pred = args.process ? ['--predicate', `process == "${String(args.process).replace(/"/g, '')}"`] : []
        const r = await run('xcrun', ['simctl', 'spawn', device!.udid, 'log', 'show', '--last', `${Number(args.seconds) || 60}s`, '--style', 'compact', ...pred], { timeoutMs: 60000 })
        const lines = r.stdout.split('\n')
        return { text: lines.slice(-200).join('\n') || r.stderr || '(no log lines)' }
      }
    }
  ]
}

export function readPng(path: string): string {
  return readFileSync(path).toString('base64')
}
