// The views cmdr.mc sends an agent (GET /agent/*, the /conversations socket), as agent-client reads them
// (local-agents design § 3.3; moved from the plugin's channel.ts and files.ts in S5, which re-export them). Types only.

/** `ref`: its name in its message's text, `image-01` / `file-02` (inline file references design § 3); `removed`: taken off its message. */
export type Attachment = { id: string; name: string; mimeType: string; kind: 'image' | 'pdf' | 'text' | 'archive' | 'document'; size: number; ref?: string; removed?: true }

/** `bot`: one of cmdr.mc's own authors (its id names it: `deploy`), never a person. */
export type Author = { kind: 'user' | 'agent' | 'bot'; id: string; name: string; handle?: string; archetype?: string; crewKey?: string; /** /agent/me: where it runs (local-agents design § 3.2) */ runsOn?: string; /** /agent/me: a local agent's operator */ operator?: { id: string; name: string } }

export type Conversation = {
  id: string
  kind: 'channel' | 'group' | 'private'
  crewKey: string | null
  slot: string | null
  label: string | null
  participants: Author[]
  unread: number
  /** One of the organization's feeds, as cmdr.mc says (its bots.ts isFeed). Absent from a cmdr.mc that predates it. */
  feed?: boolean
  /** An organization's or crew's custom channel (custom channels design § 3.4); its agents are its seats. */
  custom?: boolean
  /** Our seat's mode in a custom channel (custom channels design § 3.4): all, mentions, read. Absent: read as mentions. */
  mode?: 'all' | 'mentions' | 'read'
  /** A project's deliverable channel: the project. */
  projectId?: string | null
  /** A task's deliverable channel: the task. */
  taskId?: string | null
  /** A deliverable channel's address in cmdr.app, as cmdr.mc builds it (speaking-policy design §3.6); absent on any other, and from a cmdr.mc before it. Never built here. */
  href?: string
}

/** `threadRootId`: a reply, in that message's thread (threads are one level). `thread`: a thread's first message, its replies so far. */
export type Message = {
  id: string
  conversationId: string
  author: Author | null
  body: string
  createdAt: string
  threadRootId?: string | null
  /** On a reply: the agents who have written in its thread, as cmdr.mc reads them when it's delivered. Whether we hear the thread. */
  threadAgentIds?: string[]
  /** The agents this message addresses on the record, typed or carried forward by cmdr.mc (speaking-policy design §3.3); absent when none, and from a cmdr.mc before it. */
  mentionedAgentIds?: string[]
  thread?: { replyCount: number; lastReplyAt: string } | null
  permission?: { id: string; status: string }
  /** A card saying an agent isn't connected (agent error card design § 3): for people; the plugin never hears it. */
  agentNotice?: { id: string; agentId: string; status: string }
  attachments?: Attachment[]
  /** Set when cmdr.mc posted it as task news (as the crew's queue, else its `tasks` bot): task_created, task_status, task_moved, agent_free, agent_idle, offer_answered, offer_expired, pr_merged, backlog_deep. */
  feed?: string | null
  /** Set when it shows a task as a card (cmdr.mc's TaskCardView): for people to read. */
  task?: { key: string } | null
  /** Its reactions, each emoji once (cmdr.mc's ReactionView); absent from a cmdr.mc before them. */
  reactions?: ReactionView[]
}

/** Who reacted with one emoji, and how many (cmdr.mc's ReactionView): what the react tool's call answers. */
export type ReactionView = { emoji: string; count: number; by: { kind: 'user' | 'agent'; id: string; name: string }[] }
