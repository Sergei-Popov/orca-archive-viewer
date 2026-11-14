// Zstandard through fzstd. Frame headers are read here first: fzstd allocates the window a frame
// declares (up to 2 GiB), so frames with a window over 128 MiB are refused before fzstd sees
// them. A frame that records its content size unpacks straight into a buffer of that size; one
// that does not streams through a window that vendor/fzstd is patched to slide cheaply (fzstd
// 0.1.1 moved the whole window after every block).

import { Decompress, decompress } from '../../vendor/fzstd/fzstd.mjs'
import { DamagedError, Sink, TooLargeError, UnsupportedDataError, asDecodeError, feed } from './sink'

/** Largest window the viewer unpacks; zstd uses at most 8 MiB below level 20 (`--ultra`). */
export const MAX_ZSTD_WINDOW = 128 * 1024 * 1024

const MAX_BLOCK = 128 * 1024

export type ZstdFrame = {
  start: number
  end: number
  /** Skippable frames carry no content. */
  skippable: boolean
  /** Window size in bytes. */
  window: number
  /** Frame_Content_Size, when the header records it. */
  size: number | null
  /** Most bytes the blocks can produce. */
  most: number
}

const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

/** Little-endian number of `n` bytes (n ≤ 8), exact up to 2^53. */
function readLE(b: Uint8Array, at: number, n: number): number {
  let value = 0
  for (let i = n - 1; i >= 0; i--) value = value * 256 + b[at + i]
  return value
}

/** Every frame of the data, found from the headers and block headers without decoding. */
export function zstdFrames(data: Uint8Array): ZstdFrame[] {
  const frames: ZstdFrame[] = []
  let at = 0
  while (at < data.length) {
    if (at + 8 > data.length) throw new DamagedError('zstd data ends early')
    const magic = u32(data, at)
    if (magic >>> 4 === 0x184d2a5) {
      const end = at + 8 + u32(data, at + 4)
      if (end > data.length) throw new DamagedError('zstd skippable frame ends early')
      frames.push({ start: at, end, skippable: true, window: 0, size: null, most: 0 })
      at = end
      continue
    }
    if (magic !== 0xfd2fb528) throw new DamagedError('not zstd data')
    const descriptor = data[at + 4]
    if (descriptor & 8) throw new DamagedError('reserved zstd header bit')
    const fcsFlag = descriptor >> 6
    const single = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictBytes = [0, 1, 2, 4][descriptor & 3]
    let p = at + 5
    let window = 0
    if (!single) {
      const wd = data[p++]
      const base = 2 ** (10 + (wd >> 3))
      window = base + (base / 8) * (wd & 7)
    }
    p += dictBytes
    const fcsBytes = fcsFlag ? 1 << fcsFlag : single
    if (p + fcsBytes > data.length) throw new DamagedError('zstd header ends early')
    let size: number | null = null
    if (fcsBytes) size = readLE(data, p, fcsBytes) + (fcsFlag === 1 ? 256 : 0)
    p += fcsBytes
    if (single) window = size ?? 0
    let most = 0
    for (;;) {
      if (p + 3 > data.length) throw new DamagedError('zstd data ends early')
      const header = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
      const last = header & 1
      const type = (header >> 1) & 3
      const blockSize = header >>> 3
      p += 3
      if (type === 3) throw new DamagedError('reserved zstd block type')
      if (type !== 1 && blockSize > MAX_BLOCK) throw new DamagedError('zstd block too large')
      p += type === 1 ? 1 : blockSize
      most += type === 2 ? MAX_BLOCK : blockSize
      if (p > data.length) throw new DamagedError('zstd data ends early')
      if (last) break
    }
    p += checksum * 4
    if (p > data.length) throw new DamagedError('zstd checksum missing')
    if (size !== null && size > most) throw new DamagedError('zstd content size larger than its blocks')
    frames.push({ start: at, end: p, skippable: false, window, size, most })
    at = p
  }
  return frames
}

/**
 * Every frame of Zstandard data, joined; `truncate` keeps the first `limit` bytes instead of
 * throwing. Throws `UnsupportedDataError` for a window over `maxWindow`.
 */
export function unzstd(
  data: Uint8Array,
  limit: number,
  truncate = false,
  maxWindow = MAX_ZSTD_WINDOW
): { bytes: Uint8Array; truncated: boolean } {
  let frames: ZstdFrame[]
  try {
    frames = zstdFrames(data)
  } catch (error) {
    throw asDecodeError(error, 'zstd')
  }
  if (frames.some((frame) => !frame.skippable && frame.window > maxWindow)) {
    throw new UnsupportedDataError('zstd-window')
  }
  const known = frames.every((frame) => frame.skippable || frame.size !== null)
  const declared = frames.reduce((sum, frame) => sum + (frame.size ?? 0), 0)
  const sink = new Sink(limit, truncate, known ? declared : 0)
  try {
    for (const frame of frames) {
      if (frame.skippable || frame.size === 0) continue
      if (sink.full) break
      const bytes = data.subarray(frame.start, frame.end)
      const room = limit - sink.total
      if (frame.size !== null && frame.size <= room) {
        sink.push(decompress(bytes, new Uint8Array(frame.size)))
        continue
      }
      if (frame.size !== null && !truncate) throw new TooLargeError(limit)
      // Unknown size, or only the start of a long frame is wanted: stream it.
      const stream = new Decompress((chunk) => sink.push(chunk))
      feed(bytes, (chunk, final) => stream.push(chunk, final), sink)
    }
  } catch (error) {
    throw asDecodeError(error, 'zstd')
  }
  return { bytes: sink.result(), truncated: sink.full }
}
