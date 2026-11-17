// An agent's dailies entry, checked as cmdr.mc will check it (dailies.v1:
// core/modules/schema/dailies.v1.json; cmdr.mc box.service.ts dailyEntryOf) —
// the check_dailies tool. cmdr.mc refuses an entry that's off, and the box
// only logs that, so an agent never heard: 82 refused entries on one crew in
// two weeks (status "done", summary/note for group/description, no
// completed_at), none of them on its Dailies page. This says every problem at
// once, by field, so the agent can fix the file it just wrote.

export const TASK_STATUSES = ['completed', 'in-progress', 'blocked', 'backlog'] as const
export const LINK_TYPES = ['design', 'adr', 'pr', 'commit', 'todo', 'memory', 'planning', 'investigation', 'executive-summary', 'other'] as const
/** cmdr.mc's ceiling for one day's entry. */
export const MAX_DAILY_BYTES = 64 * 1024

/** What a common slip should have been: said beside the problem. */
const STATUS_FOR: Record<string, string> = { done: 'completed', complete: 'completed', finished: 'completed', 'in_progress': 'in-progress', wip: 'in-progress', todo: 'backlog' }

/** Every way the entry falls short of dailies.v1, as cmdr.mc reads it; none: it will be accepted. */
export function dailiesProblems(raw: unknown): string[] {
  const out: string[] = []
  if (JSON.stringify(raw ?? null).length > MAX_DAILY_BYTES) out.push('the entry is over 64 KB')
  const e = raw as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [...out, 'the file must hold one JSON object']
  if (e.schema_version !== 1) out.push('schema_version must be 1 (a number)')
  if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) out.push('date must be "YYYY-MM-DD"')
  if (typeof e.being !== 'string') out.push('being is required: your name')
  if (typeof e.summary !== 'string') out.push("summary is required: the day in a sentence or two")
  if (!Array.isArray(e.tasks)) return [...out, 'tasks must be an array']
  if (e.tasks.length > 500) out.push('tasks: at most 500')
  e.tasks.forEach((t: unknown, i: number) => {
    const at = `tasks[${i}]`
    if (!t || typeof t !== 'object' || Array.isArray(t)) return void out.push(`${at} must be an object`)
    const task = t as Record<string, unknown>
    if (typeof task.group !== 'string') out.push(`${at}.group is required: the project or area${typeof task.summary === 'string' ? ' (not summary)' : ''}`)
    if (typeof task.description !== 'string') out.push(`${at}.description is required: 5-10 words on what was done${typeof task.note === 'string' || typeof task.summary === 'string' ? ' (note is optional and extra; it is not the description)' : ''}`)
    if (typeof task.completed_at !== 'string') out.push(`${at}.completed_at is required: an ISO 8601 time with its offset, e.g. 2026-11-16T03:20:00Z`)
    if (!(TASK_STATUSES as readonly unknown[]).includes(task.status)) {
      const hint = typeof task.status === 'string' ? STATUS_FOR[task.status.toLowerCase()] : undefined
      out.push(`${at}.status must be one of ${TASK_STATUSES.join(', ')}${task.status === undefined ? '' : `, not ${JSON.stringify(task.status)}`}${hint ? ` (use "${hint}")` : ''}`)
    }
    if (task.tags !== undefined && (!Array.isArray(task.tags) || !task.tags.every((x) => typeof x === 'string'))) out.push(`${at}.tags must be an array of strings`)
    if (task.links !== undefined) {
      if (!Array.isArray(task.links)) return void out.push(`${at}.links must be an array`)
      task.links.forEach((l: unknown, j: number) => {
        const link = l as Record<string, unknown> | null
        if (!link || !(LINK_TYPES as readonly unknown[]).includes(link.type) || typeof link.url !== 'string') return void out.push(`${at}.links[${j}] needs a type (${LINK_TYPES.join(', ')}) and a url`)
        const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(link.url)?.[1]?.toLowerCase()
        if (scheme && scheme !== 'http' && scheme !== 'https') out.push(`${at}.links[${j}].url must be http(s) or a relative path`)
      })
    }
  })
  return out
}

/** The tool's answer for a file's text: accepted, or what to fix. */
export function checkDailiesText(text: string): { ok: boolean; message: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, message: `Not JSON: ${(e as Error).message}. Fix the file and check it again.` }
  }
  const problems = dailiesProblems(raw)
  if (!problems.length) return { ok: true, message: `OK: cmdr will accept it (${(raw as { tasks: unknown[] }).tasks.length} task${(raw as { tasks: unknown[] }).tasks.length === 1 ? '' : 's'}). It shows on your crew's Dailies page within a few minutes.` }
  return { ok: false, message: `cmdr would refuse this entry, and it would not show on the Dailies page. Fix the file and check it again:\n${problems.map((p) => `- ${p}`).join('\n')}` }
}
