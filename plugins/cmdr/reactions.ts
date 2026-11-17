// What reactions mean to an agent (Adrian, 2026-11-08: "ack + answer").
//
// - Reacting alone says "heard, nothing to add". Words the agent writes after
//   reacting are still its answer and are posted (reply-guard.ts), unless all
//   they do is describe the reaction ("Reacted ✅ to acknowledge").
// - A ✅ or 👍 (any skin tone) from the person the agent is waiting on
//   (waiting_on), on one of the agent's messages, is "yes, go ahead": the wait
//   ends and the agent hears it as an answer. Any other emoji, or anyone else's,
//   is a plain notice, owed nothing, and the wait stands.
// - read_history shows a message's reactions under it, the agent's own as "you".
import type { ReactionView } from './channel.js'

/** ✅ (with or without its emoji selector) or 👍 in any skin tone. */
const GO_AHEAD = /^(?:✅️?|\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?)$/u

export const isGoAhead = (emoji: string) => GO_AHEAD.test(emoji)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `on` (what waiting_on was told: "Adrian", "Adrian's call on the layout") names this person: their full name, or their first name as a word. */
export function awaits(on: string, by: { kind: string; name: string }): boolean {
  if (by.kind !== 'user') return false
  const said = on.toLowerCase().replace(/@/g, '')
  const full = by.name.trim().toLowerCase()
  if (!full) return false
  const first = full.split(/\s+/)[0]!
  return [full, first].some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n)}($|[^\\p{L}\\p{N}])`, 'u').test(said))
}

/** A message's reactions as read_history shows them: "👍 Dana Scully, you · 🎉 Quill". `name` gives a reactor's name as the agent may see it ("you", or "someone" for one not admitted). */
export async function reactionsLine(reactions: ReactionView[] | undefined, name: (by: ReactionView['by'][number]) => Promise<string>): Promise<string> {
  if (!reactions?.length) return ''
  const parts = await Promise.all(reactions.map(async (r) => `${r.emoji} ${(await Promise.all(r.by.map(name))).join(', ') || r.count}`))
  return parts.join(' · ')
}

/** Text after a reaction that only describes it ("Reacted ✅ to acknowledge."): nothing anyone needs to read. */
export const narratesReaction = (text: string) => text.length <= 160 && /\breact(?:ed|ing|ion)?\b/i.test(text)
