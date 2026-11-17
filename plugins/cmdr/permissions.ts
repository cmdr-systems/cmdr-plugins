// Permission requests, without stopping the agent: when Claude Code would ask
// before it acts, the plugin's PermissionRequest hook (hook.ts) hands the
// request to the channel, which puts a card in the agent's home channel on
// cmdr (cmdr.mc: POST /agent/permissions) and answers the hook AT ONCE: allowed
// when cmdr.mc decided on the spot (the crew's rules or risk tolerance cover
// it), otherwise refused for now, saying it was asked. The agent keeps
// working and talking. When the people who direct its crew decide
// (`permission:decided` on the socket), the channel tells the session, and an
// allowed request goes through the next time the agent makes exactly that call
// (once). Slack's equivalent is its permission card (../slack/server.ts).
//
// Before, the channel relayed Claude Code's own prompt
// (`notifications/claude/channel/permission_request`) and answered it when
// someone decided: the tool call, and with it the whole session, waited,
// hearing nothing and saying nothing, for as long as nobody did.
//
// This file is the pure part: what "Always allow" would add for a request
// (its rule), what makes two calls the same call, and what the agent is told.
// channel.ts wires the edges.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * Commands whose prefix is no boundary: a rule for them would allow anything
 * (a shell, sudo, a wrapper that runs its arguments, an interpreter that runs
 * any code it's given). These can be allowed once, never always.
 */
export const NO_PREFIX_RULE: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh',
  'sudo', 'su', 'doas', 'pkexec', 'runuser',
  'env', 'eval', 'exec', 'xargs', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'command', 'builtin', 'source', '.', 'watch', 'stdbuf', 'setsid', 'chroot', 'unshare', 'nsenter', 'script',
  'python', 'python3', 'node', 'bun', 'deno', 'perl', 'ruby', 'php', 'lua', 'osascript', 'awk', 'gawk', 'sed',
])

/** Tools whose first word is a family, not a boundary: "always allow `git status`", not "always allow git". */
const TWO_WORD = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'kubectl', 'gcloud', 'gsutil', 'forge', 'cargo', 'go', 'make', 'systemctl', 'journalctl', 'apt', 'apt-get', 'brew'])

const WORD = /^[A-Za-z0-9_/.][A-Za-z0-9_.\/+@=-]*$/

/** The command a Bash request runs, from Claude Code's preview: its JSON `command`, or the preview itself. */
export function commandOf(inputPreview: string): string | null {
  const text = inputPreview.trim()
  try {
    const parsed = JSON.parse(text) as { command?: unknown }
    if (typeof parsed?.command === 'string') return parsed.command
  } catch {
    // a truncated preview: find "command":"…" in it
    const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`)
      } catch {
        return m[1]!
      }
    }
  }
  return text.startsWith('{') ? null : text || null
}

/** At most this many commands in one line get an "always" (more is once only). */
const MAX_RULES = 10

/**
 * A command line's commands, each as its words, split where the shell runs
 * another (`;`, `&&`, `||`, `|`, `&`, a newline), quoted text kept whole; a
 * `#` comment dropped. Null when it has something whose commands can't be
 * read from the text: a substitution (`$(…)`, backticks), a subshell or
 * group (`(…)`, `{…}`), process substitution, or an open quote.
 */
export function commandsOf(line: string): string[][] | null {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'") {
      const j = line.indexOf("'", i + 1)
      if (j < 0) return null
      word += line.slice(i + 1, j)
      has = true
      i = j
    } else if (c === '"') {
      let j = i + 1
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '`' || (line[j] === '$' && line[j + 1] === '(')) return null
        if (line[j] === '\\' && j + 1 < line.length) j++
        word += line[j]
      }
      if (j >= line.length) return null
      has = true
      i = j
    } else if (c === '\\') {
      if (i + 1 < line.length && line[i + 1] !== '\n') word += line[++i]
      else i++
      has = true
    } else if (c === '`' || c === '(' || c === ')' || c === '{' || c === '}' || (c === '$' && line[i + 1] === '(')) {
      return null
    } else if (c === '#' && !has) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++
    } else if (c === ';' || c === '\n') {
      endCommand()
    } else if (c === '|') {
      endCommand()
      if (line[i + 1] === '|' || line[i + 1] === '&') i++
    } else if (c === '&') {
      if (line[i + 1] === '&') {
        endCommand()
        i++
      } else if (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>') {
        // a redirect (2>&1, &>file), not another command
        word += c
        has = true
      } else endCommand()
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
      has = true
    }
  }
  endCommand()
  return out
}

/**
 * Shell words that lead a command without naming it: `do echo x` runs echo,
 * `if test -f x` runs test. A rule for one of them (`Bash(do:*)`) is never
 * matched; Claude Code checks the command after it.
 */
const LEADS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time'])
/** Shell words that open or close a construct and run nothing themselves: `for f in a b`, `done`, `fi`. */
const CONSTRUCT = new Set(['for', 'select', 'case', 'in', 'done', 'fi', 'esac', 'function'])

/** One command's prefix rule, or null when no prefix of it is a boundary. */
function prefixRule(words: string[]): string | null | undefined {
  // Leading assignments (FOO=bar cmd) don't name the command; only assignments: nothing to allow.
  // Nor do the shell's own words: `do echo $f` is echo; `for f in a b` and `done` are nothing to allow.
  for (;;) {
    if (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1)
    else if (words.length && LEADS.has(words[0]!)) words = words.slice(1)
    else break
  }
  if (words.length && CONSTRUCT.has(words[0]!)) return undefined
  const first = words[0]
  if (first === undefined) return undefined
  if (!WORD.test(first) || NO_PREFIX_RULE.has(first.split('/').pop()!)) return null
  const second = words[1]
  const prefix = TWO_WORD.has(first) && second && WORD.test(second) && !second.startsWith('-') ? `${first} ${second}` : first
  return `Bash(${prefix}:*)`
}

/**
 * What "Always allow" adds to the agent's allowed rules for this request, or
 * null: allowed once only. A shell command gets a prefix rule for each
 * command it runs (`ls -la x; find . | head` is `Bash(ls:*)`, `Bash(find:*)`
 * and `Bash(head:*)`, one per line: Claude Code asks about each command of a
 * line on its own, so a rule for the first alone would ask again), never a
 * bare `Bash`, which would allow every command. A line with a command that
 * runs other code (a shell, sudo, an interpreter), or that can't be read,
 * gets none. Another tool is its name (`Read`, `WebFetch`, `mcp__…`).
 */
export function ruleFor(toolName: string, inputPreview: string): string | null {
  if (toolName !== 'Bash') return /^[A-Za-z0-9_:.-]{1,120}$/.test(toolName) ? toolName : null
  const command = commandOf(inputPreview)
  if (!command) return null
  const commands = commandsOf(command)
  if (!commands?.length) return null
  const rules: string[] = []
  for (const words of commands) {
    const r = prefixRule(words)
    if (r === null) return null
    if (r && !rules.includes(r)) rules.push(r)
  }
  return rules.length && rules.length <= MAX_RULES ? rules.join('\n') : null
}

/** A request's rule as the rules it is (one per line). */
export const rulesOf = (rule: string | null | undefined): string[] => (rule ? rule.split('\n').filter(Boolean) : [])

/**
 * The channel's own tools (speaking, listening, and its crew's projects and
 * tasks: reply, read_history, list_conversations, list_projects,
 * propose_project, list_tasks, add_task, update_task), as Claude
 * Code names a plugin's MCP server: `mcp__plugin_<plugin>_<server>`, here
 * plugin `cmdr` (.claude-plugin/plugin.json) and server `cmdr` (.mcp.json).
 * A server-level rule allows all of them. They are the agent's only way to
 * speak, listen and track its work, and cmdr.mc already decides what each may do, so asking a
 * person before each reply would only stall it (Engineering's agents asked
 * to list their own conversations, 2026-10-27).
 */
export const OWN_TOOLS_RULE = 'mcp__plugin_cmdr_cmdr'

/**
 * Add `rule` to `permissions.allow` in the agent's own ~/.claude/settings.json,
 * keeping everything else; written beside and renamed, so a reader never sees
 * half a file. A file whose `permissions.allow` isn't a list is left alone
 * (it says something we can't read; overwriting it would lose that).
 */
export function addAllowRule(settingsPath: string, rule: string, log: (line: string) => void): { ok: boolean; alreadyPresent: boolean } {
  let tmp: string | null = null
  try {
    let raw = '{}'
    try {
      raw = readFileSync(settingsPath, 'utf8')
    } catch {
      /* no file yet: start one */
    }
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, alreadyPresent: false }
    const settings = parsed as Record<string, unknown>
    const permissions = (settings.permissions ?? {}) as Record<string, unknown>
    if ('allow' in permissions && !Array.isArray(permissions.allow)) {
      log(`not adding ${rule}: permissions.allow in ${settingsPath} isn't a list`)
      return { ok: false, alreadyPresent: false }
    }
    const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as string[])] : []
    if (allow.includes(rule)) return { ok: true, alreadyPresent: true }
    settings.permissions = { ...permissions, allow: [...allow, rule] }
    tmp = `${settingsPath}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, settingsPath)
    tmp = null
    return { ok: true, alreadyPresent: false }
  } catch (e) {
    log(`adding ${rule} to ${settingsPath} failed: ${e}`)
    if (tmp) rmSync(tmp, { force: true })
    return { ok: false, alreadyPresent: false }
  }
}

// ── asking without waiting ─────────────────────────────────────────────

/** What a PermissionRequest hook hands the channel (hook.ts), checked. */
/** `cwd`: the session's working folder when it asked (a script's relative path is from there). */
export type PermissionAsk = { toolName: string; toolInput: Record<string, unknown>; cwd?: string }

export function checkAsk(raw: unknown): PermissionAsk | null {
  const a = raw as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown } | null
  if (!a || typeof a.tool_name !== 'string' || !a.tool_name) return null
  const input = a.tool_input
  return { toolName: a.tool_name, toolInput: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}, ...(typeof a.cwd === 'string' && a.cwd ? { cwd: a.cwd } : {}) }
}

/** The channel's answer to the hook: Claude Code's PermissionRequest decision. */
export type PermissionAnswer = { behavior: 'allow' } | { behavior: 'deny'; message: string } | { behavior: 'passive' }

/** What the hook prints for Claude Code. A refusal never interrupts: the turn goes on. */
export function hookOutput(a: PermissionAnswer): string {
  // No decision: Claude Code's own prompt asks the operator at the terminal (a local agent, local-agents design § 3.3).
  if (a.behavior === 'passive') return ''
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: a.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: a.message, interrupt: false } } })
}

/** JSON with its keys sorted, so the same input is the same text however it was built. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/**
 * Which calls are the same call, for a decision to cover: a shell command by
 * its command alone (its description and timeout are the agent's words, not
 * what runs), any other tool by its whole input. A command that runs a script
 * file by the file's contents too (`script`, its sha256): allowed, it goes
 * through only while the file is what the card showed.
 */
export function callKey(a: PermissionAsk, script?: string | null): string {
  if (a.toolName === 'Bash' && typeof a.toolInput.command === 'string') return `Bash\n${a.toolInput.command}${script ? `\n${script}` : ''}`
  return `${a.toolName}\n${stable(a.toolInput)}`
}

/** What cmdr.mc's card shows of the input, and of a script (it keeps 4000 characters, cut short past that). */
export const PREVIEW_MAX = 4000
const cap = (text: string) => (text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX - 1)}…`)
export function previewOf(input: Record<string, unknown>): string {
  return cap(JSON.stringify(input))
}

/** Interpreters that run the file they're given (the first word that isn't a flag). */
const RUNS_FILE = new Set(['sh', 'bash', 'zsh', 'dash', 'python', 'python3', 'node', 'bun', 'deno', 'perl', 'ruby'])
/** Flags that hand an interpreter its code inline, or on stdin: no file. */
const INLINE = new Set(['-c', '-e', '-', '--eval', '--print', '-p', '-m'])

/**
 * The script file a command runs, when it's one command that does
 * (`bash x.sh`, `python3 /tmp/…/x.py --flag`, `./x.sh`), resolved from the
 * session's folder; null for anything else (a line of several, a pipe, a
 * redirect, a substitution, quotes, code given inline).
 */
export function scriptOf(command: string, cwd?: string): string | null {
  const line = command.trim()
  if (!line || /[;&|<>`$()\n'"\\{}]/.test(line)) return null
  const words = line.split(/\s+/)
  const first = words[0]!
  let path: string | undefined
  if (RUNS_FILE.has(first)) {
    for (const w of words.slice(1)) {
      if (INLINE.has(w)) return null
      if (!w.startsWith('-')) {
        path = w
        break
      }
    }
  } else if (first.includes('/')) path = first
  if (!path) return null
  return isAbsolute(path) ? path : cwd ? resolve(cwd, path) : null
}

/** A script past this size isn't read: the card says it runs it, with no contents. */
const SCRIPT_READ_MAX = 1024 * 1024

/** The script, as the card shows it (cut short past PREVIEW_MAX), and its sha256 (callKey); null when it can't be read. */
export function readScript(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): { preview: string; sha256: string } | null {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > SCRIPT_READ_MAX) return null
    const content = read(path)
    return { preview: cap(content), sha256: createHash('sha256').update(content).digest('hex') }
  } catch {
    return null
  }
}

/** Why, in the agent's words: a shell command's description, when it gave one. */
export function descriptionOf(a: PermissionAsk): string {
  const d = a.toolInput.description
  return typeof d === 'string' ? d.slice(0, 2000) : ''
}

/** cmdr.mc's request id: lowercase letters, unique per agent. Ours now, not Claude Code's. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => String.fromCharCode(97 + (b % 26))).join('')
}

/** Tools whose whole point is a person at this session's terminal, which nobody watches. */
const AT_THE_TERMINAL = new Set(['AskUserQuestion'])

/** What the agent is told, in the call's result and when it's decided. `what`: the call, as one line (activity.ts). */
export const say = {
  atTheTerminal: (tool: string) =>
    AT_THE_TERMINAL.has(tool) ? `Nobody sees this session, so ${tool} can't be answered. Ask in the conversation with reply instead, end your turn, and you'll hear the answer as a message.` : null,
  asked: (what: string, home: string) =>
    `Not yet: this needs permission (${what}). The people who direct your crew have been asked on a card in #${home}. You're not blocked: keep answering messages and carry on with anything that doesn't need this. Don't try to get the same result another way. You'll get a message when they decide; if they allow it, make exactly this call again and it will go through.`,
  stillAsked: (what: string, home: string) =>
    `Still waiting for permission (${what}): it's on a card in #${home}, not decided yet. Carry on with something else; you'll get a message when they decide.`,
  refusedNow: (what: string) => `Refused: your crew's rules don't allow this (${what}). Don't try it another way; if you need it, say why in your home channel.`,
  nowhere: (what: string) => `Refused: this needs permission (${what}) and there's no home channel to ask in. Don't try it another way; say what you need with reply.`,
  tooLong: (what: string, scratchpad: string) =>
    `Refused: this command is too long for anyone to review on a permission card (${what}). Write it to a script file in your scratchpad directory (under ${scratchpad}/) with the Write tool, then run that file as a single command (e.g. \`bash <path>\` or \`python3 <path>\`): the card shows the script, and asks once.`,
  unreachable: (what: string) => `Refused for now: this needs permission (${what}) and cmdr couldn't be reached to ask. Don't try it another way; try again in a few minutes.`,
  allowed: (what: string) => `Permission granted (${what}). Make exactly the same call again now and it will go through, once; then carry on where you left off. No need to reply to this.`,
  refused: (what: string) => `Permission refused (${what}). Don't do it, and don't try to get the same result another way; if you still need it, explain why in your home channel. No need to reply to this.`,
  withdrawn: (what: string) => `Your permission request (${what}) is no longer waiting: nobody decided it. If you still need it, make the call again to ask again. No need to reply to this.`,
}
