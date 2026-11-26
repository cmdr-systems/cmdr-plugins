// cmdr-agent's verbs (the entry, cli/cmdr-agent.ts, checks the dependencies first, then imports this): the CLI face of agent-client (local-agents design § 3.3, S6, LOCAL-AGENTS-8; its contract is the agent-client
// API document's CLI table). A session with a shell talks to cmdr through it, as the plugin's MCP tools do, over the same
// library: one version by construction, no package.json of its own (design T-1, AC-31): run it as
// `bun <plugin>/cli/cmdr-agent.ts <verb> …`.
//
// Every verb needs CMDR_AGENT_KEY and CMDR_API_URL, checked first (AC-18); `link` and `unlink` also CMDR_STATE_DIR,
// where the plugin's hooks read the link. Every call has a 10 s budget; a read verb or `link` that meets a network error
// or a 5xx tries once more after 1 s (specifications § Error taxonomy). A refusal is one line on stderr,
// `refused: <reason>[: <detail>]`, cmdr.mc's own refusal carried verbatim under `server-refused`; the exit is 1, and 0
// only on success. When CMDR_STATE_DIR is set, each refusal and each link change is a line in its events.log (no message
// text). No verb touches a repository.
//
// What it shows from someone outside the crew's people is withheld, as the plugin's read_history withholds it:
// admission is agent-client's Hearing, the same code the plugin hears with.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, Me, Message, Person } from '../agent-client/index.js'
import { ADMITTED_BOTS, clearLink, Hearing, Link, McClient, Mode, Session, SessionRefused, type SessionScope } from '../agent-client/index.js'
import { ACTIVITY_SOCK_FILE, probeSocket } from '../state-dir.js'
// The plugin's one check on a file to send (a secret's path refused, through any link; size): called, not copied.
import { MAX_FILES, readToSend } from '../files.js'

export const CLI_TIMEOUT_MS = 10_000
export const RETRY_AFTER_MS = 1_000
const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{1,39}$/
const UUID = /^[0-9a-f-]{36}$/

export const USAGE = `usage: cmdr-agent <verb> [args]

  me                                   who this key is, as JSON
  conversations                        where you can speak, with unread counts
  history <chat> [--thread <id>] [--limit <n>]
  reply <chat> <text> [--thread <id>] [--file <path>]…
                                       post (up to 10 files); prints the message's link
  react <chat> <message> <emoji> [--remove]
  search <words…> [--project <key>] [--task <KEY>] [--limit <n>]
  tasks <project>                      a project's tasks
  task <KEY>                           one task, e.g. checkout-12
  offers                               your pending work offers
  respond <offer> accept|decline [reason]   a decline says why
  waiting <on> <what> [--task <KEY>] | waiting --clear
  link <project> [<n>]                 mirror this terminal to a task's channel, or with no <n> the project's
  unlink                               stop mirroring
  listen [--since <iso>] [--scope main|launcher|<conversationId>]
                                       print each message for you as a <channel …> line, until interrupted; it
                                       declares its scope first (main unless told), as a session does
  sessions                             your live sessions: scope, channel, since
  home pull|push|release --cwd <dir> [--machine-file <path>]
                                       the agent's home (agent home sync § 3.4), for a box: pull before a start,
                                       push each round, push and release on a clean stop; prints counts only
  launch install|run|status|stop|start|uninstall …
                                       the session launcher: a login service that keeps one session of yours
                                       running, until you stop it (cmdr-agent launch --help)

env: CMDR_API_URL, CMDR_AGENT_KEY (every verb but launch, whose own --help says); CMDR_STATE_DIR (link, unlink: a live session's directory); CMDR_APP_URL (links, optional)
A refusal is one line on stderr, "refused: <reason>", and exit 1.`

/** `cmdr-agent home push`'s exit when the home moved under another machine: restart the agent (design 0.1.17, H-23). */
export const HOME_MOVED_EXIT = 3

export const VERBS = ['me', 'conversations', 'history', 'reply', 'react', 'search', 'tasks', 'task', 'offers', 'respond', 'waiting', 'link', 'unlink', 'listen', 'sessions', 'home', 'launch'] as const
export type Verb = (typeof VERBS)[number]

/** The socket the listen verb needs: socket.io's, or a test's. */
export type ListenSocket = { on(event: string, fn: (...a: any[]) => void): unknown; off?(event: string, fn: (...a: any[]) => void): unknown; emit?(event: string, data: unknown): unknown; close(): unknown }

export type CliDeps = {
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  fetch?: typeof fetch
  socketOf?: (client: McClient) => ListenSocket
  /** listen ends when this aborts (SIGINT/SIGTERM in main). */
  stop?: AbortSignal
  /** The retry's wait; tests pass a fast one. */
  sleep?: (ms: number) => Promise<void>
  /** Whether a live session answers at this state directory's socket (link, unlink: `state-dir-idle`); tests pass one. */
  probeStateDir?: (dir: string) => Promise<boolean>
  /** How long listen waits for cmdr.mc to answer its declaration (agent-client's SESSION_DECLARE_TIMEOUT_MS by default). */
  declareTimeoutMs?: number
  /** launch's edges, over the real ones (tests: a fake tmux, a fake service manager, a fake socket). */
  launch?: Partial<import('./launch.js').LaunchDeps>
}

/** listen's --scope, read as the closed set (sessions design § 3.5). */
const scopeArg = (v: string | undefined): SessionScope | null => (v === undefined || v === 'main' ? { scope: 'main' } : v === 'launcher' ? { scope: 'launcher' } : UUID.test(v) ? { scope: 'linked', conversationId: v } : null)
/** A live session answers at the directory, or link and unlink would write where nothing reads (sessions design § 3.4). */
const liveSessionAt = async (deps: CliDeps, dir: string) => {
  if (!(await (deps.probeStateDir ?? ((d: string) => probeSocket(join(d, ACTIVITY_SOCK_FILE))))(dir))) refuse('state-dir-idle', `no live session answers in ${dir}: start one there, or point CMDR_STATE_DIR at a running session's directory`)
}

/** A refusal: its reason, then what to do about it. */
class Refusal extends Error {
  constructor(
    readonly reason: string,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}
const refuse = (reason: string, detail?: string): never => {
  throw new Refusal(reason, detail)
}

/** cmdr.mc's refusal (agent-client's apiError line: `<status> <code>: <message>`), or none. */
const statusOf = (e: unknown): number | null => {
  const m = /^(\d{3}) /.exec(e instanceof Error ? e.message : '')
  return m ? Number(m[1]) : null
}
/** Network trouble or a 5xx: worth one more try on a read (specifications § Error taxonomy). */
const transient = (e: unknown) => {
  const s = statusOf(e)
  return s === null ? !(e instanceof Refusal) : s >= 500
}

/** `--flag value` pairs out of argv (`bools` take no value); the rest stay positional. A flag given twice: `opt` holds
 *  the last, `all` every one (`--file`). */
export function parseArgs(argv: string[], flags: readonly string[], bools: readonly string[] = []): { pos: string[]; opt: Record<string, string>; all: Record<string, string[]>; on: Set<string> } {
  const pos: string[] = []
  const opt: Record<string, string> = {}
  const all: Record<string, string[]> = {}
  const on = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (bools.includes(name)) {
        on.add(name)
        continue
      }
      if (!flags.includes(name)) refuse('usage', `unknown flag ${a}`)
      const v = argv[++i]
      if (v === undefined || v === '') refuse('usage', `${a} needs a value`)
      opt[name] = v!
      ;(all[name] ??= []).push(v!)
    } else pos.push(a)
  }
  return { pos, opt, all, on }
}

/** A task key as typed, `checkout-12` or `CHECKOUT-12`: the number is after the LAST dash, so a project key that itself
 *  ends in `-<digits>` still reads right (`app-2-14` is app-2's task 14). design D-2. */
export function taskKey(s: string): { project: string; n: number } | null {
  const m = /^(.+)-(\d{1,9})$/.exec(s.trim().toLowerCase())
  return m && PROJECT_KEY.test(m[1]!) ? { project: m[1]!, n: Number(m[2]) } : null
}

/** cmdr.app's address for links: CMDR_APP_URL, else CMDR_API_URL with its api. host as app. (the plugin's server.ts). */
export function appOf(env: CliDeps['env']): string | null {
  const set = (env.CMDR_APP_URL ?? '').trim().replace(/\/+$/, '')
  if (set) return set
  try {
    const u = new URL(env.CMDR_API_URL ?? '')
    if (!u.hostname.startsWith('api.')) return null
    u.hostname = `app.${u.hostname.slice(4)}`
    return u.origin
  } catch {
    return null
  }
}

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** One line, whatever the body holds: newlines as `\n`, a backslash doubled, so a reader splits on lines safely. */
const oneLine = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n')

/** How a conversation reads (the plugin's `where`). */
export function whereOf(c: Conversation, me: { id: string }): string {
  if (c.kind === 'channel') return `#${c.label ?? c.slot}${c.href ? ` (${c.href})` : ''}`
  const others = c.participants.filter((p) => !(p.kind === 'agent' && p.id === me.id)).map((p) => p.name)
  return c.kind === 'private' ? `private with ${others.join(', ')}` : `group ${c.label ? `#${c.label} ` : ''}with ${others.join(', ')}`
}

/** An inbound message as the session reads it: the plugin's channel meta as a `<channel …>` tag, the body inside, one line. */
export function channelLine(c: Conversation, m: Message, role: string, me: { id: string }): string {
  const meta: [string, string][] = [
    ['source', 'cmdr'],
    ['chat_id', c.id],
    ['conversation', whereOf(c, me)],
    ['user', m.author?.name ?? 'someone'],
    ['user_id', m.author?.id ?? ''],
    ['user_kind', m.author?.kind ?? 'user'],
    ['user_role', role],
    ['message_id', m.id],
    ['ts', m.createdAt],
    ...(m.threadRootId ? ([['thread_id', m.threadRootId]] as [string, string][]) : []),
  ]
  return `<channel ${meta.map(([k, v]) => `${k}="${attr(v)}"`).join(' ')}>${oneLine(m.body)}</channel>`
}

/** A message as history and search print it, with its reactions; withheld when its author isn't admitted (the plugin's read_history). */
const messageLine = (m: Message, role: string | null, me: { id: string }) => {
  const mine = m.author?.kind === 'agent' && m.author.id === me.id
  const who = `${m.author?.name ?? 'someone'}${role && !mine ? ` (${role})` : ''}`
  const replies = m.thread ? ` (${m.thread.replyCount} ${m.thread.replyCount === 1 ? 'reply' : 'replies'}: --thread ${m.id})` : ''
  const shown = mine || role
  const reacted = shown && m.reactions?.length ? ` [${m.reactions.map((r) => `${r.emoji} ${r.count}`).join(' ')}]` : ''
  return `[${m.createdAt} · ${m.id}] ${who}: ${shown ? oneLine(m.body) : "[withheld: not one of this crew's people]"}${reacted}${replies}`
}

type Task = { key: string; title: string; status: string; assignee?: { name?: string; handle?: string } | null; wsjf?: number | null; ready?: boolean }
type Offer = { id: string; task: { key: string; title: string } | null; status: string; reason: string | null; expiresAt: string }

/** One line in `<CMDR_STATE_DIR>/events.log` (the plugin's idiom), when there is one: never a message's text. */
const eventOf = (env: CliDeps['env']) => (tag: string) => {
  const dir = env.CMDR_STATE_DIR?.trim()
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, 'events.log'), `${new Date().toISOString()} ${tag}\n`)
  } catch {
    // Observability only: a state dir it can't write never fails the verb.
  }
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    ;(verb === undefined ? deps.err : deps.out)(USAGE)
    return verb === undefined ? 2 : 0
  }
  const event = eventOf(deps.env)
  try {
    if (!(VERBS as readonly string[]).includes(verb)) refuse('usage', `no verb ${verb} (cmdr-agent --help)`)
    // launch decides for itself where its key comes from: install from the environment, run, exec and status from the
    // launcher's home, stop, start and uninstall none (session launcher design 0.2.4 § 3.1, AC-17). Every other verb: below.
    if (verb === 'launch') {
      const { launch, realLaunchDeps } = await import('./launch.js')
      return launch(rest, { ...realLaunchDeps({ env: deps.env, out: deps.out, err: deps.err, fetch: deps.fetch, stop: deps.stop }), ...deps.launch })
    }
    // The key first, for every verb but launch (AC-18, narrowed by the session launcher's AC-17), before any argument is read.
    let client: McClient
    try {
      client = McClient.create({ apiUrl: deps.env.CMDR_API_URL ?? '', key: deps.env.CMDR_AGENT_KEY ?? '', timeoutMs: CLI_TIMEOUT_MS, fetch: deps.fetch })
    } catch (e) {
      const [reason, ...detail] = String((e as Error).message).split(': ')
      return refuse(reason!, detail.join(': ') || undefined)
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    /** A read (or link): once more after 1 s on network trouble or a 5xx, then as it came. */
    const retrying = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f()
      } catch (e) {
        if (!transient(e)) throw e
        await sleep(RETRY_AFTER_MS)
        return f()
      }
    }
    await verbs[verb as Exclude<Verb, 'launch'>](rest, { client, deps, retrying, event })
    return 0
  } catch (e) {
    // `home push` meeting a moved home (design 0.1.17): its own exit code, which the box's push timer acts on.
    if (e instanceof Error && e.message === 'home-moved') return HOME_MOVED_EXIT
    const line = e instanceof Refusal ? e.message : statusOf(e) !== null ? `server-refused: ${(e as Error).message}` : `unreachable: ${(e as Error)?.message ?? String(e)}`
    event(`agent-client.refused reason=${line.split(':')[0]}`)
    deps.err(`refused: ${line}`)
    return 1
  }
}

type Ctx = { client: McClient; deps: CliDeps; retrying: <T>(f: () => Promise<T>) => Promise<T>; event: (tag: string) => void }

/** Admission over this key's crew: who the CLI shows a body from (the plugin's Admission, through Hearing). */
const hearingFor = ({ client, deps }: Ctx, me: Me) => Hearing.create(me, () => client.people() as Promise<Person[]>, { log: (l) => deps.err(`cmdr-agent: ${l}`), bots: [...ADMITTED_BOTS] })

const stateDir = (env: CliDeps['env']): string => {
  const d = Mode.stateDir(env)
  return typeof d === 'string' ? d : refuse(d.refused, 'set CMDR_STATE_DIR (the connect snippet does): the directory the plugin reads the link from')
}

/** Who this key is, refusing a doc agent (`platform-agent`): it never runs this module. */
const meOf = async (ctx: Ctx): Promise<Me> => {
  const me = await ctx.retrying(() => ctx.client.me())
  const mode = Mode.of(me)
  return typeof mode === 'string' ? me : refuse(mode.refused)
}

const verbs: Record<Exclude<Verb, 'launch'>, (a: string[], ctx: Ctx) => Promise<void>> = {
  async me(_a, ctx) {
    ctx.deps.out(JSON.stringify(await meOf(ctx), null, 2))
  },

  async conversations(_a, ctx) {
    const me = await meOf(ctx)
    const all = await ctx.retrying(() => ctx.client.conversations())
    ctx.deps.out(all.map((c) => `${c.id}  ${whereOf(c, me)}${c.unread ? `  (${c.unread} unread)` : ''}`).join('\n') || '(no conversations)')
  },

  async history(a, ctx) {
    const { pos, opt } = parseArgs(a, ['thread', 'limit'])
    const [chat] = pos
    if (!chat || pos.length > 1) refuse('usage', 'history <chat> [--thread <id>] [--limit <n>]')
    const limit = Math.max(1, Math.min(100, Number(opt.limit ?? 20) || 20))
    const me = await meOf(ctx)
    const msgs = await ctx.retrying(() => (opt.thread ? ctx.client.thread(chat!, opt.thread, limit).then((t) => [t.root, ...t.replies]) : ctx.client.history(chat!, limit)))
    const { roleOf } = hearingFor(ctx, me)
    const lines = await Promise.all(msgs.map(async (m) => messageLine(m, await roleOf(m.author), me)))
    ctx.deps.out(lines.join('\n') || '(no messages)')
  },

  async reply(a, { client, deps }) {
    const { pos, opt, all } = parseArgs(a, ['thread', 'file'])
    const [chat, ...words] = pos
    const text = words.join(' ').trim()
    const paths = all.file ?? []
    if (!chat || (!text && !paths.length)) refuse('usage', 'reply <chat> <text> [--thread <id>] [--file <path>]…')
    if (paths.length > MAX_FILES) refuse('usage', `up to ${MAX_FILES} files`)
    // Every file read and checked before any is uploaded: one that can't go, and nothing leaves this machine.
    const ready: { name: string; data: Uint8Array }[] = []
    for (const p of paths) ready.push(await readToSend(p).catch((e: Error) => refuse('file-refused', e.message)))
    const attachmentIds: string[] = []
    for (const f of ready) attachmentIds.push((await client.attach(chat!, f.name, f.data)).id)
    // A thread id cmdr.mc doesn't know is its 404, carried verbatim (AC-18): nothing is checked here first. Never
    // retried: a post that timed out may have landed.
    const m = await client.post(chat!, text, { threadRootId: opt.thread ?? null, attachmentIds })
    const app = appOf(deps.env)
    deps.out(app ? `${app}/m/${m.id}` : m.id)
  },

  async react(a, { client, deps }) {
    const { pos, on } = parseArgs(a, [], ['remove'])
    const [chat, msg, emoji, ...more] = pos
    if (!chat || !msg || !emoji || more.length) refuse('usage', 'react <chat> <message> <emoji> [--remove]')
    const r = await client.react(chat!, msg!, emoji!, on.has('remove'))
    deps.out(r.reactions.map((x) => `${x.emoji} ${x.count}`).join(' ') || '(no reactions)')
  },

  async search(a, ctx) {
    const { pos, opt } = parseArgs(a, ['project', 'task', 'limit'])
    const q = pos.join(' ').trim()
    if (!q) refuse('usage', 'search <words…> [--project <key>] [--task <KEY>] [--limit <n>]')
    const qs = new URLSearchParams({ q })
    if (opt.project) qs.set('project', opt.project)
    if (opt.task) {
      const t = taskKey(opt.task)
      qs.set('task', t ? `${t.project}/${t.n}` : opt.task)
    }
    if (opt.limit) qs.set('limit', String(Math.max(1, Math.min(100, Number(opt.limit) || 20))))
    const me = await meOf(ctx)
    const { hits } = await ctx.retrying(() => ctx.client.search(qs))
    const { roleOf } = hearingFor(ctx, me)
    const lines = await Promise.all(hits.map(async (h) => `${h.conversation.id} ${h.conversation.name ?? ''} ${messageLine(h, await roleOf(h.author), me)}`))
    ctx.deps.out(lines.join('\n') || '(no matches)')
  },

  async tasks(a, { client, deps, retrying }) {
    const [project, ...more] = a
    if (!project || more.length || !PROJECT_KEY.test(project)) refuse('usage', 'tasks <project> (a project key, lowercase)')
    const all = await retrying(() => client.api<Task[]>(`/agent/projects/${project}/tasks`))
    deps.out(all.map((t) => `${t.key} [${t.status}] ${t.title} — ${t.assignee?.handle ? `@${t.assignee.handle}` : (t.assignee?.name ?? 'unassigned')} · ${t.wsjf != null ? `wsjf ${t.wsjf}` : 'unscored'}${t.ready ? ' · ready' : ''}`).join('\n') || '(no tasks)')
  },

  async task(a, { client, deps, retrying }) {
    const t = a.length === 1 ? taskKey(a[0]!) : null
    if (!t) refuse('usage', 'task <KEY>, e.g. checkout-12')
    deps.out(JSON.stringify(await retrying(() => client.api<unknown>(`/agent/projects/${t!.project}/tasks/${t!.n}`)), null, 2))
  },

  async offers(_a, { client, deps, retrying }) {
    const all = await retrying(() => client.api<Offer[]>('/agent/crew/offers?status=pending'))
    deps.out(all.map((o) => `${o.id} ${o.task ? `${o.task.key} ${o.task.title}` : 'work (no task named)'} · ${o.status} · expires ${o.expiresAt}`).join('\n') || '(no pending offers)')
  },

  async respond(a, { client, deps }) {
    const [id, answer, ...why] = a
    const reason = why.join(' ').trim()
    if (!id || !UUID.test(id) || (answer !== 'accept' && answer !== 'decline')) refuse('usage', 'respond <offer> accept|decline [reason]')
    if (answer === 'decline' && !reason) refuse('usage', 'a decline says why: respond <offer> decline <reason>')
    const o = await client.api<Offer>(`/agent/crew/offers/${id}/respond`, { method: 'POST', body: { accept: answer === 'accept', ...(reason ? { reason: reason.slice(0, 500) } : {}) } })
    deps.out(`${o.status}: ${o.task ? o.task.key : o.id}`)
  },

  async waiting(a, { client, deps }) {
    const { pos, opt, on } = parseArgs(a, ['task'], ['clear'])
    if (on.has('clear')) {
      if (pos.length || opt.task) refuse('usage', 'waiting --clear takes nothing else')
      await client.api('/agent/crew/waiting', { method: 'DELETE' })
      deps.out('not waiting')
      return
    }
    const [who, ...what] = pos
    const w = what.join(' ').trim()
    if (!who || !w) refuse('usage', 'waiting <on> <what> [--task <KEY>] | waiting --clear')
    await client.api('/agent/crew/waiting', { method: 'POST', body: { on: who, what: w, ...(opt.task ? { task: opt.task } : {}) } })
    deps.out(`waiting on ${who}: ${w}`)
  },

  async link(a, ctx) {
    const [project, n, ...more] = a
    // Two arguments, never one key: a project key may end in -<digits> (D-2). Refused before any call (bad-ref).
    if (!project || more.length || !PROJECT_KEY.test(project) || (n !== undefined && !/^\d{1,9}$/.test(n))) refuse('bad-ref', 'link <project> [<n>]: a project key, and a task number for its task')
    const dir = stateDir(ctx.deps.env)
    await liveSessionAt(ctx.deps, dir)
    const me = await meOf(ctx)
    // One rule in both faces (design 0.1.13, PD-15 b): a box agent has no operator and no terminal turn to mirror. The
    // plugin's link_terminal refuses it with the same words (channel.ts).
    if (Mode.of(me) !== 'external') refuse('not-external', 'Only a local agent links its terminal.')
    const link = await ctx.retrying(() => Link.of({ stateDir: dir, api: ctx.client.api, me }).set(n === undefined ? { kind: 'project', project: project! } : { kind: 'task', project: project!, n: Number(n) }))
    if (!link) refuse('bad-ref', `${project} is not a project this agent can see`)
    ctx.event(`agent-client.link.set kind=${link!.kind}`)
    ctx.deps.out(`linked to ${link!.label} (${link!.conversationId}): while linked, the terminal's prompts and answers are posted there`)
  },

  async unlink(_a, { deps, event }) {
    const dir = stateDir(deps.env)
    await liveSessionAt(deps, dir)
    if (!clearLink(dir)) refuse('not-linked')
    event('agent-client.link.cleared')
    deps.out('unlinked')
  },

  async listen(a, ctx) {
    const { pos, opt } = parseArgs(a, ['since', 'scope'])
    const scope = scopeArg(opt.scope)
    if (pos.length || !scope || (opt.since !== undefined && Number.isNaN(Date.parse(opt.since)))) refuse('usage', 'listen [--since <iso>] [--scope main|launcher|<conversationId>]')
    const { client, deps } = ctx
    const me = await meOf(ctx)
    const { hears, roleOf } = hearingFor(ctx, me)
    const conversations = new Map<string, Conversation>()
    const refresh = async () => {
      for (const c of await ctx.retrying(() => client.conversations())) conversations.set(c.id, c)
    }
    await refresh()
    /** Printed once: a message seen in the catch-up and again live is one line. */
    const printed = new Set<string>()
    const hand = async (c: Conversation, m: Message) => {
      if (printed.has(m.id) || !hears(c, m)) return
      const role = await roleOf(m.author)
      if (!role) return
      printed.add(m.id)
      deps.out(channelLine(c, m, role, me))
      await client.read(c.id).catch((err) => deps.err(`cmdr-agent: marking ${c.id} read failed: ${err}`))
    }
    // The socket first, so nothing posted during the catch-up is missed; its messages wait in the lane behind it.
    const socket = (deps.socketOf ?? ((c) => c.socket() as unknown as ListenSocket))(client)
    // Its scope is declared before anything is printed (AC-9): the lane waits on the first declaration, and a refusal
    // ends listen. Declared again on every later `ready` (a reconnect), never otherwise (sessions design § 5).
    let first = true
    // cmdr.mc refuses a connection with an `error` event, then closes it (`session-limit`, a revoked key): said verbatim,
    // and listen ends non-zero, whether it comes before the declaration or after (S10-1).
    let serverRefusal: string | null = null
    let endListen: () => void = () => {}
    const ended = new Promise<void>((r) => (endListen = r))
    const declared = new Promise<void>((resolve, reject) => {
      socket.on('error', (e: { message?: string } | undefined) => {
        serverRefusal = String(e?.message ?? 'refused')
        reject(new SessionRefused(serverRefusal))
        endListen()
      })
      socket.on('ready', () => {
        const was = first
        first = false
        Session.scope(socket, scope!, { timeoutMs: deps.declareTimeoutMs })
          .then(() => was && resolve())
          .catch((e) => (was ? reject(e) : deps.err(`cmdr-agent: declaring the session again failed: ${e instanceof SessionRefused ? e.reason : e}`)))
      })
    })
    // Nothing is handed on until the declaration is answered; a refusal is said below, and nothing is printed.
    let lane: Promise<void> = declared.catch(() => new Promise<void>(() => {}))
    const inLane = (f: () => Promise<void>) => {
      lane = lane.then(f).catch((err) => deps.err(`cmdr-agent: inbound failed: ${err}`))
      return lane
    }
    if (opt.since) {
      const since = Date.parse(opt.since)
      void inLane(async () => {
        // What came since, oldest first: each conversation's latest 100 (a thread reply arrives in its conversation's).
        const all: [Conversation, Message][] = []
        for (const c of conversations.values()) for (const m of await ctx.retrying(() => client.history(c.id, 100))) if (Date.parse(m.createdAt) > since) all.push([c, m])
        all.sort((x, y) => Date.parse(x[1].createdAt) - Date.parse(y[1].createdAt))
        for (const [c, m] of all) await hand(c, m)
      })
    }
    // One at a time, in arrival order (the plugin's lane): a lookup never lets the next message overtake.
    socket.on('message:new', (e: { conversationId: string; message: Message }) =>
      inLane(async () => {
        if (!conversations.has(e.conversationId)) await refresh().catch(() => {})
        const c = conversations.get(e.conversationId)
        if (c) await hand(c, e.message)
      }),
    )
    socket.on('connect_error', (e: Error) => deps.err(`cmdr-agent: socket: ${e.message}`))
    const refusedAs = (reason: string) => (reason === 'session-limit' ? refuse('session-limit', 'this agent already has as many live sessions as cmdr allows: end one') : serverRefusal ? refuse('server-refused', reason) : refuse(reason, "cmdr.mc didn't accept this listen's scope"))
    await declared.catch((e) => {
      socket.close()
      refusedAs(e instanceof SessionRefused ? e.reason : 'session-refused')
    })
    await Promise.race([
      ended,
      new Promise<void>((resolve) => {
        if (deps.stop?.aborted) return resolve()
        deps.stop?.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
    if (serverRefusal) {
      socket.close()
      refusedAs(serverRefusal)
    }
    await lane
    socket.close()
  },

  async sessions(_a, ctx) {
    const me = (await meOf(ctx)) as Me & { sessions?: { scope: string; conversationId?: string; label?: string; since: string }[] }
    const all = me.sessions ?? []
    ctx.deps.out(all.map((s) => `${s.scope}${s.scope === 'linked' ? `  #${s.label ?? s.conversationId}` : ''}  since ${s.since}`).join('\n') || '(no sessions)')
  },
  // The box's half of agent home sync (design 0.1.9 § 2, AC-7, AC-12): the same pull, push and release the Mac
  // launcher runs in-process. Each call takes or renews this machine's lease first (the same machine gets the same
  // lease back). Prints counts, never a path or content.
  home: async (a, ctx) => {
    const p = parseArgs(a, ['cwd', 'machine-file'])
    const step = p.pos[0]
    if (p.pos.length !== 1 || !['pull', 'push', 'release'].includes(step!)) refuse('usage', 'home pull|push|release --cwd <dir> [--machine-file <path>]')
    const cwd = p.opt.cwd ?? refuse('usage', '--cwd <dir>: the agent\'s working directory')
    const { machine } = await import('../home/machine.js')
    const home = await import('../home/home-sync.js')
    const m = p.opt['machine-file'] ? machine(p.opt['machine-file']) : machine()
    const hctx = { client: ctx.client, machine: m, cwd, memoryDir: home.memoryDirOf(cwd, ctx.deps.env as NodeJS.ProcessEnv), fetch: ctx.deps.fetch }
    if (step === 'pull') {
      const r = await home.pull(hctx)
      ctx.deps.out(`pulled: revision ${r.revision}, ${r.fetched} fetched, ${r.deleted} deleted, ${r.conflicts} set aside`)
      return
    }
    const { leaseId } = await ctx.client.homeLease(m)
    if (step === 'push') {
      let r
      try {
        r = await home.push(hctx, leaseId)
      } catch (e) {
        if (!(e instanceof home.HomeMoved)) throw e
        // The home moved while this box didn't hold it (H725-5). A pull never runs under a live session (design 0.1.17,
        // H-23): nothing is pushed, and the exit code (HOME_MOVED_EXIT) asks the push timer's privileged post step to
        // restart the agent's unit, whose ExecStopPost releases and ExecStartPre pulls.
        ctx.deps.out('home moved: nothing pushed; the agent restarts so its start pulls')
        throw e
      }
      let put = r.put
      let deleted = r.deleted
      while (r.more) {
        r = await home.push(hctx, leaseId)
        put += r.put
        deleted += r.deleted
      }
      ctx.deps.out(`pushed: ${put} changed, ${deleted} deleted`)
      return
    }
    const r = await home.release(hctx, leaseId)
    ctx.deps.out(`released${r.pushed ? `: ${r.pushed.put} changed, ${r.pushed.deleted} deleted` : ''}`)
  },
}

