// ZIP (PKWARE APPNOTE 6.3): the central directory, found from the end record, lists every entry;
// each entry's data is unpacked only when it is previewed or saved. Handles ZIP64, data
// descriptors, prefixed data (self-extracting archives), Unix modes and links, Info-ZIP Unicode
// paths and extended timestamps, NTFS times, and legacy code page names.

import { bunzip2 } from '../codecs/bzip2'
import { crc32 } from '../codecs/crc32'
import { inflate } from '../codecs/deflate'
import { DamagedError, TooLargeError } from '../codecs/sink'
import { unzstd } from '../codecs/zstd'
import { findEndOfCentralDirectory } from './detect'
import { type Archive, type Entry, EntryError, type ReadResult } from './model'
import { type LegacyEncoding, decodeName, normalizePath, tryUtf8 } from './names'

const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const SIG_END64 = 0x06064b50
const SIG_LOCATOR64 = 0x07064b50

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

/** Parses a ZIP file. Throws `DamagedError` when there is no readable central directory. */
export function parseZip(bytes: Uint8Array, encoding: LegacyEncoding): Archive {
  const end = findEndOfCentralDirectory(bytes)
  if (end < 0) {
    throw new DamagedError('no ZIP end record')
  }
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

  const raws: Raw[] = []
  let at = cdOffset + shift
  let damaged = false
  // Walk the records while they last: some writers wrap the 16-bit entry count past 65 535.
  for (;;) {
    if (at + 46 > bytes.length || u32(bytes, at) !== SIG_CENTRAL) {
      damaged = raws.length < total && total !== 0xffff
      break
    }
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
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    const extraStart = at + 46 + nameLength
    const extraEnd = Math.min(bytes.length, extraStart + extraLength)

    let mtime: number | undefined = dosTime(date, time)
    let unicodePath: string | null = null
    for (let x = extraStart; x + 4 <= extraEnd; ) {
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

  return build(bytes, raws, shift, encoding, commentBytes, damaged)
}

function build(
  bytes: Uint8Array,
  raws: Raw[],
  shift: number,
  encoding: LegacyEncoding,
  commentBytes: Uint8Array,
  damaged: boolean
): Archive {
  let legacyNames = false
  const entries: Entry[] = raws.map((raw, index) => {
    const decoded = raw.unicodePath ?? null
    const name = decoded === null ? decodeName(raw.nameBytes, raw.utf8Flag, encoding) : { name: decoded, legacy: false }
    legacyNames ||= name.legacy
    const isLink = raw.mode !== undefined && (raw.mode & 0o170000) === 0o120000
    const dir =
      /[/\\]$/.test(name.name) ||
      (raw.mode !== undefined && (raw.mode & 0o170000) === 0o040000) ||
      (raw.dosDir && raw.size === 0)
    const entry: Entry = {
      index,
      path: normalizePath(name.name, raw.backslashes),
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
      try {
        const target = readRaw(bytes, raw, shift, 4096)
        entry.link = { target: new TextDecoder().decode(target.bytes), hard: false }
      } catch {
        // A link we cannot read shows as a file.
      }
    }
    return entry
  })
  const comment = commentBytes.length ? decodeName(commentBytes, false, encoding).name : undefined

  return {
    kind: 'zip',
    format: 'ZIP',
    entries,
    archiveSize: bytes.length,
    legacyNames,
    encoding,
    comment,
    damaged,
    read(entry, limit) {
      const raw = raws[entry.index]
      if (!raw) throw new EntryError('missing')
      if (entry.dir) throw new EntryError('directory')
      return readRaw(bytes, raw, shift, limit)
    },
    withEncoding(next) {
      return build(bytes, raws, shift, next, commentBytes, damaged)
    }
  }
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
        result = { bytes: data.subarray(0, Math.min(data.length, limit)), truncated: data.length > limit }
        break
      case 8:
        result = inflate(data, raw.size, limit)
        break
      case 12:
        result = bunzip2(data, limit, true)
        break
      case 93:
        result = unzstd(data, limit, true)
        break
      default:
        throw new EntryError('method', methodName(raw.method))
    }
  } catch (error) {
    if (error instanceof EntryError) throw error
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
