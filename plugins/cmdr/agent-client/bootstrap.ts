// agent-client's bootstrap (local-agents design 0.1.14–0.1.16, PD-16/PD-17; API `bootstrap.dependencyGap`): whether the
// plugin's runtime packages are installed at exactly bun.lock's versions. Both faces run it before any external import,
// the plugin's start (start.ts) and the CLI's entry (cli/cmdr-agent.ts), and refuse `dependencies-missing: <package>`
// on a gap, from any working directory. Why: an offline `claude plugin install` reports success and installs no
// dependencies (R-15), and bun would otherwise fetch an absent package at run time, at a version nobody chose.
// `bunfig.toml`'s `auto = "disable"` is the second guard, for the plugin folder as the working directory.
//
// node:* imports only: this file must load where nothing else can.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** A runtime package not installed as locked: `found` is the installed version, null when absent. */
export type DependencyGap = { package: string; expected: string; found: string | null }

/** bun.lock is JSON with trailing commas. Strings are skipped whole, so a comma inside one is never touched. */
export function parseBunLock(text: string): { packages?: Record<string, unknown[]> } {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, close) => (close === undefined ? m : close)))
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The first runtime dependency (package.json `dependencies`, in its order) missing from `node_modules` or at a version
 *  other than bun.lock's; null when every one is as locked. Unreadable package.json or bun.lock is a gap too (fail
 *  closed), reported as that file. */
export function dependencyGap(pluginDir: string): DependencyGap | null {
  let deps: string[]
  let locked: Record<string, unknown[]>
  try {
    deps = Object.keys((JSON.parse(read(join(pluginDir, 'package.json')) ?? 'null') as { dependencies?: Record<string, string> }).dependencies ?? {})
  } catch {
    return { package: 'package.json', expected: 'readable', found: null }
  }
  try {
    locked = parseBunLock(read(join(pluginDir, 'bun.lock')) ?? 'null').packages ?? {}
  } catch {
    return { package: 'bun.lock', expected: 'readable', found: null }
  }
  for (const name of deps) {
    const entry = locked[name]?.[0]
    const expected = typeof entry === 'string' && entry.startsWith(`${name}@`) ? entry.slice(name.length + 1) : null
    if (!expected) return { package: name, expected: 'an entry in bun.lock', found: null }
    let found: string | null = null
    try {
      const v = (JSON.parse(read(join(pluginDir, 'node_modules', name, 'package.json')) ?? 'null') as { version?: unknown } | null)?.version
      found = typeof v === 'string' ? v : null
    } catch {
      found = null
    }
    if (found !== expected) return { package: name, expected, found }
  }
  return null
}

/** The refusal's one line (design 0.1.18, AC-33): its reason, the package, what was found and expected, the plugin
 *  folder it checked, and both remedies, because the guard cannot tell a marketplace copy from one installed from a
 *  folder. Both entries print it unchanged. */
export const gapLine = (g: DependencyGap, pluginDir: string): string => {
  const dir = resolve(pluginDir)
  return `dependencies-missing: ${g.package} (${g.found === null ? 'absent' : `found ${g.found}`}; expected ${g.expected}) in ${dir}. Run \`claude plugin install cmdr@cmdr-crew\` again with the network up, or \`bun install --frozen-lockfile\` in ${dir}.`
}
