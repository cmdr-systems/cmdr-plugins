// agent-client's Session (local-agents design § 3.3, agent-client API `Session.open(stateDir)`): one session's own state,
// composed from the parts that moved here in S5: the wake gate and its belt (wake-gate.ts), the machine-readable
// activity.state (session-state.ts), and what a hook step was doing (activity.ts). Read tracking, thread membership
// and the wait stay where they were (the plugin's channel.ts): the CLI (S6) needed neither as session state (its
// `listen` marks a conversation read with McClient.read as it prints; its `waiting` is one call), so nothing moved.
import { join } from 'node:path'
import { WakeBelt, WakeGate } from './wake-gate.js'
import { sessionStateWriter } from './session-state.js'

export { activityOf, checkActivity, redact, type Activity, type ActivityKind, type HookInput } from './activity.js'
export { sessionStateWriter, STEP_EVERY_MS, type SessionState, type SessionStateName, type SessionStateWriter } from './session-state.js'
export { WAKE_CONFIRM_MS, WAKE_MAX_ATTEMPTS, WakeBelt, WakeGate, type BeltVerdict, type WakeAction, type WakeObservation } from './wake-gate.js'

/** The file the session's state is written to, inside its state dir (the plugin's server.ts names the same). */
export const ACTIVITY_STATE_FILE = 'activity.state'

/** How long a session waits for cmdr.mc to answer its declaration (sessions design § 5): silence is a refusal, `timeout`. */
export const SESSION_DECLARE_TIMEOUT_MS = 5_000

/** What this session hears (sessions design § 3.1): the operator's main session, one conversation, or the launcher. */
export type SessionScope = { scope: 'main' } | { scope: 'launcher' } | { scope: 'linked'; conversationId: string }
/** cmdr.mc's acceptance: for `linked`, the conversation's label and, for a project's or task's channel, what it is (AC-13). */
export type SessionOk = { scope: SessionScope['scope']; conversationId?: string; label?: string; deliverable?: { kind: 'project' | 'task'; key: string } }
/** A refusal, by its reason: `session-scope-invalid`, `not-visible`, or `timeout` (no answer). */
export class SessionRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
/** The socket a session declares on: socket.io's (`emit`), or the plugin's wrapper (`out`). */
export type DeclareSocket = { on(event: string, fn: (...a: any[]) => void): unknown; off?(event: string, fn: (...a: any[]) => void): unknown; emit?(event: string, data: unknown): unknown; out?(event: string, data: unknown): unknown }

export const Session = {
  /**
   * Declare this socket's scope to cmdr.mc (sessions design § 3.6): resolves to its `agent:session:ok`, rejects with
   * `SessionRefused`. Never retries: the caller declares again on every `ready` (a reconnect), and only then. The
   * routing order is cmdr.mc's alone (Tenet 2): this only declares.
   */
  scope(socket: DeclareSocket, scope: SessionScope, opts: { timeoutMs?: number } = {}): Promise<SessionOk> {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = () => {
        done = true
        clearTimeout(timer)
        socket.off?.('agent:session:ok', ok)
        socket.off?.('agent:session:refused', refused)
      }
      const ok = (data: SessionOk) => {
        if (done) return
        finish()
        resolve(data)
      }
      const refused = (data: { reason?: string }) => {
        if (done) return
        finish()
        reject(new SessionRefused(String(data?.reason ?? 'refused')))
      }
      const timer = setTimeout(() => {
        if (done) return
        finish()
        reject(new SessionRefused('timeout'))
      }, opts.timeoutMs ?? SESSION_DECLARE_TIMEOUT_MS)
      socket.on('agent:session:ok', ok)
      socket.on('agent:session:refused', refused)
      const send = socket.out ?? socket.emit
      send!.call(socket, 'agent:session', scope)
    })
  },

  open(stateDir: string, opts: { log?: (line: string) => void; wakeConfirmMs?: number; wakeMaxAttempts?: number } = {}) {
    return {
      state: sessionStateWriter({ path: join(stateDir, ACTIVITY_STATE_FILE), log: opts.log }),
      wake: new WakeGate(),
      belt: new WakeBelt(opts.wakeConfirmMs, opts.wakeMaxAttempts),
    }
  },
} as const
