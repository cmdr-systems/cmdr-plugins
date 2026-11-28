// This machine's id (agent home sync design 0.1.9 § 2, H-8): a random id made once, at `~/.cmdr/machine.json` (0600),
// shared by every agent on the machine and by the desktop app, which sends it to cmdr.mc at setup. cmdr.mc records it
// on the agent's key; every home call names it (`X-Cmdr-Machine`), and a key set up on another machine is refused.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Machine = { machineId: string; machineName: string }
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const machineFile = (home = homedir()) => join(home, '.cmdr', 'machine.json')

/** A person's name for this machine: the host name without `.local`, at most 80 printable characters. */
export function nameOf(host = hostname()): string {
  return host.replace(/\.local$/i, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'This Mac'
}

/** The machine, made once if absent: created exclusively, so two launchers starting at once agree on one id. */
export function machine(path = machineFile()): Machine {
  const read = (): Machine | null => {
    try {
      const j = JSON.parse(readFileSync(path, 'utf8')) as { machineId?: unknown; machineName?: unknown }
      if (typeof j.machineId === 'string' && ID.test(j.machineId)) return { machineId: j.machineId, machineName: typeof j.machineName === 'string' && j.machineName.trim() ? j.machineName.slice(0, 80) : nameOf() }
    } catch {
      /* absent, or being written */
    }
    return null
  }
  const found = read()
  if (found) return found
  const m: Machine = { machineId: randomBytes(16).toString('hex'), machineName: nameOf() }
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, JSON.stringify(m, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    return m
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  // Another process made it a moment ago: its id is the machine's.
  for (let i = 0; i < 50; i++) {
    const other = read()
    if (other) return other
    Bun.sleepSync(20)
  }
  throw new Error(`machine.json at ${path} is unreadable`)
}

/** A box's enrolment record: root-owned, 0644, written by cmdr-box-bootstrap.sh at enrolment (design 0.1.34 § 2). */
export const BOX_FILE = '/etc/cmdr-crew/box.json'

/** The step can't name this box: its box.json is missing, unreadable, or lacks crew.key or enrolledAt. */
export class MachineUnknown extends Error {
  readonly code = 'machine-unknown'
}

/**
 * A box's machine id (home sync design 0.1.32, ruled 0.1.34; LOCAL-AGENTS-53): `box-` + the first 32 hex characters of
 * sha256(`<crew.key>:<enrolledAt>`), from box.json, whatever the process's `$HOME`. One id per enrolment, stable for
 * the box's life: a crew has one box, and `enrolledAt` is written once per enrolment and kept when the minute loop adds
 * `box.id` later, which is why `box.id` is never read. A re-provisioned VM enrols again and gets a new id. There is no
 * fallback to `$HOME/.cmdr/machine.json` (a per-HOME id is what LOCAL-AGENTS-52 was): no box.json, no step.
 */
export function boxMachine(path = BOX_FILE, host = hostname()): Machine {
  let j: { crew?: { key?: unknown }; enrolledAt?: unknown }
  try {
    j = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new MachineUnknown(`machine-unknown: ${path} is missing or unreadable`)
  }
  const key = j?.crew?.key
  const at = j?.enrolledAt
  if (typeof key !== 'string' || !key || typeof at !== 'string' || !at) throw new MachineUnknown(`machine-unknown: ${path} names no crew.key or enrolledAt`)
  return { machineId: 'box-' + createHash('sha256').update(`${key}:${at}`).digest('hex').slice(0, 32), machineName: nameOf(host) }
}

/**
 * The machine a home step names, chosen by the agent's `runsOn` scope (LOCAL-AGENTS-53; design 0.1.30 reads `runsOn`
 * from `/agent/me` first in every step, so this never runs for `platform` or an unknown scope): a box agent is its box
 * (`boxMachine`, whatever `$HOME`), a person's machine (`external`) is `machine.json` under `$HOME`. A box never falls
 * back to `$HOME`: its box.json unreadable is MachineUnknown, and nothing is written.
 */
export function machineFor(scope: 'box' | 'external', files: { boxFile?: string; machineFile?: string } = {}): Machine {
  return scope === 'box' ? boxMachine(files.boxFile ?? BOX_FILE) : machine(files.machineFile ?? machineFile())
}
