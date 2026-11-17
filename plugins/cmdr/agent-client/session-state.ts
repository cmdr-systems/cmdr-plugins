// Whether the agent's session is between turns, for the machine: written to
// `<CMDR_STATE_DIR>/activity.state` as
//
//   { "state": "idle", "since": "<ISO time>" }
//   { "state": "working", "since": "<ISO time>", "step": "<ISO time>" }
//
// so the box can restart an agent only when no turn would be cut off
// (crew-updates design, Project 1 § 4: wait for idle; the coordinator's
// restart-when-idle reads it).
//
// It is the SESSION's state, not the conversation's (channel.ts's activity
// feed), and it is only what Claude Code's own hooks prove: working from a
// hook that runs inside a turn (UserPromptSubmit, a tool step), idle at the
// turn's end (Stop) and when the plugin starts. Handing the session something
// (a message, the startup wake, a decision) is NOT a turn: Claude Code can
// drop a channel notification (2026-10-31, engineering box: builder, auditor
// and enforcer resumed with --continue, took their wakes, never ran a turn,
// and read working for good, so restart-when-idle deferred them forever).
//
// Not on the feed's 90-second quiet fallback either: a long build runs a
// single tool call with no hook in between, and calling that idle is exactly
// the restart that cuts a turn off. A Stop that never arrives leaves it
// working; `step` (the last hook step, refreshed at most every STEP_EVERY_MS)
// is how the coordinator tells such a file from a live turn
// (idle-restart.ts: no step for 30 minutes is stale).
//
// Written atomically (beside it, then renamed): a reader never sees half a
// file. Never throws: a state file that can't be written must not take the
// channel down with it (each failure is logged).
import { renameSync, writeFileSync } from 'node:fs'

export type SessionStateName = 'idle' | 'working'
export type SessionState = { state: SessionStateName; since: string; step?: string }

/** While working, the last hook step is rewritten at most this often: a turn of a thousand tool calls is not a thousand writes. */
export const STEP_EVERY_MS = 60_000

export interface SessionStateDeps {
  path: string
  now?(): Date
  write?(path: string, content: string): void
  log?(line: string): void
}

export interface SessionStateWriter {
  /** idle: the turn ended (or none has started). working: a hook step of a turn, now. */
  mark(state: SessionStateName): void
  current(): SessionState | null
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

export function sessionStateWriter(deps: SessionStateDeps): SessionStateWriter {
  const now = deps.now ?? (() => new Date())
  const write = deps.write ?? atomicWrite
  let cur: SessionState | null = null
  function put(next: SessionState) {
    try {
      write(deps.path, `${JSON.stringify(next)}\n`)
      cur = next
    } catch (e) {
      // Not recorded as current, so the next mark tries again.
      deps.log?.(`activity.state: ${e}`)
    }
  }
  return {
    mark(state) {
      const t = now()
      const at = t.toISOString()
      if (state === 'idle') {
        if (cur?.state !== 'idle') put({ state, since: at })
        return
      }
      if (cur?.state !== 'working') return put({ state, since: at, step: at })
      // Still working: the step moves on, but not on every hook.
      if (t.getTime() - Date.parse(cur.step ?? cur.since) >= STEP_EVERY_MS) put({ ...cur, step: at })
    },
    current: () => cur,
  }
}
