// Sizes, dates, ratios and Unix modes as the tree and preview show them.

export type Units = { b: string; kb: string; mb: string; gb: string }

export function formatSize(bytes: number, locale: string, units: Units): string {
  if (bytes < 1024) return `${bytes} ${units.b}`
  const steps: [number, string][] = [
    [1024 ** 3, units.gb],
    [1024 ** 2, units.mb],
    [1024, units.kb]
  ]
  for (const [size, unit] of steps) {
    if (bytes >= size) {
      const value = bytes / size
      const digits = value < 10 ? 1 : 0
      return `${value.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${unit}`
    }
  }
  return `${bytes} ${units.b}`
}

/** Exact byte count with grouping, for tooltips and the details grid. */
export function formatBytes(bytes: number, locale: string): string {
  return bytes.toLocaleString(locale)
}

export function formatDate(ms: number | undefined, locale: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Compact date and time for the tree's column: "11/14/26, 3:31 PM", "14.11.2026, 15:31". */
export function formatShortDate(ms: number | undefined, locale: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
}

/** Packed size as a share of the unpacked size: "35 %". */
export function formatRatio(packed: number, size: number, locale: string): string {
  if (size <= 0) return ''
  const share = packed / size
  return share.toLocaleString(locale, { style: 'percent', maximumFractionDigits: share < 0.1 ? 1 : 0 })
}

/** `ls -l` style: `-rw-r--r--`, `drwxr-xr-x`, `lrwxrwxrwx`. */
export function formatMode(mode: number): string {
  const type = mode & 0o170000
  const kind =
    type === 0o040000 ? 'd' : type === 0o120000 ? 'l' : type === 0o020000 ? 'c' : type === 0o060000 ? 'b' : type === 0o010000 ? 'p' : '-'
  const bit = (mask: number, char: string) => (mode & mask ? char : '-')
  let out = kind
  out += bit(0o400, 'r') + bit(0o200, 'w')
  out += mode & 0o4000 ? (mode & 0o100 ? 's' : 'S') : bit(0o100, 'x')
  out += bit(0o040, 'r') + bit(0o020, 'w')
  out += mode & 0o2000 ? (mode & 0o010 ? 's' : 'S') : bit(0o010, 'x')
  out += bit(0o004, 'r') + bit(0o002, 'w')
  out += mode & 0o1000 ? (mode & 0o001 ? 't' : 'T') : bit(0o001, 'x')
  return out
}

export function formatCrc(crc: number): string {
  return crc.toString(16).toUpperCase().padStart(8, '0')
}

/**
 * Characters that change how a name looks without being seen: format characters such as the
 * bidi controls (U+202E makes `photo` U+202E `gpj.exe` read "photoexe.jpg"), control characters, and
 * line and paragraph separators.
 */
const HIDDEN = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu

/** `text` with every hidden character written out as ⟨U+202E⟩, for names, titles and paths. */
export function visibleText(text: string): string {
  return text.replace(HIDDEN, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}

/** A file name to suggest when saving: the last segment, without hidden characters. */
export function saveName(name: string, fallback: string): string {
  return name.slice(name.lastIndexOf('/') + 1).replace(HIDDEN, '').trim() || fallback
}

/**
 * `text` cut into pieces, the ones that contain `needle` (ignoring case) marked. Each code point
 * is lowercased on its own and mapped back, so a match after a letter whose lowercase is longer
 * (Turkish İ becomes i and a combining dot) marks the right characters; a match that covers part
 * of such a letter marks all of it.
 */
export function highlightParts(text: string, needle: string): { text: string; mark: boolean }[] {
  const query = needle.trim().toLowerCase()
  if (!query) return [{ text, mark: false }]
  let lower = ''
  // from[k]: where in `text` the code point behind lower[k] starts; ends[k]: where it ends.
  const from: number[] = []
  const ends: number[] = []
  for (let i = 0; i < text.length; ) {
    const size = text.codePointAt(i)! > 0xffff ? 2 : 1
    const piece = text.slice(i, i + size).toLowerCase()
    for (let k = 0; k < piece.length; k++) from.push(i), ends.push(i + size)
    lower += piece
    i += size
  }
  const parts: { text: string; mark: boolean }[] = []
  let at = 0
  for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, i + query.length)) {
    const start = Math.max(from[i], at)
    const end = ends[i + query.length - 1]
    if (end <= start) continue
    if (start > at) parts.push({ text: text.slice(at, start), mark: false })
    parts.push({ text: text.slice(start, end), mark: true })
    at = end
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at), mark: false })
  return parts
}
