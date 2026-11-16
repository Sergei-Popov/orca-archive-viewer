// XZ through the TypeScript port of XZ Embedded in ./xz/ (see ./xz/stream.ts for the upstream
// version and what changed).

import { asDecodeError } from './sink'
import { Output } from './xz/lzma2'
import { decodeXz } from './xz/stream'

/**
 * The XZ data unpacked: every Stream, joined, as `xz -d` does. `truncate` keeps the first `limit`
 * bytes instead of throwing `TooLargeError`.
 */
export function unxz(data: Uint8Array, limit: number, truncate = false): { bytes: Uint8Array; truncated: boolean } {
  const out = new Output(limit, truncate)
  try {
    decodeXz(data, out)
  } catch (error) {
    throw asDecodeError(error, 'xz')
  }
  return { bytes: out.result(), truncated: out.full }
}
