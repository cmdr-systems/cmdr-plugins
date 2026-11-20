// Files in conversations, the agent's side (cmdr.mc takes what Claude can
// read: an image, a PDF, or text, each within Claude's limit for it).
//
//   sending   reply's `files`: paths on this machine, read and uploaded to the
//             conversation (cmdr.mc checks each), then posted with the
//             message. A path that names a secret (a .env, a key, .ssh/,
//             cloud credentials) is refused here, whatever its content.
//   receiving a message's files are downloaded into the agent's inbox
//             (<inbox>/<message id>/<name>) before it's handed the message,
//             whose text then lists their paths, so it can Read them (images
//             and PDFs too: Claude Code's Read shows it those). A zip is
//             unpacked beside it, safely (unzip.ts), its files listed.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
import { unpackDirFor, unzipSafely } from './unzip.js'

// agent-client's view (S5); re-exported so this path keeps it (plan D-7).
export type { Attachment } from './agent-client/types.js'
import type { Attachment } from './agent-client/types.js'
/** How the channel moves bytes to and from cmdr.mc (server.ts: fetch; tests: memory). */
export interface FileTransport {
  upload(path: string, name: string, data: Uint8Array): Promise<Attachment>
  download(path: string): Promise<Uint8Array>
}

/** The most one file may be (cmdr.mc's largest: a PDF). */
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const MAX_FILES = 10
/** What one message's files may come to, downloaded. */
const MAX_INBOUND_BYTES = 100 * 1024 * 1024

const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|.*secret.*|.*token.*)$/i
const SECRET_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.config\/gcloud|\.config\/gh|\.claude)(\/|$)/

/** Why a path can't be sent, or null when it can. */
export function refusal(path: string): string | null {
  if (!isAbsolute(path)) return `${path}: give the whole path (from /)`
  if (SECRET_DIR.test(path) || SECRET_NAME.test(basename(path))) return `${path}: looks like a credential or secret, so it isn't sent`
  return null
}

/** The name a file is sent under (FEATURE-REQUESTS-8 S3): its own, minus the `<id[:8]>-` this plugin puts on every
 *  download (`fetchAttachment`, `get_task_file`), and ONLY when the file's real path is under the session's real
 *  inbox root, at any depth (`<inbox>/<message id>/`, `<inbox>/assets/`, `<inbox>/tasks/<key>/`). A file of the
 *  agent's own that happens to start with eight hex and a dash keeps its name. A name that would strip to nothing is
 *  sent whole. The NAME is the one the caller gave (a link keeps its own); only WHERE it is uses the real path. Pure. */
export function sentName(name: string, realPath: string, realInbox: string | undefined): string {
  if (!realInbox || !realPath.startsWith(realInbox.endsWith(sep) ? realInbox : realInbox + sep)) return name
  const stripped = name.replace(/^[0-9a-f]{8}-/i, '')
  return stripped || name
}

/** A file to send, read; its refusal as an Error. `inboxRoot`: the session's inbox (FEATURE-REQUESTS-8), so a file
 *  the plugin downloaded there goes back under the name a person gave it (`sentName`). */
export async function readToSend(path: string, inboxRoot?: string): Promise<{ name: string; data: Uint8Array }> {
  const why = refusal(path)
  if (why) throw new Error(why)
  // Through any link: what it really is must pass too.
  const real = await realpath(path).catch(() => null)
  if (!real) throw new Error(`${path}: no such file`)
  const again = refusal(real)
  if (again) throw new Error(again)
  const s = await stat(real)
  if (!s.isFile()) throw new Error(`${path}: not a file`)
  if (s.size === 0) throw new Error(`${path}: it's empty`)
  if (s.size > MAX_FILE_BYTES) throw new Error(`${path}: over 32 MB`)
  const inbox = inboxRoot ? await realpath(inboxRoot).catch(() => undefined) : undefined
  return { name: sentName(basename(path), real, inbox), data: await readFile(real) }
}

/** A file's size, as people read it. */
export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)
export const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120) || 'file'

/** How a file is named in the list: its name, then its kind (a MIME type for a picture or PDF) and size. */
const labelOf = (a: Attachment) => `${a.name} (${a.kind === 'text' ? 'text' : a.kind === 'archive' ? 'zip' : a.mimeType}, ${size(a.size)})`
/** Its name in the message's text, when it has one: `[image-01] ` before its line, the same string the text holds. */
export const refTag = (a: Pick<Attachment, 'ref'>) => (a.ref ? `[${a.ref}] ` : '')

/**
 * Names for the files a message carries, in their order, as the text writes them (inline file references design
 * § 3): `image-NN` for an image, `file-NN` for any other kind, each counted from 01. The kind is the one cmdr.mc
 * answered on upload (never guessed here); cmdr.mc checks the names again at post, and its check is what decides.
 */
export function refsFor(files: readonly Pick<Attachment, 'id' | 'kind'>[]): { id: string; ref: string }[] {
  const n = { image: 0, file: 0 }
  return files.map((f) => {
    const prefix = f.kind === 'image' ? 'image' : 'file'
    n[prefix] += 1
    return { id: f.id, ref: `${prefix}-${String(n[prefix]).padStart(2, '0')}` }
  })
}

/** A file's line in read_history: its name, kind and size, and whether it's gone (nothing is downloaded there). */
export const historyLine = (a: Attachment) => `- ${refTag(a)}${labelOf(a)}${a.removed ? ': removed' : ''}`

/**
 * One file, downloaded from `path` into `dir` as `<id[:8]>-<name>` (a zip unpacked beside it, safely), and the
 * lines that list it. The one body withFiles() and get_asset share: a download or write that fails throws, and
 * each caller says so its own way. A second fetch of the same file writes the same path.
 */
export async function fetchAttachment(a: Attachment, dir: string, path: string, transport: FileTransport): Promise<{ lines: string[]; bytes: number }> {
  const label = labelOf(a)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${safe(a.id).slice(0, 8)}-${safe(a.name)}`)
  const data = await transport.download(path)
  await writeFile(file, data, { mode: 0o600 })
  const tag = refTag(a)
  if (a.kind !== 'archive') return { lines: [`- ${tag}${file} — ${label}`], bytes: data.length }
  // A zip: unpacked beside it, safely (unzip.ts), or why not.
  const to = unpackDirFor(file)
  const u = await unzipSafely(Buffer.from(data), to)
  if (!u.ok) return { lines: [`- ${tag}${file} — ${label}: not unpacked (${u.reason})`], bytes: data.length }
  const lines = [`- ${tag}${file} — ${label}, unpacked to ${to}/ (${u.files.length} file${u.files.length === 1 ? '' : 's'}):`]
  for (const f of u.files.slice(0, 40)) lines.push(`  - ${f}`)
  if (u.files.length > 40) lines.push(`  - …and ${u.files.length - 40} more in ${to}/`)
  for (const s of u.skipped) lines.push(`  - skipped ${s.name}: ${s.why}`)
  return { lines, bytes: data.length }
}

/**
 * A message's text as the session reads it: its body, then its files, each
 * downloaded into the inbox and listed by its path (or why it couldn't be).
 */
export async function withFiles(body: string, messageId: string, attachments: Attachment[] | undefined, inbox: string | undefined, transport: FileTransport | undefined, log: (line: string) => void): Promise<string> {
  if (!attachments?.length) return body
  const lines: string[] = []
  let total = 0
  for (const a of attachments) {
    const label = `${refTag(a)}${labelOf(a)}`
    // Taken off its message: there's nothing to download, and its name in the text now points at nothing.
    if (a.removed) {
      lines.push(`- ${label}: removed from the message`)
      continue
    }
    if (!inbox || !transport) {
      lines.push(`- ${label}: not downloaded (no inbox here)`)
      continue
    }
    if (total + a.size > MAX_INBOUND_BYTES) {
      lines.push(`- ${label}: not downloaded (over 100 MB for one message)`)
      continue
    }
    try {
      const got = await fetchAttachment(a, join(inbox, safe(messageId)), `/agent/attachments/${a.id}/content`, transport)
      total += got.bytes
      lines.push(...got.lines)
    } catch (e) {
      log(`downloading ${a.id} failed: ${e}`)
      lines.push(`- ${label}: couldn't be downloaded`)
    }
  }
  return `${body}${body ? '\n\n' : ''}[Files with this message (Read them by path):]\n${lines.join('\n')}`
}
