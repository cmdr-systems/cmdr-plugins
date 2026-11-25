// A second session of a local agent stands down instead of failing (LOCAL-AGENTS-41).
//
// A local agent's state directory belongs to one live session (state-dir.ts). Another Claude Code session started in
// the agent's folder (a one-off `claude`, a check) used to get `state-dir-in-use` and exit 1. Claude Code then caches
// that MCP failure for its project folder for 15 minutes, across sessions, so the launcher's next fresh session
// skipped the cmdr server altogether ("Skipping connection (recent failure cached…)"), and the agent stayed offline
// until someone picked Reconnect (seen on a local agent, 2026-11-25).
//
// So this session's server connects and serves nothing: no tools, no channel. It is never a silent "connected but
// deaf" (MASE, 2026-11-25): the reason, naming the session that holds the directory, is in its instructions (what
// `/mcp` and the session are told), on stderr and in the events log (`standing_down`).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { PLUGIN_VERSION } from './agent-client/client.js'
import type { Holder } from './state-dir.js'

/** The one line said everywhere: why, and who holds the directory. */
export function standDownLine(dir: string, holder: Holder | null): string {
  const where = dir.split('/').filter(Boolean).slice(-2).join('/')
  const who = holder ? `pid ${holder.pid} (session ${holder.session ?? 'unknown'}, since ${holder.since})` : 'another session of this agent'
  return `standing down: state-dir-in-use, ${where} is held by ${who}, in ${dir}. This session hears nothing and can't answer as the agent; the agent's own session does.`
}

export type StandDownDeps = {
  transport: Transport
  dir: string
  holder: Holder | null
  log: (line: string) => void
  stamp: (tag: string) => void
}

/** Connect an MCP server with no tools, its instructions the reason. Resolves once connected. */
export async function standDown(deps: StandDownDeps): Promise<Server> {
  const line = standDownLine(deps.dir, deps.holder)
  deps.log(line)
  deps.stamp(`standing_down holder=${deps.holder?.pid ?? 'unknown'}`)
  const mcp = new Server({ name: 'cmdr', version: PLUGIN_VERSION }, { capabilities: { tools: {} }, instructions: `cmdr channel ${line}` })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  await mcp.connect(deps.transport)
  return mcp
}
