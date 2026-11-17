// A local agent's session claims its state directory (local-agent sessions design 0.1.6 § 3.4; ADR-055): one live
// session per directory, so two sessions never share `link.json` or the hooks' `activity.sock`.
//
// The claim is an exclusive lock on `<dir>/activity.lock`, held for the process's life and released by the kernel when
// the process dies, SIGKILL included. In order, and only in this order (the design names what each other order
// broke: probing before the lock let two starts both bind, 2 of 30; removing without a probe took over a live
// session):
//
//   1. lock      refused: another session holds the directory → `state-dir-in-use`; nothing probed, nothing removed
//   2. probe     once, while holding the lock: a server answers → a session from before this lock existed holds the
//                socket → `state-dir-in-use`, nothing removed (the lock is let go)
//   3. remove    silence: the socket file is stale (a live owner would hold the lock, or answer) → removed
//   4. bind      the hooks' server, on the now-free path
//
// Only the lock's holder probes or removes, so neither can race. External mode only: a box's start keeps its own
// remove-and-rebind (server.ts), unchanged.
import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'activity.lock'
export const ACTIVITY_SOCK_FILE = 'activity.sock'
/** How long a probe of the directory's socket waits for an answer: a live hooks server answers locally at once. */
export const STATE_DIR_PROBE_MS = 1_000

/** The start's refusal, said in the line the other start refusals use. */
export class StateDirInUse extends Error {
  readonly code = 'state-dir-in-use'
  constructor(dir: string, why: 'locked' | 'answering') {
    super(
      why === 'locked'
        ? `state-dir-in-use: another session of this agent is running in ${dir}. Start this one with its own CMDR_STATE_DIR (for example …/sessions/<name>).`
        : `state-dir-in-use: a session started by an older cmdr plugin is still running in ${dir}. End it, or start this one with its own CMDR_STATE_DIR.`,
    )
  }
}

export type Lock = { release(): void }
export type ClaimDeps<S> = {
  /** Take the exclusive lock on this path without waiting; null when another process holds it. */
  lock: (path: string) => Lock | null
  /** Whether a server answers on this unix socket. */
  probe: (sock: string) => Promise<boolean>
  rm: (sock: string) => void
  bind: (sock: string) => S
  /** A test's seam between taking the lock and the rest (PL-8): never set in production, never an environment variable. */
  afterLock?: () => Promise<void>
}

/** Claim `dir` for this session and bind its hooks' server, or throw `StateDirInUse`. */
export async function claimStateDir<S>(dir: string, deps: ClaimDeps<S>): Promise<{ server: S; lock: Lock }> {
  const sock = join(dir, ACTIVITY_SOCK_FILE)
  const lock = deps.lock(join(dir, LOCK_FILE))
  if (!lock) throw new StateDirInUse(dir, 'locked')
  await deps.afterLock?.()
  if (await deps.probe(sock)) {
    lock.release()
    throw new StateDirInUse(dir, 'answering')
  }
  deps.rm(sock)
  return { server: deps.bind(sock), lock }
}

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
let libc: { symbols: { flock: (fd: number, op: number) => number } } | null = null
const flock = (fd: number, op: number) => {
  libc ??= dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }) as never
  return libc!.symbols.flock(fd, op)
}
/** Descriptors of the locks this process holds: kept referenced, never closed while held (closing would let go). */
const held = new Set<number>()

/** flock(2), exclusive and non-blocking, on its own open file description: the kernel lets go when this process ends. */
export function flockExclusive(path: string): Lock | null {
  const fd = openSync(path, 'a', 0o600)
  if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)
    return null
  }
  held.add(fd)
  return {
    release() {
      if (!held.delete(fd)) return
      flock(fd, LOCK_UN)
      closeSync(fd)
    },
  }
}

/** Whether a server answers on this unix socket within `ms`: any HTTP answer is one (a pre-lock plugin answers every path). */
export async function probeSocket(sock: string, ms = STATE_DIR_PROBE_MS): Promise<boolean> {
  try {
    await fetch('http://cmdr/ping', { unix: sock, signal: AbortSignal.timeout(ms) } as RequestInit)
    return true
  } catch {
    return false
  }
}

export const realClaimDeps = <S>(bind: (sock: string) => S): ClaimDeps<S> => ({
  lock: flockExclusive,
  probe: (sock) => probeSocket(sock),
  rm: (sock) => rmSync(sock, { force: true }),
  bind,
})
