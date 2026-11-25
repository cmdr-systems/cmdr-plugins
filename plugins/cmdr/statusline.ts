// The agent's Claude Code status line (the box's launcher sets it in the
// agent's settings: crew-launch pointStatusLine; a local agent's launcher in
// its session's own --settings file: launcher design 0.2.27 § 3.3 step 5).
// Claude Code runs it after every assistant message with the session's live
// numbers on stdin; how full its context is (context.ts) is handed to this
// agent's channel over its local socket (<CMDR_STATE_DIR>/activity.sock),
// which tells cmdr.mc.
//
// It prints one short line, the terminal's status line. On a person's
// computer, when they have a status line of their own (CMDR_STATUSLINE_NEXT,
// set by the launcher from their ~/.claude/settings.json), that one runs
// after, given the same input, and its output is what shows: their terminal
// looks as it did. It always exits 0: a status line that fails must not
// trouble the session.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readStatusLine } from './context.js'

/** How long the person's own status line may take before ours shows instead. */
const NEXT_TIMEOUT_MS = 5_000

const stateDir = (process.env.CMDR_STATE_DIR ?? '').trim() || join(homedir(), '.claude', 'channels', 'cmdr')
const next = (process.env.CMDR_STATUSLINE_NEXT ?? '').trim()
let input = ''
let ours = ''
try {
  input = await Bun.stdin.text()
  const c = readStatusLine(JSON.parse(input))
  if (c) {
    ours = c.percent === null ? 'context —' : `context ${Math.round(c.percent)}%`
    // Handed as Claude Code gave it: the channel reads it again (context.ts), it never trusts what it's sent.
    await fetch('http://cmdr/context', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: input, signal: AbortSignal.timeout(800) } as RequestInit).catch(() => {})
  }
} catch {
  // nothing readable, or no channel listening (yet): nothing to report
}
let shown = ours
if (next) {
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'CMDR_STATUSLINE_NEXT' && k !== 'CMDR_AGENT_KEY') env[k] = v
    const p = Bun.spawn(['/bin/sh', '-c', next], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'ignore', env })
    // Raced against the clock, not left to a kill: a child of theirs can hold stdout open past its shell (Verify R719-1).
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), NEXT_TIMEOUT_MS)))
    const out = await Promise.race([new Response(p.stdout).text(), late])
    clearTimeout(timer)
    if (out === null) p.kill(9)
    else if ((await p.exited) === 0 || out) shown = out
  } catch {
    // theirs failed to start: ours shows
  }
}
process.stdout.write(shown)
process.exit(0)
