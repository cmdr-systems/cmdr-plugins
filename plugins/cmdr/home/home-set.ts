/**
 * @file home-set.ts
 * @description
 * What an agent's home may hold (agent home sync design 0.1.9 § 3.1): the twin of cmdr.mono's
 * services/cmdr.mc/src/modules/agent-home/home-set.ts, which applies the same rules at the commit route. Both must
 * pass `home-set.cases.json`, byte for byte the same file in both repos; tests/home/home-set.parity.spec.ts runs these
 * rules over cmdr.mono's cases at main (design § 8 Tenet 2, Partial — twins). Change both, or neither.
 *
 * A path is relative to the home: `memory/<file>` (the agent's Claude Code memory) or `files/<path>` (its working
 * directory). The launcher applies these before it uploads; the commit route applies them again (defence in depth;
 * secret exclusion is by pattern and never complete, R-2).
 */

export const HOME_ROOTS = ['memory/', 'files/'] as const;
/** A file over this is never in a home (§ 3.1). */
export const MAX_FILE = 20 * 1024 * 1024;
/** A home over this takes no new files (§ 3.1; OQ-2). */
export const MAX_HOME = 500 * 1024 * 1024;
const MAX_PATH_BYTES = 512;

/**
 * Directories never synced, at any depth. `.home-conflicts` is the pull's own (§ 3.4). `.cmdr` is the machine's
 * identity and launcher state (design 0.1.22): on a box the working directory is HOME, so `files/.cmdr/machine.json`
 * would otherwise travel. `.bun`, `.npm` and `.pnpm-store` are package caches.
 */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', 'build', '.cache', '.home-conflicts', '.cmdr', '.bun', '.npm', '.pnpm-store']);
/** Files never synced: the launcher's own state. */
const EXCLUDED_FILES = new Set(['.home-state']);
/** Secret patterns on a file's name (§ 3.1). */
const SECRET = [/^\.env/i, /\.pem$/i, /\.key$/i, /credentials/i, /^settings\.local\.json$/i, /^\.claude\.json$/i];

export type Verdict = 'ok' | 'invalid' | 'excluded' | 'secret' | 'too-big';

/** A well-formed home path: under a root, relative, no `.`/`..`/empty segment, no control character or backslash. */
export function validPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false;
  if (new TextEncoder().encode(p).length > MAX_PATH_BYTES) return false;
  if (!HOME_ROOTS.some((r) => p.startsWith(r)) || p.length === p.indexOf('/') + 1) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Whether a file belongs in the home. `gitDir`: a `.git` is in one of its directories (a checkout: git is its record,
 * § 1); the walk knows that, the route can't, and relies on `.git` itself being excluded.
 */
export function inHome(path: string, file: { size: number; gitDir?: boolean }): Verdict {
  if (!validPath(path)) return 'invalid';
  const segs = path.split('/');
  const name = segs[segs.length - 1]!;
  if (file.gitDir || segs.slice(1, -1).some((d) => EXCLUDED_DIRS.has(d)) || EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name)) return 'excluded';
  if (SECRET.some((re) => re.test(name))) return 'secret';
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_FILE) return 'too-big';
  return 'ok';
}
