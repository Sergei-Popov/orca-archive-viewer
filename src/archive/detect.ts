// Archive and compression formats by their first bytes; extensions are only a hint.

export type Magic =
  | 'zip'
  | 'gzip'
  | 'bzip2'
  | 'xz'
  | 'zstd'
  | 'tar'
  | '7z'
  | 'rar'
  | 'lzip'
  | 'compress'
  | 'cab'
  | 'unknown'

const starts = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

export function detect(bytes: Uint8Array): Magic {
  if (starts(bytes, [0x50, 0x4b]) && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) return 'zip'
  if (starts(bytes, [0x1f, 0x8b])) return 'gzip'
  if (starts(bytes, [0x42, 0x5a, 0x68]) && bytes[3] >= 0x31 && bytes[3] <= 0x39) return 'bzip2'
  if (starts(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz'
  if (starts(bytes, [0x28, 0xb5, 0x2f, 0xfd])) return 'zstd'
  if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z'
  if (starts(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar'
  if (isLzip(bytes)) return 'lzip'
  if (starts(bytes, [0x1f, 0x9d])) return 'compress'
  if (isCab(bytes)) return 'cab'
  if (isTar(bytes)) return 'tar'
  if (findEndOfCentralDirectory(bytes) >= 0) return 'zip' // self-extracting or prefixed ZIP
  return 'unknown'
}

/**
 * An lzip member header: "LZIP", version 1 and a valid coded dictionary size (4 KiB to 512 MiB:
 * a power of two from 2^12 to 2^29, less 0-7 sixteenths of it). Four letters alone would also
 * match a text file that starts with "LZIP".
 */
function isLzip(bytes: Uint8Array): boolean {
  if (!starts(bytes, [0x4c, 0x5a, 0x49, 0x50, 0x01]) || bytes.length < 6) return false
  const log = bytes[5] & 0x1f
  return log >= 12 && log <= 29 && (log > 12 || bytes[5] >> 5 === 0)
}

const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

/**
 * A Cabinet header (CFHEADER): "MSCF", its three reserved fields zero, format version 1.x and a
 * cabinet at least as long as the 36-byte header. "MSCF" alone would also match a text file.
 */
function isCab(bytes: Uint8Array): boolean {
  if (!starts(bytes, [0x4d, 0x53, 0x43, 0x46]) || bytes.length < 36) return false
  return le32(bytes, 4) === 0 && le32(bytes, 12) === 0 && le32(bytes, 20) === 0 && bytes[25] === 1 && le32(bytes, 8) >= 36
}

/**
 * A TAR header block: its checksum matches (ustar magic is optional for V7 archives). Zeros at
 * the start are an empty archive when nothing but zeros follows, or when the first block that is
 * not zeros is a TAR header (an empty archive joined with another one, which tar lists as empty):
 * a disk image (ext4, an ISO) starts with zeros too, and is a single file.
 */
export function isTar(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false
  if (isZeroBlock(bytes, 0)) {
    // An empty archive is at least two zero blocks.
    if (bytes.length < 1024) return false
    let at = 512
    while (at + 512 <= bytes.length && isZeroBlock(bytes, at)) at += 512
    if (at + 512 <= bytes.length) return tarChecksumOk(bytes, at)
    for (let i = at; i < bytes.length; i++) if (bytes[i] !== 0) return false
    return true
  }
  return tarChecksumOk(bytes, 0)
}

export function isZeroBlock(bytes: Uint8Array, at: number): boolean {
  for (let i = at; i < at + 512; i++) {
    if (bytes[i] !== 0) return false
  }
  return true
}

export function tarChecksumOk(bytes: Uint8Array, at: number): boolean {
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : bytes[at + i]
    unsigned += b
    signed += b > 127 ? b - 256 : b
  }
  let stored = 0
  let digits = 0
  for (let i = 148; i < 156; i++) {
    const c = bytes[at + i]
    if (c >= 0x30 && c <= 0x37) {
      stored = stored * 8 + (c - 0x30)
      digits++
    } else if (c !== 0x20 && c !== 0) {
      return false
    } else if (digits > 0) {
      break
    }
  }
  return digits > 0 && (stored === unsigned || stored === signed)
}

/** Offset of the ZIP end-of-central-directory record, or -1. Searches back over the comment. */
export function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const last = bytes.length - 22
  if (last < 0) return -1
  const stop = Math.max(0, last - 0xffff)
  let loose = -1
  for (let i = last; i >= stop; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) {
      const commentLength = bytes[i + 20] | (bytes[i + 21] << 8)
      if (i + 22 + commentLength === bytes.length) return i
      if (loose < 0 && i + 22 + commentLength <= bytes.length) loose = i
    }
  }
  return loose
}
