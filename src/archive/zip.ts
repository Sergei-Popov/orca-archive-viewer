// ZIP (PKWARE APPNOTE 6.3): the central directory, found from the end record, lists every entry;
// each entry's data is unpacked only when it is previewed or saved. Handles ZIP64, data
// descriptors, prefixed data (self-extracting archives), Unix modes and links, Info-ZIP Unicode
// paths and extended timestamps, NTFS times, and legacy code page names. A ZIP cut off before its
// end record is read from its local headers instead, front to back, as bsdtar does.

import { bunzip2 } from '../codecs/bzip2'
import { crc32 } from '../codecs/crc32'
import { deflateEnd, inflate } from '../codecs/deflate'
import { DamagedError, TooLargeError, UnsupportedDataError } from '../codecs/sink'
import { unzstd } from '../codecs/zstd'
import { findEndOfCentralDirectory } from './detect'
import { type Archive, type Entry, EntryError, type ReadResult } from './model'
import { type LegacyEncoding, decodeName, normalizePath, tryUtf8 } from './names'

const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const SIG_END64 = 0x06064b50
const SIG_LOCATOR64 = 0x07064b50
const SIG_DESCRIPTOR = 0x08074b50
/** Most a DEFLATE entry may unpack to while a cut ZIP's local headers are scanned for its end. */
const SCAN_LIMIT = 512 * 1024 * 1024

const METHODS: Record<number, string> = {
  0: 'Stored',
  1: 'Shrink',
  6: 'Implode',
  8: 'Deflate',
  9: 'Deflate64',
  12: 'BZIP2',
  14: 'LZMA',
  93: 'Zstandard',
  95: 'XZ',
  96: 'JPEG',
  97: 'WavPack',
  98: 'PPMd',
  99: 'AES'
}

export function methodName(method: number): string {
  return METHODS[method] ?? `#${method}`
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 0x100000000

type Raw = {
  nameBytes: Uint8Array
  unicodePath: string | null
  utf8Flag: boolean
  backslashes: boolean
  flags: number
  method: number
  crc: number
  packed: number
  size: number
  localOffset: number
  mtime: number | undefined
  mode: number | undefined
  dosDir: boolean
}

/**
 * Parses a ZIP file. Without an end record (a cut download) the entries come from the local
 * headers, and the archive is damaged. Throws `DamagedError` when not even one local header
 * can be read.
 */
export function parseZip(bytes: Uint8Array, encoding: LegacyEncoding): Archive {
  const end = findEndOfCentralDirectory(bytes)
  if (end < 0) return scanLocal(bytes, encoding)
  let total = u16(bytes, end + 10)
  let cdSize = u32(bytes, end + 12)
  let cdOffset = u32(bytes, end + 16)
  const commentLength = u16(bytes, end + 20)
  const commentBytes = bytes.subarray(end + 22, Math.min(bytes.length, end + 22 + commentLength))
  let cdEnd = end

  // ZIP64: the locator sits right before the end record and points at the ZIP64 end record.
  const locator = end - 20
  if (locator >= 0 && u32(bytes, locator) === SIG_LOCATOR64) {
    let end64 = u64(bytes, locator + 8)
    if (end64 + 56 > bytes.length || u32(bytes, end64) !== SIG_END64) {
      end64 = locator - 56 // prefixed archive: the stored offset is off by the prefix
    }
    if (end64 >= 0 && u32(bytes, end64) === SIG_END64) {
      total = u64(bytes, end64 + 32)
      cdSize = u64(bytes, end64 + 40)
      cdOffset = u64(bytes, end64 + 48)
      cdEnd = end64
    }
  }

  // Data before the archive (a self-extractor stub) shifts every stored offset.
  let shift = 0
  const actualStart = cdEnd - cdSize
  if (actualStart >= 0 && actualStart !== cdOffset && u32(bytes, actualStart) === SIG_CENTRAL) {
    shift = actualStart - cdOffset
  }

  const raws = centralRecords(bytes, cdOffset + shift)
  const damaged = raws.length < total && total !== 0xffff
  return build(bytes, raws, shift, encoding, commentBytes, damaged, new Map())
}

/**
 * The central directory records from `at` on, while they last. A record whose name, extra field
 * or comment runs past the end of the data (a ZIP cut inside its central directory) ends the walk:
 * read anyway, it would give a name cut short, or a file turned into a folder by a cut after a
 * `/`, in place of the whole local header.
 */
function centralRecords(bytes: Uint8Array, at: number): Raw[] {
  const raws: Raw[] = []
  // Walk the records while they last: some writers wrap the 16-bit entry count past 65 535.
  for (;;) {
    if (at + 46 > bytes.length || u32(bytes, at) !== SIG_CENTRAL) break
    const madeBy = u16(bytes, at + 4)
    const flags = u16(bytes, at + 8)
    const method = u16(bytes, at + 10)
    const time = u16(bytes, at + 12)
    const date = u16(bytes, at + 14)
    const crc = u32(bytes, at + 16)
    let packed = u32(bytes, at + 20)
    let size = u32(bytes, at + 24)
    const nameLength = u16(bytes, at + 28)
    const extraLength = u16(bytes, at + 30)
    const entryCommentLength = u16(bytes, at + 32)
    const external = u32(bytes, at + 38)
    let localOffset = u32(bytes, at + 42)
    if (at + 46 + nameLength + extraLength + entryCommentLength > bytes.length) break
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    const extraStart = at + 46 + nameLength
    const extraEnd = extraStart + extraLength

    const extra = readExtra(bytes, extraStart, extraEnd, nameBytes, { size, packed, localOffset })
    size = extra.size
    packed = extra.packed
    localOffset = extra.localOffset
    const mtime = extra.mtime ?? dosTime(date, time)
    const unicodePath = extra.unicodePath

    const host = madeBy >> 8
    const unix = host === 3 || host === 19
    raws.push({
      nameBytes,
      unicodePath,
      utf8Flag: (flags & 0x800) !== 0,
      backslashes: host === 0 || host === 11 || host === 14,
      flags,
      method,
      crc,
      packed,
      size,
      localOffset,
      mtime,
      mode: unix && external >>> 16 ? external >>> 16 : undefined,
      dosDir: (external & 0x10) !== 0
    })
    at = extraStart + extraLength + entryCommentLength
  }
  return raws
}

type Sizes = { size: number; packed: number; localOffset: number }

/**
 * The extra fields this viewer reads: ZIP64 sizes and offset (only for fields stored as
 * 0xFFFFFFFF, in that order), extended timestamps, NTFS times and Info-ZIP Unicode paths.
 */
function readExtra(
  bytes: Uint8Array,
  start: number,
  end: number,
  nameBytes: Uint8Array,
  sizes: Sizes
): Sizes & { mtime: number | undefined; unicodePath: string | null } {
  let { size, packed, localOffset } = sizes
  let mtime: number | undefined
  let unicodePath: string | null = null
  for (let x = start; x + 4 <= end; ) {
    const id = u16(bytes, x)
    const length = u16(bytes, x + 2)
    const data = x + 4
    if (id === 0x0001) {
      let p = data
      if (size === 0xffffffff && p + 8 <= data + length) (size = u64(bytes, p)), (p += 8)
      if (packed === 0xffffffff && p + 8 <= data + length) (packed = u64(bytes, p)), (p += 8)
      if (localOffset === 0xffffffff && p + 8 <= data + length) localOffset = u64(bytes, p)
    } else if (id === 0x5455 && length >= 5 && bytes[data] & 1) {
      mtime = u32(bytes, data + 1) * 1000
    } else if (id === 0x000a && length >= 32 && u16(bytes, data + 4) === 1) {
      // NTFS: 100 ns ticks since 1601-01-01.
      const ticks = u64(bytes, data + 8)
      if (ticks > 0) mtime = Math.round(ticks / 10000 - 11644473600000)
    } else if (id === 0x7075 && length >= 5 && bytes[data] === 1) {
      // Info-ZIP Unicode Path, used when it matches the name it overrides.
      if (u32(bytes, data + 1) === crc32(nameBytes)) {
        unicodePath = tryUtf8(bytes.subarray(data + 5, data + length))
      }
    }
    x = data + length
  }
  return { size, packed, localOffset, mtime, unicodePath }
}

/**
 * Entries from the local headers, front to back, for a ZIP without an end record. Sizes come from
 * the header, or for an entry written with a data descriptor and no sizes, from the descriptor:
 * a DEFLATE entry is inflated to find where it ends (the descriptor's signature is optional),
 * otherwise the first signed descriptor that records its distance as the packed size counts.
 * Each search starts where the last entry ended, so the scan stays linear. A central directory
 * reached on the way gives the full record (Unix mode, link) of each entry it still lists; local
 * headers carry no Unix mode, so other links show as small files.
 */
function scanLocal(bytes: Uint8Array, encoding: LegacyEncoding): Archive {
  const raws: Raw[] = []
  // A split archive's first part may start with a descriptor signature as a marker.
  let at = u32(bytes, 0) === SIG_DESCRIPTOR ? 4 : 0
  while (at + 30 <= bytes.length && u32(bytes, at) === SIG_LOCAL) {
    const flags = u16(bytes, at + 6)
    const method = u16(bytes, at + 8)
    const nameLength = u16(bytes, at + 26)
    const extraLength = u16(bytes, at + 28)
    const nameBytes = bytes.subarray(at + 30, Math.min(bytes.length, at + 30 + nameLength))
    const start = at + 30 + nameLength + extraLength
    if (start > bytes.length) break
    const extra = readExtra(bytes, at + 30 + nameLength, start, nameBytes, {
      size: u32(bytes, at + 22),
      packed: u32(bytes, at + 18),
      localOffset: at
    })
    let { size, packed } = extra
    let crc = u32(bytes, at + 14)
    let next: number
    if (flags & 8 && packed === 0) {
      let found: Descriptor | null = null
      if (method === 8) {
        const end = deflateEnd(bytes, start, SCAN_LIMIT)
        found = end === null ? null : descriptorAt(bytes, end, start)
      } else {
        found = findDescriptor(bytes, start)
      }
      if (!found) break // cut inside this entry's data: its size is not known
      ;({ crc, packed, size, next } = found)
    } else {
      next = start + packed
      // A descriptor can follow even when the header has the sizes; its signature is optional.
      if (flags & 8 && next <= bytes.length) next = afterDescriptor(bytes, next)
    }
    raws.push({
      nameBytes,
      unicodePath: extra.unicodePath,
      utf8Flag: (flags & 0x800) !== 0,
      backslashes: false,
      flags,
      method,
      crc,
      packed,
      size,
      localOffset: at,
      mtime: extra.mtime ?? dosTime(u16(bytes, at + 12), u16(bytes, at + 10)),
      mode: undefined,
      dosDir: false
    })
    if (next > bytes.length) break // listed, and damaged when read
    at = next
  }
  if (!raws.length) throw new DamagedError('no ZIP end record or local header')
  if (at + 46 <= bytes.length && u32(bytes, at) === SIG_CENTRAL) {
    // The records the cut central directory still has replace the local ones, matched by offset.
    const central = new Map(centralRecords(bytes, at).map((raw) => [raw.localOffset, raw]))
    for (let i = 0; i < raws.length; i++) raws[i] = central.get(raws[i].localOffset) ?? raws[i]
  }
  return build(bytes, raws, 0, encoding, new Uint8Array(0), true, new Map())
}

type Descriptor = { crc: number; packed: number; size: number; next: number }

/** The first signed data descriptor after `start` that records its distance as the packed size. */
function findDescriptor(bytes: Uint8Array, start: number): Descriptor | null {
  for (let p = bytes.indexOf(0x50, start); p >= 0 && p + 16 <= bytes.length; p = bytes.indexOf(0x50, p + 1)) {
    if (u32(bytes, p) !== SIG_DESCRIPTOR) continue
    const found = descriptorAt(bytes, p, start)
    if (found) return found
  }
  return null
}

/** The data descriptor at `at`, signed or not, 32- or 64-bit, if it records `at - start` as the
 *  packed size. */
function descriptorAt(bytes: Uint8Array, at: number, start: number): Descriptor | null {
  const packed = at - start
  const p = u32(bytes, at) === SIG_DESCRIPTOR ? at + 4 : at
  if (p + 12 <= bytes.length && u32(bytes, p + 4) === packed) {
    return { crc: u32(bytes, p), packed, size: u32(bytes, p + 8), next: p + 12 }
  }
  if (p + 20 <= bytes.length && u64(bytes, p + 4) === packed) {
    return { crc: u32(bytes, p), packed, size: u64(bytes, p + 12), next: p + 20 }
  }
  return null
}

/** Where the next record starts after the descriptor at `at`, with or without its signature. */
function afterDescriptor(bytes: Uint8Array, at: number): number {
  const signed = u32(bytes, at) === SIG_DESCRIPTOR
  for (const skip of signed ? [16, 24] : [12, 20]) {
    const p = at + skip
    if (p === bytes.length || (p + 4 <= bytes.length && bytes[p] === 0x50 && bytes[p + 1] === 0x4b)) return p
  }
  return at + (signed ? 16 : 12)
}

/** Symbolic link targets by local header offset; null when the target cannot be read. */
type LinkCache = Map<number, string | null>

function build(
  bytes: Uint8Array,
  raws: Raw[],
  shift: number,
  encoding: LegacyEncoding,
  commentBytes: Uint8Array,
  damaged: boolean,
  links: LinkCache
): Archive {
  let legacyNames = false
  let cut = false
  const entries: Entry[] = raws.map((raw, index) => {
    const decoded = raw.unicodePath ?? null
    const name = decoded === null ? decodeName(raw.nameBytes, raw.utf8Flag, encoding) : { name: decoded, legacy: false }
    legacyNames ||= name.legacy
    const isLink = raw.mode !== undefined && (raw.mode & 0o170000) === 0o120000
    const dir =
      /[/\\]$/.test(name.name) ||
      (raw.mode !== undefined && (raw.mode & 0o170000) === 0o040000) ||
      (raw.dosDir && raw.size === 0)
    const normal = normalizePath(name.name, raw.backslashes)
    cut ||= normal.cut
    const entry: Entry = {
      index,
      path: normal.path,
      dir,
      size: raw.size,
      packed: raw.packed,
      mtime: raw.mtime,
      mode: raw.mode,
      method: methodName(raw.method),
      crc: raw.crc,
      encrypted: (raw.flags & 1) !== 0,
      legacy: name.legacy
    }
    if (isLink && !entry.encrypted && raw.size < 4096) {
      // A link's target is its data, so it is unpacked the first time a row or the preview asks,
      // never while the archive opens: thousands of records can point at one costly stream.
      let link: Entry['link'] | null = null
      Object.defineProperty(entry, 'link', {
        enumerable: true,
        get: () => {
          if (link === null) {
            const target = linkTarget(bytes, raw, shift, links)
            link = target === null ? undefined : { target, hard: false }
          }
          return link
        }
      })
    }
    return entry
  })
  const comment = commentBytes.length ? decodeName(commentBytes, false, encoding).name : undefined

  return {
    kind: 'zip',
    format: 'ZIP',
    entries,
    archiveSize: bytes.length,
    unpacked: 0,
    legacyNames,
    encoding,
    comment,
    // A path cut at the length limit means names the archive should not have.
    damaged: damaged || cut,
    read(entry, limit) {
      const raw = raws[entry.index]
      if (!raw) throw new EntryError('missing')
      if (entry.dir) throw new EntryError('directory')
      return readRaw(bytes, raw, shift, limit)
    },
    withEncoding(next) {
      return build(bytes, raws, shift, next, commentBytes, damaged, links)
    }
  }
}

/** A link's target, read once per local header; null when it cannot be read (it shows as a file). */
function linkTarget(bytes: Uint8Array, raw: Raw, shift: number, links: LinkCache): string | null {
  const key = raw.localOffset + shift
  let target = links.get(key)
  if (target === undefined) {
    try {
      target = new TextDecoder().decode(readRaw(bytes, raw, shift, 4096).bytes)
    } catch {
      target = null
    }
    links.set(key, target)
  }
  return target
}

function readRaw(bytes: Uint8Array, raw: Raw, shift: number, limit: number): ReadResult {
  if (raw.flags & 1 || raw.method === 99) {
    throw new EntryError('encrypted')
  }
  const local = raw.localOffset + shift
  if (local + 30 > bytes.length || u32(bytes, local) !== SIG_LOCAL) {
    throw new EntryError('damaged', 'local header not found')
  }
  const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
  const end = start + raw.packed
  if (end > bytes.length) {
    throw new EntryError('damaged', 'data ends early')
  }
  const data = bytes.subarray(start, end)
  let result: ReadResult
  try {
    switch (raw.method) {
      case 0:
        if (data.length !== raw.size) throw new DamagedError('stored data is not the size the archive records')
        result = { bytes: data.subarray(0, Math.min(data.length, limit)), truncated: data.length > limit }
        break
      case 8:
        result = inflate(data, raw.size, limit)
        break
      case 12:
      case 93: {
        // Like inflate: one byte past the recorded size is enough to call the entry damaged.
        const cap = Math.min(limit, raw.size) + 1
        const out = raw.method === 12 ? bunzip2(data, cap, true) : unzstd(data, cap, true)
        if (out.bytes.length > raw.size) throw new DamagedError('data is longer than the size the archive records')
        result = out.bytes.length > limit ? { bytes: out.bytes.subarray(0, limit), truncated: true } : { bytes: out.bytes, truncated: false }
        break
      }
      default:
        throw new EntryError('method', methodName(raw.method))
    }
  } catch (error) {
    if (error instanceof EntryError) throw error
    if (error instanceof UnsupportedDataError) throw new EntryError('unsupported', error.feature)
    if (error instanceof DamagedError || error instanceof TooLargeError) {
      throw new EntryError('damaged', error.message)
    }
    throw new EntryError('damaged', error instanceof Error ? error.message : String(error))
  }
  if (!result.truncated) {
    result.crcOk = crc32(result.bytes) === raw.crc
  }
  return result
}

/** MS-DOS date and time fields as local time; undefined when unset. */
export function dosTime(date: number, time: number): number | undefined {
  if (date === 0) return undefined
  const year = 1980 + (date >> 9)
  const month = ((date >> 5) & 15) - 1
  const day = date & 31
  if (month < 0 || month > 11 || day < 1) return undefined
  return new Date(year, month, day, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime()
}
