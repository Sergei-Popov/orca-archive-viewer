// Minimal ZIP and TAR writers for tests: they write exactly the fields a case needs, including
// the odd ones real archivers produce (legacy code page names, ZIP64 fields, prefixes, PAX).

import { deflateSync } from '../../vendor/fflate/fflate.mjs'
import { crc32 } from '../codecs/crc32'

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

class Writer {
  bytes: number[] = []
  u8(v: number) {
    this.bytes.push(v & 0xff)
  }
  u16(v: number) {
    this.u8(v)
    this.u8(v >>> 8)
  }
  u32(v: number) {
    this.u16(v & 0xffff)
    this.u16(v >>> 16)
  }
  u64(v: number) {
    this.u32(v % 0x100000000)
    this.u32(Math.floor(v / 0x100000000))
  }
  raw(b: Uint8Array) {
    for (const v of b) this.bytes.push(v)
  }
  get length() {
    return this.bytes.length
  }
  done() {
    return Uint8Array.from(this.bytes)
  }
}

export type ZipItem = {
  name: string | Uint8Array
  data?: Uint8Array
  method?: 0 | 8 | 12 | 14 | 93 | 99
  flags?: number
  /** High byte of "version made by": 0 DOS, 3 Unix. */
  host?: number
  external?: number
  extra?: Uint8Array
  /** Write sizes and offset as 0xFFFFFFFF with a ZIP64 extra field. */
  zip64?: boolean
  date?: number
  time?: number
  /** Store this CRC instead of the real one. */
  crc?: number
  /** Store this uncompressed size instead of the real one. */
  size?: number
}

export function zip(items: ZipItem[], options: { prefix?: Uint8Array; comment?: string; zip64End?: boolean } = {}): Uint8Array {
  const w = new Writer()
  if (options.prefix) w.raw(options.prefix)
  const base = options.prefix?.length ?? 0
  const central: Uint8Array[] = []
  for (const item of items) {
    const name = typeof item.name === 'string' ? utf8(item.name) : item.name
    const data = item.data ?? new Uint8Array(0)
    const method = item.method ?? 0
    // Only Deflate is compressed here; other methods store `data` as already packed bytes.
    const packed = method === 8 ? deflateSync(data) : data
    const crc = item.crc ?? crc32(data)
    const size = item.size ?? data.length
    const offset = w.length - base
    const extra = item.extra ?? new Uint8Array(0)
    w.u32(0x04034b50)
    w.u16(20)
    w.u16(item.flags ?? 0)
    w.u16(method)
    w.u16(item.time ?? 0)
    w.u16(item.date ?? 0x5b21)
    w.u32(crc)
    w.u32(packed.length)
    w.u32(size)
    w.u16(name.length)
    w.u16(0)
    w.raw(name)
    w.raw(packed)

    const c = new Writer()
    let zip64Extra = new Uint8Array(0)
    if (item.zip64) {
      const x = new Writer()
      x.u16(1)
      x.u16(24)
      x.u64(size)
      x.u64(packed.length)
      x.u64(offset)
      zip64Extra = x.done()
    }
    c.u32(0x02014b50)
    c.u16(((item.host ?? 3) << 8) | 20)
    c.u16(20)
    c.u16(item.flags ?? 0)
    c.u16(method)
    c.u16(item.time ?? 0)
    c.u16(item.date ?? 0x5b21)
    c.u32(crc)
    c.u32(item.zip64 ? 0xffffffff : packed.length)
    c.u32(item.zip64 ? 0xffffffff : size)
    c.u16(name.length)
    c.u16(zip64Extra.length + extra.length)
    c.u16(0)
    c.u16(0)
    c.u16(0)
    c.u32(item.external ?? (item.host === 0 ? 0 : 0o100644 << 16) >>> 0)
    c.u32(item.zip64 ? 0xffffffff : offset)
    c.raw(name)
    c.raw(zip64Extra)
    c.raw(extra)
    central.push(c.done())
  }
  const cdOffset = w.length - base
  for (const c of central) w.raw(c)
  const cdSize = w.length - base - cdOffset
  if (options.zip64End) {
    const end64 = w.length - base
    w.u32(0x06064b50)
    w.u64(44)
    w.u16(45)
    w.u16(45)
    w.u32(0)
    w.u32(0)
    w.u64(items.length)
    w.u64(items.length)
    w.u64(cdSize)
    w.u64(cdOffset)
    w.u32(0x07064b50)
    w.u32(0)
    w.u64(end64)
    w.u32(1)
  }
  const comment = utf8(options.comment ?? '')
  w.u32(0x06054b50)
  w.u16(0)
  w.u16(0)
  w.u16(options.zip64End ? 0xffff : items.length)
  w.u16(options.zip64End ? 0xffff : items.length)
  w.u32(options.zip64End ? 0xffffffff : cdSize)
  w.u32(options.zip64End ? 0xffffffff : cdOffset)
  w.u16(comment.length)
  w.raw(comment)
  return w.done()
}

export type TarItem = {
  name: string | Uint8Array
  data?: Uint8Array
  type?: string
  link?: string
  mode?: number
  /** Seconds; null leaves the field empty. Negative or over 11 octal digits: base-256. */
  mtime?: number | null
  prefix?: string
  /** Write the size in base-256. */
  base256?: boolean
  /** Old V7 header: no ustar magic. */
  v7?: boolean
  /** Corrupt the checksum. */
  badChecksum?: boolean
  /** Old GNU magic "ustar  \0", which has no prefix field. */
  gnu?: boolean
  /** Raw bytes to place in the header before the checksum: [offset, bytes]. */
  fields?: [number, Uint8Array][]
  /** Blocks between the header and the data (old GNU sparse extension blocks). */
  extension?: Uint8Array
}

function octal(value: number, length: number): Uint8Array {
  return utf8(value.toString(8).padStart(length - 1, '0') + '\0')
}

/** GNU base-256: 0x80 then the value, or two's complement with a 0xff lead when negative. */
export function base256(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let v = value < 0 ? -value - 1 : value
  for (let i = length - 1; i > 0; i--) {
    out[i] = v % 256
    v = Math.floor(v / 256)
  }
  if (value < 0) for (let i = 1; i < length; i++) out[i] = ~out[i] & 0xff
  out[0] = value < 0 ? 0xff : 0x80
  return out
}

export function tarHeader(item: TarItem, size: number): Uint8Array {
  const h = new Uint8Array(512)
  const name = typeof item.name === 'string' ? utf8(item.name) : item.name
  h.set(name.subarray(0, 100), 0)
  h.set(octal(item.mode ?? 0o644, 8), 100)
  h.set(octal(0, 8), 108)
  h.set(octal(0, 8), 116)
  h.set(item.base256 ? base256(size, 12) : octal(size, 12), 124)
  const mtime = item.mtime === undefined ? 1700000000 : item.mtime
  if (mtime !== null) h.set(mtime < 0 || mtime >= 8 ** 11 ? base256(mtime, 12) : octal(mtime, 12), 136)
  h.set(utf8('        '), 148)
  h[156] = (item.type ?? '0').charCodeAt(0)
  if (item.link) h.set(utf8(item.link), 157)
  if (item.gnu) {
    h.set(utf8('ustar  \0'), 257)
  } else if (!item.v7) {
    h.set(utf8('ustar\0'), 257)
    h.set(utf8('00'), 263)
    if (item.prefix) h.set(utf8(item.prefix), 345)
  }
  for (const [at, bytes] of item.fields ?? []) h.set(bytes, at)
  let sum = 0
  for (const b of h) sum += b
  if (item.badChecksum) sum += 1
  h.set(utf8(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return h
}

export function tar(items: TarItem[], options: { end?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = []
  for (const item of items) {
    const data = item.data ?? new Uint8Array(0)
    parts.push(tarHeader(item, data.length))
    if (item.extension) parts.push(item.extension)
    parts.push(data)
    parts.push(new Uint8Array((512 - (data.length % 512)) % 512))
  }
  if (options.end !== false) parts.push(new Uint8Array(1024))
  return concat(...parts)
}

/** A PAX extended header item carrying `records`; pairs keep their order and repeated keys. */
export function pax(records: Record<string, string> | [string, string][], type = 'x'): TarItem {
  let body = ''
  for (const [key, value] of Array.isArray(records) ? records : Object.entries(records)) {
    const text = ` ${key}=${value}\n`
    let length = text.length + 1
    while (String(length).length + utf8(text).length !== length) length = String(length).length + utf8(text).length
    body += `${length}${text}`
  }
  return { name: 'PaxHeader', type, data: utf8(body) }
}

/**
 * A sparse file as GNU tar's old `S` header: `runs` are [offset, data] in file order; the header
 * holds four, and each extension block 21 more.
 */
export function gnuSparse(name: string, runs: [number, Uint8Array][], realSize: number): TarItem {
  const slot = ([offset, data]: [number, Uint8Array]) => concat(octal(offset, 12), octal(data.length, 12))
  const fields: [number, Uint8Array][] = runs.slice(0, 4).map((run, i) => [386 + i * 24, slot(run)])
  fields.push([483, octal(realSize, 12)])
  const blocks: Uint8Array[] = []
  for (let i = 4; i < runs.length; i += 21) {
    const block = new Uint8Array(512)
    runs.slice(i, i + 21).forEach((run, j) => block.set(slot(run), j * 24))
    if (i + 21 < runs.length) block[504] = 1
    blocks.push(block)
  }
  if (blocks.length) fields.push([482, new Uint8Array([1])])
  return { name, type: 'S', gnu: true, fields, extension: concat(...blocks), data: concat(...runs.map(([, data]) => data)) }
}

/** The 1.0 sparse map GNU tar and bsdtar put before the data, padded to whole blocks. */
export function sparseMap(runs: [number, number][]): Uint8Array {
  const text = utf8(`${runs.length}\n` + runs.map(([offset, length]) => `${offset}\n${length}\n`).join(''))
  return concat(text, new Uint8Array((512 - (text.length % 512)) % 512))
}
