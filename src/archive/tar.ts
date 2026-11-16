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

/**
 * A numeric field: octal digits after optional spaces, ended by a space or NUL, or base-256 when
 * the first byte has its high bit set, negative in two's complement when the next bit is set too
 * (GNU tar writes pre-1970 times that way). Null when the field holds no digits.
 */
export function tarNumber(b: Uint8Array, at: number, length: number): number | null {
  const lead = b[at]
  if (lead & 0x80) {
    if (lead & 0x40) {
      // Summing the inverted bytes keeps small negative numbers exact; subtracting 256 ** 12 from
      // the unsigned value would round them away.
      let inverted = ~lead & 0x3f
      for (let i = 1; i < length; i++) inverted = inverted * 256 + (~b[at + i] & 0xff)
      return -(inverted + 1)
    }
    let value = lead & 0x3f
    for (let i = 1; i < length; i++) value = value * 256 + b[at + i]
    return value
  }
  let value = 0
  let digits = 0
  for (let i = at; i < at + length; i++) {
    const c = b[i]
    if (c === 0x20 && digits === 0) continue
    if (c < 0x30 || c > 0x37) break
    value = value * 8 + (c - 0x30)
    digits++
  }
  return digits ? value : null
}

/** Seconds since 1970 as milliseconds, when a Date can hold them. */
function time(seconds: number | null): number | undefined {
  if (seconds === null || !Number.isFinite(seconds)) return undefined
  const ms = seconds * 1000
  return Math.abs(ms) <= 8.64e15 ? ms : undefined
}

export type PaxRecords = { records: [string, string][]; damaged: boolean }

/**
 * PAX records, "<length> <key>=<value>\n" with the length counting the whole record, in order.
 * A NUL ends them, as in Python's tarfile. A length with a leading zero, over 20 digits or too
 * short for its own record, or a record without its "=" or newline, is damage: parsing stops
 * there, so a crafted length cannot make the scan go back over the same bytes.
 */
export function parsePax(data: Uint8Array): PaxRecords {
  const records: [string, string][] = []
  const decoder = new TextDecoder()
  let at = 0
  while (at < data.length && data[at] !== 0) {
    let p = at
    let length = 0
    while (p < data.length && p - at < 21 && data[p] >= 0x30 && data[p] <= 0x39) length = length * 10 + data[p++] - 0x30
    const digits = p - at
    const end = at + length
    // The shortest record is "<digits> k=\n".
    const framed =
      digits > 0 && digits <= 20 && data[at] !== 0x30 && data[p] === 0x20 && length >= digits + 4 && end <= data.length
    if (!framed || data[end - 1] !== 0x0a) return { records, damaged: true }
    const record = data.subarray(p + 1, end - 1)
    const eq = record.indexOf(0x3d)
    if (eq <= 0) return { records, damaged: true }
    records.push([decoder.decode(record.subarray(0, eq)), decoder.decode(record.subarray(eq + 1))])
    at = end
  }
  return { records, damaged: false }
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
    let size = tarNumber(bytes, at + 124, 12) ?? 0
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
    } else if (type === 'x' || type === 'g') {
      const parsed = parsePax(data)
      damaged ||= parsed.damaged
      // fromEntries defines keys as own properties: a "__proto__" record stays a record.
      if (type === 'x') pax = Object.fromEntries(parsed.records)
      else globalPax = { ...globalPax, ...Object.fromEntries(parsed.records) }
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
      // PAX times are decimal seconds, possibly with a fraction and a sign.
      const mtimePax = /^-?\d{1,15}(\.\d+)?$/.test(headerPax.mtime ?? '') ? Number(headerPax.mtime) : null
      raws.push({
        nameBytes,
        paxPath: headerPax.path ?? null,
        linkBytes: longLink ?? cstring(bytes, at + 157, 100),
        paxLink: headerPax.linkpath ?? null,
        type,
        size: type === '5' || type === '1' || type === '2' ? 0 : size,
        dataStart,
        mtime: time(mtimePax) ?? time(tarNumber(bytes, at + 136, 12)),
        mode: tarNumber(bytes, at + 100, 8) ?? 0
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
  // The entries at each path, in archive order: an appended tar can hold a path more than once.
  const byPath = new Map<string, number[]>()
  for (const entry of entries) {
    const list = byPath.get(entry.path)
    if (list) list.push(entry.index)
    else byPath.set(entry.path, [entry.index])
  }
  /** The last entry at `path` before `index`: the file a hard link at `index` was made from. */
  const before = (path: string, index: number): Entry | undefined => {
    const list = byPath.get(path) ?? []
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo > 0 ? entries[list[lo - 1]] : undefined
  }

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
      // A hard link stores no data: read the file it links to, as tar and Python's tarfile do:
      // the last entry at that path before the link, on each hop.
      for (let hops = 0; target.link?.hard && hops < 8; hops++) {
        const linked = before(normalizePath(target.link.target, false), target.index)
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
