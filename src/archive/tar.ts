// TAR: 512-byte headers, each followed by its data padded to 512 bytes. Reads POSIX ustar, old
// V7 headers, GNU long names and links (`L`, `K`), PAX extended headers (`x`, `g`: path,
// linkpath, size, mtime), base-256 numbers, and sparse files: GNU `S` headers and the PAX
// GNU.sparse formats 0.0, 0.1 and 1.0 (macOS `tar -cf` writes 1.0 for any file with holes), whose
// holes read back as zeros, as GNU tar and Python's tarfile extract them.

import { isZeroBlock, tarChecksumOk } from './detect'
import { type Archive, type Entry, EntryError, type ReadResult } from './model'
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
  sparse?: Sparse
}

/**
 * Where a sparse file's data lies: `runs` holds offset and length pairs in file order, stored one
 * after another from `start`; the rest of the file is zeros. `error` when the map is unusable.
 */
type Sparse = { runs: number[]; start: number } | { error: 'damaged' | 'unsupported' }

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

/** A run map that reads the file: runs in order, inside its size, using no more than is stored. */
function sparseRuns(runs: number[] | null, realSize: number | null, start: number, stored: number): Sparse {
  if (!runs || realSize === null || !Number.isSafeInteger(realSize) || realSize < 0) return { error: 'unsupported' }
  let end = 0
  let total = 0
  for (let i = 0; i < runs.length; i += 2) {
    const offset = runs[i]
    const length = runs[i + 1]
    if (!(offset >= end && length >= 0 && offset + length <= realSize)) return { error: 'unsupported' }
    end = offset + length
    total += length
  }
  return total <= stored ? { runs, start } : { error: 'unsupported' }
}

/**
 * An old GNU `S` header's map: four runs in the header, 21 in each extension block that follows
 * while the "extended" byte is set. An empty length ends the map, as in GNU tar.
 */
function oldGnuMap(bytes: Uint8Array, at: number): { runs: number[] | null; blocks: number } {
  const runs: number[] = []
  let valid = true
  let done = false
  const read = (from: number, count: number) => {
    for (let i = 0; i < count && !done; i++) {
      const offset = tarNumber(bytes, from + i * 24, 12)
      const length = tarNumber(bytes, from + i * 24 + 12, 12)
      if (length === null) done = true
      else if (offset === null) valid = false
      else runs.push(offset, length)
    }
  }
  read(at + 386, 4)
  let blocks = 0
  for (let extended = bytes[at + 482] !== 0; extended; ) {
    const block = at + 512 + blocks * 512
    blocks++
    if (block + 512 > bytes.length) return { runs: null, blocks }
    read(block, 21)
    extended = bytes[block + 504] !== 0
  }
  return { runs: valid ? runs : null, blocks }
}

const decimal = (text: string | undefined): number | null =>
  text !== undefined && /^\d{1,16}$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null

/**
 * The PAX GNU.sparse formats. 0.0 lists GNU.sparse.offset and GNU.sparse.numbytes records in
 * order, 0.1 puts them in GNU.sparse.map, both with the size in GNU.sparse.size; 1.0 stores the
 * map at the start of the data, in whole blocks, with the size in GNU.sparse.realsize. Null when
 * the entry is not sparse.
 */
function paxSparse(
  local: Record<string, string>,
  records: [string, string][],
  bytes: Uint8Array,
  start: number,
  size: number
): { sparse: Sparse; realSize: number } | null {
  const keys = Object.keys(local).filter((key) => key.startsWith('GNU.sparse.') && key !== 'GNU.sparse.name')
  if (!keys.length) return null
  if (local['GNU.sparse.major'] === '1' && local['GNU.sparse.minor'] === '0') {
    const realSize = decimal(local['GNU.sparse.realsize'])
    const map = sparseMap10(bytes, start, size)
    if (typeof map === 'string') return { sparse: { error: map }, realSize: realSize ?? size }
    const skip = map.blocks * 512
    return { sparse: sparseRuns(map.runs, realSize, start + skip, Math.max(0, size - skip)), realSize: realSize ?? size }
  }
  let runs: number[] | null = null
  const realSize = decimal(local['GNU.sparse.size'])
  if (local['GNU.sparse.map'] !== undefined) {
    runs = local['GNU.sparse.map'].split(',').map(decimal) as number[]
    if (runs.some((n) => n === null) || runs.length % 2) runs = null
  } else if (local['GNU.sparse.size'] !== undefined) {
    const offsets = records.filter(([key]) => key === 'GNU.sparse.offset').map(([, value]) => decimal(value))
    const lengths = records.filter(([key]) => key === 'GNU.sparse.numbytes').map(([, value]) => decimal(value))
    if (offsets.length === lengths.length && ![...offsets, ...lengths].includes(null)) {
      runs = offsets.flatMap((offset, i) => [offset as number, lengths[i] as number])
    }
  }
  return { sparse: sparseRuns(runs, realSize, start, size), realSize: realSize ?? size }
}

/** The 1.0 map: decimal numbers each ended by a newline, the run count first, then the runs. */
function sparseMap10(bytes: Uint8Array, start: number, size: number): { runs: number[]; blocks: number } | 'damaged' | 'unsupported' {
  const end = Math.min(start + size, bytes.length)
  const ran = start + size > bytes.length ? 'damaged' : 'unsupported'
  let p = start
  const number = (): number | null | 'end' => {
    const from = p
    let value = 0
    while (p < end && p - from < 17 && bytes[p] >= 0x30 && bytes[p] <= 0x39) value = value * 10 + bytes[p++] - 0x30
    if (p >= end) return 'end'
    if (p === from || bytes[p] !== 0x0a || !Number.isSafeInteger(value)) return null
    p++
    return value
  }
  const count = number()
  if (typeof count !== 'number') return count === 'end' ? ran : 'unsupported'
  const runs: number[] = []
  // Each number takes at least two bytes, so a huge count runs out of data first.
  while (runs.length < count * 2) {
    const n = number()
    if (typeof n !== 'number') return n === 'end' ? ran : 'unsupported'
    runs.push(n)
  }
  return { runs, blocks: Math.ceil((p - start) / 512) }
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
  let paxRecords: [string, string][] = []
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
    let dataStart = at + 512
    // An old GNU sparse header: extension blocks with more of the map come before the data.
    const gnuMap = type === 'S' ? oldGnuMap(bytes, at) : null
    if (gnuMap) dataStart += gnuMap.blocks * 512
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
      if (type === 'x') {
        pax = Object.fromEntries(parsed.records)
        paxRecords = parsed.records
      } else globalPax = { ...globalPax, ...Object.fromEntries(parsed.records) }
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
      let entrySize = type === '5' || type === '1' || type === '2' ? 0 : size
      let sparse: Sparse | undefined
      if (gnuMap) {
        const realSize = tarNumber(bytes, at + 483, 12)
        sparse = gnuMap.runs ? sparseRuns(gnuMap.runs, realSize, dataStart, size) : { error: cut ? 'damaged' : 'unsupported' }
        entrySize = realSize !== null && Number.isSafeInteger(realSize) && realSize >= 0 ? realSize : size
      } else if (type === '0' || type === '7') {
        const found = paxSparse(pax, paxRecords, bytes, dataStart, size)
        if (found) ({ sparse, realSize: entrySize } = found)
      }
      raws.push({
        nameBytes,
        // GNU tar names 0.1 and 1.0 sparse files "GNUSparseFile.<pid>/<name>" in the header.
        paxPath: headerPax['GNU.sparse.name'] ?? headerPax.path ?? null,
        linkBytes: longLink ?? cstring(bytes, at + 157, 100),
        paxLink: headerPax.linkpath ?? null,
        type,
        size: entrySize,
        dataStart,
        mtime: time(mtimePax) ?? time(tarNumber(bytes, at + 136, 12)),
        mode: tarNumber(bytes, at + 100, 8) ?? 0,
        sparse
      })
      longName = null
      longLink = null
      pax = {}
      paxRecords = []
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
  S: 0o100000,
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
  let cut = false
  const entries: Entry[] = raws.map((raw, index) => {
    const name = raw.paxPath !== null ? { name: raw.paxPath, legacy: false } : decode(raw.nameBytes)
    const dir = raw.type === '5' || raw.type === 'D' || /\/$/.test(name.name)
    const normal = normalizePath(name.name, false)
    cut ||= normal.cut
    const entry: Entry = {
      index,
      path: normal.path,
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
    // A path cut at the length limit means names the archive should not have.
    damaged: damaged || cut,
    read(entry, limit) {
      let target = entry
      // A hard link stores no data: read the file it links to, as tar and Python's tarfile do:
      // the last entry at that path before the link, on each hop.
      for (let hops = 0; target.link?.hard && hops < 8; hops++) {
        const linked = before(normalizePath(target.link.target, false).path, target.index)
        if (!linked) throw new EntryError('missing', target.link.target)
        target = linked
      }
      if (target.dir) throw new EntryError('directory')
      const raw = raws[target.index]
      if (!raw) throw new EntryError('missing')
      if (raw.sparse) return readSparse(bytes, raw.size, raw.sparse, limit)
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

/** A sparse file's first `limit` bytes: zeros, with each stored run copied to its offset. */
function readSparse(bytes: Uint8Array, size: number, sparse: Sparse, limit: number): ReadResult {
  if ('error' in sparse) throw new EntryError(sparse.error, 'tar-sparse')
  const length = Math.min(size, limit)
  const out = new Uint8Array(length)
  let from = sparse.start
  for (let i = 0; i < sparse.runs.length; i += 2) {
    const offset = sparse.runs[i]
    const run = sparse.runs[i + 1]
    if (offset >= length) break
    const take = Math.min(run, length - offset)
    if (from + take > bytes.length) throw new EntryError('damaged', 'data ends early')
    out.set(bytes.subarray(from, from + take), offset)
    from += run
  }
  return { bytes: out, truncated: size > limit }
}
