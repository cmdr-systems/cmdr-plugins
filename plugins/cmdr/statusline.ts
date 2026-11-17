// The agent's Claude Code status line (the box's launcher sets it in the
// agent's settings: crew-launch pointStatusLine). Claude Code runs it after
// every assistant message with the session's live numbers on stdin; how full
// its context is (context.ts) is handed to this agent's channel over its
// local socket (<CMDR_STATE_DIR>/activity.sock), which tells cmdr.mc.
//
// It prints one short line, the terminal's status line, which nobody
// watches but reads true for anyone who does. It always exits 0: a status
// line that fails must not trouble the session.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readStatusLine } from './context.js'

const stateDir = (process.env.CMDR_STATE_DIR ?? '').trim() || join(homedir(), '.claude', 'channels', 'cmdr')
try {
  const input = await Bun.stdin.text()
  const c = readStatusLine(JSON.parse(input))
  if (c) {
    process.stdout.write(c.percent === null ? 'context —' : `context ${Math.round(c.percent)}%`)
    // Handed as Claude Code gave it: the channel reads it again (context.ts), it never trusts what it's sent.
    await fetch('http://cmdr/context', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: input, signal: AbortSignal.timeout(800) } as RequestInit).catch(() => {})
  }
} catch {
  // nothing readable, or no channel listening (yet): nothing to report
}
process.exit(0)
