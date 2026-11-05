import type { ToolKind } from './types'
import { describeComputerAction } from './computer-action'

/** Friendly titles for R-Code's own agent tools (browser, iOS, delegation, web). */
export function describeRcodeTool(name: string, args: any): { kind: ToolKind; title: string; detail?: string } | null {
  const a = args ?? {}
  switch (name) {
    case 'browser_open':
      return { kind: 'browser', title: `Open ${String(a.url ?? '').replace(/^https?:\/\//, '')}` }
    case 'browser_snapshot':
      return { kind: 'browser', title: 'Read the page' }
    case 'browser_click':
      return { kind: 'browser', title: `Click ${a.text ? `"${a.text}"` : a.ref ?? 'element'}` }
    case 'browser_type':
      return { kind: 'browser', title: `Type into ${a.ref ?? 'field'}`, detail: a.text }
    case 'browser_screenshot':
      return { kind: 'browser', title: 'Screenshot the page' }
    case 'browser_eval':
      return { kind: 'browser', title: 'Run JavaScript in the page', detail: a.code }
    case 'browser_console':
      return { kind: 'browser', title: 'Read the browser console' }
    case 'ios_build_and_run':
      return { kind: 'ios', title: `Build & run${a.scheme ? ` ${a.scheme}` : ''} in the Simulator` }
    case 'ios_screenshot':
      return { kind: 'ios', title: 'Screenshot the Simulator' }
    case 'ios_tap':
      return { kind: 'ios', title: `Tap (${a.x}, ${a.y})` }
    case 'ios_swipe':
      return { kind: 'ios', title: 'Swipe in the Simulator' }
    case 'ios_type_text':
      return { kind: 'ios', title: 'Type in the Simulator', detail: a.text }
    case 'ios_describe_ui':
      return { kind: 'ios', title: 'Inspect the Simulator UI' }
    case 'ios_list_simulators':
      return { kind: 'ios', title: 'List simulators' }
    case 'ios_boot_simulator':
      return { kind: 'ios', title: `Boot ${a.device ?? 'simulator'}` }
    case 'ios_open_url':
      return { kind: 'ios', title: `Open ${a.url} in the Simulator` }
    case 'ios_app_logs':
      return { kind: 'ios', title: 'Read Simulator logs' }
    case 'terminal_run':
      return { kind: 'command', title: a.title ? `Run ${a.title} in the terminal` : 'Run in the terminal', detail: a.command }
    case 'terminal_read':
      return { kind: 'command', title: `Read terminal ${a.id ?? ''}`.trim() }
    case 'terminal_write':
      return { kind: 'command', title: `Type into terminal ${a.id ?? ''}`.trim(), detail: a.text }
    case 'terminal_kill':
      return { kind: 'command', title: `Stop terminal ${a.id ?? ''}`.trim() }
    case 'terminal_list':
      return { kind: 'command', title: 'List terminals' }
    case 'computer':
      return { kind: 'computer', title: describeComputerAction(a), detail: a.action === 'type' ? a.text : undefined }
    case 'search_web':
    case 'web_search':
      return { kind: 'web', title: `Search the web for "${a.query ?? ''}"` }
    case 'fetch_url':
    case 'web_fetch':
      return { kind: 'web', title: `Fetch ${String(a.url ?? '').replace(/^https?:\/\//, '')}` }
    case 'delegate_task':
      return { kind: 'task', title: `Delegate to ${a.agent ?? 'agent'}`, detail: a.task }
    case 'list_agents':
      return { kind: 'task', title: 'List available agents' }
    case 'suggest_new_chat':
      return { kind: 'task', title: 'Suggest a fresh chat', detail: a.reason }
    default:
      return null
  }
}
