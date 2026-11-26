// When cmdr.mc closes the /conversations socket, whether to try again and when (reconnect-after-rollout design 0.1.5
// § 3 F-2). Pure: the clock and the randomness are the caller's. socket.io reconnects by itself after a lost transport,
// never after the server's own disconnect (`io server disconnect`), so that case is decided here.

/** The refusals that end a connection for good, by the `code` cmdr.mc sends (design § 3 F-1's table). */
export const FINAL_CODES: ReadonlySet<string> = new Set(['revoked', 'session-limit', 'payment-held', 'session-revoked', 'too-many'])
/** The same, by `message`, for a cmdr.mc from before `code`. A 402's message has no fixed text, so an older server's
 *  payment-held refusal reads as not final here and is retried; each retry is refused again until it's paid. */
export const FINAL_MESSAGES: ReadonlySet<string> = new Set(['revoked', 'session-limit', 'Session revoked', 'Too many connections'])

export type Refusal = { code?: string; message?: string }

/** Final: decided on `code` when cmdr.mc sends one, on `message` otherwise. No refusal at all is never final. */
export function isFinal(r: Refusal | null | undefined): boolean {
  if (!r) return false
  if (typeof r.code === 'string' && r.code) return FINAL_CODES.has(r.code)
  return typeof r.message === 'string' && FINAL_MESSAGES.has(r.message)
}

/** The refusal's name for a stamp: its code, else its message, else `none`. */
export const refusalName = (r: Refusal | null | undefined): string => (r?.code || r?.message || 'none').replace(/\s+/g, '-')

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_CAP_MS = 60_000
/** Connected this long, and the next disconnect starts the schedule again from the first step. */
export const RECONNECT_RESET_MS = 60_000

/** The delay before attempt `n` (0-based): 1 s doubling to a 60 s cap, then ±50 % (`rand` in [0, 1)). */
export function nextDelay(n: number, rand: number): number {
  const step = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, n), RECONNECT_CAP_MS)
  return Math.round(step * (0.5 + rand))
}

/** The attempt counter across disconnects: reset by a connection that lasted RECONNECT_RESET_MS. */
export class Backoff {
  private n = 0
  private connectedAt: number | null = null
  constructor(private readonly now: () => number, private readonly rand: () => number) {}
  /** The socket is in (cmdr.mc's `ready`). */
  connected(): void {
    this.connectedAt = this.now()
  }
  /** It closed: a long enough connection starts the schedule again. */
  disconnected(): void {
    if (this.connectedAt !== null && this.now() - this.connectedAt >= RECONNECT_RESET_MS) this.n = 0
    this.connectedAt = null
  }
  /** The next attempt's delay, counting it. */
  next(): number {
    return nextDelay(this.n++, this.rand())
  }
  /** Attempts made since the schedule last started. */
  get attempts(): number {
    return this.n
  }
}
