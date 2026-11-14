// DEFLATE and GZIP through fflate, stopping at a size limit.

import { Gunzip, Inflate, inflateSync } from '../../vendor/fflate/fflate.mjs'
import { DamagedError, Sink, TooLargeError, asDecodeError, feed } from './sink'

/**
 * Raw DEFLATE (ZIP method 8). `expected` is the size the archive declares: when it fits the limit
 * the data inflates in one call into a buffer of that size; otherwise it streams and stops at
 * `limit`, returning what it has with `truncated` set.
 */
export function inflate(
  data: Uint8Array,
  expected: number,
  limit: number
): { bytes: Uint8Array; truncated: boolean } {
  try {
    if (expected <= limit && expected > 0) {
      const out = inflateSync(data, { out: new Uint8Array(expected) })
      return { bytes: out, truncated: false }
    }
    const sink = new Sink(limit, true)
    const stream = new Inflate((chunk) => sink.push(chunk))
    feed(data, (chunk, final) => stream.push(chunk, final), sink)
    return { bytes: sink.result(), truncated: sink.full }
  } catch (error) {
    throw asDecodeError(error, 'deflate')
  }
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

/** Every member of a GZIP file, joined. Throws `TooLargeError` past `limit`. */
export function gunzip(data: Uint8Array, limit: number): Uint8Array {
  const sink = new Sink(limit)
  try {
    const stream = new Gunzip((chunk) => sink.push(chunk))
    feed(data, (chunk, final) => stream.push(chunk, final), sink, 1 << 20)
  } catch (error) {
    // Tar writers pad .tar.gz files with zeros after the last member; fflate reads those as a
    // broken member. Keep what was unpacked when it ends on padding.
    if (!(error instanceof TooLargeError) && sink.total > 0 && endsWithZeros(data)) {
      return sink.result()
    }
    throw asDecodeError(error, 'gzip')
  }
  return sink.result()
}

function endsWithZeros(data: Uint8Array): boolean {
  return data.length > 0 && data[data.length - 1] === 0
}
