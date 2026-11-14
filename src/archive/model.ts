// What every archive format turns into: a flat list of entries the tree is built from, and a
// reader for one entry's bytes.

import type { LegacyEncoding } from './names'

export type Entry = {
  /** Position in the archive; stable across re-decoding names. */
  index: number
  /** Normalized path (`a/b/c.txt`). */
  path: string
  dir: boolean
  /** Unpacked size in bytes. */
  size: number
  /** Packed size in bytes, when the format stores each entry compressed (ZIP). */
  packed?: number
  /** Modification time in milliseconds. */
  mtime?: number
  /** Unix mode bits, file type included. */
  mode?: number
  /** Symbolic link or hard link target. */
  link?: { target: string; hard: boolean }
  /** Compression method name (ZIP), such as "Deflate". */
  method?: string
  crc?: number
  encrypted?: boolean
  /** Name bytes were decoded with a legacy code page. */
  legacy?: boolean
}

export type ReadResult = {
  bytes: Uint8Array
  /** The entry is longer than the limit; `bytes` holds its start. */
  truncated: boolean
  /** False when the unpacked bytes fail the stored CRC. */
  crcOk?: boolean
}

export type EntryErrorCode = 'encrypted' | 'method' | 'damaged' | 'directory' | 'missing'

export class EntryError extends Error {
  readonly code: EntryErrorCode
  readonly detail: string

  constructor(code: EntryErrorCode, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'EntryError'
    this.code = code
    this.detail = detail
  }
}

export type ArchiveKind = 'zip' | 'tar' | 'single'

export type Archive = {
  kind: ArchiveKind
  /** Short label for the toolbar: "ZIP", "TAR", "TAR + GZIP", "GZIP"… */
  format: string
  entries: Entry[]
  /** Size of the archive file itself. */
  archiveSize: number
  /** Some names have no UTF-8 marking and were decoded with `encoding`. */
  legacyNames: boolean
  encoding: LegacyEncoding
  /** ZIP archive comment. */
  comment?: string
  /** The archive ends early or has damaged records; `entries` holds what could be read. */
  damaged?: boolean
  /** Unpacks an entry, at most `limit` bytes. Throws `EntryError`. */
  read(entry: Entry, limit: number): ReadResult
  /** The same archive with names decoded in another code page. */
  withEncoding(encoding: LegacyEncoding): Archive
}
