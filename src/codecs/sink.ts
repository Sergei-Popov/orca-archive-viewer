// Collects decompressed output up to a limit, so a small archive that unpacks to gigabytes (a
// "zip bomb") is refused or cut at the limit instead of exhausting the tab's memory.

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

export type UnsupportedFeature = 'zstd-window' | 'xz-dictionary' | 'xz-options'

/**
 * Output of a decoder, in one buffer that grows by doubling up to `limit`. Decoders still decode
 * whatever input they were given in one push, so callers feed input in small slices and stop
 * once the sink is full; output past the limit is never kept.
 */
export class Sink {
  private buf: Uint8Array
  total = 0
  /** True once the limit was reached in `truncate` mode. */
  full = false

  readonly limit: number
  private readonly truncate: boolean

  /**
   * `truncate`: keep the first `limit` bytes and set `full`; otherwise throw `TooLargeError`.
   * `hint`: the expected size, so the buffer is allocated once.
   */
  constructor(limit: number, truncate = false, hint = 0) {
    this.limit = limit
    this.truncate = truncate
    this.buf = new Uint8Array(Math.max(0, Math.min(hint, limit)))
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
    const need = this.total + chunk.length
    if (need > this.buf.length) {
      const next = new Uint8Array(Math.min(this.limit, Math.max(need, this.buf.length * 2, 1 << 16)))
      next.set(this.buf.subarray(0, this.total))
      this.buf = next
    }
    // Decoders may reuse their output buffers, so this is a copy.
    this.buf.set(chunk, this.total)
    this.total = need
    if (this.total >= this.limit && this.truncate) {
      this.full = true
    }
  }

  /** The bytes so far: a view, not a copy. */
  result(): Uint8Array {
    return this.total === this.buf.length ? this.buf : this.buf.subarray(0, this.total)
  }
}

/** Feeds `data` to `push` in slices so a capped sink can stop a decoder early. */
export function feed(
  data: Uint8Array,
  push: (chunk: Uint8Array, final: boolean) => void,
  sink: Sink,
  slice = 1 << 16
): void {
  if (data.length === 0) {
    push(data, true)
    return
  }
  for (let at = 0; at < data.length && !sink.full; at += slice) {
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
