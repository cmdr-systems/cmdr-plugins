// What the agent is doing, as one line for the people in its conversation:
// its Claude Code hooks (hooks/hooks.json → hook.ts) hand each step here
// (a tool about to run, a prompt, the turn's end), and the channel sends the
// line to cmdr.mc as `agent:activity` (channel.ts), which shows it in the
// conversation's feed, live, never stored.
//
// Pure: a hook's input in, { state, kind, summary } out. Commands and paths
// are what people see, so they're shortened, made relative to the agent's
// working folder, and anything that looks like a secret is blanked (cmdr.mc
// blanks again).

export type ActivityKind = 'thinking' | 'reading' | 'searching' | 'running' | 'editing' | 'writing' | 'web' | 'tasks' | 'replying' | 'delegating' | 'waiting' | 'other'
export type Activity = { state: 'working' | 'idle'; kind?: ActivityKind; summary?: string }
/** What Claude Code hands a hook on stdin (the part read here). */
export type HookInput = { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; transcript_path?: string; stop_hook_active?: boolean; last_assistant_message?: string; error?: string; /** UserPromptSubmit: the prompt's text */ prompt?: string; /** PreCompact: 'auto' or 'manual' */ trigger?: string; session_id?: string }

const MAX = 110
const KINDS = new Set<string>(['thinking', 'reading', 'searching', 'running', 'editing', 'writing', 'web', 'tasks', 'replying', 'delegating', 'waiting', 'other'])

/** Secrets that look like secrets, blanked. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[\w]{20,}|lin_(api|oauth)_[A-Za-z0-9]{16,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ya29\.[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, '•••')
    .replace(/\b(bearer|token|authorization)(\s*[:=]?\s*)[\w.~+/=-]{12,}/gi, '$1$2•••')
    .replace(/\b([\w-]*(?:password|passwd|secret|api[_-]?key|token)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2•••')
    .replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '•••')
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Shortened in the middle, so both ends (the command, the file name) stay. */
function clip(s: string, max = MAX): string {
  const t = oneLine(s)
  if (t.length <= max) return t
  const half = Math.floor((max - 1) / 2)
  return `${t.slice(0, half)}…${t.slice(t.length - half)}`
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A path as people read it: relative to the working folder when it's under it. */
function pathOf(raw: unknown, cwd?: string): string {
  const p = str(raw)
  if (!p) return 'a file'
  const base = (cwd ?? '').replace(/\/+$/, '')
  return base && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p
}

const OWN = /^mcp__plugin_cmdr_cmdr__(.+)$/

/** A tool about to run, as a line. */
function toolActivity(tool: string, input: Record<string, unknown>, cwd?: string): Activity {
  const working = (kind: ActivityKind, summary: string): Activity => ({ state: 'working', kind, summary: clip(redact(summary)) })
  switch (tool) {
    case 'Bash': {
      const command = str(input.command).split('\n')[0] ?? ''
      return working('running', command ? `Running \`${clip(redact(command), MAX - 10)}\`` : 'Running a command')
    }
    case 'Read':
      return working('reading', `Reading ${pathOf(input.file_path, cwd)}`)
    case 'LS':
      return working('reading', `Listing ${pathOf(input.path, cwd)}`)
    case 'Edit':
    case 'MultiEdit':
      return working('editing', `Editing ${pathOf(input.file_path, cwd)}`)
    case 'NotebookEdit':
      return working('editing', `Editing ${pathOf(input.notebook_path, cwd)}`)
    case 'Write':
      return working('writing', `Writing ${pathOf(input.file_path, cwd)}`)
    case 'Grep':
      return working('searching', `Searching for “${clip(str(input.pattern), 50)}”${input.path ? ` in ${pathOf(input.path, cwd)}` : ''}`)
    case 'Glob':
      return working('searching', `Looking for ${clip(str(input.pattern), 60)}`)
    case 'WebFetch': {
      let host = ''
      try {
        host = new URL(str(input.url)).host
      } catch {}
      return working('web', host ? `Reading ${host}` : 'Reading a web page')
    }
    case 'WebSearch':
      return working('web', `Searching the web for “${clip(str(input.query), 60)}”`)
    case 'Task':
    case 'Agent':
      return working('delegating', `Handing off: ${clip(str(input.description) || 'a sub-task', 80)}`)
    case 'TodoWrite':
      return working('thinking', 'Planning its steps')
  }
  const own = OWN.exec(tool)
  if (own) {
    const name = own[1]!
    const task = input.project && input.task ? ` ${String(input.project).toUpperCase()}-${String(input.task).replace(/^.*-/, '')}` : ''
    switch (name) {
      case 'reply':
        return working('replying', 'Writing a reply')
      case 'stay_quiet':
        return working('other', 'Staying quiet')
      case 'react':
        return working('replying', input.remove === true ? 'Taking back a reaction' : 'Reacting')
      case 'read_history':
        return working('reading', 'Reading the conversation')
      case 'list_conversations':
        return working('reading', 'Looking at its conversations')
      case 'link':
        return working('reading', 'Finding a link')
      case 'comment_task':
        return working('tasks', `Commenting on${task || ' a task'}`)
      case 'update_task':
        return working('tasks', `Updating${task || ' a task'}`)
      case 'add_task':
        return working('tasks', 'Adding a task')
      case 'get_task':
        return working('tasks', `Reading${task || ' a task'}`)
      case 'list_tasks':
      case 'list_projects':
        return working('tasks', 'Looking at tasks')
      case 'propose_project':
        return working('tasks', 'Proposing a project')
    }
    return working('other', `Using ${name.replace(/_/g, ' ')}`)
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return working('other', `Using ${mcp[2]!.replace(/_/g, ' ')} (${mcp[1]!.replace(/^plugin_/, '').replace(/_/g, ' ')})`)
  return working('other', `Using ${tool}`)
}

/** A hook's input as the line to show, or null: nothing to say. */
export function activityOf(input: HookInput): Activity | null {
  switch (input.hook_event_name) {
    case 'PreToolUse':
      return input.tool_name ? toolActivity(input.tool_name, input.tool_input ?? {}, input.cwd) : null
    case 'UserPromptSubmit':
      return { state: 'working', kind: 'thinking', summary: 'Thinking' }
    // StopFailure fires INSTEAD of Stop when an API error ended the turn (the usage
    // limit, a refused token, overloaded). The turn is over all the same: without
    // it, a limited agent read working until the stale bound, and every restart
    // waited on it, the one that would put a new token in included (2026-11-07, on
    // a crew box).
    case 'Stop':
    case 'StopFailure':
      return { state: 'idle' }
    default:
      return null
  }
}

/** What reaches the channel from a hook, checked (it's a local socket, but still). */
export function checkActivity(raw: unknown): Activity | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (a.state === 'idle') return { state: 'idle' }
  if (a.state !== 'working') return null
  return { state: 'working', kind: KINDS.has(String(a.kind)) ? (a.kind as ActivityKind) : 'other', summary: typeof a.summary === 'string' ? clip(redact(a.summary)) : undefined }
}
