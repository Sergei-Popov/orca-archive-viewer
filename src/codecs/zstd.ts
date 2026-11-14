// Zstandard through fzstd, stopping at a size limit.

import { Decompress } from '../../vendor/fzstd/fzstd.mjs'
import { Sink, asDecodeError, feed } from './sink'

/** Every frame of Zstandard data, joined; `truncate` keeps the first `limit` bytes instead of throwing. */
export function unzstd(
  data: Uint8Array,
  limit: number,
  truncate = false
): { bytes: Uint8Array; truncated: boolean } {
  const sink = new Sink(limit, truncate)
  try {
    const stream = new Decompress((chunk) => sink.push(chunk))
    feed(data, (chunk, final) => stream.push(chunk, final), sink)
  } catch (error) {
    throw asDecodeError(error, 'zstd')
  }
  return { bytes: sink.result(), truncated: sink.full }
}
