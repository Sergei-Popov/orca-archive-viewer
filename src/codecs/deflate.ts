// DEFLATE and GZIP through fflate's streaming inflater, fed in small slices so a size cap stops it
// early: one slice of DEFLATE expands to at most about 1000 times its size.

import { Inflate } from '../../vendor/fflate/fflate.mjs'
import { crc32 } from './crc32'
import { DamagedError, Sink, TooLargeError, asDecodeError, feed } from './sink'

const SLICE = 1 << 16

/**
 * Raw DEFLATE (ZIP method 8). `expected` is the size the archive declares. Up to `limit` bytes
 * come back, with `truncated` set when the entry is longer. Data that unpacks to more than the
 * declared size is damaged: it stops one byte past the declared size instead of running on.
 */
export function inflate(
  data: Uint8Array,
  expected: number,
  limit: number,
  slice = SLICE
): { bytes: Uint8Array; truncated: boolean } {
  const cap = Math.min(limit, expected) + 1
  // DEFLATE expands at most 1032 times, so a lying size cannot make the sink allocate much, and
  // slices of about cap / 1032 bytes keep the work past the cap to about the cap itself.
  const sink = new Sink(cap, true, Math.min(cap, data.length * 1032 + 64))
  const step = Math.min(slice, Math.max(1024, Math.ceil(cap / 1032)))
  try {
    const stream = new Inflate((chunk) => sink.push(chunk))
    feed(data, (chunk, final) => stream.push(chunk, final && !sink.full), sink, step)
  } catch (error) {
    if (!sink.full) throw asDecodeError(error, 'deflate')
  }
  const bytes = sink.result()
  if (bytes.length > expected) {
    throw new DamagedError('deflate data is longer than the size the archive declares')
  }
  if (bytes.length > limit) {
    return { bytes: bytes.subarray(0, limit), truncated: true }
  }
  return { bytes, truncated: false }
}

/**
 * Where the raw DEFLATE stream that starts at `start` ends, found by inflating it with the output
 * thrown away; null when the data ends first, is damaged, or unpacks to more than `limit`.
 */
export function deflateEnd(data: Uint8Array, start: number, limit: number, slice = SLICE): number | null {
  let total = 0
  const stream = new Inflate((chunk) => {
    total += chunk.length
  })
  const state = stream as unknown as InflateInternals
  let pos = start
  try {
    while (pos < data.length) {
      const end = Math.min(pos + slice, data.length)
      stream.push(data.subarray(pos, end), false)
      pos = end
      if (state.s.f && !state.s.l) return pos - state.p.subarray(((state.s.p ?? 0) + 7) >> 3).length
      if (total > limit) return null
    }
  } catch {
    return null
  }
  return null
}

export type GzipHeader = {
  /** FNAME bytes, without the terminating zero. */
  name: Uint8Array | null
  /** MTIME in milliseconds, or null when the header leaves it zero. */
  mtime: number | null
}

/** Reads the first member's header (RFC 1952). */
export function gzipHeader(data: Uint8Array): GzipHeader {
  if (data.length < 10 || data[0] !== 0x1f || data[1] !== 0x8b) {
    throw new DamagedError('not gzip data')
  }
  const flags = data[3]
  const seconds = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) >>> 0
  let at = 10
  if (flags & 4) {
    at += 2 + (data[at] | (data[at + 1] << 8))
  }
  let name: Uint8Array | null = null
  if (flags & 8) {
    const start = at
    while (at < data.length && data[at] !== 0) at++
    name = data.subarray(start, at)
  }
  return { name, mtime: seconds ? seconds * 1000 : null }
}

/** Length of the member header at `at`; throws when there is no valid one. */
function memberHeader(data: Uint8Array, at: number): number {
  if (at + 10 > data.length || data[at] !== 0x1f || data[at + 1] !== 0x8b || data[at + 2] !== 8) {
    throw new DamagedError('not a gzip member')
  }
  const flags = data[at + 3]
  if (flags & 0xe0) throw new DamagedError('reserved gzip flags')
  let p = at + 10
  if (flags & 4) p += 2 + (data[p] | (data[p + 1] << 8))
  for (const bit of [8, 16]) {
    if (flags & bit) {
      while (p < data.length && data[p] !== 0) p++
      p++
    }
  }
  if (flags & 2) p += 2
  if (p > data.length) throw new DamagedError('gzip header ends early')
  return p - at
}

const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

function allZero(data: Uint8Array, from: number): boolean {
  for (let i = from; i < data.length; i++) if (data[i] !== 0) return false
  return true
}

/** fflate's Inflate state: `s.f` the last block began, `s.l` a block is in progress, `s.p` the
 *  bit position in `p`, the input not consumed yet. Gunzip in fflate 0.8.3 reads the same. */
type InflateInternals = { s: { f?: number; l?: unknown; p?: number }; p: Uint8Array }

export type GunzipResult = {
  bytes: Uint8Array
  /** A member failed its CRC-32 or size check, the data ends early, or junk follows it. */
  damaged: boolean
}

/**
 * Every member of a GZIP file, joined, each checked against its CRC-32 and ISIZE. Zero bytes
 * after a complete member are padding (tar writers add them). Damaged data returns what came
 * before the damage with `damaged` set; data with nothing readable throws `DamagedError`.
 * Throws `TooLargeError` past `limit`.
 */
/**
 * The size a gzip file unpacks to, from the ISIZE at its end, when that fits one member: DEFLATE
 * output is at least its input less stored-block overhead and at most 1032 times it. Otherwise
 * 0: several members (ISIZE is the last one's), trailing bytes, or 4 GiB or more (ISIZE wraps).
 */
export function singleMemberSize(data: Uint8Array): number {
  if (data.length < 18) return 0
  let start: number
  try {
    start = memberHeader(data, 0)
  } catch {
    return 0
  }
  const packed = data.length - start - 8
  const size = u32(data, data.length - 4)
  return packed > 0 && size + 64 >= packed - Math.ceil(packed / 8192) && size <= packed * 1032 + 64 ? size : 0
}

export function gunzip(data: Uint8Array, limit: number, slice = SLICE): GunzipResult {
  const sink = new Sink(limit, false, singleMemberSize(data))
  let damaged = false
  let members = 0
  let at = 0
  try {
    while (at < data.length) {
      if (members > 0 && allZero(data, at)) break
      let pos: number
      try {
        pos = at + memberHeader(data, at)
      } catch (error) {
        if (members === 0) throw error
        damaged = true // something that is not gzip after the last member
        break
      }
      let crc = 0
      let size = 0
      const stream = new Inflate((chunk) => {
        crc = crc32(chunk, crc)
        size += chunk.length
        sink.push(chunk)
      })
      const state = stream as unknown as InflateInternals
      let rest: Uint8Array | null = null
      while (pos < data.length) {
        const end = Math.min(pos + slice, data.length)
        stream.push(data.subarray(pos, end), false)
        pos = end
        if (state.s.f && !state.s.l) {
          rest = state.p.subarray(((state.s.p ?? 0) + 7) >> 3)
          break
        }
      }
      if (!rest) {
        damaged = true // the data ends inside the member
        break
      }
      const trailer = pos - rest.length
      if (trailer + 8 > data.length) {
        damaged = true
        break
      }
      if (u32(data, trailer) !== crc >>> 0 || u32(data, trailer + 4) !== size >>> 0) {
        damaged = true
      }
      members++
      at = trailer + 8
    }
  } catch (error) {
    if (error instanceof TooLargeError) throw error
    if (sink.total === 0) throw asDecodeError(error, 'gzip')
    damaged = true
  }
  if (members === 0 && sink.total === 0) {
    throw new DamagedError('gzip data ends early')
  }
  return { bytes: sink.result(), damaged }
}
