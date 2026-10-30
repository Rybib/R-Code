import type { AgentId } from '@shared/types'

// One registry for every tool R-Code gives its agents. Claude and Codex reach it as an
// HTTP MCP server; the built-in Pi agent through its R-Code extension.

export interface ToolResult {
  text: string
  image?: { data: string; mimeType: string }
  isError?: boolean
}

export interface ToolContext {
  threadId: string
  agent: AgentId
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** Only offer this tool to these agents (default: all). */
  agents?: AgentId[]
  /** Hidden from delegated sub-agent threads. */
  topLevelOnly?: boolean
  /** Settings flag that must be on. */
  enabledBy?: 'enableDelegation'
  run(ctx: ToolContext, args: any): Promise<ToolResult>
}

const tools = new Map<string, ToolDef>()

export function registerTools(defs: ToolDef[]): void {
  for (const d of defs) tools.set(d.name, d)
}

export function toolsFor(agent: AgentId, opts: { isChild: boolean; settings: { enableDelegation: boolean } }): ToolDef[] {
  return [...tools.values()].filter(
    (t) => (!t.agents || t.agents.includes(agent)) && !(t.topLevelOnly && opts.isChild) && !(t.enabledBy && !opts.settings[t.enabledBy])
  )
}

export function getTool(name: string): ToolDef | undefined {
  return tools.get(name)
}

export const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
export const num = (description: string): Record<string, unknown> => ({ type: 'number', description })
export const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description })
