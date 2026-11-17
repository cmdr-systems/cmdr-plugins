// agent-client's Link (local-agents design § 3.3; moved from the plugin's terminal-link.ts in S5, which re-exports it).
// A local agent's terminal, linked to a project's or task's channel (local-agents design § 3.3, AC-14, AC-15): the
// link is this session's own state, `<CMDR_STATE_DIR>/link.json`, written whole (temp + rename) so a reader never
// sees half of it. While it's set, the operator's prompts and the agent's answers to them are mirrored there
// (the plugin's channel.ts), marked as the terminal's.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Api, Me } from './client.js'
import type { Conversation, Message } from './types.js'

export type TerminalLink = { kind: 'project' | 'task'; key: string; conversationId: string; label: string }

export const LINK_FILE = 'link.json'

export function readLink(stateDir: string): TerminalLink | null {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, LINK_FILE), 'utf8')) as Partial<TerminalLink>
    return (v.kind === 'project' || v.kind === 'task') && typeof v.key === 'string' && typeof v.conversationId === 'string' ? { kind: v.kind, key: v.key, conversationId: v.conversationId, label: typeof v.label === 'string' ? v.label : v.key } : null
  } catch {
    return null
  }
}

export function writeLink(stateDir: string, link: TerminalLink): void {
  const path = join(stateDir, LINK_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(link), { mode: 0o600 })
  renameSync(tmp, path)
}

export function clearLink(stateDir: string): boolean {
  const had = readLink(stateDir) !== null
  rmSync(join(stateDir, LINK_FILE), { force: true })
  return had
}

/** The mirror's own budget, inside the hook's (UserPromptSubmit 3 s, Stop 15 s): design § 5. */
export const MIRROR_TIMEOUT_MS = 2_000
export const LINK_TIMEOUT_MS = 5_000

// ── Link.of: the link and the mirror over a client (agent-client API `Link.of`; moved from the plugin's channel.ts) ──

/** What a link names, already parsed by its face (the plugin's link_terminal tool, the CLI's `link` verb). */
export type LinkTarget = { kind: 'task'; project: string; n: number } | { kind: 'project'; project: string }

export type LinkDeps = {
  stateDir: string
  api: Api
  /** The session's own /agent/me; its `operator` is refreshed in place when absent (a manager's PATCH takes effect). */
  me: Me
  stamp?: (tag: string) => void
  log?: (line: string) => void
}

export const Link = {
  of(d: LinkDeps) {
    const stamp = d.stamp ?? (() => {})
    const log = d.log ?? (() => {})

    /** A prompt is its operator's: with none (never set, or their account gone) it is never posted, for it would read
     *  as the agent's own words (design AC-26). Read again from cmdr.mc first, so a manager's PATCH takes effect. */
    async function operatorId(): Promise<string | null> {
      if (d.me.operator?.id) return d.me.operator.id
      const fresh = await d.api<Me>('/agent/me', { timeoutMs: MIRROR_TIMEOUT_MS }).catch(() => null)
      if (fresh?.operator?.id) d.me.operator = fresh.operator
      return d.me.operator?.id ?? null
    }

    return {
      get: () => readLink(d.stateDir),
      clear: () => clearLink(d.stateDir),
      operatorId,
      /** Resolve the target's channel at cmdr.mc and record it; a refusal is thrown as cmdr.mc says it, nothing recorded.
       *  `null` for a project the agent can't see. `label` says how the face names the channel. */
      async set(t: LinkTarget, label: (c: Conversation) => string = (c) => c.label ?? (t.kind === 'task' ? `${t.project.toUpperCase()}-${t.n}` : t.project)): Promise<TerminalLink | null> {
        let link: TerminalLink
        if (t.kind === 'task') {
          const c = await d.api<Conversation>('/agent/conversations/deliverable', { method: 'POST', body: { kind: 'task', ref: `${t.project}/${t.n}` }, timeoutMs: LINK_TIMEOUT_MS })
          link = { kind: 'task', key: `${t.project.toUpperCase()}-${t.n}`, conversationId: c.id, label: label(c) }
        } else {
          const p = (await d.api<{ id: string; key: string }[]>('/agent/projects', { timeoutMs: LINK_TIMEOUT_MS })).find((x) => x.key === t.project)
          if (!p) return null
          const c = await d.api<Conversation>('/agent/conversations/deliverable', { method: 'POST', body: { kind: 'project', id: p.id }, timeoutMs: LINK_TIMEOUT_MS })
          link = { kind: 'project', key: t.project, conversationId: c.id, label: label(c) }
        }
        writeLink(d.stateDir, link)
        stamp(`link_set ${link.kind}`)
        return link
      },
      /** Post the prompt or the answer to the linked channel, marked as the terminal's: the channel's label when posted,
       *  null when not (unlinked, empty, no operator for a prompt, or cmdr.mc refused: never retried, never in the
       *  turn's way). */
      async mirror(kind: 'prompt' | 'answer', text: string): Promise<string | null> {
        const link = readLink(d.stateDir)
        const body = text.trim().slice(0, 8000)
        if (!link || !body) return null
        let terminal: { forUserId?: string } = {}
        if (kind === 'prompt') {
          const op = await operatorId()
          if (!op) {
            stamp('mirror_refused no-operator')
            return null
          }
          terminal = { forUserId: op }
        }
        try {
          await d.api<Message>(`/agent/conversations/${link.conversationId}/messages`, { method: 'POST', body: { body, terminal }, timeoutMs: MIRROR_TIMEOUT_MS })
          stamp(`mirror_posted ${kind}`)
          return link.label
        } catch (e) {
          // Never retried (the record would be out of order) and never in the turn's way: counted, logged.
          stamp(`mirror_failed ${kind}`)
          log(`mirroring the ${kind} to ${link.label} failed: ${e}`)
          return null
        }
      },
    }
  },
} as const
