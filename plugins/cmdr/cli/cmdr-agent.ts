#!/usr/bin/env bun
// cmdr-agent's entry (local-agents design 0.1.15, PD-17): run as `bun <cmdr plugin>/cli/cmdr-agent.ts <verb> …` from any
// directory. The shared bootstrap checks the plugin's runtime packages against bun.lock FIRST, before any external
// import, because bunfig.toml's auto-install guard binds to the working directory and would not cover a run from
// elsewhere: a gap is refused (`refused: dependencies-missing: …`, exit 1), never fetched. Only node:* and relative
// imports here; the verbs are main.ts's.
import { dirname, join } from 'node:path'
import { dependencyGap, gapLine } from '../agent-client/bootstrap.js'

const pluginDir = join(dirname(import.meta.path), '..')
const gap = dependencyGap(pluginDir)
if (gap) {
  process.stderr.write(`refused: ${gapLine(gap, pluginDir)}\n`)
  process.exit(1)
}
const { run } = await import('./main.js')
const stop = new AbortController()
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => stop.abort())
const code = await run(process.argv.slice(2), {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  stop: stop.signal,
})
process.exit(code)
