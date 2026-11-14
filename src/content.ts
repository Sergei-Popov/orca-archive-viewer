// What an entry's bytes are, for the preview: an image, text, a nested archive or other binary.

import { isArchive } from './archive/open'

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

export function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const starts = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

/** The image MIME type from the bytes, or from the name for SVG; null when not an image. */
export function imageType(name: string, bytes: Uint8Array): string | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  if (starts(bytes, [0x42, 0x4d]) && extension(name) === 'bmp') return 'image/bmp'
  if (starts(bytes, [0, 0, 1, 0]) && extension(name) === 'ico') return 'image/x-icon'
  if (starts(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  if (extension(name) === 'svg') {
    const head = new TextDecoder().decode(bytes.subarray(0, 2048)).trimStart()
    if (head.startsWith('<') && /<svg[\s>]/i.test(head + new TextDecoder().decode(bytes.subarray(2048, 65536)))) {
      return 'image/svg+xml'
    }
  }
  return null
}

export type Decoded = { text: string; encoding: string }

/**
 * Text when the bytes look like text: a Unicode BOM, or no NUL bytes and few control characters
 * in the first 8 KiB. UTF-8 when valid, else `fallback` (a single-byte code page).
 */
export function decodeText(bytes: Uint8Array, truncated: boolean, fallback: string): Decoded | null {
  if (starts(bytes, [0xef, 0xbb, 0xbf])) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 BOM' }
  }
  if (starts(bytes, [0xff, 0xfe])) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16 LE' }
  }
  if (starts(bytes, [0xfe, 0xff])) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16 BE' }
  }
  const sample = bytes.subarray(0, 8192)
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]
    if (b === 0) return null
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) control++
  }
  if (control > sample.length / 50) return null
  // A cut through a multi-byte character at the limit is not an encoding error.
  let end = bytes.length
  if (truncated) {
    let back = 0
    while (back < 3 && end - back > 0 && (bytes[end - back - 1] & 0xc0) === 0x80) back++
    if (end - back > 0 && bytes[end - back - 1] >= 0xc0) end -= back + 1
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder(fallback).decode(bytes), encoding: fallback.toUpperCase() }
  }
}

export type ContentKind =
  | { kind: 'image'; mime: string }
  | { kind: 'archive' }
  | { kind: 'text'; decoded: Decoded }
  | { kind: 'binary' }

export function classify(name: string, bytes: Uint8Array, truncated: boolean, fallback: string): ContentKind {
  const mime = imageType(name, bytes)
  if (mime && !truncated) return { kind: 'image', mime }
  if (isArchive(bytes)) return { kind: 'archive' }
  const decoded = decodeText(bytes, truncated, fallback)
  if (decoded) return { kind: 'text', decoded }
  return { kind: 'binary' }
}

/** `xxd`-style lines: offset, 16 hex bytes in two groups of 8, and the printable ASCII. */
export function hexDump(bytes: Uint8Array, max = 65536): string {
  const lines: string[] = []
  const end = Math.min(bytes.length, max)
  for (let at = 0; at < end; at += 16) {
    let hex = ''
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (at + i < end) {
        const b = bytes[at + i]
        hex += b.toString(16).padStart(2, '0') + ' '
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
      } else {
        hex += '   '
      }
      if (i === 7) hex += ' '
    }
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex} ${ascii}`)
  }
  return lines.join('\n')
}
