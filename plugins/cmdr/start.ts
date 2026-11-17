// The plugin's start (`bun run start`, which .mcp.json runs on a box and on a laptop; local-agents design 0.1.14,
// PD-16): the shared bootstrap checks the runtime packages against bun.lock before any external import and refuses
// `dependencies-missing: <package>` (exit 1) before any import of it and before any socket. Then the server.
// Only node:* and relative imports here.
import { dependencyGap, gapLine } from './agent-client/bootstrap.js'

const gap = dependencyGap(import.meta.dir)
if (gap) {
  process.stderr.write(`cmdr channel: ${gapLine(gap, import.meta.dir)}\n`)
  process.exit(1)
}
await import('./server.js')
