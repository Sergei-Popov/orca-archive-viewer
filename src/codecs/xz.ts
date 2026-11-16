// XZ through the TypeScript port of XZ Embedded in ./xz/ (see ./xz/stream.ts for the upstream
// version and what changed).

import { DamagedError, type StreamResult, asDecodeError } from './sink'
import { Output } from './xz/lzma2'
import { decodeXz, indexedSize } from './xz/stream'

/**
 * The XZ data unpacked: every Stream, joined, as `xz -d` does. `truncate` keeps the first `limit`
 * bytes instead of throwing `TooLargeError`. `partial`: damaged or cut-off data returns what was
 * decoded before the damage, as `xz -d` writes it before it stops.
 */
export function unxz(data: Uint8Array, limit: number, truncate = false, partial = false): StreamResult {
  const out = new Output(limit, truncate, indexedSize(data))
  try {
    decodeXz(data, out)
  } catch (error) {
    const failure = asDecodeError(error, 'xz')
    if (partial && failure instanceof DamagedError && out.pos > 0) {
      return { bytes: out.result(), truncated: false, damaged: true }
    }
    throw failure
  }
  return { bytes: out.result(), truncated: out.full, damaged: false }
}
