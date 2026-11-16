// File names inside archives. ZIP marks UTF-8 names with a flag; names without it (and TAR names)
// are raw bytes in whatever code page the archiver's system used: CP437 for old DOS and Windows
// tools in the West, CP866 for Russian ones, sometimes Windows-1251.

export type LegacyEncoding = 'cp437' | 'cp866' | 'windows-1251'

export const LEGACY_ENCODINGS: readonly LegacyEncoding[] = ['cp437', 'cp866', 'windows-1251']

/** CP437 0x80–0xFF; TextDecoder has no CP437. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

const utf8 = new TextDecoder('utf-8', { fatal: true })
const decoders = new Map<string, TextDecoder>()

function decoder(label: string): TextDecoder {
  let d = decoders.get(label)
  if (!d) {
    d = new TextDecoder(label)
    decoders.set(label, d)
  }
  return d
}

export function isAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7f) return false
  }
  return true
}

/** The bytes as UTF-8, or null when they are not valid UTF-8. */
export function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes)
  } catch {
    return null
  }
}

export function decodeLegacy(bytes: Uint8Array, encoding: LegacyEncoding): string {
  if (encoding === 'cp437') {
    let out = ''
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80]
    }
    return out
  }
  return decoder(encoding === 'cp866' ? 'ibm866' : 'windows-1251').decode(bytes)
}

export type DecodedName = { name: string; legacy: boolean }

/**
 * A name: UTF-8 when the bytes are valid UTF-8, otherwise `legacy` (and marked so the toolbar
 * offers the code page picker). Some tools set the UTF-8 flag on names in the system code page,
 * so the flag does not win over bytes that are not UTF-8.
 */
export function decodeName(bytes: Uint8Array, _utf8Flag: boolean, legacy: LegacyEncoding): DecodedName {
  if (isAscii(bytes)) {
    return { name: latin(bytes), legacy: false }
  }
  const text = tryUtf8(bytes)
  if (text !== null) {
    return { name: text, legacy: false }
  }
  return { name: decodeLegacy(bytes, legacy), legacy: true }
}

function latin(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096))
  }
  return out
}

/** The default code page for names without a UTF-8 flag: CP866 for a Russian UI, else CP437. */
export function defaultLegacyEncoding(locale: string | undefined): LegacyEncoding {
  return (locale ?? '').toLowerCase().startsWith('ru') ? 'cp866' : 'cp437'
}

/** Real file systems stop at 4 KiB paths (Linux PATH_MAX); longer or deeper names are cut. */
export const MAX_PATH_LENGTH = 4096
export const MAX_PATH_SEGMENTS = 1024

/**
 * A stored path as the tree shows it: `/` separators, no leading `/` or `./`, no empty
 * segments, no trailing slash. A path past MAX_PATH_SEGMENTS segments or MAX_PATH_LENGTH
 * characters is cut there and `cut` is set: every folder of a path costs the tree its whole
 * prefix, so a crafted name 70,000 folders deep would take gigabytes.
 */
export function normalizePath(path: string, backslashes: boolean): { path: string; cut: boolean } {
  const segments: string[] = []
  let length = -1
  for (const segment of (backslashes ? path.replace(/\\/g, '/') : path).split('/')) {
    if (segment === '' || segment === '.') continue
    const room = MAX_PATH_LENGTH - length - 1
    if (segments.length === MAX_PATH_SEGMENTS || segment.length > room) {
      if (segments.length < MAX_PATH_SEGMENTS && room > 0) {
        // Never cut a character in two: a lone surrogate would show as a replacement mark.
        const code = segment.charCodeAt(room - 1)
        const kept = segment.slice(0, code >= 0xd800 && code < 0xdc00 ? room - 1 : room)
        if (kept) segments.push(kept)
      }
      return { path: segments.join('/'), cut: true }
    }
    segments.push(segment)
    length += segment.length + 1
  }
  return { path: segments.join('/'), cut: false }
}

/** The last path segment. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}
