// Agent home sync, the machine's half (agent home sync design 0.1.33 § 3.2, § 3.4; LOCAL-AGENTS-49 slice 3, LOCAL-AGENTS-54 S2): the one
// implementation of pull, push and release, run in-process by the Mac launcher (cli/launch.ts) and by the box through
// `cmdr-agent home` (cli/home.ts). cmdr.mc holds the manifest and signs every link; this never holds a Google
// credential, never names a bucket, and never logs a path or a byte of content.
//
//   pull     before a session starts: take the lease, then make the local home the manifest, path by path, from
//            three readings, L (the file now), S (the last synced manifest, `.home-state`) and M (the manifest):
//            a path changed locally since S that differs from M is moved to `.home-conflicts/` first (I-7, H-7)
//   push     each tick while running: what changed since S, uploaded (write-once, content-addressed) and committed from
//            S's revision; a lost answer converges through revision-moved (PL-1, H-18)
//   release  push, then let the lease go
//
// Each step first reads where this home lives (`scopeOf`, design 0.1.29): a crew box walks an allowlist, a person's
// machine the denylist, and a platform agent has no home here (`{none: true}`, nothing touched). Each reports how it
// went (`homeReport`, 0.1.25 item 7), and never waits on or fails for that report.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { refusalOf, type HomeEntry, type HomeManifest, type HomeReport, type McClient } from '../agent-client/client.js'
import { HOME_RULES, inHome, MAX_FILE, type HomeScope } from './home-set.js'
import type { Machine } from './machine.js'

/** `.home-state` and `.home-conflicts/` live in the working directory (both outside the home set, § 3.1). */
export const STATE_FILE = '.home-state'
export const CONFLICTS_DIR = '.home-conflicts'
/** At most this much is pushed in one tick; the rest goes next tick (a first push of a big home is spread out). */
export const PUSH_FILES_PER_TICK = 200
export const PUSH_BYTES_PER_TICK = 50 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 60_000
export const UPLOAD_TIMEOUT_MS = 60_000
const BATCH = 500
/** Downloads in flight at once in a pull (design 0.1.28). */
export const PULL_CONCURRENCY = 8
/** A release's push makes at most this many attempts, each rebasing (design 0.1.12 § 3.4), so a clean stop always ends. */
export const RELEASE_PUSH_ATTEMPTS = 3

export type Ctx = {
  client: Pick<McClient, 'homeLease' | 'homeManifest' | 'homeLinks' | 'homeCommit' | 'homeRelease' | 'homeReport' | 'me'>
  machine: Machine
  /** The agent's working directory: `files/`. */
  cwd: string
  /** Claude Code's memory folder for this cwd on this machine: `memory/` (§ 3.2). */
  memoryDir: string
  fetch?: typeof fetch
  now?: () => Date
  /** `/agent/me`'s `runsOn`, when the caller already read it for this step (the box verb reads it once, § 4.5). */
  runsOn?: string | null
  /** Epoch ms: a pull starts no download it couldn't finish by then (design 0.1.28), and says what it left. */
  deadline?: number
}

/** Where this agent runs isn't known (`runsOn` missing, unrecognised, or `/agent/me` unanswered): no step guesses. */
export class HomeScopeUnknown extends Error {
  constructor(runsOn: unknown) {
    super(`scope-unknown: runsOn ${runsOn === undefined || runsOn === null ? 'absent' : JSON.stringify(runsOn)}`)
  }
}

/** A pull that reached its deadline with downloads left (design 0.1.28): what landed stays, and the next attempt keeps it. */
export class PullIncomplete extends Error {
  constructor(readonly fetched: number, readonly remaining: number) {
    super(`pull-incomplete: ${fetched} fetched, ${remaining} remaining`)
  }
}

/** A call that never got an answer names what it was calling (design OQ-5), so an `unreachable:` line says which route. */
async function via<T>(route: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (refusalOf(e).status === null && e instanceof Error && !e.message.startsWith(`${route}: `)) e.message = `${route}: ${e.message}`
    throw e
  }
}

/** `/agent/me`'s `runsOn`, the one reader (the box verb hands it to its machine choice too, LOCAL-AGENTS-53). Null when
 *  the answer has none; throws when `/agent/me` doesn't answer. */
export async function readRunsOn(client: Pick<McClient, 'me'>): Promise<string | null> {
  const me = await via('/agent/me', () => client.me())
  return typeof me.runsOn === 'string' ? me.runsOn : null
}

/**
 * Where this home lives, the one choke point (design 0.1.29), first in each of pull, push and release: `box` and
 * `external` as `runsOn` says; `platform` has no home here (`none`); anything else, absent, or unanswered throws
 * HomeScopeUnknown. Never inferred from a path.
 */
export async function scopeOf(ctx: Pick<Ctx, 'client' | 'runsOn'>): Promise<HomeScope | 'none'> {
  let runsOn: string | null | undefined = ctx.runsOn
  if (runsOn === undefined) {
    try {
      runsOn = await readRunsOn(ctx.client)
    } catch {
      throw new HomeScopeUnknown('unanswered')
    }
  }
  if (runsOn === 'box' || runsOn === 'external') return runsOn
  if (runsOn === 'platform') return 'none'
  throw new HomeScopeUnknown(runsOn)
}

/** Sends a report and forgets it (0.1.25 item 7): an older cmdr.mc's 404 or any failure is said once and never fails a step. */
let reportSaid = false
function report(ctx: Ctx, body: HomeReport) {
  void Promise.resolve()
    .then(() => ctx.client.homeReport(ctx.machine.machineId, { ...body, machineName: ctx.machine.machineName }))
    .catch((e) => {
      if (reportSaid) return
      reportSaid = true
      process.stderr.write(`home report not sent (${refusalOf(e).status ?? 'unreachable'}); sync is unaffected\n`)
    })
}
/** Agent homes off (a cmdr.mc without them, 404, or switched off, 503 home-unavailable): its report route answers the
 *  same, so nothing is reported (design 0.1.15). */
const homesOff = (e: unknown) => { const { status, code } = refusalOf(e); return status === 404 || code === 'home-unavailable' }
const resultOf = (e: unknown) => (e instanceof LeaseLost || refusalOf(e).code === 'lease-held' ? 'held-elsewhere' : 'failed')

/** The last synced manifest, and the lease it was synced under (H725-5): a rebase is safe only under that same lease. */
export type HomeState = { revision: number; entries: Record<string, string>; leaseId?: string }
export type Decision = 'keep' | 'fetch' | 'delete' | 'conflict-then-fetch' | 'conflict-then-delete'

/** Claude Code's project folder name for a working directory: every character not a letter or digit is `-`. */
export const slugOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
/** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug(cwd)>/memory` (§ 3.2): where Claude Code looks on this machine. */
export const memoryDirOf = (cwd: string, env: NodeJS.ProcessEnv = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', slugOf(cwd), 'memory')

/**
 * The H-7 table, pure: what a pull does to one path, from L (local md5 now), S (its md5 when last synced), M (the
 * manifest's). Absent is null.
 */
export function decide(L: string | null, S: string | null, M: string | null): Decision {
  if (L === S) {
    if (M === S) return 'keep'
    return M === null ? (L === null ? 'keep' : 'delete') : 'fetch'
  }
  // Changed locally since the last sync (or never synced).
  if (L === M) return 'keep'
  if (L === null) return M === null ? 'keep' : 'fetch'
  // Never synced and not in the home (design 0.1.24): kept, and the next push adds it. A box pushes at most
  // PUSH_FILES_PER_TICK a tick, so its backlog is exactly these files; setting them aside at each start emptied the home.
  if (S === null && M === null) return 'keep'
  return M === null ? 'conflict-then-delete' : 'conflict-then-fetch'
}

const md5Of = (b: Uint8Array) => createHash('md5').update(b).digest('hex')

/**
 * A file's md5 by its size and mtime, so an unchanged file isn't read every tick (a home can be 500 MB). Git's
 * racy-clean rule (H725-3): a hit counts only when the file's mtime is safely older than when its hash was taken. A
 * file written in the same clock tick as its last hash (same size, same mtime, other bytes) is always read again.
 */
const hashes = new Map<string, { size: number; mtimeMs: number; md5: string; hashedAt: number }>()
/** The mtime resolution assumed: a file's mtime must be at least this much older than its hash to trust the cache. */
export const RACY_MS = 2_000
export function cachedMd5(abs: string, now = Date.now()): string | null {
  let st
  try {
    st = statSync(abs)
  } catch {
    return null
  }
  const hit = hashes.get(abs)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && st.mtimeMs + RACY_MS <= hit.hashedAt) return hit.md5
  const md5 = md5Of(readFileSync(abs))
  hashes.set(abs, { size: st.size, mtimeMs: st.mtimeMs, md5, hashedAt: now })
  return md5
}

/**
 * The home set on disk: home path → absolute file path (exclusions and caps applied; § 3.1). For a `box` home only its
 * allowlist is visited (design 0.1.29): `files/.claude/{skills,agents,commands}`, `files/.claude/CLAUDE.md` and the
 * memory folder. Nothing else under the working directory (a box's HOME) is ever listed or lstat'ed.
 */
export function walk(ctx: Pick<Ctx, 'cwd' | 'memoryDir'>, scope: HomeScope): Map<string, string> {
  const out = new Map<string, string>()
  const judge = (rel: string, file: { size: number; gitDir?: boolean }) => inHome(rel, file, HOME_RULES, scope)
  const visit = (root: string, base: string, prefix: string, inGit: boolean) => {
    let names: string[]
    try {
      names = readdirSync(base)
    } catch {
      return
    }
    // A directory holding `.git` is a checkout: nothing under it is the home's (git is its record, § 1).
    const gitDir = inGit || names.includes('.git')
    for (const n of names) {
      const abs = join(base, n)
      let st
      try {
        // lstat, never stat: a symbolic link is never followed (design 0.1.23). A link out of the home (a box's
        // `.claude/activity/handoffs/<agent>` into the shared workspace) is not the home's, and a pull that moved a file
        // behind one would cross a mount (EXDEV) and stop halfway.
        st = lstatSync(abs, { throwIfNoEntry: false })
      } catch {
        continue
      }
      if (!st || st.isSymbolicLink()) continue
      const rel = `${prefix}${relative(root, abs).split(sep).join('/')}`
      if (st.isDirectory()) {
        // Prune early: an excluded directory isn't walked at all. `files/.claude` itself never is: from version 2 only
        // some of its children are home content (skills, agents, commands, CLAUDE.md), each judged on its own.
        if (rel !== 'files/.claude' && judge(`${rel}/x`, { size: 0 }) === 'excluded') continue
        visit(root, abs, prefix, gitDir)
      } else if (st.isFile() && judge(rel, { size: st.size, gitDir }) === 'ok') out.set(rel, abs)
    }
  }
  if (scope === 'box') {
    // Each allowlisted root is entered only if no step to it is a link (design 0.1.23 holds for the roots too).
    const real = (p: string) => !throughLink(ctx, p)
    for (const d of ['skills', 'agents', 'commands']) {
      if (real(`files/.claude/${d}/x`)) visit(ctx.cwd, join(ctx.cwd, '.claude', d), 'files/', false)
    }
    const claudeMd = join(ctx.cwd, '.claude', 'CLAUDE.md')
    const st = real('files/.claude/CLAUDE.md') ? lstatSync(claudeMd, { throwIfNoEntry: false }) : undefined
    if (st?.isFile() && judge('files/.claude/CLAUDE.md', { size: st.size }) === 'ok') out.set('files/.claude/CLAUDE.md', claudeMd)
  } else visit(ctx.cwd, ctx.cwd, 'files/', false)
  visit(ctx.memoryDir, ctx.memoryDir, 'memory/', false)
  return out
}

/** Whether reaching a home path on this machine goes through a symbolic link (design 0.1.23): such a path is never the home's,
 * so a pull never writes, deletes or sets it aside, whatever the manifest or `.home-state` says. */
export function throughLink(ctx: Pick<Ctx, 'cwd' | 'memoryDir'>, path: string): boolean {
  const memory = path.startsWith('memory/')
  const segs = path.slice(memory ? 7 : 6).split('/')
  let at = memory ? ctx.memoryDir : ctx.cwd
  for (const seg of segs) {
    at = join(at, seg)
    const st = lstatSync(at, { throwIfNoEntry: false })
    if (!st) return false
    if (st.isSymbolicLink()) return true
  }
  return false
}

/** Moves a file, across a mount if it must (EXDEV: copy, then remove), so a set-aside never fails halfway (design 0.1.23). */
export function moveFile(from: string, to: string, rename: (a: string, b: string) => void = renameSync) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    copyFileSync(from, to)
    // Checked before the original goes: a short or failed copy never costs the file.
    if (md5Of(readFileSync(to)) !== md5Of(readFileSync(from))) {
      rmSync(to, { force: true })
      throw new Error('move-copy-mismatch')
    }
    rmSync(from)
  }
}

/** Where a home path lives on this machine. */
export function localPath(ctx: Pick<Ctx, 'cwd' | 'memoryDir'>, path: string): string {
  if (path.startsWith('memory/')) return join(ctx.memoryDir, ...path.slice(7).split('/'))
  return join(ctx.cwd, ...path.slice(6).split('/'))
}

export function readState(cwd: string): HomeState {
  try {
    const j = JSON.parse(readFileSync(join(cwd, STATE_FILE), 'utf8')) as Partial<HomeState>
    if (typeof j.revision === 'number' && j.entries && typeof j.entries === 'object') return { revision: j.revision, entries: j.entries as Record<string, string>, ...(typeof j.leaseId === 'string' ? { leaseId: j.leaseId } : {}) }
  } catch {
    /* never synced */
  }
  return { revision: 0, entries: {} }
}

/** `.home-state`: written only after a manifest was read or a commit answered (§ 9's write site). */
export function writeState(cwd: string, m: HomeManifest | { revision: number; entries: HomeEntry[] }, leaseId: string) {
  const s: HomeState = { revision: m.revision, entries: Object.fromEntries(m.entries.map((e) => [e.path, e.md5])), leaseId }
  const p = join(cwd, STATE_FILE)
  writeFileSync(`${p}.tmp`, JSON.stringify(s))
  renameSync(`${p}.tmp`, p)
}

function writeAtomic(path: string, data: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.home-tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

async function download(ctx: Ctx, url: string, md5: string): Promise<Uint8Array> {
  const res = await via('bucket', () => (ctx.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }))
  if (!res.ok) throw new Error(`bucket: download ${res.status}`)
  const b = new Uint8Array(await res.arrayBuffer())
  if (md5Of(b) !== md5) throw new Error('download md5 mismatch')
  return b
}

export type Pulled = { revision: number; fetched: number; deleted: number; conflicts: number; bytes: number }

/**
 * Takes the lease (or throws its refusal) and makes the local home the manifest (I-7), except a home never committed,
 * which this machine seeds (H-26). Never pushes. A platform agent has no home here: `{none: true}`, no lease, nothing
 * touched. Reports how it went, and never waits on that.
 */
export async function pull(ctx: Ctx): Promise<(Pulled & { leaseId: string }) | { none: true }> {
  const scope = await scopeOf(ctx)
  if (scope === 'none') return { none: true }
  const at = () => (ctx.now?.() ?? new Date()).toISOString()
  try {
    const out = await pullIn(ctx, scope)
    report(ctx, { pull: { at: at(), result: 'ok', fetched: out.fetched, deleted: out.deleted, setAside: out.conflicts } })
    return out
  } catch (e) {
    const done = e instanceof PullIncomplete ? e.fetched : 0
    if (!homesOff(e)) report(ctx, { pull: { at: at(), result: resultOf(e), fetched: done, deleted: 0, setAside: 0 } })
    throw e
  }
}

async function pullIn(ctx: Ctx, scope: HomeScope): Promise<Pulled & { leaseId: string }> {
  const lease = await via('/agent/home/lease', () => ctx.client.homeLease(ctx.machine))
  const m = await via('/agent/home/manifest', () => ctx.client.homeManifest(ctx.machine.machineId))
  // A home never committed (revision 0) is seeded from this machine, not applied to it (design 0.1.21 § 3.4, H-26): every local file is
  // kept, nothing is moved or deleted, and the first push commits them all as revision 1. Applying an empty manifest
  // would set the whole of an existing agent's home aside on its first sync. Another machine seeding at the same time
  // can't also win: the lease is one-holder, and a commit from revision 0 meets revision-moved once one has landed.
  if (m.revision === 0) {
    writeState(ctx.cwd, m, lease.leaseId)
    return { revision: 0, fetched: 0, deleted: 0, conflicts: 0, bytes: 0, leaseId: lease.leaseId }
  }
  const S = readState(ctx.cwd).entries
  const M = new Map(m.entries.map((e) => [e.path, e.md5]))
  // A path the home set excludes is never applied, whatever the manifest or `.home-state` says (design 0.1.22 § 3.1):
  // an entry committed before its rule existed (a box's `files/.cmdr/machine.json`) is not written here, and the push
  // carries it (0.1.27): only cmdr.mc prunes. Never written means never a machine id or a cache swapped under a running start.
  const applies = (p: string) => { const v = inHome(p, { size: 0 }, HOME_RULES, scope); return v !== 'excluded' && v !== 'invalid' && !throughLink(ctx, p) }
  // Only a path in S or M can be anything but `keep` (design 0.1.29): a local file in neither is kept whatever its bytes,
  // so it is never hashed. The walk still decides which local files are the home's (a checkout's, a too-big file's are not).
  const local = walk(ctx, scope)
  const paths = new Set([...Object.keys(S), ...M.keys()].filter(applies))
  const L = new Map<string, string>()
  for (const p of paths) {
    const abs = local.get(p)
    const h = abs ? cachedMd5(abs) : null
    if (h) L.set(p, h)
  }
  const stamp = (ctx.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const toFetch: { path: string; md5: string }[] = []
  const out: Pulled = { revision: m.revision, fetched: 0, deleted: 0, conflicts: 0, bytes: 0 }
  // Every file set aside, so a pull that fails before it's done puts back each one nothing replaced (design 0.1.23): a failed
  // pull leaves the home as it found it, never without the files it had only begun to swap.
  const moved: [string, string][] = []
  // Design 0.1.23's order: set aside, then download, then delete, and `.home-state` only at the end.
  const toDelete: string[] = []
  try {
    for (const path of paths) {
      const d = decide(L.get(path) ?? null, S[path] ?? null, M.get(path) ?? null)
      if (d === 'keep') continue
      const here = localPath(ctx, path)
      if (d.startsWith('conflict')) {
        // The local version goes aside first, never lost and never pushed (`.home-conflicts/` is outside the home set).
        const aside = join(ctx.cwd, CONFLICTS_DIR, stamp, ...path.split('/'))
        moveFile(here, aside)
        moved.push([here, aside])
        out.conflicts += 1
      }
      if (d === 'fetch' || d === 'conflict-then-fetch') toFetch.push({ path, md5: M.get(path)! })
      else if (d === 'delete') toDelete.push(here)
    }
    await fetchAll(ctx, lease.leaseId, toFetch, out)
    for (const here of toDelete) {
      if (!existsSync(here)) continue
      rmSync(here)
      out.deleted += 1
    }
  } catch (e) {
    for (const [here, aside] of moved.reverse()) {
      try {
        if (!existsSync(here) && existsSync(aside)) moveFile(aside, here)
      } catch {
        /* left in .home-conflicts: never lost */
      }
    }
    throw e
  }
  writeState(ctx.cwd, m, lease.leaseId)
  return { ...out, leaseId: lease.leaseId }
}

/**
 * The downloads, PULL_CONCURRENCY at a time, each written the moment it lands (design 0.1.28), so a repeat attempt keeps
 * what landed (L = M: keep). With `ctx.deadline`, no download starts that couldn't finish by it; once the in-flight ones
 * end, what's left throws PullIncomplete. A failed download stops new starts and is thrown once the in-flight ones end.
 */
async function fetchAll(ctx: Ctx, leaseId: string, toFetch: { path: string; md5: string }[], out: Pulled) {
  const byMd5 = new Map<string, string[]>()
  for (const f of toFetch) byMd5.set(f.md5, [...(byMd5.get(f.md5) ?? []), f.path])
  const md5s = [...byMd5.keys()]
  const now = () => (ctx.now?.() ?? new Date()).getTime()
  const late = () => ctx.deadline !== undefined && now() >= ctx.deadline - DOWNLOAD_TIMEOUT_MS
  let failure: unknown = null
  let stopped = false
  let done = 0
  for (let i = 0; i < md5s.length && !stopped; i += BATCH) {
    const batch = md5s.slice(i, i + BATCH)
    const links = await via('/agent/home/links', () => ctx.client.homeLinks(ctx.machine.machineId, { leaseId, read: batch }))
    let next = 0
    const worker = async () => {
      while (!stopped && next < batch.length) {
        if (late()) {
          stopped = true
          return
        }
        const md5 = batch[next++]!
        try {
          const b = await download(ctx, links.read[md5]!, md5)
          for (const path of byMd5.get(md5)!) {
            writeAtomic(localPath(ctx, path), b)
            out.fetched += 1
            out.bytes += b.length
          }
          done += 1
        } catch (e) {
          failure ??= e
          stopped = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PULL_CONCURRENCY, batch.length) }, worker))
  }
  if (failure) throw failure
  if (done < md5s.length) throw new PullIncomplete(out.fetched, toFetch.length - out.fetched)
}

export class LeaseLost extends Error {
  constructor() {
    super('lease-lost')
  }
}

/**
 * The home moved while this machine didn't hold the lease (H725-5): `.home-state` was synced under another lease, and
 * the manifest is past it. Pushing would overwrite another machine's work; the caller pulls instead, which sets this
 * machine's changes aside in .home-conflicts/.
 */
export class HomeMoved extends Error {
  constructor() {
    super('home-moved')
  }
}

/** `backlog`: the files this tick left for the next (0 unless `more`), counted in the same loop (plan 0.1.1 F-1). */
export type Pushed = { committed: boolean; put: number; deleted: number; uploaded: number; more: boolean; backlog: number }

/**
 * What changed since `.home-state`, pushed: blobs not `present` uploaded through their write-once links, then one
 * commit from S's revision. blob-missing: links again for those, upload, commit once more in the same tick (H-14).
 * revision-moved: re-read the manifest; if it holds every put at its md5 and none of the deletes, that was this
 * machine's own commit whose answer was lost, and `.home-state` takes it (PL-1, H-18); otherwise next tick.
 * lease-lost: throws LeaseLost (the launcher stops the session; the entries are kept by cmdr.mc as unmerged).
 * A platform agent has no home here: `{none: true}`. Reports how it went, and never waits on that.
 */
export async function push(ctx: Ctx, leaseId: string): Promise<Pushed | { none: true }> {
  const scope = await scopeOf(ctx)
  if (scope === 'none') return { none: true }
  return pushIn(ctx, leaseId, scope)
}

async function pushIn(ctx: Ctx, leaseId: string, scope: HomeScope): Promise<Pushed> {
  const at = () => (ctx.now?.() ?? new Date()).toISOString()
  try {
    const out = await pushOnce(ctx, leaseId, scope)
    report(ctx, { push: { at: at(), result: 'ok', put: out.put, deleted: out.deleted, backlog: out.backlog } })
    return out
  } catch (e) {
    const code = e instanceof LeaseLost ? 'lease-lost' : e instanceof HomeMoved ? 'home-moved' : refusalOf(e).code
    if (!homesOff(e)) report(ctx, { push: { at: at(), result: resultOf(e), put: 0, deleted: 0, backlog: 0, ...(code ? { refusal: code.slice(0, 64) } : {}) } })
    throw e
  }
}

async function pushOnce(ctx: Ctx, leaseId: string, scope: HomeScope): Promise<Pushed> {
  const state = readState(ctx.cwd)
  // Synced under another lease (a lapse, a box's fresh lease per call): only safe if nobody moved the home since.
  if (state.leaseId !== leaseId) {
    const m = await via('/agent/home/manifest', () => ctx.client.homeManifest(ctx.machine.machineId))
    if (m.revision !== state.revision) throw new HomeMoved()
    writeState(ctx.cwd, m, leaseId)
    state.leaseId = leaseId
  }
  const local = walk(ctx, scope)
  const changed: { path: string; abs: string }[] = []
  for (const [p, abs] of local) changed.push({ path: p, abs })
  // The carry rule (design 0.1.27): a synced path the walk didn't yield is deleted from the home only if it is home
  // content by today's rules, isn't behind a symbolic link here (design 0.1.23: it may be a real file on another
  // machine), and has no file here at all. An entry a newer rule excludes (an older launcher's), or a file this machine
  // has but doesn't walk, is carried in the manifest as it is, never deleted for another machine's sake.
  const homeContent = (p: string) => { const v = inHome(p, { size: 0 }, HOME_RULES, scope); return v !== 'excluded' && v !== 'invalid' }
  const del = Object.keys(state.entries).filter((p) => !local.has(p) && homeContent(p) && !throughLink(ctx, p) && !existsSync(localPath(ctx, p)))
  // Read each candidate once: its bytes are what is hashed and what is uploaded (never two readings, R862-1).
  const put: (HomeEntry & { bytes: Uint8Array })[] = []
  let bytes = 0
  let more = false
  let backlog = 0
  for (const c of changed) {
    // Unchanged since the last sync (by the cached hash): not read at all.
    if (state.entries[c.path] && cachedMd5(c.abs) === state.entries[c.path]) continue
    // Past this tick's cap: only counted (a never-synced file is a candidate unread; a synced one by its cached hash).
    if (more) {
      backlog += 1
      continue
    }
    let b: Uint8Array
    try {
      b = readFileSync(c.abs)
    } catch {
      continue // gone since the walk: next tick
    }
    if (b.length > MAX_FILE) continue
    const md5 = md5Of(b)
    if (state.entries[c.path] === md5) continue
    if (put.length >= PUSH_FILES_PER_TICK || bytes + b.length > PUSH_BYTES_PER_TICK) {
      more = true
      backlog += 1
      continue
    }
    put.push({ path: c.path, md5, size: b.length, bytes: b })
    bytes += b.length
  }
  if (!put.length && !del.length) return { committed: false, put: 0, deleted: 0, uploaded: 0, more: false, backlog: 0 }
  const id = ctx.machine.machineId
  let uploaded = 0
  const upload = async (entries: typeof put) => {
    const want = [...new Map(entries.map((e) => [e.md5, e])).values()]
    for (let i = 0; i < want.length; i += BATCH) {
      const batch = want.slice(i, i + BATCH)
      let links
      try {
        links = await via('/agent/home/links', () => ctx.client.homeLinks(id, { leaseId, write: batch.map((e) => ({ md5: e.md5, size: e.size })) }))
      } catch (e) {
        if (refusalOf(e).code === 'lease-lost') throw new LeaseLost()
        throw e
      }
      for (const e of batch) {
        const w = links.write[e.md5]
        if (!w) continue // present
        const res = await via('bucket', () => (ctx.fetch ?? fetch)(w.url, { method: w.method, headers: w.headers, body: e.bytes, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }))
        // 412: someone (this machine, a moment ago) already wrote it; write-once means its bytes are these.
        if (!res.ok && res.status !== 412) throw new Error(`bucket: upload ${res.status}`)
        uploaded += 1
      }
    }
  }
  await upload(put)
  const body = { leaseId, baseRevision: state.revision, put: put.map(({ path, md5, size }) => ({ path, md5, size })), delete: del, homeRules: HOME_RULES }
  const commitOnce = async () => via('/agent/home/commit', () => ctx.client.homeCommit(id, body))
  let answer
  try {
    answer = await commitOnce()
  } catch (e) {
    const r = refusalOf(e)
    if (r.code === 'lease-lost') throw new LeaseLost()
    if (r.code === 'blob-missing') {
      const missing = new Set(Array.isArray(r.detail?.md5s) ? (r.detail!.md5s as string[]) : put.map((p) => p.md5))
      await upload(put.filter((p) => missing.has(p.md5)))
      answer = await commitOnce().catch((e2) => {
        if (refusalOf(e2).code === 'lease-lost') throw new LeaseLost()
        throw e2
      })
    } else if (r.code === 'revision-moved') {
      const m = await via('/agent/home/manifest', () => ctx.client.homeManifest(id))
      const M = new Map(m.entries.map((x) => [x.path, x.md5]))
      const ours = put.every((p) => M.get(p.path) === p.md5) && del.every((p) => !M.has(p))
      // Rebase on it either way (H725-1): only the lease holder commits, so the manifest is what this machine already
      // landed (a commit whose answer was lost). Keeping the stale revision would refuse every later commit forever.
      // Ours exactly: done. Otherwise what differs (an edit made since) is committed from here on the next push.
      writeState(ctx.cwd, m, leaseId)
      if (ours) return { committed: true, put: put.length, deleted: del.length, uploaded, more, backlog }
      return { committed: false, put: 0, deleted: 0, uploaded, more: true, backlog: backlog + put.length }
    } else throw e
  }
  writeState(ctx.cwd, answer, leaseId)
  return { committed: true, put: put.length, deleted: del.length, uploaded, more, backlog }
}

/** A clean end: push what's left, then let the lease go. A failure to release is fine: the lease expires (5 min). */
export async function release(ctx: Ctx, leaseId: string): Promise<{ pushed: Pushed | null; unpushed: boolean } | { none: true }> {
  const scope = await scopeOf(ctx)
  if (scope === 'none') return { none: true }
  let pushed: Pushed | null = null
  try {
    // At most RELEASE_PUSH_ATTEMPTS, each rebasing (H725-1; design 0.1.12), so a clean stop always ends. Anything still
    // unpushed stays on this machine, and is said (`unpushed`); if it differs from the home, the next pull here sets
    // it aside in .home-conflicts/, so it's never lost.
    for (let i = 0; i < RELEASE_PUSH_ATTEMPTS; i++) {
      pushed = await pushIn(ctx, leaseId, scope)
      if (!pushed.more) break
    }
  } catch (e) {
    if (e instanceof LeaseLost) return { pushed: null, unpushed: true }
    if (!(e instanceof HomeMoved)) throw e
    // The home moved under another machine: nothing is pushed over it. The changes stay here; the next pull sets them
    // aside. The lease is still let go.
    await ctx.client.homeRelease(ctx.machine.machineId, leaseId).catch(() => undefined)
    return { pushed: null, unpushed: true }
  }
  await ctx.client.homeRelease(ctx.machine.machineId, leaseId).catch(() => undefined)
  return { pushed, unpushed: !!pushed?.more }
}
