// This machine's id (agent home sync design 0.1.9 § 2, H-8): a random id made once, at `~/.cmdr/machine.json` (0600),
// shared by every agent on the machine and by the desktop app, which sends it to cmdr.mc at setup. cmdr.mc records it
// on the agent's key; every home call names it (`X-Cmdr-Machine`), and a key set up on another machine is refused.
import { randomBytes } from 'node:crypto'
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
