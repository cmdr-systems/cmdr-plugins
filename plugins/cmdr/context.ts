// How full the agent's context is, for its card and its picture in cmdr.app
// (decided 2026-11-01: everyone in its organization sees it, as a ring
// around its picture; at 95% it will restart itself rather than compact).
//
// Two sources, both Claude Code's own:
//   - its status line (statusline.ts): Claude Code runs it after every
//     assistant message and hands it the live window, the tokens in it and
//     the percentage used (`context_window`), measured by the harness, so
//     a 200k session and a 1M one each read true. The box's launcher points
//     the agent's status line at it (crew-launch pointStatusLine).
//   - its transcript (the status line says where): how many times this
//     session was compacted (`compact_boundary` rows) and when it started.
//     Read once from the start, then only what was added since: a session's
//     transcript runs to hundreds of megabytes.
//
// A compacted session is full (BUGS-9): cmdr.mc reads one with a compaction,
// or one this channel said is about to compact (`compacting`, the PreCompact
// hook), as 100%, and Doc restarts it fresh.
//
// Pure but for the reads the counter is handed.

/** What the status line hands over, checked. */
export type StatusContext = {
  /** Tokens in the window on the last call (input, cache reads and writes); null before the first call, and just after a compaction. */
  tokens: number | null
  /** The window's size: 200000, or 1000000 for an extended-context model. */
  window: number
  /** Of the window, used, 0–100; null when Claude Code couldn't say yet. */
  percent: number | null
  model: string | null
  sessionId: string | null
  transcriptPath: string | null
}

/** The session's compactions so far, and when it started (its transcript's first row). */
export type Compactions = { count: number; lastAt: string | null; startedAt: string | null }

/** What goes to cmdr.mc as `agent:context`. `compacting`: Claude Code is about to compact this session (the PreCompact
 *  hook, BUGS-9): cmdr.mc reads it as full from then on, and Doc restarts it fresh. */
export type ContextReport = Omit<StatusContext, 'transcriptPath'> & { sessionStartedAt: string | null; compactions: number; lastCompactAt: string | null; compacting?: true }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null)

/** The status line's input (Claude Code's JSON), as far as context goes; null when it carries none. */
export function readStatusLine(raw: unknown): StatusContext | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const cw = (r.context_window && typeof r.context_window === 'object' ? r.context_window : null) as Record<string, unknown> | null
  const window = num(cw?.context_window_size)
  if (!cw || !window) return null
  // The tokens as the percentage counts them: input only (input, cache reads, cache writes), never output.
  const usage = (cw.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null) as Record<string, unknown> | null
  const fromUsage = usage ? (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) : null
  const tokens = fromUsage ?? num(cw.total_input_tokens)
  const given = num(cw.used_percentage)
  const percent = given !== null ? Math.min(100, given) : tokens !== null ? Math.min(100, (tokens / window) * 100) : null
  const model = r.model && typeof r.model === 'object' ? str((r.model as Record<string, unknown>).id) : null
  const path = str(r.transcript_path, 1024)
  return {
    tokens,
    window,
    percent: percent === null ? null : Math.round(percent * 10) / 10,
    model,
    sessionId: str(r.session_id),
    // Only a transcript (a .jsonl, absolute): the channel reads it.
    transcriptPath: path && path.startsWith('/') && path.endsWith('.jsonl') && !path.includes('/../') ? path : null,
  }
}

/** Compactions and the first row's time, in whole transcript lines. */
export function compactionsIn(lines: string[], into: Compactions = { count: 0, lastAt: null, startedAt: null }): Compactions {
  const out = { ...into }
  for (const line of lines) {
    if (!line) continue
    const first = out.startedAt === null
    // Only rows that could be a boundary are parsed (and the first, for its time): most of a transcript is neither.
    if (!first && !line.includes('"compact_boundary"')) continue
    let row: { type?: string; subtype?: string; timestamp?: string }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (first && typeof row.timestamp === 'string') out.startedAt = row.timestamp
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      out.count++
      out.lastAt = typeof row.timestamp === 'string' ? row.timestamp : out.lastAt
    }
  }
  return out
}

export type TranscriptIo = { size(path: string): Promise<number>; read(path: string, from: number, length: number): Promise<Buffer> }

/** At most this much read at a time: a first read of a long session goes in pieces. */
const CHUNK = 4 * 1024 * 1024

/**
 * A session's compactions, kept up to date from its transcript: the first call
 * reads it whole, later ones only what was added since. Another transcript
 * (a new session), or this one shorter than read (replaced), starts over.
 */
export class CompactionCounter {
  private path: string | null = null
  private offset = 0
  private rest = ''
  private seen: Compactions = { count: 0, lastAt: null, startedAt: null }

  constructor(private readonly io: TranscriptIo) {}

  async update(path: string): Promise<Compactions> {
    const size = await this.io.size(path)
    if (path !== this.path || size < this.offset) {
      this.path = path
      this.offset = 0
      this.rest = ''
      this.seen = { count: 0, lastAt: null, startedAt: null }
    }
    while (this.offset < size) {
      const length = Math.min(CHUNK, size - this.offset)
      const buf = await this.io.read(path, this.offset, length)
      if (!buf.length) break
      this.offset += buf.length
      const lines = (this.rest + buf.toString('utf8')).split('\n')
      // The last piece may be a row still being written: kept for the next read.
      this.rest = lines.pop() ?? ''
      this.seen = compactionsIn(lines, this.seen)
    }
    return { ...this.seen }
  }
}
