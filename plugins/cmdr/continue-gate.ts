// The turn's end, checked a second way: did the agent stop on work it still
// has? An agent that writes "next I'll check the deploy, then -81" and ends
// its turn has started neither: Claude Code takes the written plan as the
// turn's end, and nothing wakes the agent until someone asks it something
// (seen 2026-11-02: Sentience stopped on a plan twice in one day, the second
// time for most of a day, with -81 in progress).
//
// So at the turn's end (the Stop hook, hook.ts → channel.ts stopCheck), the
// turn is held open once, telling the agent to go on, when either:
//   - it has a task of its own in progress, or
//   - its last words promise a next step ("I'll", "next", "starting it now").
// Never when it has said what it's waiting on (waiting_on): a person's
// answer, a review, CI, a deploy. That wait holds until someone (a person or
// another agent) next writes to it, which is what usually ends it; then a
// turn that stops without saying so again is held open once more.
//
// Once per turn: Claude Code marks a turn this hook already held open
// (stop_hook_active) and hook.ts never asks twice, so an agent that truly
// can't go on and won't say why only costs one more step, never a loop.
// The queue never is: its turns are news and offers, never a task of its own.

/** What the agent said it's waiting on (waiting_on): who or what, and for what. */
export type Waiting = { on: string; what: string; task?: string; at: string }
export type MyTask = { key: string; title: string; status: string }
export type GateVerdict = { block: false } | { block: true; reason: string }

/** A next step promised in the agent's own words, the way agents write it. */
const PROMISE = /\b(?:I['’]ll|I will|I['’]m (?:going to|starting|moving on|picking up|on it)|next,? I|(?:then|next|now) (?:I['’]ll|on to)|starting (?:it|on|now|that)|moving on to|picking (?:it|that) up)\b/i
/** How much of the promise to quote back. */
const QUOTE = 160

/** The sentence that holds the promise, cut to fit, or null. */
export function promiseIn(text: string | undefined): string | null {
  if (!text) return null
  const m = PROMISE.exec(text)
  if (!m) return null
  const start = Math.max(text.lastIndexOf('\n', m.index), text.lastIndexOf('. ', m.index)) + 1
  const end = text.slice(m.index).search(/[.\n]/)
  const s = text.slice(start, end < 0 ? undefined : m.index + end).trim().replace(/^[-*\d.)\s]+/, '')
  return s.length > QUOTE ? `${s.slice(0, QUOTE - 1)}…` : s
}

export function continueGate(input: { isQueue: boolean; waiting: Waiting | null; tasks: MyTask[] | null; lastText?: string }): GateVerdict {
  if (input.isQueue || input.waiting) return { block: false }
  const doing = (input.tasks ?? []).filter((t) => t.status === 'in_progress')
  const promise = promiseIn(input.lastText)
  if (!doing.length && !promise) return { block: false }
  const said = promise ? `you ended on what you'll do next: "${promise}"` : ''
  const lead = doing.length ? `You have ${doing.map((t) => `${t.key} (${t.title})`).join(', ')} in progress${said ? `, and ${said}` : ''}` : `Y${said.slice(1)}`
  return {
    block: true,
    reason: `Before you stop: ${lead}. Nothing happens until you start it, and nobody will wake you to. Carry on with it now, in this turn. If you can't go on (you're waiting on a person's answer, a review, CI or a deploy), call waiting_on to say what for, then stop.${doing.length ? ' If a task is finished, set its status with update_task.' : ''}`,
  }
}
