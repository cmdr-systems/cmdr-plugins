#!/usr/bin/env bun
// cmdr channel for Claude Code: the agent's conversations on cmdr's own
// surface (cmdr.mc), the native counterpart of ../slack. A stdio MCP server
// with the `claude/channel` capability:
//
//   inbound   messages the agent should hear arrive in the session as
//             <channel source="cmdr" chat_id="…" conversation="…" user="…">,
//             pushed live from cmdr.mc's /conversations socket
//   outbound  the agent answers with the `reply` tool; its transcript never
//             reaches anyone
//
// What it hears: every message in its private and group conversations; in
// every channel, its crew's general channel too, anything that @-mentions
// it. Never its own messages. On start it catches up on what arrived while
// it was away (its unread), and whatever it's handed counts as read. The
// session opens with the `startup` wake, before any of it (channel.ts).
//
// Its one credential is its own cmdr.mc key (scope messages:rw), so it sees
// exactly what cmdr.mc lets that agent see: its crew's channels and its own
// conversations, never the organization's people-only channels.
//
//   CMDR_API_URL          cmdr.mc, e.g. https://api.cmdr.it
//   CMDR_AGENT_KEY        the agent's key (cmdr.mc: pnpm agent:key:local <crew> <agent>)
//   CMDR_STATE_DIR        the plugin's state dir (events.log; activity.state,
//                         the session's idle/working for the machine; the
//                         witness files when CREW_HEALTH_DIR is unset).
//                         Default ~/.claude/channels/cmdr
//   CREW_HEALTH_DIR       the per-agent witness export dir, when provisioning
//                         renders it (heartbeat · model-progress · delivered)
//   CMDR_AGENT_ARCHETYPE  the assembler's archetype, the fallback (the queue's and
//                         offers') when cmdr.mc's /agent/me carries none
//   CMDR_APP_URL          cmdr.app, for links to messages (<url>/m/<message_id>).
//                         Default: CMDR_API_URL with its api. host as app.
//                         (https://api.cmdr.it → https://app.cmdr.it); neither, no links
//
// This file is only the wiring of real edges (env, fetch, socket.io, stdio);
// the behavior lives in channel.ts, beats.ts and wake-gate.ts.
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startChannel, type Api } from './channel.js'
import { McClient } from './agent-client/client.js'
import type { Attachment, FileTransport } from './files.js'
import { MODE_FILE } from './mode.js'
import { standDown } from './stand-down.js'
import { ACTIVITY_SOCK_FILE, claimStateDir, realClaimDeps, StateDirInUse } from './state-dir.js'

const API = (process.env.CMDR_API_URL ?? '').replace(/\/+$/, '')
const KEY = (process.env.CMDR_AGENT_KEY ?? '').trim()
if (!API || !KEY) {
  process.stderr.write('cmdr channel: set CMDR_API_URL and CMDR_AGENT_KEY\n')
  process.exit(1)
}

// The state dir, Slack's SLACK_STATE_DIR rule: the env var when set (the
// assembler renders `<agentStateDir>/cmdr`), else the per-user default. The
// witness dir is CREW_HEALTH_DIR when declared (the canonical home every
// cross-uid health reader looks in, design 0.3.5), else the state dir:
// exactly ../slack/server.ts's WITNESS_DIR.
// cmdr.app, where a link to a message opens: set, or cmdr.mc's own address with api. as app.
const APP = (process.env.CMDR_APP_URL ?? '').trim().replace(/\/+$/, '') || appOf(API)
function appOf(api: string): string | undefined {
  try {
    const u = new URL(api)
    if (!u.hostname.startsWith('api.')) return undefined
    u.hostname = `app.${u.hostname.slice(4)}`
    return u.origin
  } catch {
    return undefined
  }
}

const STATE_DIR_SET = !!(process.env.CMDR_STATE_DIR ?? '').trim()
const STATE_DIR = (process.env.CMDR_STATE_DIR ?? '').trim() || join(homedir(), '.claude', 'channels', 'cmdr')
const WITNESS_DIR = (process.env.CREW_HEALTH_DIR ?? '').trim() || STATE_DIR
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

const log = (line: string) => process.stderr.write(`cmdr channel: ${line}\n`)

// Lifecycle stamps beside the state, the same events.log idiom as Slack's
// logMcpLifecycle. Observability only: never throws into the protocol path.
function stamp(tag: string): void {
  try {
    appendFileSync(join(STATE_DIR, 'events.log'), `${new Date().toISOString()} ${tag}\n`)
  } catch {}
}
stamp(`server_started pid=${process.pid}`)

// agent-client's McClient (local-agents S5): the same request as before, no timeout unless a call names one (R-12, PD-9).
const client = McClient.create({ apiUrl: API, key: KEY })
const api: Api = client.api

// Files (files.ts): uploads as multipart, downloads as bytes, the same key.
const files: FileTransport = {
  async upload(path, name, data) {
    const form = new FormData()
    form.set('file', new Blob([data]), name)
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'X-Cmdr-Api-Key': KEY, Accept: 'application/json' }, body: form })
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: Attachment; error?: { message?: string } }
    if (!res.ok || json.success === false || !json.data) throw new Error(`${res.status} ${json.error?.message ?? res.statusText}`)
    return json.data
  },
  async download(path) {
    const res = await fetch(`${API}${path}`, { headers: { 'X-Cmdr-Api-Key': KEY } })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return new Uint8Array(await res.arrayBuffer())
  },
}

// Set once the hooks' socket is listening.
let hooksListening = false
// The channel, once startChannel returns (the hooks' server may be bound before that: the claim below).
let channel: Awaited<ReturnType<typeof startChannel>> | null = null
const ACTIVITY_SOCK = join(STATE_DIR, ACTIVITY_SOCK_FILE)

// The session's hooks (hooks/hooks.json → hook.ts) hand their steps here, on
// a socket only this agent's user can open: what it's doing, for its
// conversation (channel.activity), and what needs permission
// (channel.permission). Best effort: without it, no activity, and permission
// requests are refused (hook.ts).
async function hooksFetch(req: Request): Promise<Response> {
  // Bound before startChannel returns in external mode (the claim, state-dir.ts): until the channel exists, not yet.
  if (!channel) return new Response(null, { status: 503 })
  const body = await req.json().catch(() => null)
  // An answer the session never sent (hook.ts): posted as the agent; 204 once cmdr.mc has it.
  if (new URL(req.url).pathname === '/unsent') return new Response(null, { status: (await channel.postUnsent(body)) ? 204 : 502 })
  // The turn's end (hook.ts): whether to hold it open, telling the agent to carry on.
  if (new URL(req.url).pathname === '/stop') return Response.json(await channel.stopCheck(body))
  // A turn's prompt and its final text (hook.ts): who opened it; a local agent's linked terminal, mirrored.
  if (new URL(req.url).pathname === '/prompt') return Response.json(await channel.prompt(body))
  if (new URL(req.url).pathname === '/answer') {
    await channel.answer(body)
    return new Response(null, { status: 204 })
  }
  // A permission request (hook.ts): asked on a card, answered at once.
  if (new URL(req.url).pathname === '/permission') return Response.json(await channel.permission(body))
  // A compaction about to run (hook.ts PreCompact): told to cmdr.mc; held off only on its word (BUGS-9).
  if (new URL(req.url).pathname === '/compacting') return Response.json(await channel.compacting(body))
  // How full its context is (statusline.ts): told to cmdr.mc.
  if (new URL(req.url).pathname === '/context') {
    await channel.context(body)
    return new Response(null, { status: 204 })
  }
  channel.activity(body)
  return new Response(null, { status: 204 })
}
const serveHooks = (sock: string) => {
  const server = Bun.serve({ unix: sock, fetch: hooksFetch })
  chmodSync(sock, 0o600)
  hooksListening = true
  stamp('activity_listening')
  return server
}

// A refusal at start (a doc agent; a local agent without CMDR_STATE_DIR) is said and the process ends: no socket
// was opened (local-agents design § 3.3). Except `state-dir-in-use`: another session holds this agent's directory, and
// this one stands down (stand-down.ts, LOCAL-AGENTS-41) rather than fail, since Claude Code caches a failure for the
// folder and would skip the agent's own next session.
const transport = new StdioServerTransport()
const started = await startChannel({
  api,
  files,
  inboxDir: join(STATE_DIR, 'inbox'),
  openSocket: () => {
    const s = client.socket()
    return Object.assign(s, {
      out: (event: string, data: unknown) => s.emit(event, data),
      // Never buffered for a reconnect: a compaction can't wait for one.
      ask: (event: string, data: unknown, ms: number) => (s.connected ? s.timeout(ms).emitWithAck(event, data) : Promise.reject(new Error('not connected'))),
    })
  },
  transport,
  witnessDir: WITNESS_DIR,
  stateDir: STATE_DIR,
  stateDirSet: STATE_DIR_SET,
  // The conversation this session was started for (the launcher's; sessions design § 3.4): its scope is fixed there.
  sessionScope: process.env.CMDR_SESSION_SCOPE,
  // A local agent's session claims its state directory before any socket to cmdr.mc (local-agent sessions design
  // 0.1.6 § 3.4): the lock, one probe under it, then remove and bind. A refusal (`state-dir-in-use`) ends the start.
  claimStateDir: async () => {
    await claimStateDir(STATE_DIR, realClaimDeps(serveHooks))
  },
  activityStatePath: join(STATE_DIR, 'activity.state'),
  // A wake no turn started on is delivered again only when the hooks can tell us a turn started (wake-gate.ts).
  hooksListening: () => hooksListening,
  archetypeHint: process.env.CMDR_AGENT_ARCHETYPE,
  appUrl: APP,
  // The session's transcript, for its compactions (context.ts): read in pieces, from where the last read stopped.
  transcripts: {
    size: async (path) => (await stat(path)).size,
    read: async (path, from, length) => {
      const f = await open(path, 'r')
      try {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await f.read(buf, 0, length, from)
        return buf.subarray(0, bytesRead)
      } finally {
        await f.close()
      }
    },
  },
  log,
  stamp,
}).catch(async (e: unknown) => {
  if (e instanceof StateDirInUse) {
    await standDown({ transport, dir: e.dir, holder: e.holder, log, stamp })
    return null
  }
  process.stderr.write(`cmdr channel: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
// Standing down: the MCP server is up with no tools; nothing else here runs, and the process ends with Claude Code's.
if (!started) await new Promise<never>(() => {})
channel = started!

// Where it runs, for its hooks (mode.ts MODE_FILE): a local agent's hooks hand over its prompts and answers.
if (channel.mode === 'external') writeFileSync(join(STATE_DIR, MODE_FILE), 'external', { mode: 0o600 })
else rmSync(join(STATE_DIR, MODE_FILE), { force: true })

// A box's start (and a local agent's claim having bound already, above): the box removes and rebinds as it always has.
if (!hooksListening && channel.mode !== 'external') {
  try {
    rmSync(ACTIVITY_SOCK, { force: true })
    serveHooks(ACTIVITY_SOCK)
  } catch (e) {
    log(`activity socket: ${e}`)
  }
}
