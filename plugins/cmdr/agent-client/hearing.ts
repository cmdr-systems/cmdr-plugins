// agent-client's Hearing (local-agents design § 3.3; moved from the plugin's admission.ts and channel.ts in S5,
// which re-export it): who is admitted (Admission, roleOf) and what is heard (hearsOf).
//
// Who reaches this agent (decided 2026-10-26): its crew's people, as cmdr.mc
// names them (GET /agent/people: the crew's director, its collaborators and
// the platform superadmin), and the agents of its own crew. Nobody else: on
// cmdr, anyone in the organization can post in a crew's channel, and an
// organization member who isn't one of the crew's people must not be able to
// direct its agents. Slack's equivalent is the allowFrom list.
//
// The people change from the app (a collaborator added or removed), so they
// are read live and re-read every PEOPLE_REFRESH_MS, and at once (at most
// every UNKNOWN_REFRESH_MS) when someone not on the list writes, so a person
// just added is heard on their first message. FAIL CLOSED: until cmdr.mc
// has answered, or when it can't, no person is admitted; the crew's agents
// still are.
//
// And the bots this agent is told (`bots`): cmdr.mc's own authors (a message
// only cmdr.mc itself writes, never a person): `deploy`, which reports pull
// requests and deploys (an agent's own PR cards in its home, everything in
// the organization's #prs and #deploy feeds), admitted for every agent; and
// `tasks`, the queue's. Which of their messages wake an agent is hearsOf's
// (below).
import type { Author, Conversation, Message } from './types.js'

export type Role = 'director' | 'collaborator' | 'superadmin'
export type Person = { id: string; name: string; role: Role }

export const PEOPLE_REFRESH_MS = 60_000
export const UNKNOWN_REFRESH_MS = 15_000

export class Admission {
  private people = new Map<string, Person>()
  private loadedAt = 0
  private lastUnknownRefresh = 0
  private inflight: Promise<void> | null = null

  constructor(
    private readonly load: () => Promise<Person[]>,
    private readonly crewKey: string | null | undefined,
    private readonly selfId: string,
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
    private readonly refreshMs = PEOPLE_REFRESH_MS,
    private readonly unknownRefreshMs = UNKNOWN_REFRESH_MS,
    private readonly bots: readonly string[] = [],
  ) {}

  /** Re-read the crew's people. On failure the last good list stays (empty at first: fail closed). */
  refresh(): Promise<void> {
    this.inflight ??= this.load()
      .then((all) => {
        this.people = new Map((Array.isArray(all) ? all : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]))
        this.loadedAt = this.now()
      })
      .catch((e) => this.log(`couldn't read this crew's people (admitting only its agents until it can): ${e}`))
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  /** What role the author has here, or null: not admitted. Our own messages are never admitted. */
  async roleOf(author: Author | null): Promise<Role | 'agent' | 'bot' | null> {
    if (!author) return null
    if (author.kind === 'bot') return this.bots.includes(author.id) ? 'bot' : null
    if (author.kind === 'agent') return author.id !== this.selfId && !!this.crewKey && author.crewKey === this.crewKey ? 'agent' : null
    if (this.now() - this.loadedAt > this.refreshMs) await this.refresh()
    let p = this.people.get(author.id)
    if (!p && this.now() - this.lastUnknownRefresh > this.unknownRefreshMs) {
      this.lastUnknownRefresh = this.now()
      await this.refresh()
      p = this.people.get(author.id)
    }
    return p?.role ?? null
  }

  /** The admitted people, for the session's instructions. */
  list(): Person[] {
    return [...this.people.values()]
  }
}

/** Each role's home channel (cmdr.app's HOME): where it answers everything.
 *  Keyed on BOTH archetype vocabularies: cmdr.mc calls the QA role `qa`, the
 *  assembler's closed set (assembler/src/core/types.ts ARCHETYPES) calls it
 *  `qa-auditor`, and either may be the one we're handed. */
export const HOME: Readonly<Record<string, string>> = {
  architect: 'architecture',
  builder: 'build',
  'qa-auditor': 'quality',
  qa: 'quality', // cmdr.mc's name for qa-auditor
  enforcer: 'security',
  doc: 'health',
  queue: 'tasks',
}

/** The home channel's slot for an archetype; null for `custom` or unknown
 *  (DMs and @-mentions only). */
export function homeFor(archetype: string | undefined | null): string | null {
  return HOME[(archetype ?? '').trim()] ?? null
}

/** The crew's task channel: the queue's home, where tasks are taken in and
 *  work is offered. Everyone else hears it as any other channel that isn't
 *  their home: when they're @-mentioned (Adrian, 2026-10-29). Its feed bot
 *  is the queue's alone. */
export const TASKS = 'tasks'

/** cmdr's own bots, every agent's to read (admission): deploy (PR cards in our home, the #prs and #deploy feeds),
 *  tasks (the queue's news in #tasks; a nudge in our home when we've stalled), and Doc, cmdr's health agent in every
 *  organization (cmdr.mono #673, 2026-11-17: its cards, and its word to us when our context is heavy). One list for
 *  the box's plugin and a local agent's cmdr-agent: Doc was withheld as "not one of this crew's people" (2026-11-17). */
export const ADMITTED_BOTS: readonly string[] = ['deploy', 'tasks', 'doc']

/** One of the organization's feeds (#prs, #deploy): its bot's; we read it, nobody writes there. cmdr.mc says which
 *  (deliverable-channels design §3.5). Guessing from crewKey took every project and task channel for a feed. */
export const isFeed = (c: Conversation): boolean => c.feed === true

/** Whether a message names this agent: `@handle` or `@name`, case-insensitive, not inside a word or after another
 *  `@`. A backtick is not a word character, so a mention inside code still matches, which is why the runtime contract
 *  says a fenced mention still reaches its agent. The contract's mention rule is checked against this predicate
 *  (tests/mention-rule.spec.ts, CMDR-CREW-142): change it here and that check moves with it. */
export function mentionOf(me: Pick<Author, 'handle' | 'name'>): RegExp {
  return new RegExp(`(^|[^\\w@])@(${escape(me.handle ?? '')}|${escape(me.name)})\\b`, 'i')
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether this message is for us: where it is, and whether it names us (or answers in a thread we're in). Who wrote it
 *  is admission's. Pure: built once per session from who we are. */
export type HearsView = { me: Pick<Author, 'id'>; home: string | null; isQueue: boolean; mention: RegExp }
export const hearsOf =
  ({ me, home, isQueue, mention }: HearsView) =>
  (c: Conversation, m: Message): boolean => {
    // Our own message never comes back to us, but one: the queue's task news, which cmdr.mc posts as the queue (in #tasks).
    if (m.author?.kind === 'agent' && m.author.id === me.id) return isQueue && !!m.feed && c.kind === 'channel' && c.slot === TASKS
    // Task news and task cards are for people (and the news, the queue's): another agent hears a card only when it's mentioned in it, and the news never.
    if (m.feed) return isQueue && m.author?.kind === 'bot' && c.kind === 'channel' && c.slot === TASKS
    if (m.task && !mention.test(m.body)) return false
    // Another agent's permission card is for the people who decide it, not for us; and a card saying an agent isn't
    // connected (cmdr's agent-notice, agent error card design 0.1.4 § 2) is for the people waiting on it: never heard,
    // not even in our home, where a bot's message is otherwise heard unnamed.
    if (m.permission || m.agentNotice) return false
    // A custom channel we read only (custom channels design 0.1.6 § 3.5, CC-6): nothing in it wakes us, a bot naming us
    // included. `mode` absent (an older cmdr.mc) reads as mentions: never more than the server said.
    if (c.kind === 'channel' && c.custom && c.mode === 'read') return false
    // A bot speaks to us in our home (the cards of the pull requests we open, the deploys that carry them, the task feed
    // in #tasks), and in any other channel that isn't a feed when it names us: a pull request's card in its task's
    // channel says `by @handle`, and its notices open with `@handle` (PR-routing design 0.3.3 §3.3). Never in the
    // organization's #prs and #deploy feeds, even named: those we read, unasked.
    if (m.author?.kind === 'bot') return c.kind === 'channel' && !isFeed(c) && ((!!home && c.slot === home) || (!!c.custom && c.mode === 'all') || mention.test(m.body))
    if (c.kind !== 'channel') return true
    // A custom channel we hear all of (its owners and admins chose it).
    if (c.custom && c.mode === 'all') return true
    // Named on the record: typed, or carried forward by cmdr.mc from whoever was named last (speaking-policy design §3.3).
    // The own-message drop above stays first (AC-18): a session never hears its own persona, however it's named.
    // A home of null (a local agent) is no channel's: a deliverable's slot is null too, and must not read as home.
    return (home !== null && c.slot === home) || mention.test(m.body) || (m.mentionedAgentIds ?? []).includes(me.id) || (!!m.threadRootId && (m.threadAgentIds ?? []).includes(me.id))
  }

/** The design's Port (agent-client API: `Hearing.create(me, people)`): admission and hearing for one session. The
 *  plugin builds the same two from its own deps (channel.ts); the CLI (S6) builds them here. */
export const Hearing = {
  create(
    me: Author,
    people: () => Promise<Person[]>,
    opts: { archetype?: string | null; log: (line: string) => void; now?: () => number; refreshMs?: number; unknownRefreshMs?: number; bots?: readonly string[] },
  ) {
    const home = homeFor(me.archetype ?? opts.archetype)
    const admission = new Admission(people, me.crewKey, me.id, opts.log, opts.now ?? Date.now, opts.refreshMs, opts.unknownRefreshMs, opts.bots ?? [])
    return { admission, home, hears: hearsOf({ me, home, isQueue: home === TASKS, mention: mentionOf(me) }), roleOf: (author: Author | null) => admission.roleOf(author) }
  },
} as const
