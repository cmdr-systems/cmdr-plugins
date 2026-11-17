// The startup-wake gate for the cmdr channel: a pure, instance-scoped state
// machine, one instance per plugin spawn. The cmdr counterpart of
// ../slack/wake-gate.ts, with the same two conjuncts and the same rule that
// they are this process's own in-memory observations THIS SPAWN (no IO here,
// so a stale events.log can never satisfy it).
//
// The conjunction, as Slack measured it: neither event implies the other
// (mcp_tools_list fired before socket_connected in 2 of 5 boots). The wake
// needs both: the socket, so the agent's announcement can land and it can
// hear the answer; the tool list, so the session can act on the wake at all.
//
// The gate decides the FIRST delivery, exactly once per spawn: a socket.io
// reconnect re-emits `ready`, and a harness may list tools more than once,
// and neither may wake the session again (the persona's startup ceremony is
// "announce in your home channel", which must not repeat mid-session).
//
// The belt (WakeBelt, below) is a separate observation: whether a TURN
// started on the wake, seen as a step from the session's own hooks
// (UserPromptSubmit, a tool step). None within WAKE_CONFIRM_MS: the session
// dropped it, and it is delivered again, up to WAKE_MAX_ATTEMPTS in all.
// Seen 2026-10-31 on the engineering box: builder, auditor and enforcer,
// restarted with --continue, took their wakes (wake_delivered attempt=1) and
// never ran a turn on them. A wake that started a turn is never repeated, so
// the announcement still happens once.

export type WakeObservation =
  /** cmdr.mc's /conversations socket said `ready`: authenticated and
   *  subscribed, so the announcement can land */
  | 'socket_connected'
  /** the harness fetched our tool list: the session can call reply */
  | 'tools_list_served'

export type WakeAction = { kind: 'deliver' } | { kind: 'none' }

export class WakeGate {
  private socketUp = false
  private toolsServed = false
  private delivered = false

  /** Feed one first-party event. Returns `deliver` exactly once per
   *  instance: on the event that completes the conjunction. */
  observe(ev: WakeObservation): WakeAction {
    if (ev === 'socket_connected') this.socketUp = true
    if (ev === 'tools_list_served') this.toolsServed = true
    if (this.delivered || !(this.socketUp && this.toolsServed)) return { kind: 'none' }
    this.delivered = true
    return { kind: 'deliver' }
  }
}

/** How long after a wake the session's hooks must show a turn started on it. UserPromptSubmit fires as the turn starts;
 *  90 s also covers a turn whose first hook is its first tool call on a long resumed conversation. */
export const WAKE_CONFIRM_MS = 90_000
/** The wake is delivered at most this many times in all (the first, and two more). */
export const WAKE_MAX_ATTEMPTS = 3

export type BeltVerdict =
  /** nothing to do yet (no wake out, or its window still open) */
  | { kind: 'wait' }
  /** no turn started on the last one: deliver it again, as this attempt */
  | { kind: 'redeliver'; attempt: number }
  /** no turn on any attempt: stop trying (once) */
  | { kind: 'give-up'; attempts: number }
  /** a turn started on it, or the belt already gave up */
  | { kind: 'done' }

/**
 * Whether a turn started on the wake. Pure: the caller hands it the clock's
 * time (channel.ts: a timer per attempt; tests: any number).
 */
export class WakeBelt {
  private attempts = 0
  private lastAt: number | null = null
  private finished = false

  constructor(
    readonly confirmMs: number = WAKE_CONFIRM_MS,
    readonly maxAttempts: number = WAKE_MAX_ATTEMPTS,
  ) {}

  /** The wake (this attempt) reached the session at `now`. Returns the attempt's number. */
  delivered(now: number): number {
    this.attempts++
    this.lastAt = now
    return this.attempts
  }

  /** A step from the session's hooks. True when it is the one that confirmed the wake. */
  stepSeen(): boolean {
    if (this.finished || this.attempts === 0) return false
    this.finished = true
    return true
  }

  check(now: number): BeltVerdict {
    if (this.finished) return { kind: 'done' }
    if (this.lastAt === null || now - this.lastAt < this.confirmMs) return { kind: 'wait' }
    if (this.attempts < this.maxAttempts) return { kind: 'redeliver', attempt: this.attempts + 1 }
    this.finished = true
    return { kind: 'give-up', attempts: this.attempts }
  }
}
