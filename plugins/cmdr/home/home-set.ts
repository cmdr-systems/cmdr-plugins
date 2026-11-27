/**
 * @file home-set.ts
 * @description
 * What an agent's home may hold (agent home sync design 0.1.33 § 3.1): the twin of cmdr.mono's
 * services/cmdr.mc/src/modules/agent-home/home-set.ts, which applies the same rules at the commit route. Both must
 * pass `home-set.cases.json`, byte for byte the same file in both repos; tests/home/home-set.parity.spec.ts runs these
 * rules over cmdr.mono's cases at main, at every version and scope (design § 8 Tenet 2, Partial — twins). Change both,
 * or neither. Unlike cmdr.mc's twin, this one takes `homeRules` and `scope` with no defaults (plan 0.1.1 § 4.1, W-1): a
 * box call that forgot its scope would quietly get the denylist, so a miss is a compile error.
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
 * The newest home-set rules version (design 0.1.25 § 3.1, `homeRules`). Each exclusion carries the version it was added
 * in, and a commit is judged by the version its launcher walks by: a put that only a newer rule excludes is accepted as
 * before, so an older launcher keeps working (0.1.25 item 8). Secret patterns, path validity and the size limit are
 * version 0 and never versioned upwards. 0: before 0.1.22. 1: `.cmdr`, `.bun`, `.npm`, `.pnpm-store` (0.1.22). 2: under
 * `files/.claude/`, only skills, agents, commands and CLAUDE.md (0.1.26). 3: a box's allowlist (0.1.29), scope `box` only;
 * for `external` 3 admits what 2 admits, and cmdr.mc's twin judges every commit as `external` (0.1.30, H-31).
 */
export const HOME_RULES = 3;

/**
 * Directories never synced, at any depth, with the version each was added in. `.home-conflicts` is the pull's own
 * (§ 3.4). `.cmdr` is the machine's identity and launcher state (design 0.1.22): on a box the working directory is HOME,
 * so `files/.cmdr/machine.json` would otherwise travel. `.bun`, `.npm` and `.pnpm-store` are package caches.
 */
const EXCLUDED_DIRS = new Map<string, number>([
  ['.git', 0], ['node_modules', 0], ['.venv', 0], ['dist', 0], ['build', 0], ['.cache', 0], ['.home-conflicts', 0],
  ['.cmdr', 1], ['.bun', 1], ['.npm', 1], ['.pnpm-store', 1],
]);
/** Under `files/.claude/` (Claude Code's own directory, on a box), only these are home content from version 2 (0.1.26). */
const CLAUDE_DIRS = new Set(['skills', 'agents', 'commands']);
/** Files never synced: the launcher's own state. */
const EXCLUDED_FILES = new Set(['.home-state']);
/** Secret patterns on a file's name (§ 3.1). */
const SECRET = [/^\.env/i, /\.pem$/i, /\.key$/i, /credentials/i, /^settings\.local\.json$/i, /^\.claude\.json$/i];

export type Verdict = 'ok' | 'invalid' | 'excluded' | 'secret' | 'too-big';
/** Where the home lives (design 0.1.29): a crew box walks an allowlist from version 3; anything else the denylist. */
export type HomeScope = 'box' | 'external';

/** A well-formed home path: under a root, relative, no `.`/`..`/empty segment, no control character or backslash. */
export function validPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false;
  if (new TextEncoder().encode(p).length > MAX_PATH_BYTES) return false;
  if (!HOME_ROOTS.some((r) => p.startsWith(r)) || p.length === p.indexOf('/') + 1) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Whether a file belongs in the home, by the rules of version `homeRules` for a home of `scope`. `gitDir`: the walk
 * found a `.git` in one of its directories (a checkout: git is its record, § 1). Secrets are judged before exclusions,
 * so a secret name is `secret` at every version whatever rule later covers its folder (0.1.26). From version 3 a `box`
 * home holds only `memory/**`, `files/.claude/{skills,agents,commands}/**` and `files/.claude/CLAUDE.md` (0.1.29); for
 * `external`, 3 admits what 2 admits.
 */
export function inHome(path: string, file: { size: number; gitDir?: boolean }, homeRules: number, scope: HomeScope): Verdict {
  if (!validPath(path)) return 'invalid';
  const segs = path.split('/');
  const name = segs[segs.length - 1]!;
  if (SECRET.some((re) => re.test(name))) return 'secret';
  const excludedDir = (d: string) => (EXCLUDED_DIRS.get(d) ?? Infinity) <= homeRules;
  if (file.gitDir || segs.slice(1, -1).some(excludedDir) || excludedDir(name) || EXCLUDED_FILES.has(name)) return 'excluded';
  const claudeContent = segs[0] === 'files' && segs[1] === '.claude' && segs.length > 2
    && (segs.length === 3 ? segs[2] === 'CLAUDE.md' : CLAUDE_DIRS.has(segs[2]!));
  if (homeRules >= 2 && segs[0] === 'files' && segs[1] === '.claude' && segs.length > 2 && !claudeContent) return 'excluded';
  if (homeRules >= 3 && scope === 'box' && segs[0] !== 'memory' && !claudeContent) return 'excluded';
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_FILE) return 'too-big';
  return 'ok';
}
