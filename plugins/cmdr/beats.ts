/**
 * The health witness files, for an agent on cmdr: the same three files, at the
 * same basenames, in the same format, with the same meanings as the Slack
 * plugin's (design: cmdr-crew-platform-provisioning § 5, row "Health daemon"),
 * so the coordinator's probe and the health daemon's `plugin-dead` /
 * hung verdicts read a cmdr agent exactly as they read a Slack one:
 *
 *   `heartbeat`       plugin-alive: rewritten every 60s WHILE the cmdr.mc
 *                     socket is live; the writer stopping IS the disconnect
 *                     signal (coordinator design 0.1.1 § 4: the probe
 *                     adjudicates staleness at 5 missed beats);
 *   `model-progress`  the Arm-P beat, model-demonstrably-processing: touched
 *                     at the MCP CallTool entry and at reply-complete, NEVER
 *                     on the delivery path;
 *   `delivered`       the delivered witness: touched when an inbound message
 *                     actually reached the session (after the boot gate),
 *                     never before.
 *
 * :warning: A FAITHFUL PORT of `../slack/beats.ts` (the two touchers) plus the
 * heartbeat writer that lives inline in `../slack/server.ts` (~:165-219), not
 * an import of them. Deploy stages each channel module on its own
 * (tools/cmdr-crew.deploy.sh copies a module to `_runtime/<key>` minus its
 * tests), so `../slack/beats.js` resolves on a box only by the accident of
 * both runtimes being staged side by side, and not at all from the plugin
 * cache. A cmdr box must not need the Slack runtime to stay healthy. The
 * readers (health/src/adapters/registry.ts) declare the basenames themselves
 * for the same reason; the three copies must agree, and the tests pin them.
 *
 * Same two properties as the Slack touchers:
 *
 *   fail-open   a witness write never throws into the path carrying real
 *               work: errors go to the injected logger, the caller proceeds;
 *   idempotent  mtime is the beat. The ISO line inside is operator courtesy,
 *               never parsed (the readers stat mtime only).
 *
 * The HOME of all three is the caller's witness dir: `CREW_HEALTH_DIR` when
 * provisioning renders it (the per-agent export dir every cross-uid reader
 * looks in), else the plugin's own `CMDR_STATE_DIR`. Same rule as Slack's.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HEARTBEAT_BASENAME = 'heartbeat'
export const MODEL_PROGRESS_BASENAME = 'model-progress'
export const DELIVERED_BASENAME = 'delivered'
export const HEARTBEAT_INTERVAL_MS = 60_000

function writeBeat(path: string, label: string, logError: (line: string) => void): void {
  try {
    writeFileSync(path, `${new Date().toISOString()} pid=${process.pid}\n`)
  } catch (err) {
    logError(`cmdr channel: ${label} write failed: ${err}\n`)
  }
}

/** The Arm-P toucher, built once at wiring time. */
export function makeModelProgressToucher(witnessDir: string, logError: (line: string) => void): () => void {
  const path = join(witnessDir, MODEL_PROGRESS_BASENAME)
  return () => writeBeat(path, 'model-progress beat', logError)
}

/** The delivered-witness toucher, built once at wiring time. Its call site's
 *  contract: after the session's notification resolved, post boot gate. */
export function makeDeliveredToucher(witnessDir: string, logError: (line: string) => void): () => void {
  const path = join(witnessDir, DELIVERED_BASENAME)
  return () => writeBeat(path, 'delivered witness', logError)
}

export interface Heartbeat {
  /** transport established: write now, then every interval (idempotent) */
  arm(): void
  /** transport lost: stop writing, so the file goes stale */
  disarm(): void
}

/** The plugin-alive heartbeat. Arming keys on TRANSPORT-ESTABLISHED (Slack:
 *  socket 'connected'; here: cmdr.mc's `ready`), so a dead transport reads
 *  plugin-dead, never alive. */
export function makeHeartbeat(
  witnessDir: string,
  logError: (line: string) => void,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): Heartbeat {
  const path = join(witnessDir, HEARTBEAT_BASENAME)
  let timer: ReturnType<typeof setInterval> | null = null
  const write = () => writeBeat(path, 'heartbeat', logError)
  return {
    arm() {
      if (timer === null) timer = setInterval(write, intervalMs)
      write()
    },
    disarm() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
