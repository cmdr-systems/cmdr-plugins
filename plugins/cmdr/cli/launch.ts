// cmdr-agent launch: the session launcher (session launcher design 0.2.4, LOCAL-AGENTS-21; plan 0.2.2). A login service
// the connect snippet installs, which holds the agent's key at rest and keeps the agent's one session running: one
// detached Claude Code session, its `main`, under tmux (`cmdr_<crew>_<handle>`), started when the service starts and started
// fresh again when it ends, never while another session of the agent is live. It opens no socket and declares no
// scope; the session is a plain `main` session, started as a person would start it.
//
// Where each sub-verb's key comes from (design § 3.1, LS-10, AC-17): `install` reads CMDR_AGENT_KEY and CMDR_API_URL
// from the environment; `run`, `exec` and `status` read `agent.key` and `config.json` in the home and ignore the
// environment; `stop`, `start` and `uninstall` need no key. So main.ts hands `launch` here before its key gate.
//
// The pure core (tick, ended, unitFor, tmuxVersionOk, sessionName, eventLine) is below the types; the shell after it.
// Every edge is injected (LaunchDeps), so the tests drive the core with a fake tmux, a fake service manager and a fake
// cmdr.mc. This file imports no socket, Session or Hearing code (AC-26 by construction, plan 0.2.2 § 4).

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ACTIVITY_STATE_FILE, McClient, Mode } from '../agent-client/index.js'
import { refusalOf, type LauncherAction } from '../agent-client/client.js'
import { HomeMoved, LeaseLost, memoryDirOf, pull as homePull, push as homePush, readState as readHomeState, release as homeRelease, type Ctx as HomeCtx } from '../home/home-sync.js'
import { machine as thisMachine, type Machine } from '../home/machine.js'
import { flockExclusive, readHolderFile, type Holder, type Lock } from '../state-dir.js'
import { CLI_TIMEOUT_MS, parseArgs, RETRY_AFTER_MS } from './main.js'

/** The home's `config.json` (design § 3.1): never the key, no timestamp (the file's mtime says when). */
export type LaunchConfig = {
  apiUrl: string
  appUrl?: string
  /** the agent's id, from `/agent/me` at install (local-agent connect design C1) */
  agentId?: string
  /** the agent's crew and handle, from `/agent/me` at install (design 0.2.4): they name its tmux session for the verbs
   *  that read files only */
  crew: string
  handle: string
  claude: string
  tmux: string
  bun: string
  plugin: string
  path: string
  cwd: string
}

/** `state.json` (design 0.2.3 § 2): the `stopped` mark (written by stop/start), and the session's last start and end
 *  with the backoff ladder's position (written by the daemon's tick only). */
export type LaunchState = {
  stopped: boolean
  /** Why it's stopped, when it wasn't a person's `launch stop` (remove/rename design AC-4; connect 0.2.9 reads it as
   *  `removed`): its agent was removed from its crew. Cleared by `start` and `stop`. */
  stoppedReason?: 'agent-removed' | 'home-released'
  /** The machine holding this agent's home lease, when a start was refused for it (agent home sync § 3.4,
   *  `held-elsewhere`): what the desktop app shows. Cleared when this machine takes the lease. */
  heldBy?: string
  /** `off`: cmdr.mc has agent homes switched off (design 0.1.15): this session runs without syncing; the next start
   *  asks again. Cleared on a successful pull. */
  homeSync?: 'off'
  lastStartAt: string | null
  lastEndAt: string | null
  /** 0..2: the index into BACKOFF_STEPS_MS of the next early-exit wait */
  backoffStep: 0 | 1 | 2
  backoffUntil: string | null
  /** The handle its session is named by (design 0.2.25/0.2.26): `/agent/me`'s, recorded when the daemon renames the
   *  session or `install` reuses a renamed agent's home (0.2.24). Absent: config.json's. The home, folder and unit keep
   *  config.json's handle; only the session follows a rename. */
  handle?: string
}
export const FRESH_STATE: LaunchState = Object.freeze({ stopped: false, lastStartAt: null, lastEndAt: null, backoffStep: 0, backoffUntil: null })

/** A session that ends within this of starting is an early exit, and backs off (design § 3.3 step 4). */
export const EARLY_EXIT_MS = 60_000
/** The backoff ladder after early exits: 1, 5, then 15 minutes, holding at 15 (design § 3.3, § 5). */
export const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const
export const TICK_MS = 30_000
/** A transfer's release waits this long for the session's turn to end, then stops it anyway (agent home sync § 3.4). */
export const RELEASE_TURN_MS = 90_000
/** A refused key: `/agent/me` again this often, staying up (design § 3.3 step 3, AC-7). */
export const REFUSED_RETRY_MS = 5 * 60_000
/** With the session up, `/agent/me` on the daemon's first tick and then every this many ticks (every 5 minutes): a
 *  rename or a removal reaches a running agent (design 0.2.26 § 3.3 step 1, LS-35). */
export const HANDLE_POLL_TICKS = 10
/** tmux commands, and a spawn that has produced no session (design § 5). */
export const TMUX_TIMEOUT_MS = 5_000
export const SPAWN_DEADLINE_MS = 5_000
/** launchctl / systemctl (plan § 4). */
export const SERVICE_TIMEOUT_MS = 10_000
/** How long a start waits for the session before it to let go of the agent's state directory, and how often it looks
 *  (reconnect-after-rollout design 0.1.8 § 3 F-5): past it, no session is started, said, and tried again next tick. */
export const RESTART_WAIT_MS = 30_000
export const HOLDER_POLL_MS = 500
/** The tmux floor (design § 3.1, § 5, LS-13): `new-session`'s command as several arguments. */
export const TMUX_FLOOR = { major: 2, minor: 0 } as const

// ── the pure core ──────────────────────────────────────────────────────

/** The closed event set (design 0.2.3 § 6). */
export const LAUNCH_EVENTS = ['launcher.started', 'launcher.refused', 'launch.session.started', 'launch.session.skipped', 'launch.session.failed', 'launch.session.ended', 'launcher.marked', 'launcher.stopped', 'launch.session.prompt-answered', 'launch.session.prompt-waiting', 'launcher.cwd-changed', 'launcher.updated', 'launcher.session-moved', 'launcher.session-renamed', 'launch.session.channel-reconnect', 'launch.session.channel-missing', 'launch.restart', 'launch.restart.stale', 'launch.restart.blocked', 'launch.home.pulled', 'launch.home.pushed', 'launch.home.held-elsewhere', 'launch.home.released', 'launch.home.failed'] as const
export type LaunchEvent = (typeof LAUNCH_EVENTS)[number]

/** What a field of an event may hold: a reason, a state word. Never a message's text (design § 6, AC-12). */
const FIELD = /^[A-Za-z0-9._:-]{1,80}$/

/** One `events.log` line: ISO time, the tag, then `k=v` pairs, or a bare word (`launcher.marked stopped`). A tag
 *  outside the set, or a value that isn't an identifier, throws: the log can't be handed a body by mistake. */
export function eventLine(tag: LaunchEvent, fields: Readonly<Record<string, string | number>>, now: Date, word?: string): string {
  if (!(LAUNCH_EVENTS as readonly string[]).includes(tag)) throw new Error(`not a launcher event: ${tag}`)
  if (word !== undefined && !FIELD.test(word)) throw new Error('an event word must be an identifier')
  const kv = Object.entries(fields).map(([k, v]) => {
    const s = String(v)
    if (!/^[a-z][a-zA-Z]*$/.test(k) || !FIELD.test(s)) throw new Error(`an event field must be an identifier: ${k}`)
    return `${k}=${s}`
  })
  return [now.toISOString(), tag, ...(word !== undefined ? [word] : []), ...kv].join(' ')
}

/** Whether `tmux -V`'s answer is at or above the floor. `tmux 3.4`, `tmux next-3.5`, `tmux 2.9a` yes; `tmux 1.9a` no;
 *  an answer with no `<major>.<minor>` in it no (refused `tmux-required`, never guessed). */
export function tmuxVersionOk(v: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(v)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > TMUX_FLOOR.major || (major === TMUX_FLOOR.major && minor >= TMUX_FLOOR.minor)
}

/** The agent's one tmux session (design 0.2.4 § 3.3): `cmdr_<crew>_<handle>`. `_` is in neither a crew key nor a
 *  handle (`^[a-z0-9-]{1,40}$`), so two agents never share a name, even two crews' `scout` on one machine. */
export const sessionName = (crew: string, handle: string): string => `cmdr_${crew}_${handle}`
/** The session as it's named now: by the handle the daemon recorded (a rename, 0.2.25), else config.json's. Every verb
 *  that names the session uses this, so `status`'s attach line names the session that exists (0.2.26). */
export const sessionOf = (config: Pick<LaunchConfig, 'crew' | 'handle'>, st: Pick<LaunchState, 'handle'>): string => sessionName(config.crew, st.handle ?? config.handle)
/** A handle as cmdr.mc makes one (crew-rules HANDLE): anything else read from a file or an answer is ignored. */
const HANDLE = /^[a-z][a-z0-9-]{1,23}$/

/** The launcher's own tmux server (design 0.2.22): every tmux call and printed attach line uses `-L cmdr`, so it never
 *  meets the person's own tmux, of another version. */
export const TMUX_SOCKET = 'cmdr'
export const tmuxOn = (tmux: string): string[] => [tmux, '-L', TMUX_SOCKET]
/** How to watch the session, as printed. */
export const attachLine = (tmux: string, name: string): string => `${tmux} -L ${TMUX_SOCKET} attach -t ${name}`
/** The daemon's exit when a newer plugin is installed (design 0.2.22/0.2.23, LS-34): `EX_TEMPFAIL`, which macOS's
 *  KeepAlive and Linux's `Restart=on-failure` both restart, onto the new code. Its session is left running. */
export const EXIT_UPDATED = 75
/** The wrapper in the launcher's home (design 0.2.17): every printed command and the unit run it. */
export const wrapperOf = (home: string): string => join(home, 'bin', 'cmdr-agent')
/** The wrapper's text: it finds the cmdr plugin Claude Code has installed now, at each run, and runs its CLI with the
 *  bun the launcher was installed with. A plugin update (a new versioned `installPath`) is picked up by the next run. */
export function wrapperScript(bun: string): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh
# cmdr-agent: the cmdr plugin's CLI, from whichever version Claude Code has installed now (launcher design 0.2.17).
# Written by \`cmdr-agent launch install\`; safe to delete with the launcher (\`launch uninstall\`).
BUN=${q(bun)}
P=$("$BUN" -e 'const d = process.env.CLAUDE_CONFIG_DIR || process.env.HOME + "/.claude"; const j = await Bun.file(d + "/plugins/installed_plugins.json").json(); console.log(j.plugins["cmdr@cmdr-crew"][0].installPath)' 2>/dev/null)
if [ -z "$P" ] || [ ! -f "$P/cli/cmdr-agent.ts" ]; then
  echo "refused: plugin-missing: Claude Code has no cmdr plugin installed: set the agent up again" >&2
  exit 69
fi
exec "$BUN" "$P/cli/cmdr-agent.ts" "$@"
`
}
/** The cmdr plugin folder Claude Code has installed now (`installed_plugins.json`), or null when it can't say. */
export function installedPlugin(claudeConfig: string | null): string | null {
  if (!claudeConfig) return null
  try {
    const j = JSON.parse(claudeConfig) as { plugins?: Record<string, { installPath?: unknown }[]> }
    const p = j?.plugins?.['cmdr@cmdr-crew']?.[0]?.installPath
    return typeof p === 'string' && p.startsWith('/') ? p.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

export type TickReason = 'live' | 'backoff' | 'stopped' | 'unauthorized'
export type TickVerdict = { action: 'none' } | { action: 'start' } | { action: 'skip'; reason: TickReason }

/** One tick's decision (design § 3.3; plan 0.2.2 § 4), first match wins. `tmuxLive`: our `cmdr_<crew>_<handle>` exists.
 *  `authorized`: `/agent/me` answered (false on 401/403). `otherLive`: it listed a live session of the agent (read
 *  only when our tmux session is absent, so any listed session is not ours). `stopped` is checked before the network
 *  answers matter, and `unauthorized` before `live` (a 401 has no sessions to read). */
export function tick(s: LaunchState, tmuxLive: boolean, otherLive: boolean, authorized: boolean, now: number): TickVerdict {
  if (tmuxLive) return { action: 'none' }
  if (s.stopped) return { action: 'skip', reason: 'stopped' }
  if (!authorized) return { action: 'skip', reason: 'unauthorized' }
  if (otherLive) return { action: 'skip', reason: 'live' }
  if (s.backoffUntil && Date.parse(s.backoffUntil) > now) return { action: 'skip', reason: 'backoff' }
  return { action: 'start' }
}

/** The state after the session ended at `now` (design § 3.3 step 4): a life past EARLY_EXIT_MS resets the ladder; an
 *  early exit waits the current step and climbs one, holding at the last. A failed spawn is an early exit. An end
 *  `launch stop` caused is not an exit of the session's own: it moves no ladder, so `start` starts it at the next tick
 *  (design § 3.1 `start`). */
export function ended(s: LaunchState, now: number, reason: 'exited' | 'stopped' = 'exited'): LaunchState {
  const lived = s.lastStartAt ? now - Date.parse(s.lastStartAt) : 0
  const at = new Date(now).toISOString()
  if (reason === 'stopped') return { ...s, lastEndAt: at }
  if (lived > EARLY_EXIT_MS) return { ...s, lastEndAt: at, backoffStep: 0, backoffUntil: null }
  const step = s.backoffStep
  return { ...s, lastEndAt: at, backoffUntil: new Date(now + BACKOFF_STEPS_MS[step]).toISOString(), backoffStep: Math.min(step + 1, BACKOFF_STEPS_MS.length - 1) as 0 | 1 | 2 }
}

/** The event a verdict logs, and whether it is a stretch's (logged once until the verdict changes): plan 0.2.2 § 4,
 *  PN-1. `unauthorized` is `launcher.refused` (§ 6 has no `skipped reason=unauthorized`). */
export function eventOfVerdict(v: TickVerdict): { tag: LaunchEvent; fields: Record<string, string> } | null {
  if (v.action !== 'skip') return null
  if (v.reason === 'unauthorized') return { tag: 'launcher.refused', fields: { reason: 'unauthorized' } }
  return { tag: 'launch.session.skipped', fields: { reason: v.reason } }
}

/** The start questions the launcher answers (launcher design 0.2.15, LOCAL-AGENTS-37), as a cmdr box's launcher does
 *  (coordinator `prompt-arms.ts`): Claude Code asks both, unattended, and an agent left at either looks running but
 *  never connects. `trust`: "Quick safety check … Yes, I trust this folder", only for the agent's own folder (the one
 *  `install` was given or made), and its default is "No, exit", so the cursor is moved down first; Claude Code then
 *  keeps the trust itself. `dev-channels`: the development-channels warning, its default "1. I am using this for local
 *  development" accepted. Anything else, any other folder's trust question included, is never answered. */
export type PromptArm = 'trust' | 'dev-channels'
export type PromptAnswer = { arm: PromptArm; keys: ('Down' | 'Enter')[] }

/** Whether the screen names `folder` on a line of its own, wrapped across lines or not (tmux's width wraps long paths). */
function namesFolder(lines: string[], folder: string): boolean {
  for (let i = 0; i < lines.length; i++) {
    let acc = ''
    for (let j = i; j < lines.length && folder.startsWith(acc + lines[j]); j++) {
      acc += lines[j]
      if (acc === folder) return true
    }
  }
  return false
}

/** What to press for a captured screen (`tmux capture-pane -p`): null when it shows none of the named questions with
 *  its cursor where the answer expects. `folders`: the agent's folder as configured and as the system resolves it
 *  (macOS shows /private/tmp for /tmp). */
export function answerFor(screen: string, folders: readonly string[]): PromptAnswer | null {
  const lines = screen.split('\n').map((l) => l.trim()).filter(Boolean)
  const flat = lines.join('').replace(/\s+/g, '')
  if (!flat.includes('Entertoconfirm')) return null
  if (flat.includes('Yes,Itrustthisfolder')) {
    if (!folders.some((f) => f && namesFolder(lines, f.replace(/\/+$/, '')))) return null
    if (flat.includes('❯Yes,Itrustthisfolder')) return { arm: 'trust', keys: ['Enter'] }
    if (flat.includes('❯No,exit')) return { arm: 'trust', keys: ['Down'] }
    return null
  }
  if (flat.includes('❯1.Iamusingthisforlocaldevelopment')) return { arm: 'dev-channels', keys: ['Enter'] }
  return null
}

/** How long after a start the launcher watches for the questions, how often it looks, and how many keys it sends at
 *  most in one watch (two questions, one of them two keys, with room for a redraw). */
export const PROMPT_WATCH_MS = 90_000
export const PROMPT_POLL_MS = 1_000
export const PROMPT_MAX_KEYS = 6

/** The channel must come up (design 0.2.27 § 3.3 step 6, LOCAL-AGENTS-41): within CHANNEL_READY_MS of a start,
 *  `/agent/me` lists a live session; else one `/mcp` reconnect, and CHANNEL_READY_MS after that, `channel-missing`
 *  once. Never a loop, never a restart: Claude Code's failure cache would outlast either. */
export const CHANNEL_READY_MS = 30_000
/** A restart asked for longer ago than this is not carried out (0.2.28, SL-1): the same window cmdr.mc reuses one in. */
export const RESTART_FRESH_MS = 15 * 60_000
export const RECONNECT_KEYS = '/mcp reconnect plugin:cmdr:cmdr'
export type ChannelWatch = { since: number; stage: 'waiting' | 'reconnected' | 'done' }
export type ChannelStep = { watch: ChannelWatch; act: 'none' | 'reconnect' | 'missing' }

/** One look at a watch. `live`: `/agent/me` listed a session (null: not asked, or it didn't answer: nothing moves). */
export function channelStep(w: ChannelWatch, live: boolean | null, now: number): ChannelStep {
  if (w.stage === 'done' || now - w.since < CHANNEL_READY_MS || live === null) return { watch: w, act: 'none' }
  if (live) return { watch: { ...w, stage: 'done' }, act: 'none' }
  if (w.stage === 'waiting') return { watch: { since: now, stage: 'reconnected' }, act: 'reconnect' }
  return { watch: { ...w, stage: 'done' }, act: 'missing' }
}

/** Whether the screen is Claude Code idle at its own input box, the one screen a reconnect is typed into (step 3d's
 *  discipline): no question waiting, and the input marker on an otherwise empty line. */
export function idleAtInput(screen: string): boolean {
  if (screen.replace(/\s+/g, '').includes('Entertoconfirm')) return false
  return screen.split('\n').some((l) => /^\s*❯\s*$/.test(l))
}

/** What the login service is told to run: paths alone, never the key or any environment (design § 3.1, § 7). */
export type UnitPaths = { userHome: string; crew: string; handle: string; home: string; bun: string; plugin: string }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** A systemd ExecStart word: quoted, with its own escapes (`%` is a specifier, `\` and `"` are quoting). */
const sd = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

/** The login service's unit (design § 3.1): macOS a LaunchAgent plist (RunAtLoad, KeepAlive), Linux a systemd user
 *  unit (Restart=on-failure, WantedBy=default.target). Its bytes are a function of the paths alone, so a re-install
 *  with the same inputs writes the same file. Any other platform: null (`platform-unsupported`). */
export function unitFor(platform: string, p: UnitPaths): { path: string; label: string; contents: string } | null {
  // The wrapper, never a versioned plugin path (design 0.2.22): each start runs the plugin installed now.
  const run = [wrapperOf(p.home), 'launch', 'run', '--home', p.home]
  if (platform === 'darwin') {
    const label = `it.cmdr.agent.${p.crew}.${p.handle}`
    const args = run.map((a) => `    <string>${xml(a)}</string>`).join('\n')
    return {
      path: `${p.userHome}/Library/LaunchAgents/${label}.plist`,
      label,
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`,
    }
  }
  if (platform === 'linux') {
    const label = `cmdr-agent-${p.crew}-${p.handle}`
    return {
      path: `${p.userHome}/.config/systemd/user/${label}.service`,
      label,
      contents: `[Unit]
Description=cmdr launcher for @${p.handle} (${p.crew})
After=network-online.target

[Service]
Type=simple
ExecStart=${run.map(sd).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
    }
  }
  return null
}

// ── the shell ──────────────────────────────────────────────────────────

/** A command's answer: tmux, systemctl, launchctl, `claude --version`. */
export type Proc = { code: number; stdout: string; stderr: string }

/** Every edge of the launcher, injected (design § 4): the tests pass fakes, cmdr-agent.ts the real ones. */
export type LaunchDeps = {
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  /** process.platform */
  platform: string
  /** the user's home folder (os.homedir()) and id (process.getuid()) */
  userHome: string
  uid: number
  /** bun's own path (process.execPath) and this plugin's folder (cli/cmdr-agent.ts's grandparent) */
  bunPath: string
  pluginDir: string
  /** a command, with its budget; a missing binary answers code 127 */
  run: (cmd: string[], timeoutMs: number) => Promise<Proc>
  /** a name on a PATH, as a shell would find it, or null */
  which: (name: string, path: string) => string | null
  /** replace this process (process.execve): launch exec */
  execve: (file: string, args: string[], env: Record<string, string>) => void
  chdir: (dir: string) => void
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** every `ms`, until the returned function is called (the tick) */
  every?: (ms: number, fn: () => void) => () => void
  /** launch run ends when this aborts (SIGTERM from the service manager) */
  stop?: AbortSignal
  lock?: (path: string) => Lock | null
  /** This machine (agent home sync § 2): its id from ~/.cmdr/machine.json; tests give one. */
  machine?: Machine
  /** The agent's Claude Code memory folder for its cwd (§ 3.2); tests give one. */
  memoryDir?: string
  /** the session holding a state directory, as it wrote itself down (state-dir.ts), or null */
  holder?: (dir: string) => Holder | null
  /** whether a process lives (kill(pid, 0)); EPERM counts as alive */
  alive?: (pid: number) => boolean
}

const aliveByKill = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** The live holder of the agent's main session directory, or null when none holds it (nobody written down, or both
 *  its processes are gone). Live iff its plugin (`server`, the process that holds the flock) or its `claude` (`pid`,
 *  which may take seconds to exit after its pane is gone) lives: design 0.1.9 § 3 F-5, R729-1. Read from the holder
 *  file only: the lock itself is never taken to test it, since that could refuse the very session a restart waits for. */
export function liveHolder(home: string, deps: LaunchDeps): Holder | null {
  const h = (deps.holder ?? readHolderFile)(join(home, 'sessions', 'main'))
  const alive = deps.alive ?? aliveByKill
  return h && (alive(h.server) || alive(h.pid)) ? h : null
}
/** Waits up to `ms` for the directory to be let go: null once it is, else the holder still there. Never kills it: the
 *  holder may be a person's own `claude` in that folder (LOCAL-AGENTS-41). */
export async function holderReleased(home: string, deps: LaunchDeps, ms = RESTART_WAIT_MS, except?: number): Promise<Holder | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)))
  const end = now() + ms
  for (;;) {
    const h = liveHolder(home, deps)
    if (!h || h.pid === except) return null
    if (now() >= end) return h
    await sleep(HOLDER_POLL_MS)
  }
}

/** A refusal: `refused: <reason>[: <detail>]` on stderr, exit 1 (as every verb, design § 3.1). */
class Refused extends Error {
  constructor(
    readonly reason: string,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}
const refuse = (reason: string, detail?: string): never => {
  throw new Refused(reason, detail)
}
/** cmdr.mc's answer to a removed agent's key: `401 agent-removed: …` (the client's one-line error). */
const isAgentRemoved = (e: unknown): boolean => /^401 agent-removed:/.test(e instanceof Error ? e.message : '')
const statusOf = (e: unknown): number | null => {
  const m = /^(\d{3}) /.exec(e instanceof Error ? e.message : '')
  return m ? Number(m[1]) : null
}

const LAUNCHER = 'launcher'
const KEY_FILE = 'agent.key'
const CONFIG_FILE = 'config.json'
const STATE_FILE = 'state.json'
/** How long install waits for launchd to finish booting out an old launcher before bootstrapping the new one. */
const BOOTOUT_WAIT_MS = 10_000
const BOOTOUT_POLL_MS = 250
const EVENTS_FILE = 'events.log'
const LOCK_FILE = 'launcher.lock'

/** A file written whole, beside then renamed, with its mode: a reader never sees half of it. */
function writeWhole(path: string, contents: string, mode: number) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}
const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** The home's launcher folder, its key and its config; a home with no key is `launcher-not-installed` (AC-14, AC-17). */
function installed(home: string): { dir: string; key: string; config: LaunchConfig } {
  const dir = join(home, LAUNCHER)
  let key = ''
  try {
    key = readFileSync(join(dir, KEY_FILE), 'utf8').trim()
  } catch {
    // below
  }
  const config = readJson<LaunchConfig>(join(dir, CONFIG_FILE))
  if (!key || !config) refuse('launcher-not-installed', `no launcher in ${home}: set the agent up on this machine again (Set up on this Mac, or its connect snippet)`)
  return { dir, key, config: config! }
}

/** The launcher homes under ~/.cmdr/agents whose config.json carries this agent id (design 0.2.24): the same
 *  enumeration the desktop's `local_agents` uses. */
function homesOfAgent(deps: LaunchDeps, agentId: string): string[] {
  const root = join(deps.userHome, '.cmdr', 'agents')
  const found: string[] = []
  try {
    for (const crew of readdirSync(root)) {
      for (const handle of readdirSync(join(root, crew))) {
        if (readJson<Partial<LaunchConfig>>(join(root, crew, handle, LAUNCHER, CONFIG_FILE))?.agentId === agentId) found.push(join(root, crew, handle))
      }
    }
  } catch {
    // none
  }
  return found
}

/** `--home`, else the one launcher home under ~/.cmdr/agents (no environment is read: design § 3.1). */
function homeOf(deps: LaunchDeps, given: string | undefined): string {
  if (given) return given.replace(/^~(?=\/|$)/, deps.userHome)
  const root = join(deps.userHome, '.cmdr', 'agents')
  const found: string[] = []
  try {
    for (const crew of readdirSync(root)) for (const handle of readdirSync(join(root, crew))) if (existsSync(join(root, crew, handle, LAUNCHER))) found.push(join(root, crew, handle))
  } catch {
    // none
  }
  if (found.length === 1) return found[0]!
  return refuse(found.length ? 'usage' : 'launcher-not-installed', found.length ? `more than one launcher home: pass --home (${found.join(', ')})` : 'no launcher installed: set the agent up on this machine (Set up on this Mac, or its connect snippet)')
}

/** The unit this home's launcher runs as: found by its own contents (`--home <home>`), so stop, status and uninstall
 *  need neither the key nor cmdr.mc. */
function unitOf(deps: LaunchDeps, home: string): { path: string; label: string } | null {
  const dir = deps.platform === 'darwin' ? join(deps.userHome, 'Library', 'LaunchAgents') : join(deps.userHome, '.config', 'systemd', 'user')
  const prefix = deps.platform === 'darwin' ? 'it.cmdr.agent.' : 'cmdr-agent-'
  const suffix = deps.platform === 'darwin' ? '.plist' : '.service'
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
  } catch {
    return null
  }
  const needle = deps.platform === 'darwin' ? `<string>--home</string>\n    <string>${xml(home)}</string>` : `"--home" ${sd(home)}`
  for (const n of names) {
    const path = join(dir, n)
    if (readFileSync(path, 'utf8').includes(needle)) return { path, label: n.slice(0, -suffix.length) }
  }
  return null
}

/** The first line a command said on stderr (or stdout), for `service-failed`. */
const firstLine = (p: Proc) => (p.stderr.trim() || p.stdout.trim() || `exit ${p.code}`).split('\n')[0]!.slice(0, 200)

/** Whether the unit is running (design § 3.1's status line). */
async function serviceState(deps: LaunchDeps, unit: { label: string } | null): Promise<'running' | 'installed, not running' | 'not installed'> {
  if (!unit) return 'not installed'
  const p = deps.platform === 'darwin' ? await deps.run(['launchctl', 'print', `gui/${deps.uid}/${unit.label}`], SERVICE_TIMEOUT_MS) : await deps.run(['systemctl', '--user', 'is-active', `${unit.label}.service`], SERVICE_TIMEOUT_MS)
  if (deps.platform === 'darwin') return p.code === 0 && /\bstate = running\b/.test(p.stdout) ? 'running' : 'installed, not running'
  return p.code === 0 && p.stdout.trim() === 'active' ? 'running' : 'installed, not running'
}

/** The tmux sessions alive now (one `list-sessions`; no server is none). */
async function liveTmux(deps: LaunchDeps, tmux: string): Promise<Set<string>> {
  const p = await deps.run([...tmuxOn(tmux), 'list-sessions', '-F', '#{session_name}'], TMUX_TIMEOUT_MS)
  return p.code === 0 ? new Set(p.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) : new Set()
}
/** Whether our tmux session exists (`has-session -t`; a missing server is "no"). */
async function hasSession(deps: LaunchDeps, tmux: string, name: string): Promise<boolean> {
  return (await deps.run([...tmuxOn(tmux), 'has-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)).code === 0
}
/** `state.json`, or a fresh state when absent or unreadable (its fields checked one by one). */
const readStateFile = (dir: string): LaunchState => {
  const j = readJson<Partial<LaunchState>>(join(dir, STATE_FILE))
  if (!j) return { ...FRESH_STATE }
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  const step = j.backoffStep === 1 || j.backoffStep === 2 ? j.backoffStep : 0
  return { stopped: j.stopped === true, ...(j.stopped === true && (j.stoppedReason === 'agent-removed' || j.stoppedReason === 'home-released') ? { stoppedReason: j.stoppedReason } : {}), ...(typeof j.heldBy === 'string' && j.heldBy ? { heldBy: j.heldBy.slice(0, 80) } : {}), ...(j.homeSync === 'off' ? { homeSync: 'off' as const } : {}), lastStartAt: iso(j.lastStartAt), lastEndAt: iso(j.lastEndAt), backoffStep: step, backoffUntil: iso(j.backoffUntil), ...(typeof j.handle === 'string' && HANDLE.test(j.handle) ? { handle: j.handle } : {}) }
}
const writeStateFile = (dir: string, st: LaunchState) => writeWhole(join(dir, STATE_FILE), `${JSON.stringify(st, null, 2)}\n`, 0o600)
/** The session's `activity.state` (the plugin writes it; the launcher only reads it, for `status`). */
const readActivity = (home: string): { state: 'idle' | 'working'; since: string } | null => {
  const s = readJson<{ state?: string; since?: string }>(join(home, 'sessions', 'main', ACTIVITY_STATE_FILE))
  return s && (s.state === 'idle' || s.state === 'working') && typeof s.since === 'string' ? { state: s.state, since: s.since } : null
}
/** Whether the session's plugin has written its activity since the session started (it has connected). */
const heardSince = (home: string, startedAt: string | null): boolean => {
  const a = readActivity(home)
  return !!a && (!startedAt || Date.parse(a.since) >= Date.parse(startedAt))
}
/** An event line appended to `events.log`; a failure to write says so on stderr and never stops the caller. */
const eventTo = (deps: LaunchDeps, dir: string, now: () => number) => (tag: LaunchEvent, fields: Record<string, string | number> = {}, word?: string) => {
  try {
    appendFileSync(join(dir, EVENTS_FILE), `${eventLine(tag, fields, new Date(now()), word)}\n`, { mode: 0o600 })
  } catch (e) {
    deps.err(`cmdr-agent launch: events.log: ${e instanceof Error ? e.message : e}`)
  }
}

type Opts = { pos: string[]; opt: Record<string, string>; on: Set<string> }

// ── install ──

async function install(o: Opts, deps: LaunchDeps) {
  // The key and the address first, from the environment, as every verb (AC-17, design 0.1.4 § 3.1).
  let client: McClient
  try {
    client = McClient.create({ apiUrl: deps.env.CMDR_API_URL ?? '', key: deps.env.CMDR_AGENT_KEY ?? '', timeoutMs: CLI_TIMEOUT_MS, fetch: deps.fetch })
  } catch (e) {
    const [reason, ...detail] = String((e as Error).message).split(': ')
    return refuse(reason!, detail.join(': ') || undefined)
  }
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') refuse('platform-unsupported', `the launcher runs on macOS and Linux, not ${deps.platform}`)
  const me = await retrying(deps, () => client.me())
  const mode = Mode.of(me)
  if (typeof mode === 'object') refuse('platform-agent', 'a doc agent runs on cmdr itself and starts no sessions')
  if (mode !== 'external') refuse('not-external', 'Only a local agent runs a launcher.')
  const path = deps.env.PATH ?? ''
  // The desktop app's own tmux (design 0.2.22, `~/.cmdr/bin/tmux`) when it passes one; else the one on PATH.
  const given = o.opt.tmux?.replace(/^~(?=\/|$)/, deps.userHome)
  if (given && !(given.startsWith('/') && existsSync(given))) refuse('tmux-required', `no tmux at ${given}`)
  const tmux = given ?? deps.which('tmux', path)
  const getTmux = deps.platform === 'darwin' ? 'brew install tmux' : 'install tmux with your package manager (e.g. sudo apt install tmux)'
  if (!tmux) refuse('tmux-required', `no tmux on PATH: ${getTmux}`)
  const v = await deps.run([tmux!, '-V'], TMUX_TIMEOUT_MS)
  if (v.code !== 0 || !tmuxVersionOk(v.stdout)) refuse('tmux-required', `found ${v.stdout.trim() || 'an unreadable tmux'}, needs 2.0 or later: ${getTmux}`)
  const claude = deps.which('claude', path)
  if (!claude) refuse('claude-required', 'no claude on PATH: install Claude Code first')
  const plugin = (o.opt.plugin ?? deps.pluginDir).replace(/\/+$/, '')
  if (!existsSync(join(plugin, 'cli', 'cmdr-agent.ts'))) refuse('usage', `no cli/cmdr-agent.ts in ${plugin}: --plugin <the cmdr plugin's folder>`)
  const crew = me.crewKey ?? 'crew'
  const stateDir = deps.env.CMDR_STATE_DIR?.trim().replace(/^~(?=\/|$)/, deps.userHome)
  // The home this agent already has, found by its id (design 0.2.24, AC-38): renamed in cmdr since, its snippet names a
  // home under the new handle, and installing there would run a second launcher for one agent. Two such homes are
  // never guessed between.
  const ours = homesOfAgent(deps, me.id)
  if (ours.length > 1) refuse('duplicate-home', `more than one launcher on this machine is this agent's: ${ours.join(', ')}. Remove all but one (launch uninstall --home <dir>)`)
  const home = ours[0] ?? (o.opt.home ? o.opt.home.replace(/^~(?=\/|$)/, deps.userHome) : stateDir ? dirname(dirname(stateDir)) : join(deps.userHome, '.cmdr', 'agents', crew, me.handle ?? me.id))
  // A reused home keeps its own handle (its folder, unit and config are named by it); its session follows /agent/me's.
  const keptHandle = ours[0] ? readJson<Partial<LaunchConfig>>(join(home, LAUNCHER, CONFIG_FILE))?.handle : undefined
  const homeHandle = typeof keptHandle === 'string' && HANDLE.test(keptHandle) ? keptHandle : (me.handle ?? me.id)
  // The session finds bun and claude as this shell did (LS-3, AC-16): its PATH, with bun's folder if absent.
  const bunDir = dirname(deps.bunPath)
  const parts = path.split(':').filter(Boolean)
  // A re-install (a re-paste, Set up again, a plugin update) keeps the folder this home already works in (launcher
  // design 0.2.18, AC-35; LOCAL-AGENTS-36): Claude Code keys memory and history by folder, so moving it silently
  // loses them. Only --cwd changes it; a fresh home gets the default. A kept home folder (from before 0.2.11) is not kept.
  const kept = readJson<Partial<LaunchConfig>>(join(home, LAUNCHER, CONFIG_FILE))?.cwd
  const keptCwd = typeof kept === 'string' && kept.startsWith('/') && kept.replace(/\/+$/, '') !== deps.userHome.replace(/\/+$/, '') ? kept : undefined
  const config: LaunchConfig = {
    apiUrl: deps.env.CMDR_API_URL!.trim().replace(/\/+$/, ''),
    ...(deps.env.CMDR_APP_URL?.trim() ? { appUrl: deps.env.CMDR_APP_URL.trim() } : {}),
    agentId: me.id,
    crew,
    handle: homeHandle,
    claude: claude!,
    tmux: tmux!,
    bun: deps.bunPath,
    plugin,
    path: (parts.includes(bunDir) ? parts : [bunDir, ...parts]).join(':'),
    // Never the home folder (design 0.2.11, R-8): Claude Code keeps no trust for it, so every unattended start there
    // stalls at its prompt. Default: a folder of the agent's own, made here, by crew and handle so two crews' agents of
    // one handle never share one (launcher design 0.2.13, LS-27).
    cwd: (o.opt.cwd ?? keptCwd ?? join(deps.userHome, 'cmdr', crew, homeHandle)).replace(/^~(?=\/|$)/, deps.userHome).replace(/\/+$/, '') || '/',
  }
  if (config.cwd === deps.userHome.replace(/\/+$/, '')) refuse('cwd-is-home', `the agent can't work in your home folder: Claude Code never keeps trust for it. Leave --cwd out (it uses ~/cmdr/${config.crew}/${config.handle}) or name another folder`)
  const unit = unitFor(deps.platform, { userHome: deps.userHome, crew, handle: homeHandle, home, bun: deps.bunPath, plugin })!
  mkdirSync(config.cwd, { recursive: true })
  // Every check has passed: now the files, the key before the unit, so a service never starts without one (§ 9).
  const dir = join(home, LAUNCHER)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  writeWhole(join(dir, KEY_FILE), (deps.env.CMDR_AGENT_KEY ?? '').trim(), 0o600)
  writeWhole(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 0o600)
  // A new key for an agent its crew had removed (re-added, its snippet pasted again): the removal stop is over (remove/
  // rename RR-3). A person's own `launch stop` is theirs and stays.
  const before = readStateFile(dir)
  if (before.stoppedReason === 'agent-removed') {
    const { stoppedReason: _gone, ...rest } = before
    writeStateFile(dir, { ...rest, stopped: false })
  }
  // The handle its session is named by, as cmdr names the agent now (0.2.24, 0.2.25): the restart below starts it so.
  const handleNow = me.handle && HANDLE.test(me.handle) ? me.handle : null
  if (handleNow && handleNow !== homeHandle) writeStateFile(dir, { ...readStateFile(dir), handle: handleNow })
  else if (readStateFile(dir).handle) {
    const { handle: _old, ...rest } = readStateFile(dir)
    writeStateFile(dir, rest)
  }
  // The wrapper before the unit that runs it (0.2.17, 0.2.22).
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeWhole(wrapperOf(home), wrapperScript(deps.bunPath), 0o755)
  chmodSync(wrapperOf(home), 0o755)
  mkdirSync(dirname(unit.path), { recursive: true })
  writeWhole(unit.path, unit.contents, 0o644)
  // The service manager last (AC-20): a refusal here leaves the files, and a re-run converges.
  const steps: string[][] =
    deps.platform === 'darwin'
      ? [['launchctl', 'bootstrap', `gui/${deps.uid}`, unit.path]]
      : [
          ['systemctl', '--user', 'daemon-reload'],
          ['systemctl', '--user', 'enable', `${unit.label}.service`],
          ['systemctl', '--user', 'restart', `${unit.label}.service`],
        ]
  if (deps.platform === 'darwin') {
    // A launcher already loaded (the snippet pasted again) is booted out first. bootout returns before launchd has
    // finished taking the old one down, and a bootstrap in that window is refused "Bootstrap failed: 5: Input/output
    // error" (Adrian's Mac, 2026-11-24 05:33Z: the old launcher stopped, the new one never started). So wait until
    // launchd no longer knows the label, up to BOOTOUT_WAIT_MS, before bootstrapping.
    const target = `gui/${deps.uid}/${unit.label}`
    await deps.run(['launchctl', 'bootout', target], SERVICE_TIMEOUT_MS)
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let waited = 0; waited < BOOTOUT_WAIT_MS && (await deps.run(['launchctl', 'print', target], SERVICE_TIMEOUT_MS)).code === 0; waited += BOOTOUT_POLL_MS) await sleep(BOOTOUT_POLL_MS)
  }
  for (const s of steps) {
    const p = await deps.run(s, SERVICE_TIMEOUT_MS)
    if (p.code !== 0) refuse('service-failed', firstLine(p))
  }
  deps.out(`launcher installed for @${me.handle}${ours[0] && homeHandle !== me.handle ? ` (its existing launcher, set up as @${homeHandle})` : ''} in ${home}`)
  deps.out(`service: ${unit.label} (${unit.path})`)
  if (deps.platform === 'linux') {
    const user = deps.env.USER ?? ''
    const linger = user ? await deps.run(['loginctl', 'show-user', user, '-p', 'Linger'], SERVICE_TIMEOUT_MS) : null
    if (linger && linger.code === 0 && linger.stdout.trim() === 'Linger=no') deps.out(`it stops when you log out; to keep it running: loginctl enable-linger ${user}`)
  }
  deps.out(`status: ${wrapperOf(home)} launch status --home ${home}`)
}

/** A read once more after 1 s on network trouble or a 5xx (the CLI's rule). */
async function retrying<T>(deps: LaunchDeps, f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    const s = statusOf(e)
    if (s !== null && s < 500) throw e
    await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(RETRY_AFTER_MS)
    return f()
  }
}

// ── exec (internal: what the daemon runs inside its tmux session) ──

/** The session's own settings (design 0.2.27 § 3.3 step 5, AC-42; LOCAL-AGENTS-43): cmdr's status line, so cmdr.mc
 *  hears how full the context is, and `idleCompaction: false` (the box's BUGS-9 rule). Read by that session only,
 *  through `--settings`; the person's own `~/.claude/settings.json` is read, never written. Their own status line runs
 *  after ours (CMDR_STATUSLINE_NEXT), so their terminal shows what it showed. */
export const SESSION_SETTINGS_FILE = 'session-settings.json'
export function sessionSettings(bun: string, pluginDir: string, own: unknown): { settings: Record<string, unknown>; next: string | null } {
  const sl = own && typeof own === 'object' ? (own as { statusLine?: { type?: unknown; command?: unknown; padding?: unknown } }).statusLine : undefined
  const next = sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim() ? sl.command : null
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`
  const statusLine: Record<string, unknown> = { type: 'command', command: `${q(bun)} ${q(join(pluginDir, 'statusline.ts'))}` }
  if (next && typeof sl!.padding === 'number') statusLine.padding = sl!.padding
  return { settings: { statusLine, idleCompaction: false }, next }
}

function exec(o: Opts, deps: LaunchDeps) {
  if (o.pos.length) refuse('usage', 'launch exec --home <dir>')
  const home = homeOf(deps, o.opt.home)
  const { key, config } = installed(home)
  const stateDir = join(home, 'sessions', 'main')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  // The pane's own environment, less anything of cmdr's, then ours: the key set here, never on a command line (AC-16).
  // No CMDR_SESSION_SCOPE (design 0.2.0): the session is a plain `main`.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(deps.env)) if (v !== undefined && !k.startsWith('CMDR_')) env[k] = v
  Object.assign(env, {
    HOME: deps.userHome,
    PATH: config.path,
    CMDR_API_URL: config.apiUrl,
    ...(config.appUrl ? { CMDR_APP_URL: config.appUrl } : {}),
    CMDR_AGENT_KEY: key,
    CMDR_STATE_DIR: stateDir,
  })
  const own = readJson<unknown>(join(deps.env.CLAUDE_CONFIG_DIR?.trim() || join(deps.userHome, '.claude'), 'settings.json'))
  const { settings, next } = sessionSettings(config.bun, deps.pluginDir.replace(/\/+$/, ''), own)
  const settingsPath = join(home, LAUNCHER, SESSION_SETTINGS_FILE)
  writeWhole(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600)
  if (next) env.CMDR_STATUSLINE_NEXT = next
  deps.chdir(config.cwd)
  deps.execve(config.claude, [config.claude, '--dangerously-load-development-channels', 'plugin:cmdr@cmdr-crew', '--settings', settingsPath], env)
}

// ── run (the daemon) ──

/** What runs the CLI inside the session: the wrapper when installed (0.2.17), so a session started after a plugin
 *  update runs the new plugin; a home from before it, its recorded plugin. */
const execVia = (config: LaunchConfig, home: string): string[] =>
  existsSync(wrapperOf(home)) ? [wrapperOf(home)] : [config.bun, join(config.plugin, 'cli', 'cmdr-agent.ts')]
/** `installed_plugins.json`, where Claude Code keeps it (inside `CLAUDE_CONFIG_DIR` when set). */
const pluginsFile = (deps: LaunchDeps): string =>
  join(deps.env.CLAUDE_CONFIG_DIR?.trim() || join(deps.userHome, '.claude'), 'plugins', 'installed_plugins.json')
const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** The agent's folder as the screen may spell it (design 0.2.21, LS-33): as configured, as the system resolves it, and
 *  each with the home folder written `~`. */
export const foldersOf = (cwd: string, userHome: string): string[] => {
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {
    // not there (yet): as configured only
  }
  const home = userHome.replace(/\/+$/, '')
  const tilde = (p: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : null)
  return [...new Set([cwd, real, tilde(cwd), tilde(real)].filter((p): p is string => !!p))]
}

/** Answers the start questions in the agent's session (design 0.2.15): looks at its screen every PROMPT_POLL_MS for up
 *  to `windowMs` (0: one look), presses what `answerFor` says, and stops once the development-channels question is
 *  answered (Claude Code's last) or the session is gone. A screen waiting on a question it doesn't know is logged once
 *  per session (`prompt-waiting`, `said.waiting`), never answered. */
async function answerPrompts(deps: LaunchDeps, config: LaunchConfig, name: string, event: (tag: LaunchEvent, fields?: Record<string, string>) => void, windowMs: number, now: () => number, sleep: (ms: number) => Promise<void>, said: { waiting: boolean }): Promise<void> {
  const target = `=${name}:`
  const folders = foldersOf(config.cwd, deps.userHome)
  const end = now() + windowMs
  let keys = 0
  // Bounded by looks as well as by the clock, so a clock that doesn't move (or jumps back) can't hold the tick forever.
  for (let looks = Math.floor(windowMs / PROMPT_POLL_MS); ; looks--) {
    if (!(await hasSession(deps, config.tmux, name))) return
    const cap = await deps.run([...tmuxOn(config.tmux), 'capture-pane', '-p', '-t', target], TMUX_TIMEOUT_MS)
    const a = cap.code === 0 ? answerFor(cap.stdout, folders) : null
    if (a) {
      await deps.run([...tmuxOn(config.tmux), 'send-keys', '-t', target, ...a.keys], TMUX_TIMEOUT_MS)
      keys += a.keys.length
      if (a.keys.includes('Enter')) event('launch.session.prompt-answered', { arm: a.arm })
      if (a.arm === 'dev-channels') return
    } else if (!said.waiting && cap.code === 0 && cap.stdout.replace(/\s+/g, '').includes('Entertoconfirm')) {
      event('launch.session.prompt-waiting', { reason: 'unknown' })
      said.waiting = true
    }
    if (looks <= 0 || now() >= end || keys >= PROMPT_MAX_KEYS) return
    await sleep(PROMPT_POLL_MS)
  }
}

/** Whether `/agent/me` lists a live session: any entry in its `sessions` (design § 3.3 step 2). */
type MeSessions = { sessions?: unknown[] }

async function daemon(o: Opts, deps: LaunchDeps): Promise<number> {
  const home = homeOf(deps, o.opt.home)
  const { dir, key, config } = installed(home)
  const lock = (deps.lock ?? flockExclusive)(join(dir, LOCK_FILE))
  if (!lock) refuse('launcher-running', `a launcher already runs for ${home}`)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const event = eventTo(deps, dir, now)
  // `let`: a rename moves the session to its new name (0.2.25), and every later tick looks for it there.
  let name = sessionOf(config, readStateFile(dir))
  try {
    const client = McClient.create({ apiUrl: config.apiUrl, key, timeoutMs: CLI_TIMEOUT_MS, fetch: deps.fetch })
    event('launcher.started')
    // The agent's home (agent home sync design 0.1.9 § 3.4): pulled before a session starts, pushed each tick while it
    // runs, released on a clean end. `homeOff`: cmdr.mc had no agent homes at this session's start (an older one, 404,
    // or switched off, 503 home-unavailable); asked again at every start (design 0.1.15),
    // so sessions start as before. A lease this machine holds is `leaseId`.
    const homeCtx: HomeCtx = { client, machine: deps.machine ?? thisMachine(join(deps.userHome, '.cmdr', 'machine.json')), cwd: config.cwd, memoryDir: deps.memoryDir ?? memoryDirOf(config.cwd, deps.env as NodeJS.ProcessEnv), fetch: deps.fetch }
    let homeOff = false
    let leaseId: string | null = null
    let heldSaid = '' // the held-elsewhere stretch, said once
    const homeUnavailable = (e: unknown) => {
      const { status, code } = refusalOf(e)
      return status === 404 || code === 'home-unavailable'
    }
    const letGo = async () => {
      if (!leaseId) return
      const id = leaseId
      leaseId = null
      try {
        const r = await homeRelease(homeCtx, id)
        event('launch.home.released', { unpushed: r.unpushed ? 1 : 0 })
      } catch {
        event('launch.home.failed', { step: 'release' }) // the lease expires within 5 min
      }
    }
    // A session of this agent on the default tmux socket (a launcher from before 0.2.22) is ended once, there only,
    // and the tick starts it again on `-L cmdr`: otherwise the agent would run twice (design 0.2.22, AC-37).
    if ((await deps.run([config.tmux, 'has-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)).code === 0) {
      await deps.run([config.tmux, 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
      event('launcher.session-moved')
    }
    let wasUp = await hasSession(deps, config.tmux, name) // a session left by a hard-killed daemon is adopted (§ 5)
    // A newer plugin installed (design 0.2.22/0.2.23): this daemon leaves for the unit to start the new code, and its
    // session keeps running. Only when the unit runs the wrapper, which is what makes the restart reach the new code.
    const runningFrom = deps.pluginDir.replace(/\/+$/, '')
    let updated = false
    let leave: () => void = () => {}
    const left = new Promise<void>((r) => (leave = r))
    let stretch: string | null = null // the last logged skip, so a stretch logs once (plan § 4, PN-1)
    const asked = { waiting: false } // this session's unknown question, logged once (design 0.2.15)
    let refusedUntil = 0 // a refused key: /agent/me again only after REFUSED_RETRY_MS (AC-7)
    let sinceMe = HANDLE_POLL_TICKS // ticks with the session up since the last poll: the first tick polls (0.2.26)
    let refusedUp = false // a generic 401 while the session is up, logged once until a poll answers (AC-40 b)
    // This start's channel watch (0.2.27 step 6); a session adopted at the daemon's start is watched from then.
    let watch: ChannelWatch | null = wasUp ? { since: now(), stage: 'waiting' } : null

    // The mark is `stop`'s and `start`'s to write, never the daemon's (design § 3.3). A tick holds the state it read
    // at its top across awaits (tmux, cmdr.mc, a spawn's five seconds), and wrote that whole object back: a `launch
    // stop` in between was undone, and the next tick restarted the session (audit K-1). Every write of the daemon's
    // takes `stopped` from the file as it is at that moment; what it returns is what it wrote.
    const save = (st: LaunchState): LaunchState => {
      const merged = { ...st, stopped: readStateFile(dir).stopped }
      writeStateFile(dir, merged)
      return merged
    }

    // Restarts asked for in cmdr.app (0.2.27 § 3.3 step 7, § 3.5): collected every tick, whatever the session's state.
    // Carried out here, in the daemon, as `launch restart` would end the session: the session is ended now (an end the
    // person asked for: no ladder moves) and this tick starts a fresh one. Never through the session's own socket.
    // Set when this tick ended our own session for a restart: cmdr.mc may list it as live a few seconds longer, and that
    // listing is ours, not a hand-started session's, so it doesn't hold the fresh start back.
    let endedForRestart = false
    const collect = async () => {
      endedForRestart = false
      let asked: LauncherAction[] = []
      try {
        asked = await client.actions({ releaseHome: !homeOff })
      } catch {
        return // an older cmdr.mc (404), or unreachable: nothing asked
      }
      for (const a of Array.isArray(asked) ? asked : []) {
        if (typeof a?.id !== 'string') continue
        if (a.kind === 'release_home') {
          // A person transferred this agent to another machine (§ 3.4): its turn ends (at most 90 s), the session stops,
          // the home is pushed and released, and this launcher stays released until a person starts it here again.
          // cmdr.mc closes the action itself when the lease is released.
          if (await hasSession(deps, config.tmux, name)) {
            for (const end = now() + RELEASE_TURN_MS; now() < end; ) {
              const cap = await deps.run([...tmuxOn(config.tmux), 'capture-pane', '-p', '-t', `=${name}:`], TMUX_TIMEOUT_MS)
              if (cap.code !== 0 || idleAtInput(cap.stdout)) break
              await sleep(1000)
            }
            await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
            event('launch.session.ended', { reason: 'stopped' })
            save(ended(readStateFile(dir), now(), 'stopped'))
            wasUp = false
          }
          await letGo()
          writeStateFile(dir, { ...readStateFile(dir), stopped: true, stoppedReason: 'home-released' })
          continue
        }
        const stale = typeof a.stale === 'boolean' ? a.stale : !(Date.parse(a.createdAt) > now() - RESTART_FRESH_MS)
        const close = (status: 'done' | 'failed', detail?: string) => client.actionDone(a.id, status, detail).catch(() => undefined)
        if (stale) {
          event('launch.restart.stale')
          await close('failed', 'stale')
          continue
        }
        if (readStateFile(dir).stopped) {
          await close('failed', 'stopped')
          continue
        }
        if (await hasSession(deps, config.tmux, name)) {
          await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
          event('launch.session.ended', { reason: 'stopped' })
          save(ended(readStateFile(dir), now(), 'stopped'))
          wasUp = false
          endedForRestart = true
        }
        event('launch.restart', { source: 'app' })
        await close('done')
      }
    }

    const once = async () => {
      if (updated) return
      await collect()
      const installedNow = installedPlugin(readText(pluginsFile(deps)))
      if (installedNow && installedNow !== runningFrom && existsSync(join(installedNow, 'cli', 'cmdr-agent.ts')) && existsSync(wrapperOf(home))) {
        updated = true
        event('launcher.updated')
        leave()
        return
      }
      let st = readStateFile(dir)
      const up = await hasSession(deps, config.tmux, name)
      if (wasUp && !up) {
        // It ended since the last tick: stopped (the mark) or exited; the ladder moves (design § 3.3 step 4-5).
        const reason = st.stopped ? 'stopped' : 'exited'
        event('launch.session.ended', { reason })
        st = save(ended(st, now(), reason))
      }
      wasUp = up
      // The home (§ 3.4): renewed and pushed each tick while the session runs; let go once it's stopped.
      if (!homeOff && leaseId && up && !st.stopped) {
        try {
          // Renews it (5 min); refused if it was forced away. Its answer is used (H725-2): a lease that expired (a Mac
          // asleep over 5 min) comes back as a NEW lease for this machine. If the home is still where this machine left
          // it, push on under the new id; if another machine changed it in between, stop and start again, so the pull
          // sets this machine's unpushed changes aside rather than pushing over the other machine's.
          const renewed = await client.homeLease(homeCtx.machine)
          if (renewed.leaseId !== leaseId) {
            const m = await client.homeManifest(homeCtx.machine.machineId)
            if (m.revision !== readHomeState(homeCtx.cwd).revision) {
              leaseId = renewed.leaseId
              await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
              event('launch.session.ended', { reason: 'exited' })
              st = save(ended(readStateFile(dir), now(), 'exited'))
              wasUp = false
              return
            }
            leaseId = renewed.leaseId
          }
          const r = await homePush(homeCtx, leaseId)
          if (r.committed) event('launch.home.pushed', { put: r.put, deleted: r.deleted })
        } catch (e) {
          if (e instanceof LeaseLost || refusalOf(e).code === 'lease-held') {
            // Forced away (a transfer): the session stops here; its last changes are kept by cmdr.mc, unmerged.
            leaseId = null
            await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
            event('launch.session.ended', { reason: 'stopped' })
            st = save(ended(readStateFile(dir), now(), 'stopped'))
            wasUp = false
            event('launch.home.held-elsewhere')
            return
          }
          if (e instanceof HomeMoved) {
            // Another machine changed the home while this one's lease had lapsed (H725-5): stop, and start again
            // through a pull, which sets this machine's changes aside rather than pushing over the other's.
            await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
            event('launch.session.ended', { reason: 'exited' })
            st = save(ended(readStateFile(dir), now(), 'exited'))
            wasUp = false
            return
          }
          event('launch.home.failed', { step: 'push' }) // next tick
        }
      }
      if (leaseId && !up && st.stopped) await letGo()
      // A session up but not yet heard from since it started (one adopted at a daemon start, or a question that came
      // late) gets one look per tick.
      if (up && !st.stopped && !heardSince(home, st.lastStartAt)) await answerPrompts(deps, config, name, event, 0, now, sleep, asked)
      // The session up: /agent/me on the first tick and every HANDLE_POLL_TICKS-th after (design 0.2.26 § 3.3 step 1),
      // for a rename (the session follows it) or a removal (the session ends); on other ticks nothing is asked.
      if (up && !st.stopped) {
        if (sinceMe < HANDLE_POLL_TICKS) {
          sinceMe++
        } else {
          sinceMe = 1
          let me: { handle?: string | null } | null = null
          try {
            me = (await retrying(deps, () => client.me())) as unknown as { handle?: string | null }
            refusedUp = false
          } catch (e) {
            const code = statusOf(e)
            if (code === 401 || code === 403) {
              if (isAgentRemoved(e)) {
                // Removed while running (remove/rename AC-4, launcher AC-40 a): the mark, said once, and the session
                // ends: its key is revoked and it hears nothing. The daemon stays up, idle, asking nothing more.
                writeStateFile(dir, { ...readStateFile(dir), stopped: true, stoppedReason: 'agent-removed' })
                event('launcher.refused', { reason: 'agent-removed' })
                stretch = 'launcher.refused:agent-removed'
                await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
                event('launch.session.ended', { reason: 'stopped' })
                save(ended(readStateFile(dir), now(), 'stopped'))
                wasUp = false
                return
              }
              // Any other refusal leaves the session running (a re-paste restarts it anyway): said once (AC-40 b).
              if (!refusedUp) event('launcher.refused', { reason: 'unauthorized' })
              refusedUp = true
            }
            // A network failure or a 5xx after the one retry: nothing changes; the next poll asks again (AC-40 c).
          }
          const handle = me?.handle ?? null
          if (handle && HANDLE.test(handle) && sessionName(config.crew, handle) !== name) {
            // Renamed in cmdr (0.2.25, AC-39): the running session takes the new name, and keeps running.
            const to = sessionName(config.crew, handle)
            const r = await deps.run([...tmuxOn(config.tmux), 'rename-session', '-t', `=${name}`, to], TMUX_TIMEOUT_MS)
            if (r.code === 0) {
              save({ ...readStateFile(dir), handle })
              name = to
              event('launcher.session-renamed')
            }
          }
        }
      }
      // The channel must come up (0.2.27 step 6): asked only while a watch is open and its 30 s have passed.
      if (up && !st.stopped && watch && watch.stage !== 'done' && now() - watch.since >= CHANNEL_READY_MS) {
        let live: boolean | null = null
        try {
          const me = (await retrying(deps, () => client.me())) as unknown as MeSessions
          live = Array.isArray(me.sessions) && me.sessions.length > 0
        } catch {
          live = null
        }
        // Unanswered (unreachable or refused): the other arms say so, and the watch closes unsaid rather than ask
        // every tick; the channel can't be judged while cmdr.mc can't be asked.
        if (live === null) {
          watch = { ...watch, stage: 'done' }
          return
        }
        const step = channelStep(watch, live, now())
        if (step.act === 'reconnect') {
          const cap = await deps.run([...tmuxOn(config.tmux), 'capture-pane', '-p', '-t', `=${name}:`], TMUX_TIMEOUT_MS)
          // Only into the screen it knows; any other, it looks again next tick, the watch unmoved.
          if (cap.code !== 0 || !idleAtInput(cap.stdout)) return
          await deps.run([...tmuxOn(config.tmux), 'send-keys', '-t', `=${name}:`, '-l', RECONNECT_KEYS], TMUX_TIMEOUT_MS)
          await deps.run([...tmuxOn(config.tmux), 'send-keys', '-t', `=${name}:`, 'Enter'], TMUX_TIMEOUT_MS)
          event('launch.session.channel-reconnect')
        } else if (step.act === 'missing') event('launch.session.channel-missing')
        watch = step.watch
      }
      let authorized = true
      let otherLive = false
      if (!up && !st.stopped) {
        if (now() < refusedUntil) authorized = false
        else {
          sinceMe = 1 // asked now: a session it starts is next polled HANDLE_POLL_TICKS ticks on
          try {
            const me = (await retrying(deps, () => client.me())) as unknown as MeSessions
            otherLive = !endedForRestart && Array.isArray(me.sessions) && me.sessions.length > 0
          } catch (e) {
            const code = statusOf(e)
            if (code !== 401 && code !== 403) throw e
            // Its agent was removed from its crew (remove/rename design AC-4): no key will work again, so it stops, says
            // so once, and asks cmdr.mc nothing more. The one write of the mark that is the daemon's own.
            if (isAgentRemoved(e)) {
              writeStateFile(dir, { ...readStateFile(dir), stopped: true, stoppedReason: 'agent-removed' })
              event('launcher.refused', { reason: 'agent-removed' })
              stretch = 'launcher.refused:agent-removed'
              return
            }
            authorized = false
            refusedUntil = now() + REFUSED_RETRY_MS
          }
        }
      }
      const v = tick(st, up, otherLive, authorized, now())
      if (v.action !== 'skip') stretch = null
      const said = eventOfVerdict(v)
      if (said && stretch !== `${said.tag}:${said.fields.reason}`) {
        event(said.tag, said.fields)
        stretch = `${said.tag}:${said.fields.reason}`
      }
      if (v.action !== 'start') return
      // The session before may still hold the state directory for a few seconds after its pane is gone: a session
      // started now would only stand down (Ylis, 2026-11-25). Wait for it; past the wait, start nothing and say so.
      const held = await holderReleased(home, deps)
      if (held) {
        event('launch.restart.blocked', { reason: 'state-dir-held', pid: String(held.pid), server: String(held.server), session: held.session ?? 'none' })
        stretch = null
        return
      }
      // Never start without the home (§ 3.4): take the lease and pull first. Held elsewhere: no session, said once.
      // Any other failure: no session this tick (starting without it would fork the home). Agent homes off (design
      // 0.1.15: 503 home-unavailable, or a 404 from a cmdr.mc without them): the session starts without syncing,
      // state.json says `homeSync: off`, and every later start asks again.
      {
        try {
          const pulled = await homePull(homeCtx)
          leaseId = pulled.leaseId
          heldSaid = ''
          homeOff = false
          if (readStateFile(dir).heldBy || readStateFile(dir).homeSync) {
            const { heldBy: _gone, homeSync: _off, ...rest } = readStateFile(dir)
            writeStateFile(dir, rest)
          }
          event('launch.home.pulled', { fetched: pulled.fetched, deleted: pulled.deleted, conflicts: pulled.conflicts })
          st = { ...readStateFile(dir), lastStartAt: st.lastStartAt }
        } catch (e) {
          if (homeUnavailable(e)) {
            homeOff = true
            leaseId = null
            if (readStateFile(dir).homeSync !== 'off') writeStateFile(dir, { ...readStateFile(dir), homeSync: 'off' })
            st = { ...readStateFile(dir), lastStartAt: st.lastStartAt } // so the start below keeps the mark
          } else {
            const r = refusalOf(e)
            if (r.code === 'lease-held') {
              const by = typeof r.detail?.machineName === 'string' ? r.detail.machineName : 'another machine'
              writeStateFile(dir, { ...readStateFile(dir), heldBy: by })
              if (heldSaid !== by) event('launch.home.held-elsewhere')
              heldSaid = by
            } else event('launch.home.failed', { step: 'pull' })
            return
          }
        }
      }
      st = { ...st, lastStartAt: new Date(now()).toISOString() }
      const spawned = await deps.run([...tmuxOn(config.tmux), 'new-session', '-d', '-s', name, '-c', config.cwd, '--', ...execVia(config, home), 'launch', 'exec', '--home', home], TMUX_TIMEOUT_MS)
      let alive = spawned.code === 0
      for (const end = now() + SPAWN_DEADLINE_MS; alive && !(await hasSession(deps, config.tmux, name)) && now() < end; ) await sleep(250)
      alive = alive && (await hasSession(deps, config.tmux, name))
      if (!alive) {
        // A `launch stop` during the spawn killed it: an end the person asked for, not a spawn that failed, so no
        // ladder moves (as for any stopped end).
        if (readStateFile(dir).stopped) {
          event('launch.session.ended', { reason: 'stopped' })
          save(ended(st, now(), 'stopped'))
          return
        }
        event('launch.session.failed', { reason: 'spawn' })
        save(ended(st, now())) // a failed spawn is an early exit (design § 5)
        return
      }
      st = save(st)
      wasUp = true
      watch = { since: now(), stage: 'waiting' }
      event('launch.session.started')
      asked.waiting = false
      if (!st.stopped) await answerPrompts(deps, config, name, event, PROMPT_WATCH_MS, now, sleep, asked)
      // The stop came while the session was still coming up, so stop's own kill found nothing to end: end it here.
      // The next tick sees it gone and logs the stopped end.
      if (st.stopped) await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
    }

    let lane: Promise<unknown> = Promise.resolve()
    const inLane = (f: () => Promise<unknown>) => {
      lane = lane.then(f).catch((e) => deps.err(`cmdr-agent launch: ${e instanceof Error ? e.message : e}`))
      return lane
    }
    await inLane(once)
    const stopTick = (deps.every ?? ((ms, fn) => {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    }))(TICK_MS, () => void inLane(once))
    await Promise.race([left, new Promise<void>((r) => (deps.stop?.aborted ? r() : deps.stop?.addEventListener('abort', () => r(), { once: true })))])
    stopTick()
    await lane
    // Leaving for an update: the session stays up for the new daemon to adopt (step 1); the unit restarts on 75.
    if (updated) return EXIT_UPDATED
    // The session dies with its supervisor (design § 3.3, AC-27), and the home is pushed and let go (§ 3.4).
    await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
    await letGo()
    event('launcher.stopped')
    return 0
  } finally {
    lock!.release()
  }
}

// ── status, stop, start, uninstall ──

async function status(o: Opts, deps: LaunchDeps) {
  const home = homeOf(deps, o.opt.home)
  const { dir, config } = installed(home)
  const unit = unitOf(deps, home)
  const st = readStateFile(dir)
  // The session that exists (the recorded handle), never /agent/me's: right inside a rename's ≤ 5 minutes (0.2.26).
  const name = sessionOf(config, st)
  deps.out(`service: ${await serviceState(deps, unit)}${unit ? ` (${unit.label})` : ''}`)
  const now_ = installedPlugin(readText(pluginsFile(deps)))
  deps.out(`plugin: ${now_ ?? config.plugin}${now_ || existsSync(join(config.plugin, 'cli', 'cmdr-agent.ts')) ? '' : ' (plugin-missing: set the agent up again)'}`)
  const up = await hasSession(deps, config.tmux, name)
  const now = (deps.now ?? Date.now)()
  const last = readEvents(dir).reverse().find((l) => / launch\.session\.(started|skipped|ended|failed)\b/.test(l)) ?? ''
  const screen = up && !heardSince(home, st.lastStartAt) ? await deps.run([...tmuxOn(config.tmux), 'capture-pane', '-p', '-t', `=${name}:`], TMUX_TIMEOUT_MS) : null
  const asking = screen && screen.code === 0 && screen.stdout.replace(/\s+/g, '').includes('Entertoconfirm')
  const session = up
    ? asking
      ? answerFor(screen.stdout, foldersOf(config.cwd, deps.userHome))
        ? `starting: answering Claude Code's start question (since ${st.lastStartAt ?? 'unknown'})`
        : `waiting on a question in its session the launcher doesn't answer: ${attachLine(config.tmux, name)}`
      : `running since ${st.lastStartAt ?? 'unknown'}`
    : st.stopped && st.stoppedReason === 'agent-removed'
      ? `removed from its crew: its key no longer works (${wrapperOf(home)} launch uninstall --home ${home} takes it off this machine)`
      : st.stopped
      ? `stopped (${wrapperOf(home)} launch start --home ${home} to resume)`
      : st.backoffUntil && Date.parse(st.backoffUntil) > now
        ? `backoff until ${st.backoffUntil}`
        : / launch\.session\.skipped reason=live\b/.test(last)
          ? 'skipped: another session is live'
          : 'not running (the next tick starts it)'
  deps.out(`session: ${session}`)
  if (up) {
    const a = readActivity(home)
    deps.out(`activity: ${!a ? 'starting' : a.state === 'idle' ? `idle since ${a.since}` : 'working'}`)
  }
  deps.out(`attach: ${attachLine(config.tmux, name)}`)
  // The handle cmdr knows it by, beside the home named by the one it was set up with (0.2.24).
  deps.out(`agent: @${st.handle ?? config.handle} (${home})`)
}
const readEvents = (dir: string): string[] => {
  try {
    return readFileSync(join(dir, EVENTS_FILE), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** The mark (design § 3.3): set by stop, cleared by start; the daemon reads it every tick and never writes it. */
function mark(o: Opts, deps: LaunchDeps, stopped: boolean): { dir: string; config: LaunchConfig } {
  if (o.pos.length) refuse('usage', stopped ? 'launch stop [--all] [--home <dir>]' : 'launch start [--home <dir>]')
  const home = homeOf(deps, o.opt.home)
  const dir = join(home, LAUNCHER)
  const config = readJson<LaunchConfig>(join(dir, CONFIG_FILE))
  if (!config) refuse('launcher-not-installed', `no launcher in ${home}`)
  const { stoppedReason: _was, ...st } = readStateFile(dir)
  writeStateFile(dir, { ...st, stopped })
  eventTo(deps, dir, deps.now ?? Date.now)('launcher.marked', {}, stopped ? 'stopped' : 'started')
  return { dir, config: config! }
}

async function stop(o: Opts, deps: LaunchDeps) {
  const { dir, config } = mark(o, deps, true) // the mark first, so the tick that sees the end reads `stopped`
  const name = sessionOf(config, readStateFile(dir))
  await deps.run([...tmuxOn(config.tmux), 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
  deps.out(`stopped: ${name} (it stays stopped until ${wrapperOf(homeOf(deps, o.opt.home))} launch start --home ${homeOf(deps, o.opt.home)})`)
}

/** `launch restart` (launcher design 0.2.27 § 3.1, AC-41; LOCAL-AGENTS-42): the session ends and a fresh one starts at
 *  once, by restarting the launcher's unit (`launchctl kickstart -k`, `systemctl --user restart`), as `set-cwd` does.
 *  The old daemon's SIGTERM kills its session; the new one's first tick starts a fresh one, with no backoff (a restart
 *  is not a crash). Refused, changing nothing: `stopped` while the stopped mark is set (`launch start` resumes), and
 *  `launcher-not-installed` with no unit. `--source desktop` when the desktop app runs it; `cli` otherwise. */
export const RESTART_SOURCES = ['cli', 'desktop', 'app'] as const
async function restart(o: Opts, deps: LaunchDeps) {
  if (o.pos.length) refuse('usage', 'launch restart [--home <dir>]')
  const source = o.opt.source ?? 'cli'
  if (!(RESTART_SOURCES as readonly string[]).includes(source)) refuse('usage', `launch restart --source ${RESTART_SOURCES.join('|')}`)
  const home = homeOf(deps, o.opt.home)
  const dir = join(home, LAUNCHER)
  const config = readJson<LaunchConfig>(join(dir, CONFIG_FILE))
  if (!config) refuse('launcher-not-installed', `no launcher in ${home}`)
  if (readStateFile(dir).stopped) refuse('stopped', `the agent is stopped: ${wrapperOf(home)} launch start --home ${home} starts it`)
  const unit = unitOf(deps, home)
  if (!unit) refuse('launcher-not-installed', `no login service for ${home}: set the agent up on this machine again`)
  const before = liveHolder(home, deps)
  const cmd = deps.platform === 'darwin' ? ['launchctl', 'kickstart', '-k', `gui/${deps.uid}/${unit!.label}`] : ['systemctl', '--user', 'restart', `${unit!.label}.service`]
  const p = await deps.run(cmd, SERVICE_TIMEOUT_MS)
  if (p.code !== 0) refuse('service-failed', firstLine(p))
  // Restarted means a new session holds the agent's state directory, not that the unit restarted (design 0.1.8 § 3
  // F-5): waited for up to the start's own wait and one tick.
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)))
  const t0 = now()
  let h = liveHolder(home, deps)
  while (!(h && h.pid !== before?.pid) && now() - t0 < RESTART_WAIT_MS + TICK_MS) {
    await sleep(HOLDER_POLL_MS)
    h = liveHolder(home, deps)
  }
  const ok = !!h && h.pid !== before?.pid
  eventTo(deps, dir, now)('launch.restart', { source, outcome: ok ? 'restarted' : 'restart-incomplete', waitedMs: String(now() - t0) })
  if (ok) return deps.out(`restarted: ${sessionOf(config!, readStateFile(dir))} started fresh`)
  if (h) refuse('restart-incomplete', `state-dir held by server ${h.server} (pid ${h.pid}, session ${h.session ?? 'unknown'})`)
  refuse('restart-incomplete', `no session holds the state dir after ${Math.round((RESTART_WAIT_MS + TICK_MS) / 1000)}s`)
}

function start(o: Opts, deps: LaunchDeps) {
  const { dir, config } = mark(o, deps, false)
  deps.out(`started: the next tick starts ${sessionOf(config, readStateFile(dir))}`)
}

/** `launch set-cwd <dir>` (launcher design 0.2.18, AC-35): move the agent to a folder that exists, then restart the
 *  launcher through its unit so the daemon reads it (it reads config.json once, at start); its session ends with the
 *  old daemon and the next starts in the new folder. Refused: the home folder (cwd-is-home), a folder that isn't there
 *  (cwd-missing, never made here). Each refusal changes nothing. */
async function setCwd(o: Opts, deps: LaunchDeps) {
  if (o.pos.length !== 1) refuse('usage', 'launch set-cwd <dir> [--home <dir>]')
  const home = homeOf(deps, o.opt.home)
  const dir = join(home, LAUNCHER)
  const config = readJson<LaunchConfig>(join(dir, CONFIG_FILE))
  if (!config) refuse('launcher-not-installed', `no launcher in ${home}`)
  const raw = o.pos[0]!.replace(/^~(?=\/|$)/, deps.userHome)
  const cwd = (raw.startsWith('/') ? raw : join(process.cwd(), raw)).replace(/\/+$/, '') || '/'
  if (cwd === deps.userHome.replace(/\/+$/, '')) refuse('cwd-is-home', "the agent can't work in your home folder: name another folder")
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) refuse('cwd-missing', `no folder at ${cwd}: make it first, or name one that exists`)
  writeWhole(join(dir, CONFIG_FILE), `${JSON.stringify({ ...config!, cwd }, null, 2)}\n`, 0o600)
  eventTo(deps, dir, deps.now ?? Date.now)('launcher.cwd-changed')
  const unit = unitOf(deps, home)
  if (unit) {
    const restart = deps.platform === 'darwin' ? ['launchctl', 'kickstart', '-k', `gui/${deps.uid}/${unit.label}`] : ['systemctl', '--user', 'restart', `${unit.label}.service`]
    const p = await deps.run(restart, SERVICE_TIMEOUT_MS)
    if (p.code !== 0) refuse('service-failed', firstLine(p))
  }
  deps.out(`the agent now works in ${cwd}${unit ? '; its launcher restarted, and its next session starts there' : ''}`)
}

async function uninstall(o: Opts, deps: LaunchDeps) {
  const home = homeOf(deps, o.opt.home)
  const dir = join(home, LAUNCHER)
  const unit = unitOf(deps, home)
  if (unit) {
    // Stopping the unit SIGTERMs the daemon, which kills its session first (AC-27).
    const steps = deps.platform === 'darwin' ? [['launchctl', 'bootout', `gui/${deps.uid}/${unit.label}`]] : [['systemctl', '--user', 'disable', '--now', `${unit.label}.service`]]
    for (const s of steps) await deps.run(s, SERVICE_TIMEOUT_MS)
    rmSync(unit.path, { force: true })
    if (deps.platform === 'linux') await deps.run(['systemctl', '--user', 'daemon-reload'], SERVICE_TIMEOUT_MS)
  }
  rmSync(dir, { recursive: true, force: true })
  deps.out(`launcher removed from ${home}${unit ? ` (and its service ${unit.label})` : ''}; ${join(home, 'sessions', 'main')} is kept`)
}

export const LAUNCH_USAGE = `usage: cmdr-agent launch <install|run|status|stop|start|restart|set-cwd|uninstall> [args]

  install [--home <dir>] [--cwd <dir>] [--plugin <folder>] [--tmux <path>]
                                       keep the key here and start the launcher as a login service
  run [--home <dir>]                   the launcher itself (the service runs it): keeps the agent's one session running
  status [--home <dir>]                the service, the session, and how to attach to it
  stop [--home <dir>]                  end the session and keep it ended (until start)
  start [--home <dir>]                 let the launcher start it again
  restart [--home <dir>]               end the session; a fresh one starts at once (refused while stopped)
  set-cwd <dir> [--home <dir>]         work in another folder (one that exists); the launcher restarts into it
  uninstall [--home <dir>]             remove the service and the key; the session ends with it

install reads CMDR_API_URL and CMDR_AGENT_KEY (and CMDR_STATE_DIR for the home); the others read the home.`

/** The real edges (cmdr-agent.ts's run): Bun's spawn with a budget, Bun.which, process.execve. */
export function realLaunchDeps(base: Pick<LaunchDeps, 'env' | 'out' | 'err' | 'fetch' | 'stop'>): LaunchDeps {
  return {
    ...base,
    platform: process.platform,
    userHome: homedir(),
    uid: process.getuid?.() ?? 0,
    bunPath: process.execPath,
    pluginDir: join(dirname(import.meta.path), '..'),
    run: async (cmd, timeoutMs) => {
      try {
        const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: timeoutMs })
        const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
        return { code, stdout, stderr }
      } catch (e) {
        return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
      }
    },
    which: (name, path) => Bun.which(name, { PATH: path }),
    execve: (file, args, env) => (process as unknown as { execve: (f: string, a: string[], e: Record<string, string>) => void }).execve(file, args, env),
    chdir: (dir) => process.chdir(dir),
  }
}

/** The family's entry (main.ts hands `launch` here before its key gate). */
export async function launch(argv: string[], deps: LaunchDeps): Promise<number> {
  const [sub, ...rest] = argv
  try {
    const flags = ['home', 'cwd', 'plugin', 'tmux', 'source']
    const o = parseArgs(rest, flags, ['all'])
    if (sub === 'install') await install(o, deps)
    else if (sub === 'run') return await daemon(o, deps)
    else if (sub === 'exec') exec(o, deps)
    else if (sub === 'status') await status(o, deps)
    else if (sub === 'stop') await stop(o, deps)
    else if (sub === 'start') start(o, deps)
    else if (sub === 'restart') await restart(o, deps)
    else if (sub === 'uninstall') await uninstall(o, deps)
    else if (sub === 'set-cwd') await setCwd(o, deps)
    else if (sub === undefined || sub === '--help' || sub === 'help') {
      deps.out(LAUNCH_USAGE)
      return sub === undefined ? 2 : 0
    } else refuse('usage', `no launch verb ${sub} (cmdr-agent launch --help)`)
    return 0
  } catch (e) {
    const line = e instanceof Refused ? e.message : (e as Error)?.constructor?.name === 'Refusal' ? (e as Error).message : statusOf(e) !== null ? `server-refused: ${(e as Error).message}` : `unreachable: ${(e as Error)?.message ?? String(e)}`
    deps.err(`refused: ${line}`)
    return 1
  }
}
