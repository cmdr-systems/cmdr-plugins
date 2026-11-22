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
// requests and deploys (a pull request's card where it lives, everything in
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

/** A crew's one channel of its own (general crew channel design § 3.1): the slot never changes, its label may. No
 *  agent has a channel of its own there or anywhere: it hears what names it and the threads it is in. */
export const GENERAL = 'general'

/** A crew's `#tasks`, while its organization has not archived its role channels: where the Queue's feed still is
 *  between this plugin and that archive. The arm goes with the cleanup (design § 3.4, R-2). */
const LEGACY_TASKS = 'tasks'

/** The role channels a crew had before the general channel, by archetype, in both vocabularies (cmdr.mc's `qa`, the
 *  assembler's `qa-auditor`). Kept for ONE release and for one reader: a permission card's address in a crew whose
 *  cmdr.mc has no general channel for it yet (channel.ts askWhere). Nothing is heard by it. */
const RETIRED_ROLE_CHANNEL: Readonly<Record<string, string>> = {
  architect: 'architecture',
  builder: 'build',
  'qa-auditor': 'quality',
  qa: 'quality',
  enforcer: 'security',
  doc: 'health',
  queue: LEGACY_TASKS,
}
export function retiredRoleChannel(archetype: string | undefined | null): string | null {
  return RETIRED_ROLE_CHANNEL[(archetype ?? '').trim()] ?? null
}

/** Whether this archetype is its crew's Queue: the one agent that hears the `tasks` bot's feed lines. */
export const isQueueArchetype = (archetype: string | undefined | null): boolean => (archetype ?? '').trim() === 'queue'

/** cmdr's own bots, every agent's to read (admission): deploy (pull requests' cards, the #prs and #deploy feeds),
 *  tasks (the queue's news; a nudge in a task's channel when we've stalled on it), and Doc, cmdr's health agent in every
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
 *  is admission's. Pure: built once per session from who we are. No channel is ours to hear whole but our private and
 *  group conversations and a custom channel seated `all` (general crew channel design § 3.4, AC-4). */
export type HearsView = { me: Pick<Author, 'id' | 'crewKey'>; isQueue: boolean; mention: RegExp }
export const hearsOf =
  ({ me, isQueue, mention }: HearsView) =>
  (c: Conversation, m: Message): boolean => {
    // Our own message never comes back to us, but one, while it lasts: in an organization that has not archived its
    // role channels cmdr.mc still posts the queue's lines and task news in `#tasks` AS the Queue (crewFeedInGeneral
    // false), and a Queue deaf to those would stop offering work. Once archived, the `tasks` bot writes every line and
    // this arm hears nothing; it goes with the cleanup, beside LEGACY_TASKS.
    if (m.author?.kind === 'agent' && m.author.id === me.id) return isQueue && !!m.feed && c.kind === 'channel' && c.slot === LEGACY_TASKS
    // Task news and the queue's own lines are for people and for the crew's Queue: in a project's channel (every queue
    // of a crew on the project hears it there), in its own crew's general channel, and in its `#tasks` while that
    // still exists. Another agent hears the news never.
    if (m.feed) return isQueue && m.author?.kind === 'bot' && c.kind === 'channel' && (!!c.projectId || (!!me.crewKey && c.crewKey === me.crewKey && (c.slot === GENERAL || c.slot === LEGACY_TASKS)))
    // A task's card is for people: another agent hears it only when it's mentioned in it.
    if (m.task && !mention.test(m.body)) return false
    // Another agent's permission card is for the people who decide it, not for us; and a card saying an agent isn't
    // connected (cmdr's agent-notice, agent error card design 0.1.4 § 2) is for the people waiting on it: never heard.
    if (m.permission || m.agentNotice) return false
    // A custom channel we read only (custom channels design 0.1.6 § 3.5, CC-6): nothing in it wakes us, a bot naming us
    // included. `mode` absent (an older cmdr.mc) reads as mentions: never more than the server said.
    if (c.kind === 'channel' && c.custom && c.mode === 'read') return false
    // A bot is heard when it names us, in any channel: a pull request's card says `by @handle`, its notices and a nudge
    // open with `@handle`. In the organization's feeds too (#prs, #deploy, #actions): a card there wakes the agent it
    // names and never another (design 0.1.18). Unnamed, a bot is heard nowhere but a custom channel seated `all`.
    if (m.author?.kind === 'bot') return c.kind === 'channel' && ((!!c.custom && c.mode === 'all') || mention.test(m.body))
    if (c.kind !== 'channel') return true
    // A custom channel we hear all of (its owners and admins chose it).
    if (c.custom && c.mode === 'all') return true
    // Named on the record: typed, or carried forward by cmdr.mc from whoever was named last (speaking-policy design §3.3).
    // The own-message drop above stays first (AC-18): a session never hears its own persona, however it's named.
    return mention.test(m.body) || (m.mentionedAgentIds ?? []).includes(me.id) || (!!m.threadRootId && (m.threadAgentIds ?? []).includes(me.id))
  }

/** The design's Port (agent-client API: `Hearing.create(me, people)`): admission and hearing for one session. The
 *  plugin builds the same two from its own deps (channel.ts); the CLI (S6) builds them here. */
export const Hearing = {
  create(
    me: Author,
    people: () => Promise<Person[]>,
    opts: { archetype?: string | null; log: (line: string) => void; now?: () => number; refreshMs?: number; unknownRefreshMs?: number; bots?: readonly string[] },
  ) {
    const isQueue = isQueueArchetype(me.archetype ?? opts.archetype)
    const admission = new Admission(people, me.crewKey, me.id, opts.log, opts.now ?? Date.now, opts.refreshMs, opts.unknownRefreshMs, opts.bots ?? [])
    return { admission, isQueue, hears: hearsOf({ me, isQueue, mention: mentionOf(me) }), roleOf: (author: Author | null) => admission.roleOf(author) }
  },
} as const
