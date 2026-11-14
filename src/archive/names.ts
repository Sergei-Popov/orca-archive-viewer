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
 * A name: UTF-8 when `utf8Flag` is set or the bytes are valid UTF-8, otherwise `legacy`
 * (and marked so the toolbar offers the code page picker).
 */
export function decodeName(bytes: Uint8Array, utf8Flag: boolean, legacy: LegacyEncoding): DecodedName {
  if (isAscii(bytes)) {
    return { name: latin(bytes), legacy: false }
  }
  const text = tryUtf8(bytes)
  if (text !== null) {
    return { name: text, legacy: false }
  }
  if (utf8Flag) {
    return { name: decoder('utf-8').decode(bytes), legacy: false }
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

/**
 * A stored path as the tree shows it: `/` separators, no leading `/` or `./`, no empty
 * segments, no trailing slash.
 */
export function normalizePath(path: string, backslashes: boolean): string {
  let p = backslashes ? path.replace(/\\/g, '/') : path
  p = p.replace(/\/{2,}/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  p = p.replace(/^\/+/, '').replace(/\/+$/, '')
  return p
    .split('/')
    .filter((segment) => segment !== '.' && segment !== '')
    .join('/')
}

/** The last path segment. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}
