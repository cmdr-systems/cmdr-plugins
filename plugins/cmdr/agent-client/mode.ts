// A local agent's mode (local-agents design § 3.3; ADR-054), part of agent-client, the plugin's internal library
// (design 0.1.8: it lives inside the plugin folder and has no package.json of its own). cmdr.mc's /agent/me says where
// the agent runs: `box` (its crew's machine: everything as it always was), `external` (a person's own machine: a
// local agent), `platform` (a doc agent, which never runs this library). Pure.

/** A channel delivery's tag as the session's transcript and its prompts carry it (Claude Code renders the server as
 *  `plugin:cmdr:cmdr`). One expression: the reply guard scans the transcript for it, and the mode tells a
 *  channel-opened turn by it at the start of the prompt (design § 3.3, R-11, AC-25). */
export const CHANNEL_TAG = /<channel source="plugin:cmdr:cmdr"[^>]*>/

export type Mode = 'box' | 'external'

/** The mode from /agent/me's runsOn; a doc agent is refused (`platform-agent`). Absent (an older cmdr.mc): box. */
export function modeOf(runsOn: string | undefined): Mode | { refused: 'platform-agent' } {
  if (runsOn === 'platform') return { refused: 'platform-agent' }
  return runsOn === 'external' ? 'external' : 'box'
}

/** Who opened a turn: a channel delivery (the prompt starts with its tag) or the operator typing at the terminal.
 *  The tag anywhere but the start is a typed prompt quoting one (design AC-25). */
export type Opener = 'channel' | 'operator'
export const openerOf = (prompt: string): Opener => (CHANNEL_TAG.exec(prompt.trimStart())?.index === 0 ? 'channel' : 'operator')

/** Where the server says, for its hooks, that it runs off the box (`<CMDR_STATE_DIR>/mode`, holding `external`). */
export const MODE_FILE = 'mode'

/** The design's Port (agent-client API: `Mode.of`, `Mode.stateDir`) over the functions above. */
export const Mode = {
  of: (me: { runsOn?: string }) => modeOf(me.runsOn),
  /** `CMDR_STATE_DIR`, one value for the hook and the server; missing ⇒ `state-dir-required`. The plugin keeps its own
   *  box default (server.ts) and asks this only off the box; the CLI (S6) asks it for `link` and `unlink`, the verbs
   *  that touch the link file (its other verbs keep no state). */
  stateDir: (env: Record<string, string | undefined>): string | { refused: 'state-dir-required' } => {
    const v = env.CMDR_STATE_DIR?.trim()
    return v ? v : { refused: 'state-dir-required' }
  },
} as const
