// The .xz container, ported to TypeScript from XZ Embedded, so the viewer needs no WebAssembly.
//
// Upstream: XZ Embedded v2024-12-30 (git commit ae63ae3a36ed01724674e8f3d750dc47bf125410),
// https://tukaani.org/xz/embedded.html, by Lasse Collin and Igor Pavlov, 0BSD.
// Ported files (linux/lib/xz/): xz_dec_stream.c and xz_stream.h → stream.ts; xz_dec_lzma2.c and
// xz_lzma2.h → lzma2.ts; xz_crc64.c → crc64.ts (CRC-32 is ../crc32.ts).
//
// Scope is what the WebAssembly build of XZ Embedded did here before: the LZMA2 filter only, no
// BCJ or delta filters, CRC-32, CRC-64 or no check (SHA-256 is refused, as in a build without
// XZ_USE_SHA256), dictionaries up to 64 MiB. Changes from the C code:
// - The whole input is in memory: no multi-call state machine. Concatenated Streams and Stream
//   Padding are decoded as xz_dec_catrun() does (XZ_DEC_CONCATENATED).
// - The Index is compared with the Blocks record by record instead of through a CRC32 hash, and
//   the first byte of each LZMA chunk must be zero (lzma2.ts), so damage that XZ Embedded lets
//   through is caught as xz -d catches it.
// - Errors name what is wrong instead of returning XZ_DATA_ERROR.

import { crc32 } from '../crc32'
import { DamagedError, UnsupportedDataError } from '../sink'
import { crc64 } from './crc64'
import type { Steps } from '../steps'
import { Lzma2Decoder, type Output } from './lzma2'

/** Largest LZMA2 dictionary the viewer accepts: `xz -9` uses 64 MiB. */
export const MAX_XZ_DICTIONARY = 64 * 1024 * 1024

const STREAM_HEADER_SIZE = 12
const HEADER_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]
const FOOTER_MAGIC = [0x59, 0x5a] // "YZ"

// enum xz_check
const XZ_CHECK_NONE = 0
const XZ_CHECK_CRC32 = 1
const XZ_CHECK_CRC64 = 4
const XZ_CHECK_MAX = 15
/** Sizes of the Check field with different Check IDs. */
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64]

/** The LZMA2 filter ID in a Block Header. */
const FILTER_LZMA2 = 0x21

const endsEarly = () => new DamagedError('xz data ends early')
const unsupportedOptions = () => new UnsupportedDataError('xz-options')

const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

/**
 * dec_vli: a little-endian base-128 number from `b[at]`, not past `end`; returns it and the
 * position after it. Values over 2^53 lose precision, which only invalid files reach.
 */
function vli(b: Uint8Array, at: number, end: number): [number, number] {
  let value = 0
  for (let shift = 0; shift < 63; shift += 7) {
    if (at >= end) throw end === b.length ? endsEarly() : new DamagedError('xz number runs past its field')
    const byte = b[at++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) {
      // Don't allow non-minimal encodings.
      if (byte === 0 && shift !== 0) throw new DamagedError('xz number is not minimally encoded')
      return [value, at]
    }
  }
  throw new DamagedError('xz number is too long')
}

/**
 * What the data unpacks to by its Indexes: each Stream ends in a Footer that gives the size of
 * the Index before it, which lists every Block's sizes. Walked from the end, Stream by Stream,
 * so the output can be allocated once. 0 when anything does not fit (a cut file, damage, data
 * that is not XZ): it is only a size hint, and the decoder checks everything again.
 */
export function indexedSize(data: Uint8Array): number {
  let end = data.length
  let total = 0
  while (end > 0) {
    // Stream Padding before the end, in whole groups of four zero bytes.
    while (end >= 4 && le32(data, end - 4) === 0) end -= 4
    const footer = end - STREAM_HEADER_SIZE
    if (footer < STREAM_HEADER_SIZE || data[end - 2] !== FOOTER_MAGIC[0] || data[end - 1] !== FOOTER_MAGIC[1]) return 0
    if (crc32(data.subarray(footer + 4, footer + 10)) !== le32(data, footer)) return 0
    const index = footer - (le32(data, footer + 4) + 1) * 4
    if (index < STREAM_HEADER_SIZE || data[index] !== 0) return 0
    let blocks = 0
    try {
      let [count, at] = vli(data, index + 1, footer)
      for (; count > 0; count--) {
        let unpadded: number
        let uncompressed: number
        ;[unpadded, at] = vli(data, at, footer)
        ;[uncompressed, at] = vli(data, at, footer)
        blocks += Math.ceil(unpadded / 4) * 4
        total += uncompressed
      }
    } catch {
      return 0
    }
    const start = index - blocks - STREAM_HEADER_SIZE
    if (start < 0 || HEADER_MAGIC.some((byte, i) => data[start + i] !== byte)) return 0
    end = start
  }
  return total
}

/**
 * Every Stream of the data with its Stream Padding (xz_dec_catrun), decoded into `out`. Stops
 * early once `out` is full in truncate mode. Yields after each LZMA2 chunk (see ../steps.ts).
 */
export function* decodeXz(data: Uint8Array, out: Output): Steps<void> {
  const lzma2 = new Lzma2Decoder(out)
  let at = 0
  for (;;) {
    at = yield* decodeStream(data, at, out, lzma2)
    if (at < 0) return
    // Stream Padding: zero bytes, a multiple of four, before the next Stream or the end.
    const padding = at
    while (at < data.length && data[at] === 0) at++
    if ((at - padding) % 4 !== 0) throw new DamagedError('xz stream padding is not a multiple of four bytes')
    if (at === data.length) return
  }
}

/** dec_main for one Stream from `data[at]`: returns the position after its Footer, or -1. */
function* decodeStream(data: Uint8Array, at: number, out: Output, lzma2: Lzma2Decoder): Steps<number> {
  // dec_stream_header
  if (at + STREAM_HEADER_SIZE > data.length) throw endsEarly()
  if (HEADER_MAGIC.some((byte, i) => data[at + i] !== byte)) throw new DamagedError('not xz data')
  if (crc32(data.subarray(at + 6, at + 8)) !== le32(data, at + 8)) {
    throw new DamagedError('xz stream header CRC-32 mismatch')
  }
  if (data[at + 6] !== 0) throw unsupportedOptions()
  const check = data[at + 7]
  // Of integrity checks, none, CRC32 and CRC64 are supported.
  if (check > XZ_CHECK_MAX || (check !== XZ_CHECK_NONE && check !== XZ_CHECK_CRC32 && check !== XZ_CHECK_CRC64)) {
    throw unsupportedOptions()
  }
  at += STREAM_HEADER_SIZE

  /** Unpadded and uncompressed size of each Block, for the Index. */
  const blocks: [number, number][] = []
  for (;;) {
    if (at >= data.length) throw endsEarly()
    // A zero byte begins the Index.
    if (data[at] === 0) break

    // dec_block_header
    const headerSize = (data[at] + 1) * 4
    if (at + headerSize > data.length) throw endsEarly()
    const header = data.subarray(at, at + headerSize)
    const fields = headerSize - 4
    if (crc32(header.subarray(0, fields)) !== le32(header, fields)) {
      throw new DamagedError('xz block header CRC-32 mismatch')
    }
    // Block Flags: one filter (LZMA2) and no reserved bits; BCJ and delta need two or more.
    const flags = header[1]
    if (flags & 0x3f) throw unsupportedOptions()
    let p = 2
    let compressedSize = -1
    let uncompressedSize = -1
    if (flags & 0x40) [compressedSize, p] = vli(header, p, fields)
    if (flags & 0x80) [uncompressedSize, p] = vli(header, p, fields)
    // Valid Filter Flags always take at least two bytes.
    if (fields - p < 2) throw new DamagedError('xz block header too short')
    if (header[p++] !== FILTER_LZMA2) throw unsupportedOptions()
    // Size of Properties: the one byte of the LZMA2 dictionary size.
    if (header[p++] !== 0x01) throw unsupportedOptions()
    if (fields - p < 1) throw new DamagedError('xz block header too short')
    const props = header[p++]
    // xz_dec_lzma2_reset: this limits the dictionary to 3 GiB to keep parsing simpler.
    if (props > 39) throw unsupportedOptions()
    const dictSize = (2 + (props & 1)) * 2 ** ((props >> 1) + 11)
    if (dictSize > MAX_XZ_DICTIONARY) throw new UnsupportedDataError('xz-dictionary')
    // The rest must be Header Padding.
    while (p < fields) if (header[p++] !== 0x00) throw unsupportedOptions()
    at += headerSize

    // dec_block: the Compressed Data
    const start = out.pos
    const dataStart = at
    lzma2.reset(dictSize)
    const end = yield* lzma2.run(data, at)
    if (end < 0) return -1
    const compressed = end - dataStart
    const uncompressed = out.pos - start
    if (
      (compressedSize >= 0 && compressedSize !== compressed) ||
      (uncompressedSize >= 0 && uncompressedSize !== uncompressed)
    ) {
      throw new DamagedError('xz block sizes differ from its header')
    }
    at = end

    // Block Padding: Compressed Data + Block Padding is a multiple of four bytes.
    while ((at - dataStart) % 4 !== 0) {
      if (at >= data.length) throw endsEarly()
      if (data[at++] !== 0) throw new DamagedError('xz block padding is not zero')
    }

    // The Check of the Block's uncompressed data.
    const checkSize = CHECK_SIZES[check]
    if (at + checkSize > data.length) throw endsEarly()
    const bytes = out.buf.subarray(start, out.pos)
    if (check === XZ_CHECK_CRC32 && crc32(bytes) !== le32(data, at)) {
      throw new DamagedError('xz block CRC-32 mismatch')
    }
    if (check === XZ_CHECK_CRC64) {
      const [lo, hi] = crc64(bytes)
      if (lo !== le32(data, at) || hi !== le32(data, at + 4)) throw new DamagedError('xz block CRC-64 mismatch')
    }
    at += checkSize
    blocks.push([headerSize + compressed + checkSize, uncompressed])
  }

  // dec_index: the Number of Records, then each Record, then Index Padding and CRC32.
  const index = at++
  let count: number
  ;[count, at] = vli(data, at, data.length)
  if (count !== blocks.length) throw new DamagedError('xz index lists another number of blocks')
  for (const [unpadded, uncompressed] of blocks) {
    let value: number
    ;[value, at] = vli(data, at, data.length)
    if (value !== unpadded) throw new DamagedError('xz index does not match the blocks')
    ;[value, at] = vli(data, at, data.length)
    if (value !== uncompressed) throw new DamagedError('xz index does not match the blocks')
  }
  while ((at - index) % 4 !== 0) {
    if (at >= data.length) throw endsEarly()
    if (data[at++] !== 0) throw new DamagedError('xz index padding is not zero')
  }
  if (at + 4 > data.length) throw endsEarly()
  if (crc32(data.subarray(index, at)) !== le32(data, at)) throw new DamagedError('xz index CRC-32 mismatch')
  const indexSize = at - index
  at += 4

  // dec_stream_footer
  if (at + STREAM_HEADER_SIZE > data.length) throw endsEarly()
  if (FOOTER_MAGIC.some((byte, i) => data[at + 10 + i] !== byte)) throw new DamagedError('xz stream footer is missing')
  if (crc32(data.subarray(at + 4, at + 10)) !== le32(data, at)) {
    throw new DamagedError('xz stream footer CRC-32 mismatch')
  }
  // Backward Size: the Index size in units of four bytes, minus one (counting its CRC32).
  if (le32(data, at + 4) !== indexSize / 4) throw new DamagedError('xz stream footer gives another index size')
  if (data[at + 8] !== 0 || data[at + 9] !== check) throw new DamagedError('xz stream footer differs from its header')
  return at + STREAM_HEADER_SIZE
}
