// Collects decompressed chunks up to a limit, so a small archive that unpacks to gigabytes (a
// "zip bomb") stops at the limit instead of exhausting the tab's memory.

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

export class Sink {
  private chunks: Uint8Array[] = []
  total = 0
  /** True once the limit was reached in `truncate` mode. */
  full = false

  readonly limit: number
  private readonly truncate: boolean

  /** `truncate`: keep the first `limit` bytes and set `full`; otherwise throw `TooLargeError`. */
  constructor(limit: number, truncate = false) {
    this.limit = limit
    this.truncate = truncate
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
    // Decoders may reuse their output buffers, so keep a copy.
    this.chunks.push(chunk.slice())
    this.total += chunk.length
    if (this.total >= this.limit && this.truncate) {
      this.full = true
    }
  }

  result(): Uint8Array {
    if (this.chunks.length === 1) {
      return this.chunks[0]
    }
    const out = new Uint8Array(this.total)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    this.chunks = [out]
    return out
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
  if (error instanceof TooLargeError || error instanceof DamagedError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new DamagedError(`${what}: ${message}`)
}
