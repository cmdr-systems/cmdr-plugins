// Agent home sync, the machine's half (agent home sync design 0.1.9 § 3.2, § 3.4; LOCAL-AGENTS-49 slice 3): the one
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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { refusalOf, type HomeEntry, type HomeManifest, type McClient } from '../agent-client/client.js'
import { inHome, MAX_FILE } from './home-set.js'
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
/** A release's push makes at most this many attempts, each rebasing (design 0.1.12 § 3.4), so a clean stop always ends. */
export const RELEASE_PUSH_ATTEMPTS = 3

export type Ctx = {
  client: Pick<McClient, 'homeLease' | 'homeManifest' | 'homeLinks' | 'homeCommit' | 'homeRelease'>
  machine: Machine
  /** The agent's working directory: `files/`. */
  cwd: string
  /** Claude Code's memory folder for this cwd on this machine: `memory/` (§ 3.2). */
  memoryDir: string
  fetch?: typeof fetch
  now?: () => Date
}

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

/** The home set on disk: home path → absolute file path (exclusions and caps applied; § 3.1). */
export function walk(ctx: Pick<Ctx, 'cwd' | 'memoryDir'>): Map<string, string> {
  const out = new Map<string, string>()
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
        st = statSync(abs, { throwIfNoEntry: false })
      } catch {
        continue
      }
      if (!st) continue
      const rel = `${prefix}${relative(root, abs).split(sep).join('/')}`
      if (st.isDirectory()) {
        // Prune early: an excluded directory isn't walked at all.
        if (inHome(`${rel}/x`, { size: 0 }) === 'excluded') continue
        visit(root, abs, prefix, gitDir)
      } else if (st.isFile() && inHome(rel, { size: st.size, gitDir }) === 'ok') out.set(rel, abs)
    }
  }
  visit(ctx.cwd, ctx.cwd, 'files/', false)
  visit(ctx.memoryDir, ctx.memoryDir, 'memory/', false)
  return out
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
  const res = await (ctx.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`download ${res.status}`)
  const b = new Uint8Array(await res.arrayBuffer())
  if (md5Of(b) !== md5) throw new Error('download md5 mismatch')
  return b
}

export type Pulled = { revision: number; fetched: number; deleted: number; conflicts: number; bytes: number }

/** Takes the lease (or throws its refusal) and makes the local home the manifest (I-7). Never pushes. */
export async function pull(ctx: Ctx): Promise<Pulled & { leaseId: string }> {
  const lease = await ctx.client.homeLease(ctx.machine)
  const m = await ctx.client.homeManifest(ctx.machine.machineId)
  const S = readState(ctx.cwd).entries
  const M = new Map(m.entries.map((e) => [e.path, e.md5]))
  const local = walk(ctx)
  const L = new Map<string, string>()
  for (const [p, abs] of local) {
    const h = cachedMd5(abs)
    if (h) L.set(p, h)
  }
  const paths = new Set([...L.keys(), ...Object.keys(S), ...M.keys()])
  const stamp = (ctx.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const toFetch: { path: string; md5: string }[] = []
  const out: Pulled = { revision: m.revision, fetched: 0, deleted: 0, conflicts: 0, bytes: 0 }
  for (const path of paths) {
    const d = decide(L.get(path) ?? null, S[path] ?? null, M.get(path) ?? null)
    if (d === 'keep') continue
    const here = localPath(ctx, path)
    if (d.startsWith('conflict')) {
      // The local version goes aside first, never lost and never pushed (`.home-conflicts/` is outside the home set).
      const aside = join(ctx.cwd, CONFLICTS_DIR, stamp, ...path.split('/'))
      mkdirSync(dirname(aside), { recursive: true })
      renameSync(here, aside)
      out.conflicts += 1
    }
    if (d === 'fetch' || d === 'conflict-then-fetch') toFetch.push({ path, md5: M.get(path)! })
    else if (d === 'delete' && existsSync(here)) {
      rmSync(here)
      out.deleted += 1
    }
  }
  const md5s = [...new Set(toFetch.map((f) => f.md5))]
  for (let i = 0; i < md5s.length; i += BATCH) {
    const links = await ctx.client.homeLinks(ctx.machine.machineId, { leaseId: lease.leaseId, read: md5s.slice(i, i + BATCH) })
    const got = new Map<string, Uint8Array>()
    for (const md5 of md5s.slice(i, i + BATCH)) got.set(md5, await download(ctx, links.read[md5]!, md5))
    for (const f of toFetch.filter((x) => got.has(x.md5))) {
      writeAtomic(localPath(ctx, f.path), got.get(f.md5)!)
      out.fetched += 1
      out.bytes += got.get(f.md5)!.length
    }
  }
  writeState(ctx.cwd, m, lease.leaseId)
  return { ...out, leaseId: lease.leaseId }
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

export type Pushed = { committed: boolean; put: number; deleted: number; uploaded: number; more: boolean }

/**
 * What changed since `.home-state`, pushed: blobs not `present` uploaded through their write-once links, then one
 * commit from S's revision. blob-missing: links again for those, upload, commit once more in the same tick (H-14).
 * revision-moved: re-read the manifest; if it holds every put at its md5 and none of the deletes, that was this
 * machine's own commit whose answer was lost, and `.home-state` takes it (PL-1, H-18); otherwise next tick.
 * lease-lost: throws LeaseLost (the launcher stops the session; the entries are kept by cmdr.mc as unmerged).
 */
export async function push(ctx: Ctx, leaseId: string): Promise<Pushed> {
  const state = readState(ctx.cwd)
  // Synced under another lease (a lapse, a box's fresh lease per call): only safe if nobody moved the home since.
  if (state.leaseId !== leaseId) {
    const m = await ctx.client.homeManifest(ctx.machine.machineId)
    if (m.revision !== state.revision) throw new HomeMoved()
    writeState(ctx.cwd, m, leaseId)
    state.leaseId = leaseId
  }
  const local = walk(ctx)
  const changed: { path: string; abs: string }[] = []
  for (const [p, abs] of local) changed.push({ path: p, abs })
  const del = Object.keys(state.entries).filter((p) => !local.has(p))
  // Read each candidate once: its bytes are what is hashed and what is uploaded (never two readings, R862-1).
  const put: (HomeEntry & { bytes: Uint8Array })[] = []
  let bytes = 0
  let more = false
  for (const c of changed) {
    // Unchanged since the last sync (by the cached hash): not read at all.
    if (state.entries[c.path] && cachedMd5(c.abs) === state.entries[c.path]) continue
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
      break
    }
    put.push({ path: c.path, md5, size: b.length, bytes: b })
    bytes += b.length
  }
  if (!put.length && !del.length) return { committed: false, put: 0, deleted: 0, uploaded: 0, more: false }
  const id = ctx.machine.machineId
  let uploaded = 0
  const upload = async (entries: typeof put) => {
    const want = [...new Map(entries.map((e) => [e.md5, e])).values()]
    for (let i = 0; i < want.length; i += BATCH) {
      const batch = want.slice(i, i + BATCH)
      let links
      try {
        links = await ctx.client.homeLinks(id, { leaseId, write: batch.map((e) => ({ md5: e.md5, size: e.size })) })
      } catch (e) {
        if (refusalOf(e).code === 'lease-lost') throw new LeaseLost()
        throw e
      }
      for (const e of batch) {
        const w = links.write[e.md5]
        if (!w) continue // present
        const res = await (ctx.fetch ?? fetch)(w.url, { method: w.method, headers: w.headers, body: e.bytes, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
        // 412: someone (this machine, a moment ago) already wrote it; write-once means its bytes are these.
        if (!res.ok && res.status !== 412) throw new Error(`upload ${res.status}`)
        uploaded += 1
      }
    }
  }
  await upload(put)
  const body = { leaseId, baseRevision: state.revision, put: put.map(({ path, md5, size }) => ({ path, md5, size })), delete: del }
  const commitOnce = async () => ctx.client.homeCommit(id, body)
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
      const m = await ctx.client.homeManifest(id)
      const M = new Map(m.entries.map((x) => [x.path, x.md5]))
      const ours = put.every((p) => M.get(p.path) === p.md5) && del.every((p) => !M.has(p))
      // Rebase on it either way (H725-1): only the lease holder commits, so the manifest is what this machine already
      // landed (a commit whose answer was lost). Keeping the stale revision would refuse every later commit forever.
      // Ours exactly: done. Otherwise what differs (an edit made since) is committed from here on the next push.
      writeState(ctx.cwd, m, leaseId)
      if (ours) return { committed: true, put: put.length, deleted: del.length, uploaded, more }
      return { committed: false, put: 0, deleted: 0, uploaded, more: true }
    } else throw e
  }
  writeState(ctx.cwd, answer, leaseId)
  return { committed: true, put: put.length, deleted: del.length, uploaded, more }
}

/** A clean end: push what's left, then let the lease go. A failure to release is fine: the lease expires (5 min). */
export async function release(ctx: Ctx, leaseId: string): Promise<{ pushed: Pushed | null; unpushed: boolean }> {
  let pushed: Pushed | null = null
  try {
    // At most RELEASE_PUSH_ATTEMPTS, each rebasing (H725-1; design 0.1.12), so a clean stop always ends. Anything still
    // unpushed stays on this machine, and is said (`unpushed`); if it differs from the home, the next pull here sets
    // it aside in .home-conflicts/, so it's never lost.
    for (let i = 0; i < RELEASE_PUSH_ATTEMPTS; i++) {
      pushed = await push(ctx, leaseId)
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
