// Zstandard through fzstd. Frame headers are read here first: fzstd allocates the window a frame
// declares (up to 2 GiB), so frames with a window over 128 MiB are refused before fzstd sees
// them. A frame that records its content size unpacks straight into a buffer of that size; one
// that does not streams through a window that vendor/fzstd is patched to slide cheaply (fzstd
// 0.1.1 moved the whole window after every block).

import { Decompress, decompress } from '../../vendor/fzstd/fzstd.mjs'
import { DamagedError, Sink, type StreamResult, TooLargeError, UnsupportedDataError, asDecodeError, feed } from './sink'

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
  /** The data ends inside this frame. */
  cut?: boolean
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
  const { frames, error } = scanFrames(data)
  if (error) throw error
  return frames
}

/**
 * The frames up to the first damage, and that damage. A frame whose header is whole but whose
 * blocks or checksum run past the end of the data is kept, marked `cut`, so its blocks can still
 * be decoded.
 */
function scanFrames(data: Uint8Array): { frames: ZstdFrame[]; error: DamagedError | null } {
  const frames: ZstdFrame[] = []
  let at = 0
  const fail = (message: string) => ({ frames, error: new DamagedError(message) })
  while (at < data.length) {
    if (at + 8 > data.length) return fail('zstd data ends early')
    const magic = u32(data, at)
    if (magic >>> 4 === 0x184d2a5) {
      const end = at + 8 + u32(data, at + 4)
      if (end > data.length) return fail('zstd skippable frame ends early')
      frames.push({ start: at, end, skippable: true, window: 0, size: null, most: 0 })
      at = end
      continue
    }
    if (magic !== 0xfd2fb528) return fail('not zstd data')
    const descriptor = data[at + 4]
    if (descriptor & 8) return fail('reserved zstd header bit')
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
    if (p + fcsBytes > data.length) return fail('zstd header ends early')
    let size: number | null = null
    if (fcsBytes) size = readLE(data, p, fcsBytes) + (fcsFlag === 1 ? 256 : 0)
    p += fcsBytes
    if (single) window = size ?? 0
    let most = 0
    const cut = () => {
      frames.push({ start: at, end: data.length, skippable: false, window, size, most, cut: true })
      return fail('zstd data ends early')
    }
    for (;;) {
      if (p + 3 > data.length) return cut()
      const header = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
      const last = header & 1
      const type = (header >> 1) & 3
      const blockSize = header >>> 3
      p += 3
      if (type === 3) return fail('reserved zstd block type')
      if (type !== 1 && blockSize > MAX_BLOCK) return fail('zstd block too large')
      p += type === 1 ? 1 : blockSize
      most += type === 2 ? MAX_BLOCK : blockSize
      if (p > data.length) return cut()
      if (last) break
    }
    if (size !== null && size > most) return fail('zstd content size larger than its blocks')
    p += checksum * 4
    if (p > data.length) return cut()
    frames.push({ start: at, end: p, skippable: false, window, size, most })
    at = p
  }
  return { frames, error: null }
}

/**
 * Every frame of Zstandard data, joined; `truncate` keeps the first `limit` bytes instead of
 * throwing. Throws `UnsupportedDataError` for a window over `maxWindow`. `partial`: damaged or
 * cut-off data returns what the frames before the damage, and the blocks of a cut-off frame,
 * unpack to.
 */
export function unzstd(
  data: Uint8Array,
  limit: number,
  truncate = false,
  maxWindow = MAX_ZSTD_WINDOW,
  partial = false
): StreamResult {
  const { frames, error } = scanFrames(data)
  if (error && !partial) throw error
  if (frames.some((frame) => !frame.skippable && frame.window > maxWindow)) {
    throw new UnsupportedDataError('zstd-window')
  }
  // A cut frame's size is not checked against its blocks, so it does not size the buffer.
  const known = frames.every((frame) => frame.skippable || (frame.size !== null && !frame.cut))
  const declared = frames.reduce((sum, frame) => sum + (frame.size ?? 0), 0)
  const sink = new Sink(limit, truncate, known ? declared : 0)
  try {
    for (const frame of frames) {
      if (frame.skippable || frame.size === 0) continue
      if (sink.full) break
      const bytes = data.subarray(frame.start, frame.end)
      const room = limit - sink.total
      if (!frame.cut && frame.size !== null && frame.size <= room) {
        sink.push(decompress(bytes, new Uint8Array(frame.size)))
        continue
      }
      if (!frame.cut && frame.size !== null && !truncate) throw new TooLargeError(limit)
      // Unknown size, only the start of a long frame is wanted, or the frame is cut off (never
      // pushed as final, so its whole blocks come out): stream it.
      const stream = new Decompress((chunk) => sink.push(chunk))
      feed(bytes, (chunk, final) => stream.push(chunk, final && !frame.cut), sink)
    }
  } catch (caught) {
    const failure = asDecodeError(caught, 'zstd')
    if (partial && failure instanceof DamagedError && sink.total > 0) {
      return { bytes: sink.result(), truncated: false, damaged: true }
    }
    throw failure
  }
  if (error && !sink.full) {
    if (sink.total === 0) throw error
    return { bytes: sink.result(), truncated: false, damaged: true }
  }
  return { bytes: sink.result(), truncated: sink.full, damaged: false }
}
