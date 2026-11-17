// Unpacking a zip someone sent the agent: the only place a zip is unpacked
// (cmdr.mc only stores it, after reading its directory). Everything cmdr.mc
// checked is checked again here, and more as it unpacks:
//
//   - the directory: no ZIP64 or multi-part; no encrypted entry; only stored
//     or deflated entries; no name that's absolute, climbs out (..), has a
//     drive letter or a control character; no link, device or other special
//     entry; at most UNZIP_LIMITS.entries entries, entryBytes each,
//     totalBytes in all, and no entry over `ratio` times its packed size
//     (past ratioFloor);
//   - each entry, as it's inflated: never more than the size it declares
//     (inflation stops there), and exactly that size and its checksum, or the
//     zip lied;
//   - each file: written only inside the folder it unpacks to (its resolved
//     path checked), never over anything (no following a link already
//     there), 0600, folders 0700;
//   - a file whose path looks like a secret (files.ts) is skipped, said so.
//
// Anything wrong, and the folder it was unpacking to is removed: all of it,
// or none of it.
import { inflateRawSync, crc32 } from 'node:zlib'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { refusal } from './files.js'

export const UNZIP_LIMITS = {
  entries: 1000,
  totalBytes: 200 * 1024 * 1024,
  entryBytes: 50 * 1024 * 1024,
  ratio: 200,
  ratioFloor: 1024 * 1024,
  nameBytes: 1024,
} as const

type Entry = { name: string; method: number; packed: number; size: number; crc: number; local: number; dir: boolean }
export type Unzipped = { ok: true; files: string[]; skipped: { name: string; why: string }[] } | { ok: false; reason: string }

/** Why a zip entry's name can't be unpacked anywhere safe, or null. */
export function badEntryName(name: string): string | null {
  if (!name) return 'an entry has no name'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'an entry name has a control character'
  if (name.startsWith('/') || name.startsWith('\\')) return 'an entry is an absolute path'
  if (/^[A-Za-z]:/.test(name)) return 'an entry has a drive letter'
  if (name.split(/[\\/]/).some((s) => s === '..')) return 'an entry climbs out of its folder'
  return null
}

/** Its directory, read and checked; no byte of any entry inflated. */
export function readDirectory(b: Buffer): { ok: true; entries: Entry[] } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason })
  if (b.length < 22) return no("it isn't a zip")
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return no("it isn't a zip, or it's damaged")
  if (eocd >= 20 && b.readUInt32LE(eocd - 20) === 0x07064b50) return no('ZIP64 isn’t unpacked')
  const count = b.readUInt16LE(eocd + 10)
  const cdSize = b.readUInt32LE(eocd + 12)
  const cdOffset = b.readUInt32LE(eocd + 16)
  if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0) return no('multi-part zips aren’t unpacked')
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return no('ZIP64 isn’t unpacked')
  if (count > UNZIP_LIMITS.entries) return no(`more than ${UNZIP_LIMITS.entries} files`)
  if (cdOffset + cdSize > eocd) return no("it's damaged")
  const entries: Entry[] = []
  let total = 0
  let at = cdOffset
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || b.readUInt32LE(at) !== 0x02014b50) return no("it's damaged")
    const madeBy = b.readUInt16LE(at + 4) >> 8
    const flags = b.readUInt16LE(at + 8)
    const method = b.readUInt16LE(at + 10)
    const crc = b.readUInt32LE(at + 16)
    const packed = b.readUInt32LE(at + 20)
    const size = b.readUInt32LE(at + 24)
    const nameLen = b.readUInt16LE(at + 28)
    const extraLen = b.readUInt16LE(at + 30)
    const commentLen = b.readUInt16LE(at + 32)
    const external = b.readUInt32LE(at + 38)
    const local = b.readUInt32LE(at + 42)
    if (at + 46 + nameLen + extraLen + commentLen > eocd || nameLen > UNZIP_LIMITS.nameBytes) return no("it's damaged")
    const name = b.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    at += 46 + nameLen + extraLen + commentLen
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return no('ZIP64 isn’t unpacked')
    if (flags & 0x41) return no('it has encrypted files')
    const why = badEntryName(name)
    if (why) return no(why)
    if (madeBy === 3) {
      const type = (external >>> 16) & 0o170000
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) return no('it has a link or a special file')
    }
    if (method !== 0 && method !== 8) return no(`an entry is packed a way that isn't unpacked (${method})`)
    if (method === 0 && packed !== size) return no("it's damaged")
    if (size > UNZIP_LIMITS.entryBytes) return no(`a file in it is over ${UNZIP_LIMITS.entryBytes / (1024 * 1024)} MB`)
    if (size > UNZIP_LIMITS.ratioFloor && size > packed * UNZIP_LIMITS.ratio) return no('a file in it has a zip bomb’s shape')
    total += size
    if (total > UNZIP_LIMITS.totalBytes) return no(`over ${UNZIP_LIMITS.totalBytes / (1024 * 1024)} MB unpacked`)
    if (local + 30 > cdOffset || b.readUInt32LE(local) !== 0x04034b50) return no("it's damaged")
    entries.push({ name, method, packed, size, crc, local, dir: name.endsWith('/') })
  }
  return { ok: true, entries }
}

/** An entry's bytes, inflated no further than its declared size, and checked against it. */
function bytesOf(b: Buffer, e: Entry): Buffer {
  const start = e.local + 30 + b.readUInt16LE(e.local + 26) + b.readUInt16LE(e.local + 28)
  if (start + e.packed > b.length) throw new Error("it's damaged")
  const packed = b.subarray(start, start + e.packed)
  // maxOutputLength stops inflation past the declared size (a bomb that lied about it stops here).
  const out = e.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, e.size) })
  if (out.length !== e.size) throw new Error('an entry lied about its size')
  if ((crc32(out) >>> 0) !== e.crc) throw new Error("an entry's checksum doesn't match")
  return out
}

/** Unpack a zip's bytes into `dest` (made here, and removed again if anything is wrong). */
export async function unzipSafely(zip: Buffer, dest: string): Promise<Unzipped> {
  const dir = readDirectory(zip)
  if (!dir.ok) return dir
  const root = resolve(dest)
  const files: string[] = []
  const skipped: { name: string; why: string }[] = []
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const e of dir.entries) {
      const target = resolve(root, e.name)
      if (target !== root && !target.startsWith(root + sep)) throw new Error('an entry climbs out of its folder')
      if (e.dir) {
        await mkdir(target, { recursive: true, mode: 0o700 })
        continue
      }
      const secret = refusal(target)
      if (secret) {
        skipped.push({ name: e.name, why: 'looks like a credential or secret' })
        continue
      }
      const data = bytesOf(zip, e)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      // wx: never over anything already there (a file, or a link to elsewhere).
      await writeFile(target, data, { mode: 0o600, flag: 'wx' })
      files.push(target)
    }
    return { ok: true, files, skipped }
  } catch (e) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Where a zip unpacks: beside it, its name without .zip. */
export const unpackDirFor = (zipPath: string) => join(dirname(zipPath), zipPath.split(sep).pop()!.replace(/\.zip$/i, '') || 'unzipped')
