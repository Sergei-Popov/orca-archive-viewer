// TAR: 512-byte headers, each followed by its data padded to 512 bytes. Reads POSIX ustar, old
// V7 headers, GNU long names and links (`L`, `K`), PAX extended headers (`x`, `g`: path,
// linkpath, size, mtime) and base-256 sizes.

import { isZeroBlock, tarChecksumOk } from './detect'
import { type Archive, type Entry, EntryError } from './model'
import { type LegacyEncoding, decodeName, normalizePath, tryUtf8 } from './names'

type Raw = {
  nameBytes: Uint8Array
  /** PAX paths are UTF-8 by definition. */
  paxPath: string | null
  linkBytes: Uint8Array
  paxLink: string | null
  type: string
  size: number
  dataStart: number
  mtime: number | undefined
  mode: number
}

function cstring(b: Uint8Array, at: number, length: number): Uint8Array {
  let end = at
  while (end < at + length && b[end] !== 0) end++
  return b.subarray(at, end)
}

/** Octal (space or NUL terminated), or base-256 when the high bit of the first byte is set. */
export function tarNumber(b: Uint8Array, at: number, length: number): number {
  if (b[at] & 0x80) {
    let value = b[at] & 0x7f
    for (let i = 1; i < length; i++) value = value * 256 + b[at + i]
    return value
  }
  let value = 0
  for (let i = at; i < at + length; i++) {
    const c = b[i]
    if (c === 0x20 && value === 0) continue
    if (c < 0x30 || c > 0x37) break
    value = value * 8 + (c - 0x30)
  }
  return value
}

/** PAX records: "<length> <key>=<value>\n". */
export function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (at < data.length) {
    let space = at
    while (space < data.length && data[space] !== 0x20) space++
    const length = Number(new TextDecoder().decode(data.subarray(at, space)))
    if (!Number.isFinite(length) || length <= 0 || at + length > data.length) break
    const record = new TextDecoder().decode(data.subarray(space + 1, at + length - 1))
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    at += length
  }
  return out
}

/** `archiveSize` and `streamDamaged`: the file's own size, and damage found while unpacking it,
 *  when the tar came out of a compressed stream. */
export function parseTar(
  bytes: Uint8Array,
  encoding: LegacyEncoding,
  format = 'TAR',
  archiveSize = bytes.length,
  streamDamaged = false
): Archive {
  const raws: Raw[] = []
  let globalPax: Record<string, string> = {}
  let pax: Record<string, string> = {}
  let longName: Uint8Array | null = null
  let longLink: Uint8Array | null = null
  let damaged = streamDamaged
  let ended = false
  let at = 0
  while (at + 512 <= bytes.length) {
    if (isZeroBlock(bytes, at)) {
      ended = true
      break
    }
    if (!tarChecksumOk(bytes, at)) {
      damaged = true
      break
    }
    const ustar = bytes[at + 257] === 0x75 && bytes[at + 258] === 0x73 && bytes[at + 259] === 0x74
    const gnu = ustar && bytes[at + 262] === 0x20 // "ustar  \0": old GNU, no prefix field
    const type = String.fromCharCode(bytes[at + 156] || 0x30)
    const headerPax = { ...globalPax, ...pax }
    let size = tarNumber(bytes, at + 124, 12)
    if (headerPax.size !== undefined) {
      // Only digits: Number('') is 0 and Number('abc') is NaN, which would end the loop silently.
      const paxSize = /^\d{1,15}$/.test(headerPax.size) ? Number(headerPax.size) : NaN
      if (Number.isSafeInteger(paxSize)) size = paxSize
      else damaged = true
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      damaged = true
      break
    }
    const dataStart = at + 512
    const next = dataStart + Math.ceil(size / 512) * 512
    const cut = dataStart + size > bytes.length
    if (cut) {
      damaged = true
    }
    const data = bytes.subarray(dataStart, Math.min(bytes.length, dataStart + size))

    if (type === 'L') {
      longName = cstring(data, 0, data.length)
    } else if (type === 'K') {
      longLink = cstring(data, 0, data.length)
    } else if (type === 'x') {
      pax = parsePax(data)
    } else if (type === 'g') {
      globalPax = { ...globalPax, ...parsePax(data) }
    } else if (type !== 'V' && type !== 'M') {
      let nameBytes = longName ?? cstring(bytes, at, 100)
      if (!longName && ustar && !gnu && bytes[at + 345] !== 0) {
        const prefix = cstring(bytes, at + 345, 155)
        const joined = new Uint8Array(prefix.length + 1 + nameBytes.length)
        joined.set(prefix)
        joined[prefix.length] = 0x2f
        joined.set(nameBytes, prefix.length + 1)
        nameBytes = joined
      }
      const mtimePax = headerPax.mtime !== undefined ? Number(headerPax.mtime) : NaN
      const mtimeField = tarNumber(bytes, at + 136, 12)
      raws.push({
        nameBytes,
        paxPath: headerPax.path ?? null,
        linkBytes: longLink ?? cstring(bytes, at + 157, 100),
        paxLink: headerPax.linkpath ?? null,
        type,
        size: type === '5' || type === '1' || type === '2' ? 0 : size,
        dataStart,
        mtime: Number.isFinite(mtimePax) ? mtimePax * 1000 : mtimeField ? mtimeField * 1000 : undefined,
        mode: tarNumber(bytes, at + 100, 8)
      })
      longName = null
      longLink = null
      pax = {}
    }
    if (cut) break
    at = next
  }
  // Bytes left over that are not a whole header, with no end-of-archive block: cut off mid-header.
  if (!ended && at < bytes.length && !damaged) damaged = true
  return build(bytes, raws, encoding, format, damaged, archiveSize)
}

const TYPE_BITS: Record<string, number> = {
  '0': 0o100000,
  '7': 0o100000,
  '1': 0o100000,
  '2': 0o120000,
  '3': 0o020000,
  '4': 0o060000,
  '5': 0o040000,
  '6': 0o010000,
  D: 0o040000
}

function build(
  bytes: Uint8Array,
  raws: Raw[],
  encoding: LegacyEncoding,
  format: string,
  damaged: boolean,
  archiveSize: number
): Archive {
  let legacyNames = false
  const decode = (b: Uint8Array) => {
    const name = decodeName(b, false, encoding)
    legacyNames ||= name.legacy
    return name
  }
  const entries: Entry[] = raws.map((raw, index) => {
    const name = raw.paxPath !== null ? { name: raw.paxPath, legacy: false } : decode(raw.nameBytes)
    const dir = raw.type === '5' || raw.type === 'D' || /\/$/.test(name.name)
    const entry: Entry = {
      index,
      path: normalizePath(name.name, false),
      dir,
      size: raw.size,
      mtime: raw.mtime,
      mode: (raw.mode & 0o7777) | (TYPE_BITS[raw.type] ?? (dir ? 0o040000 : 0o100000)),
      legacy: name.legacy
    }
    if (raw.type === '1' || raw.type === '2') {
      const target = raw.paxLink ?? (tryUtf8(raw.linkBytes) ?? decode(raw.linkBytes).name)
      entry.link = { target, hard: raw.type === '1' }
    }
    return entry
  })
  const byPath = new Map<string, Entry>()
  for (const entry of entries) byPath.set(entry.path, entry)

  return {
    kind: 'tar',
    format,
    entries,
    archiveSize,
    legacyNames,
    encoding,
    damaged,
    read(entry, limit) {
      let target = entry
      // A hard link stores no data: read the file it links to.
      for (let hops = 0; target.link?.hard && hops < 8; hops++) {
        const linked = byPath.get(normalizePath(target.link.target, false))
        if (!linked) throw new EntryError('missing', target.link.target)
        target = linked
      }
      if (target.dir) throw new EntryError('directory')
      const raw = raws[target.index]
      if (!raw) throw new EntryError('missing')
      const end = raw.dataStart + raw.size
      if (end > bytes.length) {
        const available = bytes.subarray(raw.dataStart, Math.min(bytes.length, raw.dataStart + limit))
        if (available.length < Math.min(raw.size, limit)) throw new EntryError('damaged', 'data ends early')
      }
      const length = Math.min(raw.size, limit)
      return { bytes: bytes.subarray(raw.dataStart, raw.dataStart + length), truncated: raw.size > limit }
    },
    withEncoding(next) {
      return build(bytes, raws, next, format, damaged, archiveSize)
    }
  }
}
