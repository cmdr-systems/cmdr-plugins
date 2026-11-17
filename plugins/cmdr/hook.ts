// The agent's Claude Code hooks (hooks/hooks.json): each step (a tool about
// to run, a prompt, the turn's end) as one line (activity.ts), handed to this
// agent's channel over its local socket (<CMDR_STATE_DIR>/activity.sock),
// which tells cmdr.mc. And at the turn's end, an answer the agent wrote but
// never sent with reply (reply-guard.ts) is handed to the channel, which
// posts it to the conversation as the agent: nothing it answers stays in its
// session. It always exits 0 and prints nothing, but for one case: the
// channel can't be reached to post it, and the turn is held open once,
// saying where to send it (Claude Code's Stop hook: { decision: "block" }).
// And a turn that ends with the agent's own task still in progress, or on a
// next step it only promised, is held open once the same way, telling it to
// carry on (continue-gate.ts), unless it said what it's waiting on.
//
// A permission request (PermissionRequest) always gets an answer printed,
// never nothing: nothing would leave Claude Code's own prompt up, on a
// terminal nobody watches, and the session held until the channel's backstop
// refuses it (channel.ts). The channel asks on a card and answers at once
// (permissions.ts); when it can't be reached, the request is refused, saying so.
import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activityOf, type HookInput } from './activity.js'
import { hookOutput, say, type PermissionAnswer } from './permissions.js'
import { reminder, unsentReply } from './reply-guard.js'
import { MODE_FILE } from './mode.js'

/** Enough of a transcript's end to hold the last message and the turn after it. */
const TAIL_BYTES = 4 * 1024 * 1024

async function tail(path: string): Promise<string[]> {
  const f = await open(path, 'r')
  try {
    const { size } = await f.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    await f.read(buf, 0, buf.length, start)
    return buf.toString('utf8').split('\n')
  } finally {
    await f.close()
  }
}

const stateDir = (process.env.CMDR_STATE_DIR ?? '').trim() || join(homedir(), '.claude', 'channels', 'cmdr')
// A local agent's server says so in the state dir at start (server.ts, MODE_FILE): only then does a prompt or a
// turn's end make the calls a terminal needs. A box agent's hooks are exactly what they were.
const offBox = (() => {
  try {
    return readFileSync(join(stateDir, MODE_FILE), 'utf8').trim() === 'external'
  } catch {
    return false
  }
})()
try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  if (input.hook_event_name === 'PermissionRequest') {
    const answer = await fetch('http://cmdr/permission', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify({ tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd }), signal: AbortSignal.timeout(20_000) } as RequestInit)
      .then((r) => (r.ok ? (r.json() as Promise<PermissionAnswer>) : null))
      .catch(() => null)
    // A local agent: no decision, so Claude Code's own prompt asks its operator at the terminal.
    if (answer?.behavior === 'passive') process.exit(0)
    const ok = answer?.behavior === 'allow' || (answer?.behavior === 'deny' && typeof answer.message === 'string')
    process.stdout.write(hookOutput(ok ? answer! : { behavior: 'deny', message: say.unreachable(input.tool_name ?? 'a tool') }))
    process.exit(0)
  }
  // A turn's prompt: the server learns who opened it (a channel delivery or the operator at the terminal) and, for a
  // local agent's linked terminal, mirrors it; the session is told it's mirrored (local-agents design § 3.3).
  if (offBox && input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string') {
    const told = await fetch('http://cmdr/prompt', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify({ prompt: input.prompt }), signal: AbortSignal.timeout(2_500) } as RequestInit)
      .then((r) => (r.ok ? (r.json() as Promise<{ mirrored?: string; refused?: string }>) : null))
      .catch(() => null)
    if (told?.refused === 'no-operator') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: "This terminal is linked, but this agent has no operator among its crew's people, so prompts typed here are not mirrored (your answers still are). Tell the person at the terminal: a crew manager sets the operator on the agent's page." } }))
    else if (told?.mirrored) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `This prompt is mirrored to ${told.mirrored}, and so will your answer be: the crew reads them there. Never type a secret while it is linked (unlink_terminal stops it).` } }))
  }
  // A turn's final text, first: a local agent's operator turn is mirrored to its link (the server decides).
  if (offBox && input.hook_event_name === 'Stop' && !input.stop_hook_active && typeof input.last_assistant_message === 'string') {
    await fetch('http://cmdr/answer', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify({ lastText: input.last_assistant_message }), signal: AbortSignal.timeout(2_500) } as RequestInit).catch(() => null)
  }
  // The turn's end: an answer written and never sent holds it open, once (not when this hook already held it).
  if (input.hook_event_name === 'Stop' && !input.stop_hook_active && input.transcript_path) {
    // The final text from the hook's input: the transcript's last row may not be written yet.
    const unsent = unsentReply(await tail(input.transcript_path).catch(() => []), input.last_assistant_message)
    if (unsent) {
      const posted = await fetch('http://cmdr/unsent', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify(unsent), signal: AbortSignal.timeout(10_000) } as RequestInit)
        .then((r) => r.ok)
        .catch(() => false)
      if (!posted) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: reminder(unsent) }))
        process.exit(0)
      }
    }
  }
  // The turn's end, once more: a task still in progress, or a next step only promised, holds it open once,
  // telling the agent to carry on (continue-gate.ts), unless it said what it's waiting on. Not reached: it ends.
  if (input.hook_event_name === 'Stop' && !input.stop_hook_active) {
    const v = await fetch('http://cmdr/stop', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify({ lastText: input.last_assistant_message }), signal: AbortSignal.timeout(2_500) } as RequestInit)
      .then((r) => (r.ok ? (r.json() as Promise<{ block?: boolean; reason?: string }>) : null))
      .catch(() => null)
    if (v?.block && typeof v.reason === 'string') {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: v.reason }))
      process.exit(0)
    }
  }
  const a = activityOf(input)
  if (a) await fetch('http://cmdr/activity', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify(a), signal: AbortSignal.timeout(800) } as RequestInit)
} catch {
  // no channel listening (yet), or nothing to read: nothing to report
}
process.exit(0)
