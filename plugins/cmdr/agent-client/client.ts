// agent-client's McClient (local-agents design § 3.3; agent-client API `McClient`): the typed client of cmdr.mc's
// /agent/* routes and its /conversations socket, with the agent's own key. Moved from the plugin's server.ts (`api`) in
// S5: the request is byte-for-byte the one the plugin made, so the plugin's behaviour is unchanged (AC-17). A timeout
// applies only to a call that names one, or to every call when the client was created with one: the plugin creates it
// without (today's behaviour, design R-12, plan PD-9), the CLI (S6) with 10 s.
import { io } from 'socket.io-client'
import type { Attachment, Author, Conversation, Message, ReactionView } from './types.js'
import type { Person } from './hearing.js'

/** A cmdr.mc refusal as one line: `<status> <code>: <message>` (the plugin's tools say it as it is). */
export function apiError(status: number, statusText: string, error?: { message?: string; code?: string }): Error {
  // The message as before (callers parse `<status> <code>:`); the status, code and the refusal's own fields ride along
  // for those that need them (agent home: lease-held's machineName).
  return Object.assign(new Error(`${status} ${error?.code ? `${error.code}: ` : ''}${error?.message ?? statusText}`), { status, code: error?.code ?? null, detail: error ?? null })
}

/** A cmdr.mc refusal's status, code and fields, from an error apiError made (else nulls). */
export function refusalOf(e: unknown): { status: number | null; code: string | null; detail: Record<string, unknown> | null } {
  const x = e as { status?: unknown; code?: unknown; detail?: unknown } | null
  return { status: typeof x?.status === 'number' ? x.status : null, code: typeof x?.code === 'string' ? x.code : null, detail: x?.detail && typeof x.detail === 'object' ? (x.detail as Record<string, unknown>) : null }
}

/** This plugin's version, as its package.json says it (tests/agent-client/client.spec.ts holds the two together):
 *  what the MCP server names itself and what the socket declares. */
export const PLUGIN_VERSION = '0.3.15'
/** What this plugin can do that cmdr.mc must know before it acts (general crew channel design § 3.1, AC-10):
 *  `general-channel`, it knows its crew's general channel and no home, so an organization may archive its role channels. */
export const GENERAL_CHANNEL_CAPABILITY = 'general-channel'
export const CAPABILITIES: readonly string[] = [GENERAL_CHANNEL_CAPABILITY]

export type ApiInit = { method?: string; body?: unknown; /** abort after this long; absent, the client's own (none in the plugin) */ timeoutMs?: number; /** extra request headers (agent home: X-Cmdr-Machine) */ headers?: Record<string, string> }
export type Api = <T>(path: string, init?: ApiInit) => Promise<T>

/** A restart queued for this agent's launcher (`GET /agent/actions`): `stale` is cmdr.mc's word, older than 15 min. */
export type LauncherAction = { id: string; fresh?: boolean; createdAt: string; stale?: boolean; /** absent: a restart; `release_home`: a transfer asks this machine to let the agent's home go (agent home sync § 3.4) */ kind?: string }

/** Agent home (agent home sync design 0.1.9 § 3.3). */
export type HomeEntry = { path: string; md5: string; size: number }
export type HomeManifest = { revision: number; entries: HomeEntry[] }
export type HomeLease = { leaseId: string; epoch: number; expiresAt: string }
export type SignedWrite = { url: string; method: 'PUT'; headers: Record<string, string> }
export type HomeLinks = { read: Record<string, string>; write: Record<string, SignedWrite>; present: string[] }
export type HomeCommitted = { committedAt: string; revision: number; entries: HomeEntry[] }

/** /agent/me: who the key is (design § 3.2). */
export type Me = Author & { runsOn?: string; operator?: { id: string; name: string } }
export type Thread = { root: Message; replies: Message[] }

export type McClientOptions = {
  apiUrl: string
  key: string
  timeoutMs?: number
  /** For tests; the global fetch otherwise. */
  fetch?: typeof fetch
}

export class McClient {
  readonly apiUrl: string
  readonly api: Api

  private constructor(private readonly opts: McClientOptions & { apiUrl: string; key: string }) {
    this.apiUrl = opts.apiUrl
    const doFetch = opts.fetch ?? fetch
    this.api = async <T>(path: string, init: ApiInit = {}): Promise<T> => {
      const timeoutMs = init.timeoutMs ?? opts.timeoutMs
      const res = await doFetch(`${opts.apiUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'X-Cmdr-Api-Key': opts.key, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      })
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string; code?: string } }
      if (!res.ok || json.success === false) throw apiError(res.status, res.statusText, json.error)
      return (json.data ?? json) as T
    }
  }

  /** One client per session; refuses without a key (`key-required`) or an address. */
  static create(opts: McClientOptions): McClient {
    const key = (opts.key ?? '').trim()
    const apiUrl = (opts.apiUrl ?? '').replace(/\/+$/, '')
    if (!key) throw new Error('key-required: set CMDR_AGENT_KEY')
    if (!apiUrl) throw new Error('api-url-required: set CMDR_API_URL')
    return new McClient({ ...opts, key, apiUrl })
  }

  me = () => this.api<Me>('/agent/me')
  /** The launcher's queued actions (session launcher 0.2.27 § 3.5): its restarts, oldest first; asking stamps it seen.
   *  `releaseHome`: a transfer's `release_home` too (agent home sync § 3.3); only a launcher that syncs asks. */
  actions = (opts: { releaseHome?: boolean } = {}) => this.api<LauncherAction[]>(opts.releaseHome ? '/agent/actions?with=release_home' : '/agent/actions')

  /** Agent home (design 0.1.9 § 3.3): every call names this machine. */
  private home = <T>(path: string, machineId: string, init: ApiInit = {}) => this.api<T>(`/agent/home/${path}`, { ...init, headers: { 'X-Cmdr-Machine': machineId } })
  homeLease = (m: { machineId: string; machineName: string }) => this.home<HomeLease>('lease', m.machineId, { method: 'POST', body: m })
  homeManifest = (machineId: string) => this.home<HomeManifest>('manifest', machineId)
  homeLinks = (machineId: string, body: { leaseId: string; read?: string[]; write?: { md5: string; size: number }[] }) => this.home<HomeLinks>('links', machineId, { method: 'POST', body })
  homeCommit = (machineId: string, body: { leaseId: string; baseRevision: number; put: HomeEntry[]; delete: string[] }) => this.home<HomeCommitted>('commit', machineId, { method: 'POST', body })
  homeRelease = (machineId: string, leaseId: string) => this.home<{ released: boolean }>('release', machineId, { method: 'POST', body: { leaseId } })
  /** How one went, once: `done`, or `failed` with why (`stale`, `stopped`, …). */
  actionDone = (id: string, status: 'done' | 'failed', detail?: string) =>
    this.api(`/agent/actions/${encodeURIComponent(id)}`, { method: 'POST', body: { status, ...(detail ? { detail } : {}) } })
  people = () => this.api<Person[]>('/agent/people')
  conversations = () => this.api<Conversation[]>('/agent/conversations')
  history = (id: string, limit: number) => this.api<Message[]>(`/agent/conversations/${id}/messages?limit=${limit}`)
  thread = (id: string, threadId: string, limit: number) => this.api<Thread>(`/agent/conversations/${id}/messages/${encodeURIComponent(threadId)}/thread?limit=${limit}`)
  search = (qs: URLSearchParams) => this.api<{ hits: (Message & { conversation: { id: string; name: string | null } })[] }>(`/agent/search?${qs}`)
  post = (id: string, body: string, opts: { attachmentIds?: string[]; threadRootId?: string | null; terminal?: { forUserId?: string }; timeoutMs?: number } = {}) =>
    this.api<Message>(`/agent/conversations/${id}/messages`, {
      method: 'POST',
      body: { body, ...(opts.attachmentIds?.length ? { attachmentIds: opts.attachmentIds } : {}), ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}), ...(opts.terminal ? { terminal: opts.terminal } : {}) },
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    })
  react = (id: string, messageId: string, emoji: string, remove = false) =>
    this.api<{ reactions: ReactionView[] }>(`/agent/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`, { method: remove ? 'DELETE' : 'PUT' })
  read = (id: string) => this.api(`/agent/conversations/${id}/read`, { method: 'POST' })
  openPrivate = ({ agentId }: { agentId: string }) => this.api<Conversation>('/agent/conversations/private', { method: 'POST', body: { agentId } })
  /** A project's channel by the project's id, or a task's by `<project>/<number>` (the plugin's link tool resolves both). */
  deliverable = (ref: { projectId: string } | { taskRef: string }, timeoutMs?: number) =>
    this.api<Conversation>('/agent/conversations/deliverable', { method: 'POST', body: 'taskRef' in ref ? { kind: 'task', ref: ref.taskRef } : { kind: 'project', id: ref.projectId }, ...(timeoutMs ? { timeoutMs } : {}) })

  /** Upload one file to a conversation, to post with a message (`post`'s attachmentIds): multipart, the request the
   *  plugin's server.ts FileTransport makes. Built in S6 for the CLI's `reply --file` (design D-5); the plugin keeps its
   *  own transport. Reading the file, and refusing a secret's path, is the caller's (the plugin's files.ts readToSend). */
  attach = async (conversationId: string, name: string, data: Uint8Array, timeoutMs?: number): Promise<Attachment> => {
    const form = new FormData()
    form.set('file', new Blob([data]), name)
    const t = timeoutMs ?? this.opts.timeoutMs
    const res = await (this.opts.fetch ?? fetch)(`${this.apiUrl}/agent/conversations/${encodeURIComponent(conversationId)}/attachments`, {
      method: 'POST',
      headers: { 'X-Cmdr-Api-Key': this.opts.key, Accept: 'application/json' },
      body: form,
      ...(t ? { signal: AbortSignal.timeout(t) } : {}),
    })
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: Attachment; error?: { message?: string; code?: string } }
    if (!res.ok || json.success === false || !json.data) throw apiError(res.status, res.statusText, json.error)
    return json.data
  }

  /** The /conversations socket with this key, reconnecting (the plugin's server.ts settings). */
  socket() {
    return io(`${this.apiUrl}/conversations`, { auth: this.socketAuth(), transports: ['websocket'], reconnection: true })
  }

  /** What the socket says when it connects: the key, and what this plugin is and can do (kept on the agent's presence). */
  socketAuth(): { apiKey: string; pluginVersion: string; capabilities: string[] } {
    return { apiKey: this.opts.key, pluginVersion: PLUGIN_VERSION, capabilities: [...CAPABILITIES] }
  }
}
