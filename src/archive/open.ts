// Turns bytes into an Archive: ZIP and TAR directly; GZIP, bzip2, XZ and Zstandard are unpacked
// first and show the TAR inside, or a single file when there is none.

import { bunzip2Steps } from '../codecs/bzip2'
import { gunzipSteps, gzipHeader } from '../codecs/deflate'
import { DamagedError } from '../codecs/sink'
import { type Pacing, type Steps, run, runAsync } from '../codecs/steps'
import { unxzSteps } from '../codecs/xz'
import { MAX_ZSTD_WINDOW, unzstdSteps } from '../codecs/zstd'
import { type Magic, detect, isTar } from './detect'
import { type Archive, EntryError } from './model'
import { type LegacyEncoding, baseName, decodeName } from './names'
import { parseTar } from './tar'
import { parseZip } from './zip'

/** Most bytes a compressed stream may unpack to before the viewer refuses it. */
export const MAX_UNPACKED = 512 * 1024 * 1024

/** Formats the viewer recognises but cannot open. */
export class UnsupportedFormatError extends Error {
  readonly format: string

  constructor(format: string) {
    super(`${format} is not supported`)
    this.name = 'UnsupportedFormatError'
    this.format = format
  }
}

/** Not an archive at all. */
export class NotArchiveError extends Error {
  constructor() {
    super('not an archive')
    this.name = 'NotArchiveError'
  }
}

const UNSUPPORTED: Partial<Record<Magic, string>> = {
  '7z': '7-Zip',
  rar: 'RAR',
  lzip: 'lzip',
  compress: 'compress (.Z)',
  cab: 'Cabinet (.cab)'
}

const STREAM_LABEL: Partial<Record<Magic, string>> = {
  gzip: 'GZIP',
  bzip2: 'BZIP2',
  xz: 'XZ',
  zstd: 'ZSTD'
}

export type OpenOptions = {
  encoding: LegacyEncoding
  /** The archive's own name, when known (nested archives); names the single file of a `.gz`. */
  name?: string
  /** Unpacked size limit for compressed streams. */
  limit?: number
  /** Unpack a compressed stream in steps that give the thread back, and stop (throwing
   *  `CancelledError`) once `pacing.cancelled()` is true. Without it the stream unpacks in one go. */
  pacing?: Pacing
}

/** The name of an archive format the viewer knows but does not open (7-Zip, RAR…), or null. */
export function unsupportedFormat(bytes: Uint8Array): string | null {
  return UNSUPPORTED[detect(bytes)] ?? null
}

/** True for bytes the viewer can open as an archive (used for nested archives). */
export function isArchive(bytes: Uint8Array): boolean {
  const magic = detect(bytes)
  return magic === 'zip' || magic === 'tar' || magic in STREAM_LABEL
}

export async function openArchive(bytes: Uint8Array, options: OpenOptions): Promise<Archive> {
  const magic = detect(bytes)
  const limit = options.limit ?? MAX_UNPACKED
  if (magic === 'zip') return parseZip(bytes, options.encoding)
  if (magic === 'tar') return parseTar(bytes, options.encoding)
  const unsupported = UNSUPPORTED[magic]
  if (unsupported) throw new UnsupportedFormatError(unsupported)
  const label = STREAM_LABEL[magic]
  if (!label) {
    if (bytes.length === 0) throw new DamagedError('empty file')
    throw new NotArchiveError()
  }

  // Every decoder keeps what it unpacked before damage (a cut download) and says so.
  const steps: Steps<{ bytes: Uint8Array; damaged: boolean }> =
    magic === 'gzip'
      ? gunzipSteps(bytes, limit)
      : magic === 'bzip2'
        ? bunzip2Steps(bytes, limit, false, true)
        : magic === 'xz'
          ? unxzSteps(bytes, limit, false, true)
          : unzstdSteps(bytes, limit, false, MAX_ZSTD_WINDOW, true)
  const { bytes: inner, damaged } = options.pacing ? await runAsync(steps, options.pacing) : run(steps)

  if (isTar(inner)) {
    return parseTar(inner, options.encoding, `TAR + ${label}`, bytes.length, damaged)
  }
  return single(bytes, inner, magic, label, options, damaged)
}

const SUFFIXES: Record<string, string[]> = {
  gzip: ['.gz', '.tgz', '.gzip'],
  bzip2: ['.bz2', '.tbz2', '.tbz', '.bzip2'],
  xz: ['.xz', '.txz'],
  zstd: ['.zst', '.tzst', '.zstd']
}

/** The name of the file inside a compressed stream: `notes.txt.gz` → `notes.txt`. */
export function innerName(name: string | undefined, magic: Magic): string | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  for (const suffix of SUFFIXES[magic] ?? []) {
    if (lower.endsWith(suffix) && name.length > suffix.length) {
      const stem = name.slice(0, -suffix.length)
      return suffix.startsWith('.t') && suffix !== '.tar' ? `${stem}.tar` : stem
    }
  }
  return undefined
}

function single(
  bytes: Uint8Array,
  inner: Uint8Array,
  magic: Magic,
  label: string,
  options: OpenOptions,
  damaged: boolean
): Archive {
  let name: string | undefined
  let mtime: number | undefined
  if (magic === 'gzip') {
    const header = gzipHeader(bytes)
    if (header.name?.length) name = baseName(decodeName(header.name, false, options.encoding).name)
    mtime = header.mtime ?? undefined
  }
  name ||= innerName(options.name, magic) ?? 'file'
  const entry = { index: 0, path: name, dir: false, size: inner.length, packed: bytes.length, mtime }
  const archive: Archive = {
    kind: 'single',
    format: label,
    entries: [entry],
    archiveSize: bytes.length,
    unpacked: inner.buffer.byteLength,
    legacyNames: false,
    encoding: options.encoding,
    damaged,
    read(target, limit) {
      if (target.index !== 0) throw new EntryError('missing')
      return { bytes: inner.subarray(0, Math.min(limit, inner.length)), truncated: inner.length > limit }
    },
    withEncoding() {
      return archive
    }
  }
  return archive
}
