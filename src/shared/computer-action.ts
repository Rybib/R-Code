// Plain-language lines for the agents' `computer` tool, shared by approvals and the timeline.

const short = (s: unknown, n = 60): string => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** One line for approvals and the timeline. */
export function describeComputerAction(a: any): string {
  const at = `(${a.x}, ${a.y})`
  switch (a.action) {
    case 'screenshot':
      return 'Look at the screen'
    case 'click':
      return `Click at ${at}`
    case 'double_click':
      return `Double-click at ${at}`
    case 'right_click':
      return `Right-click at ${at}`
    case 'move':
      return `Move the pointer to ${at}`
    case 'drag':
      return `Drag from ${at} to (${a.to_x}, ${a.to_y})`
    case 'scroll':
      return `Scroll ${a.direction ?? 'down'} at ${at}`
    case 'type':
      return `Type "${short(a.text)}"`
    case 'key':
      return `Press ${a.keys}`
    case 'open_app':
      return `Open ${a.app}`
    case 'wait':
      return 'Wait'
    default:
      return 'Use the computer'
  }
}
