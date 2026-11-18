// The agent's Claude Code hooks (hooks/hooks.json): each step (a tool about
// to run, a prompt, the turn's end) as one line (activity.ts), handed to this
// agent's channel over its local socket (<CMDR_STATE_DIR>/activity.sock),
// which tells cmdr.mc. And at the turn's end, an answer the agent wrote but
// never sent with reply (reply-guard.ts) is handed to the channel, which
// posts it to the conversation as the agent: nothing it answers stays in its
// session. Held open once first (Claude Code's Stop hook: { decision:
// "block" }), saying to send it with reply or call stay_quiet: only text the
// turn still ends on after that hold is posted (BUGS-7). Otherwise it exits
// 0 and prints nothing, but for the compaction it holds off (below).
// And a turn that ends with the agent's own task still in progress, or on a
// next step it only promised, is held open once the same way, telling it to
// carry on (continue-gate.ts), unless it said what it's waiting on.
//
// A permission request (PermissionRequest) always gets an answer printed,
// never nothing: nothing would leave Claude Code's own prompt up, on a
// terminal nobody watches, and the session held until the channel's backstop
// refuses it (channel.ts). The channel asks on a card and answers at once
// (permissions.ts); when it can't be reached, the request is refused, saying so.
//
// A compaction Claude Code is about to run on its own (PreCompact, trigger
// auto; BUGS-9) is told to the channel, and held off (exit 2) only when the
// channel says cmdr.mc acknowledged Doc's fresh restart of the session.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activityOf, type HookInput } from './activity.js'
import { hookOutput, say, type PermissionAnswer } from './permissions.js'
import { reminder, unsentReply } from './reply-guard.js'
import { MODE_FILE } from './mode.js'

/** How long a compaction about to run waits on the channel (hooks.json gives the hook 10 s): past it, it runs. */
const COMPACTING_WAIT_MS = 5_000

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
/** The reply guard's hold, marked: the transcript whose turn it held open (hook.ts alone writes and removes it). */
const HELD = join(stateDir, 'unsent-held')
const marked = (transcript: string) => {
  try {
    writeFileSync(HELD, transcript, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
/** The continue gate's verdict (continue-gate.ts, asked of the channel): its reason when it holds the turn, else null. */
const gateOf = (lastText: string | undefined) =>
  fetch('http://cmdr/stop', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify({ lastText }), signal: AbortSignal.timeout(2_500) } as RequestInit)
    .then((r) => (r.ok ? (r.json() as Promise<{ block?: boolean; reason?: string }>) : null))
    .then((v) => (v?.block && typeof v.reason === 'string' ? v.reason : null))
    .catch(() => null)
const post = (unsent: object) =>
  fetch('http://cmdr/unsent', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify(unsent), signal: AbortSignal.timeout(10_000) } as RequestInit)
    .then((r) => r.ok)
    .catch(() => false)
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
  // Claude Code about to compact the session on its own (PreCompact, trigger auto; BUGS-9): the channel tells cmdr.mc,
  // which reads it as full and has Doc restart it fresh. Held off (exit 2) only when the channel says cmdr.mc
  // acknowledged that restart (it waits COMPACTING_ASK_MS for that, under this wait); otherwise, with no channel to
  // ask, or past the wait, it runs. A compaction someone asked for (/compact, trigger manual) always runs.
  if (input.hook_event_name === 'PreCompact') {
    if (input.trigger !== 'auto') process.exit(0)
    const v = await fetch('http://cmdr/compacting', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify({ sessionId: input.session_id ?? null }), signal: AbortSignal.timeout(COMPACTING_WAIT_MS) } as RequestInit)
      .then((r) => (r.ok ? (r.json() as Promise<{ hold?: boolean }>) : null))
      .catch(() => null)
    if (v?.hold === true) {
      process.stderr.write('cmdr: not compacting: this session is full, and Doc is restarting it fresh (it picks up from your handoff). Write your handoff now if you have not.\n')
      process.exit(2)
    }
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
  // The turn's end: text written and never sent (reply-guard.ts) holds it open once, the reminder naming reply and
  // stay_quiet, and is posted only if the turn still ends on text after that hold (BUGS-7: posted at once, a turn's
  // closing recap went out as a message). The hold is marked in the state dir (HELD, this transcript's path) so the
  // second Stop knows it was this hold's, not the continue gate's: after the gate's, nothing is posted, as before.
  if (input.hook_event_name === 'Stop' && input.transcript_path) {
    const held = (() => {
      try {
        return readFileSync(HELD, 'utf8')
      } catch {
        return ''
      }
    })()
    rmSync(HELD, { force: true })
    if (!input.stop_hook_active || held === input.transcript_path) {
      // The final text from the hook's input: the transcript's last row may not be written yet.
      const unsent = unsentReply(await tail(input.transcript_path).catch(() => []), input.last_assistant_message)
      if (unsent && !input.stop_hook_active && marked(input.transcript_path)) {
        // The continue gate's hold, if it applies too, rides in the same block (its one hold this turn would otherwise be
        // lost, and the second Stop must be the guard's alone).
        const gate = await gateOf(input.last_assistant_message)
        process.stdout.write(JSON.stringify({ decision: 'block', reason: gate ? `${reminder(unsent)}\n\n${gate}` : reminder(unsent) }))
        process.exit(0)
      }
      // After the hold (or the mark couldn't be written): post it, once. Unreachable then: nothing more, never a second hold.
      if (unsent) await post(unsent)
    }
  }
  // The turn's end, once more: a task still in progress, or a next step only promised, holds it open once,
  // telling the agent to carry on (continue-gate.ts), unless it said what it's waiting on. Not reached: it ends.
  if (input.hook_event_name === 'Stop' && !input.stop_hook_active) {
    const reason = await gateOf(input.last_assistant_message)
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason }))
      process.exit(0)
    }
  }
  const a = activityOf(input)
  if (a) await fetch('http://cmdr/activity', { unix: join(stateDir, 'activity.sock'), method: 'POST', body: JSON.stringify(a), signal: AbortSignal.timeout(800) } as RequestInit)
} catch {
  // no channel listening (yet), or nothing to read: nothing to report
}
process.exit(0)
