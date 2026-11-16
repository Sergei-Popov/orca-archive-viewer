// Collects decompressed output up to a limit, so a small archive that unpacks to gigabytes (a
// "zip bomb") is refused or cut at the limit instead of exhausting the tab's memory.

import { type Steps, run } from './steps'

/** Thrown when a stream unpacks to more than the caller allowed. */
export class TooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`unpacks to more than ${limit} bytes`)
    this.name = 'TooLargeError'
    this.limit = limit
  }
}

/** Thrown when compressed data is damaged or truncated. */
export class DamagedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DamagedError'
  }
}

/** Valid data that uses something the viewer does not decode, such as a huge window. */
export class UnsupportedDataError extends Error {
  readonly feature: UnsupportedFeature

  constructor(feature: UnsupportedFeature) {
    super(`unsupported: ${feature}`)
    this.name = 'UnsupportedDataError'
    this.feature = feature
  }
}

export type UnsupportedFeature = 'zstd-window' | 'xz-dictionary' | 'xz-options' | 'tar-sparse'

/** Output blocks start at MIN_BLOCK and grow with the output up to BLOCK. */
const MIN_BLOCK = 64 * 1024
const BLOCK = 16 * 1024 * 1024

/**
 * Output of a decoder, up to `limit` bytes. It is kept in blocks that are joined once, in
 * result(): nothing is copied while a stream unpacks, a stream refused at the limit never holds
 * more than the limit, and the result is exactly as long as the output. Joining briefly needs
 * the output twice over, unless a right `hint` let one block hold it all. Decoders still decode
 * whatever input they were given in one push, so callers feed input in small slices and stop
 * once the sink is full; output past the limit is never kept.
 */
export class Sink {
  private blocks: Uint8Array[] = []
  private block: Uint8Array
  private used = 0
  total = 0
  /** True once the limit was reached in `truncate` mode. */
  full = false

  readonly limit: number
  private readonly truncate: boolean

  /**
   * `truncate`: keep the first `limit` bytes and set `full`; otherwise throw `TooLargeError`.
   * `hint`: the expected size, so one block can hold the output.
   */
  constructor(limit: number, truncate = false, hint = 0) {
    this.limit = limit
    this.truncate = truncate
    this.block = new Uint8Array(Math.max(0, Math.min(hint, limit)))
  }

  push(chunk: Uint8Array): void {
    if (this.full || chunk.length === 0) {
      return
    }
    const room = this.limit - this.total
    if (chunk.length > room) {
      if (!this.truncate) {
        throw new TooLargeError(this.limit)
      }
      chunk = chunk.subarray(0, room)
      this.full = true
    }
    // Decoders may reuse their output buffers, so this is a copy.
    for (let at = 0; at < chunk.length; ) {
      if (this.used === this.block.length) {
        if (this.used) this.blocks.push(this.block)
        const total = this.total + at
        this.block = new Uint8Array(Math.min(this.limit - total, Math.max(MIN_BLOCK, Math.min(BLOCK, total))))
        this.used = 0
      }
      const n = Math.min(chunk.length - at, this.block.length - this.used)
      this.block.set(chunk.subarray(at, at + n), this.used)
      this.used += n
      at += n
    }
    this.total += chunk.length
    if (this.total >= this.limit && this.truncate) {
      this.full = true
    }
  }

  /**
   * The bytes so far, in one buffer. A block's unused end was never written and costs no memory,
   * so one block is cut down (a copy) only when more than half of it is unused, after a hint
   * that was far too large: then the copy frees more than it costs.
   */
  result(): Uint8Array {
    if (!this.blocks.length) {
      if (this.used === this.block.length) return this.block
      if (this.block.length - this.used <= Math.max(MIN_BLOCK, this.used)) return this.block.subarray(0, this.used)
      this.block = this.block.slice(0, this.used)
      return this.block
    }
    const out = new Uint8Array(this.total)
    let at = 0
    for (const block of this.blocks) {
      out.set(block, at)
      at += block.length
    }
    out.set(this.block.subarray(0, this.used), at)
    this.blocks = []
    this.block = out
    this.used = out.length
    return out
  }
}

/**
 * A stream decoder's output. `damaged`: with `partial` set, damage came after some output, which
 * is what came before it; without `partial` damage throws `DamagedError`.
 */
export type StreamResult = { bytes: Uint8Array; truncated: boolean; damaged: boolean }

/** Feeds `data` to `push` in slices so a capped sink can stop a decoder early. */
export function feed(
  data: Uint8Array,
  push: (chunk: Uint8Array, final: boolean) => void,
  sink: Sink,
  slice = 1 << 16
): void {
  run(feedSteps(data, push, sink, slice))
}

/** feed in steps, one slice each (see steps.ts). */
export function* feedSteps(
  data: Uint8Array,
  push: (chunk: Uint8Array, final: boolean) => void,
  sink: Sink,
  slice = 1 << 16
): Steps<void> {
  if (data.length === 0) {
    push(data, true)
    return
  }
  for (let at = 0; at < data.length && !sink.full; at += slice) {
    if (at) yield
    const end = Math.min(at + slice, data.length)
    push(data.subarray(at, end), end === data.length)
  }
}

/** A decoder's own error, as a `DamagedError` unless it is already one of ours. */
export function asDecodeError(error: unknown, what: string): Error {
  if (error instanceof TooLargeError || error instanceof DamagedError || error instanceof UnsupportedDataError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new DamagedError(`${what}: ${message}`)
}
