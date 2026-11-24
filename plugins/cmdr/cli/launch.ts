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

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ACTIVITY_STATE_FILE, McClient, Mode } from '../agent-client/index.js'
import { flockExclusive, type Lock } from '../state-dir.js'
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
  lastStartAt: string | null
  lastEndAt: string | null
  /** 0..2: the index into BACKOFF_STEPS_MS of the next early-exit wait */
  backoffStep: 0 | 1 | 2
  backoffUntil: string | null
}
export const FRESH_STATE: LaunchState = Object.freeze({ stopped: false, lastStartAt: null, lastEndAt: null, backoffStep: 0, backoffUntil: null })

/** A session that ends within this of starting is an early exit, and backs off (design § 3.3 step 4). */
export const EARLY_EXIT_MS = 60_000
/** The backoff ladder after early exits: 1, 5, then 15 minutes, holding at 15 (design § 3.3, § 5). */
export const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const
export const TICK_MS = 30_000
/** A refused key: `/agent/me` again this often, staying up (design § 3.3 step 3, AC-7). */
export const REFUSED_RETRY_MS = 5 * 60_000
/** tmux commands, and a spawn that has produced no session (design § 5). */
export const TMUX_TIMEOUT_MS = 5_000
export const SPAWN_DEADLINE_MS = 5_000
/** launchctl / systemctl (plan § 4). */
export const SERVICE_TIMEOUT_MS = 10_000
/** The tmux floor (design § 3.1, § 5, LS-13): `new-session`'s command as several arguments. */
export const TMUX_FLOOR = { major: 2, minor: 0 } as const

// ── the pure core ──────────────────────────────────────────────────────

/** The closed event set (design 0.2.3 § 6). */
export const LAUNCH_EVENTS = ['launcher.started', 'launcher.refused', 'launch.session.started', 'launch.session.skipped', 'launch.session.failed', 'launch.session.ended', 'launcher.marked', 'launcher.stopped'] as const
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

/** What the login service is told to run: paths alone, never the key or any environment (design § 3.1, § 7). */
export type UnitPaths = { userHome: string; crew: string; handle: string; home: string; bun: string; plugin: string }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** A systemd ExecStart word: quoted, with its own escapes (`%` is a specifier, `\` and `"` are quoting). */
const sd = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

/** The login service's unit (design § 3.1): macOS a LaunchAgent plist (RunAtLoad, KeepAlive), Linux a systemd user
 *  unit (Restart=on-failure, WantedBy=default.target). Its bytes are a function of the paths alone, so a re-install
 *  with the same inputs writes the same file. Any other platform: null (`platform-unsupported`). */
export function unitFor(platform: string, p: UnitPaths): { path: string; label: string; contents: string } | null {
  const entry = `${p.plugin}/cli/cmdr-agent.ts`
  if (platform === 'darwin') {
    const label = `it.cmdr.agent.${p.crew}.${p.handle}`
    const args = [p.bun, entry, 'launch', 'run', '--home', p.home].map((a) => `    <string>${xml(a)}</string>`).join('\n')
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
ExecStart=${[p.bun, entry, 'launch', 'run', '--home', p.home].map(sd).join(' ')}
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
  if (!key || !config) refuse('launcher-not-installed', `no launcher in ${home}: run cmdr-agent launch install`)
  return { dir, key, config: config! }
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
  return refuse(found.length ? 'usage' : 'launcher-not-installed', found.length ? `more than one launcher home: pass --home (${found.join(', ')})` : 'no launcher installed: run cmdr-agent launch install')
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
  const p = await deps.run([tmux, 'list-sessions', '-F', '#{session_name}'], TMUX_TIMEOUT_MS)
  return p.code === 0 ? new Set(p.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) : new Set()
}
/** Whether our tmux session exists (`has-session -t`; a missing server is "no"). */
async function hasSession(deps: LaunchDeps, tmux: string, name: string): Promise<boolean> {
  return (await deps.run([tmux, 'has-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)).code === 0
}
/** `state.json`, or a fresh state when absent or unreadable (its fields checked one by one). */
const readStateFile = (dir: string): LaunchState => {
  const j = readJson<Partial<LaunchState>>(join(dir, STATE_FILE))
  if (!j) return { ...FRESH_STATE }
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  const step = j.backoffStep === 1 || j.backoffStep === 2 ? j.backoffStep : 0
  return { stopped: j.stopped === true, lastStartAt: iso(j.lastStartAt), lastEndAt: iso(j.lastEndAt), backoffStep: step, backoffUntil: iso(j.backoffUntil) }
}
const writeStateFile = (dir: string, st: LaunchState) => writeWhole(join(dir, STATE_FILE), `${JSON.stringify(st, null, 2)}\n`, 0o600)
/** The session's `activity.state` (the plugin writes it; the launcher only reads it, for `status`). */
const readActivity = (home: string): { state: 'idle' | 'working'; since: string } | null => {
  const s = readJson<{ state?: string; since?: string }>(join(home, 'sessions', 'main', ACTIVITY_STATE_FILE))
  return s && (s.state === 'idle' || s.state === 'working') && typeof s.since === 'string' ? { state: s.state, since: s.since } : null
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
  const tmux = deps.which('tmux', path)
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
  const home = o.opt.home ? o.opt.home.replace(/^~(?=\/|$)/, deps.userHome) : stateDir ? dirname(dirname(stateDir)) : join(deps.userHome, '.cmdr', 'agents', crew, me.handle ?? me.id)
  // The session finds bun and claude as this shell did (LS-3, AC-16): its PATH, with bun's folder if absent.
  const bunDir = dirname(deps.bunPath)
  const parts = path.split(':').filter(Boolean)
  const config: LaunchConfig = {
    apiUrl: deps.env.CMDR_API_URL!.trim().replace(/\/+$/, ''),
    ...(deps.env.CMDR_APP_URL?.trim() ? { appUrl: deps.env.CMDR_APP_URL.trim() } : {}),
    agentId: me.id,
    crew,
    handle: me.handle ?? me.id,
    claude: claude!,
    tmux: tmux!,
    bun: deps.bunPath,
    plugin,
    path: (parts.includes(bunDir) ? parts : [bunDir, ...parts]).join(':'),
    cwd: (o.opt.cwd ?? deps.userHome).replace(/^~(?=\/|$)/, deps.userHome),
  }
  const unit = unitFor(deps.platform, { userHome: deps.userHome, crew, handle: me.handle ?? me.id, home, bun: deps.bunPath, plugin })!
  // Every check has passed: now the files, the key before the unit, so a service never starts without one (§ 9).
  const dir = join(home, LAUNCHER)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  writeWhole(join(dir, KEY_FILE), (deps.env.CMDR_AGENT_KEY ?? '').trim(), 0o600)
  writeWhole(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 0o600)
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
  deps.out(`launcher installed for @${me.handle} in ${home}`)
  deps.out(`service: ${unit.label} (${unit.path})`)
  if (deps.platform === 'linux') {
    const user = deps.env.USER ?? ''
    const linger = user ? await deps.run(['loginctl', 'show-user', user, '-p', 'Linger'], SERVICE_TIMEOUT_MS) : null
    if (linger && linger.code === 0 && linger.stdout.trim() === 'Linger=no') deps.out(`it stops when you log out; to keep it running: loginctl enable-linger ${user}`)
  }
  deps.out(`status: cmdr-agent launch status --home ${home}`)
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
  deps.chdir(config.cwd)
  deps.execve(config.claude, [config.claude, '--dangerously-load-development-channels', 'plugin:cmdr@cmdr-crew'], env)
}

// ── run (the daemon) ──

/** Whether `/agent/me` lists a live session: any entry in its `sessions` (design § 3.3 step 2). */
type MeSessions = { sessions?: unknown[] }

async function daemon(o: Opts, deps: LaunchDeps): Promise<void> {
  const home = homeOf(deps, o.opt.home)
  const { dir, key, config } = installed(home)
  const lock = (deps.lock ?? flockExclusive)(join(dir, LOCK_FILE))
  if (!lock) refuse('launcher-running', `a launcher already runs for ${home}`)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const event = eventTo(deps, dir, now)
  const name = sessionName(config.crew, config.handle)
  try {
    const client = McClient.create({ apiUrl: config.apiUrl, key, timeoutMs: CLI_TIMEOUT_MS, fetch: deps.fetch })
    event('launcher.started')
    let wasUp = await hasSession(deps, config.tmux, name) // a session left by a hard-killed daemon is adopted (§ 5)
    let stretch: string | null = null // the last logged skip, so a stretch logs once (plan § 4, PN-1)
    let refusedUntil = 0 // a refused key: /agent/me again only after REFUSED_RETRY_MS (AC-7)

    // The mark is `stop`'s and `start`'s to write, never the daemon's (design § 3.3). A tick holds the state it read
    // at its top across awaits (tmux, cmdr.mc, a spawn's five seconds), and wrote that whole object back: a `launch
    // stop` in between was undone, and the next tick restarted the session (audit K-1). Every write of the daemon's
    // takes `stopped` from the file as it is at that moment; what it returns is what it wrote.
    const save = (st: LaunchState): LaunchState => {
      const merged = { ...st, stopped: readStateFile(dir).stopped }
      writeStateFile(dir, merged)
      return merged
    }

    const once = async () => {
      let st = readStateFile(dir)
      const up = await hasSession(deps, config.tmux, name)
      if (wasUp && !up) {
        // It ended since the last tick: stopped (the mark) or exited; the ladder moves (design § 3.3 step 4-5).
        const reason = st.stopped ? 'stopped' : 'exited'
        event('launch.session.ended', { reason })
        st = save(ended(st, now(), reason))
      }
      wasUp = up
      let authorized = true
      let otherLive = false
      if (!up && !st.stopped) {
        if (now() < refusedUntil) authorized = false
        else {
          try {
            const me = (await retrying(deps, () => client.me())) as unknown as MeSessions
            otherLive = Array.isArray(me.sessions) && me.sessions.length > 0
          } catch (e) {
            const code = statusOf(e)
            if (code !== 401 && code !== 403) throw e
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
      st = { ...st, lastStartAt: new Date(now()).toISOString() }
      const spawned = await deps.run([config.tmux, 'new-session', '-d', '-s', name, '-c', config.cwd, '--', config.bun, join(config.plugin, 'cli', 'cmdr-agent.ts'), 'launch', 'exec', '--home', home], TMUX_TIMEOUT_MS)
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
      event('launch.session.started')
      // The stop came while the session was still coming up, so stop's own kill found nothing to end: end it here.
      // The next tick sees it gone and logs the stopped end.
      if (st.stopped) await deps.run([config.tmux, 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
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
    await new Promise<void>((r) => (deps.stop?.aborted ? r() : deps.stop?.addEventListener('abort', () => r(), { once: true })))
    stopTick()
    await lane
    // The session dies with its supervisor (design § 3.3, AC-27).
    await deps.run([config.tmux, 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
    event('launcher.stopped')
  } finally {
    lock!.release()
  }
}

// ── status, stop, start, uninstall ──

async function status(o: Opts, deps: LaunchDeps) {
  const home = homeOf(deps, o.opt.home)
  const { dir, config } = installed(home)
  const unit = unitOf(deps, home)
  const name = sessionName(config.crew, config.handle)
  deps.out(`service: ${await serviceState(deps, unit)}${unit ? ` (${unit.label})` : ''}`)
  deps.out(`plugin: ${config.plugin}${existsSync(join(config.plugin, 'cli', 'cmdr-agent.ts')) ? '' : ' (plugin-moved: run cmdr-agent launch install again)'}`)
  const st = readStateFile(dir)
  const up = await hasSession(deps, config.tmux, name)
  const now = (deps.now ?? Date.now)()
  const last = readEvents(dir).reverse().find((l) => / launch\.session\.(started|skipped|ended|failed)\b/.test(l)) ?? ''
  const session = up
    ? `running since ${st.lastStartAt ?? 'unknown'}`
    : st.stopped
      ? 'stopped (launch start to resume)'
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
  deps.out(`attach: tmux attach -t ${name}`)
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
  writeStateFile(dir, { ...readStateFile(dir), stopped })
  eventTo(deps, dir, deps.now ?? Date.now)('launcher.marked', {}, stopped ? 'stopped' : 'started')
  return { dir, config: config! }
}

async function stop(o: Opts, deps: LaunchDeps) {
  const { config } = mark(o, deps, true) // the mark first, so the tick that sees the end reads `stopped`
  const name = sessionName(config.crew, config.handle)
  await deps.run([config.tmux, 'kill-session', '-t', `=${name}`], TMUX_TIMEOUT_MS)
  deps.out(`stopped: ${name} (it stays stopped until cmdr-agent launch start)`)
}

function start(o: Opts, deps: LaunchDeps) {
  const { config } = mark(o, deps, false)
  deps.out(`started: the next tick starts ${sessionName(config.crew, config.handle)}`)
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

export const LAUNCH_USAGE = `usage: cmdr-agent launch <install|run|status|stop|start|uninstall> [args]

  install [--home <dir>] [--cwd <dir>] [--plugin <folder>]
                                       keep the key here and start the launcher as a login service
  run [--home <dir>]                   the launcher itself (the service runs it): keeps the agent's one session running
  status [--home <dir>]                the service, the session, and how to attach to it
  stop [--home <dir>]                  end the session and keep it ended (until start)
  start [--home <dir>]                 let the launcher start it again
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
    const flags = ['home', 'cwd', 'plugin']
    const o = parseArgs(rest, flags, ['all'])
    if (sub === 'install') await install(o, deps)
    else if (sub === 'run') await daemon(o, deps)
    else if (sub === 'exec') exec(o, deps)
    else if (sub === 'status') await status(o, deps)
    else if (sub === 'stop') await stop(o, deps)
    else if (sub === 'start') start(o, deps)
    else if (sub === 'uninstall') await uninstall(o, deps)
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
