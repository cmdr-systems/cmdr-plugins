// The turn's end, checked: did the agent answer the person, or only write it
// down? People see only what goes through the reply tool; an agent that
// writes its answer as plain text in its session has said nothing to anyone
// (seen 2026-10-28: the Architect read four files, described them in text,
// and the conversation heard nothing).
//
// So an answer can't stay in the session: from the session's transcript
// (Claude Code hands the Stop hook its path), the last message the channel
// handed over (a person's or an agent's, not the startup wake) and what the
// agent did after it. No reply since, and it ended on written text: that text
// (its final answer: what it wrote after its last step, not its narration
// between steps) is unsent, and hook.ts has the channel post it there as the
// agent. Only if the channel can't be reached does the hook hold the turn
// open once instead, saying where to send it (Stop: decision "block").
//
// The final answer itself comes from the Stop hook's own input
// (last_assistant_message), never the transcript: Claude Code hasn't always
// written the turn's last row when the hook runs (measured 2026-10-30 on two
// boxes: the hook read the file 40–120 ms after the final text and found
// nothing, so 29 of 37 unsent answers on one crew were never posted). The
// transcript still says which message the turn was for and what the agent
// did with it: those rows were written long before.
//
// Staying quiet is a tool too (stay_quiet), as reply is: an agent that
// decides a message isn't its to answer says so with it, and nothing it
// writes after is posted (agents wrote "No action needed — not addressed to
// me" as their final text, and the guard posted it to the channel).
//
// A reaction says "heard, nothing to add" (reactions.ts): a turn that reacted
// and wrote nothing after has answered. Words written after it are still its
// answer and go out, unless all they do is describe the reaction ("Reacted ✅
// to acknowledge"). A reaction someone made to the agent's message
// (reaction="…" in its tag) is owed nothing, as task news isn't: what the
// agent writes after it isn't posted. Except a go-ahead (go_ahead="true": the
// person it was waiting on ✅'d or 👍'd its message): that's an answer to it,
// and what it writes after is owed as after any message.

import { narratesReaction } from './reactions.js'
import { CHANNEL_TAG } from './agent-client/mode.js'

/** Under this much text, nothing was meant for anyone (a note to self, a blank). */
const MEANT = 20

type Row = { type?: string; message?: { role?: string; content?: unknown } }
/** `threadId`: the message it answers was a reply in a thread, so the answer goes there too ('' when it wasn't). */
/** A channel delivery's tag: one expression, agent-client's (local-agents design § 3.3, R-11; moved there in S5).
 *  The reply guard scans the transcript with it, unanchored. Re-exported so this path keeps it (plan D-7). */
export { CHANNEL_TAG }

export type Unsent = { chatId: string; threadId: string; conversation: string; user: string; text: string }

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('\n')
  return ''
}
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? ''

/** What the agent wrote for the last message handed to it and never sent, or null.
 *  `final`: the turn's last text as Claude Code handed it to the Stop hook
 *  (last_assistant_message); without it (an older Claude Code), the transcript's. */
export function unsentReply(lines: string[], final?: string): Unsent | null {
  const rows: Row[] = []
  for (const l of lines) {
    try {
      rows.push(JSON.parse(l))
    } catch {
      // a line cut at the start of what was read, or not JSON: skip it
    }
  }
  // The last message from the channel: a user row whose text is a cmdr <channel> tag with a conversation.
  let at = -1
  let tag = ''
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.type !== 'user') continue
    const t = textOf(r.message?.content)
    const m = CHANNEL_TAG.exec(t)
    if (!m) continue
    // A feed event (the queue's own task news) is never answered, nor a reaction to the agent's message: nothing it writes is posted.
    if (!attr(m[0], 'chat_id') || attr(m[0], 'user_kind') === 'system' || attr(m[0], 'feed') || (attr(m[0], 'reaction') && attr(m[0], 'go_ahead') !== 'true')) return null
    at = i
    tag = m[0]
    break
  }
  if (at < 0) return null
  // Its final answer: the text after its last step (a tool's use resets it).
  let answer: string[] = []
  // Its last step was a reaction: what follows may only describe it.
  let reacted = false
  for (const r of rows.slice(at + 1)) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue
    for (const p of r.message!.content as { type?: string; name?: string; text?: string }[]) {
      if (p?.type === 'tool_use') {
        if (/__(reply|stay_quiet)$/.test(p.name ?? '')) return null
        reacted = /__react$/.test(p.name ?? '')
        answer = []
      }
      if (p?.type === 'text' && p.text) answer.push(p.text)
    }
  }
  const text = (typeof final === 'string' ? final : answer.join('\n\n')).trim()
  if (text.length < MEANT) return null
  if (reacted && narratesReaction(text)) return null
  return { chatId: attr(tag, 'chat_id'), threadId: attr(tag, 'thread_id'), conversation: attr(tag, 'conversation'), user: attr(tag, 'user'), text }
}

/** What the Stop hook tells the agent, holding its turn open. */
export function reminder(u: Unsent): string {
  return `You wrote an answer${u.user ? ` to ${u.user}` : ''}, but nobody sees this session: people only see what you send with the reply tool. Send it now with reply, chat_id "${u.chatId}"${u.threadId ? `, thread_id "${u.threadId}"` : ''}${u.conversation ? ` (${u.conversation})` : ''}. If you meant to stay quiet, use stay_quiet instead.`
}
