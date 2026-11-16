// An .xz encoder for tests only, written from the .xz file format specification and the LZMA2
// chunk format, so the tests build their .xz data in code instead of carrying it. One Stream per
// call (join calls for several); Blocks of the LZMA2 filter with no, CRC-32 or CRC-64 checks,
// optionally with their sizes in the Block Header as multi-threaded xz writes them. LZMA chunks
// come from a greedy match search over the Block with literals, matches, rep0 matches and short
// reps; a chunk that does not shrink is stored, so Blocks mix every LZMA2 chunk type. When the
// real `xz` is installed, src/codecs/cli.test.ts checks that it reads this output.

import { crc32 } from '../codecs/crc32'

export type XzOptions = {
  /** The Block check (default CRC-64, as xz writes). */
  check?: 'none' | 'crc32' | 'crc64'
  /** Most bytes per Block (default: one Block). */
  blockSize?: number
  /** Dictionary size in the Block Header: 2^n or 3 × 2^n, at least 4 KiB (default 1 MiB). */
  dictSize?: number
  /** Farthest match distance (default the dictionary size); more makes the data invalid. */
  window?: number
  /** Write Compressed and Uncompressed Size into each Block Header. */
  sizes?: boolean
  /** Most uncompressed bytes per LZMA2 chunk (default 32 KiB, at most 2 MiB). */
  chunkSize?: number
  /** Literal context and position bits and position bits (default 3, 0, 2). */
  lc?: number
  lp?: number
  pb?: number
}

const CHECK_IDS = { none: 0, crc32: 1, crc64: 4 }

// The probability model, laid out as XZ Embedded's struct lzma_dec.
const STATES = 12
const LIT_STATES = 7
const POS_STATES_MAX = 16
const IS_MATCH = 0
const IS_REP = IS_MATCH + STATES * POS_STATES_MAX
const IS_REP0 = IS_REP + STATES
const IS_REP1 = IS_REP0 + STATES
const IS_REP2 = IS_REP1 + STATES
const IS_REP0_LONG = IS_REP2 + STATES
const DIST_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX
const DIST_SPECIAL = DIST_SLOT + 4 * 64
const DIST_ALIGN = DIST_SPECIAL + 128 - 14
const LEN_CHOICE = 0
const LEN_CHOICE2 = 1
const LEN_LOW = 2
const LEN_MID = LEN_LOW + 16 * 8
const LEN_HIGH = LEN_MID + 16 * 8
const MATCH_LEN = DIST_ALIGN + 16
const REP_LEN = MATCH_LEN + LEN_HIGH + 256
const LITERAL = REP_LEN + LEN_HIGH + 256
const PROBS = LITERAL + 16 * 0x300
const MATCH_MIN = 2
const MATCH_MAX = 273

/** A range encoder (the LZMA SDK's), writing to `out`. */
class RangeEncoder {
  readonly out: number[] = []
  private low = 0 // up to 33 bits, kept exact as a double
  private range = 0xffffffff
  private cache = 0
  private cacheSize = 1

  constructor(private readonly probs: Uint16Array) {}

  bit(i: number, bit: number): void {
    const prob = this.probs[i]
    const bound = (this.range >>> 11) * prob
    if (bit === 0) {
      this.range = bound
      this.probs[i] = prob + ((2048 - prob) >>> 5)
    } else {
      this.low += bound
      this.range = (this.range - bound) >>> 0
      this.probs[i] = prob - (prob >>> 5)
    }
    this.normalize()
  }

  /** `count` bits of `value` from the most significant, each at even odds. */
  direct(value: number, count: number): void {
    for (let k = count - 1; k >= 0; k--) {
      this.range >>>= 1
      if ((value >>> k) & 1) this.low += this.range
      this.normalize()
    }
  }

  /** `count` bits of `value` from the most significant, through a bit tree at `probs`. */
  tree(probs: number, count: number, value: number): void {
    let m = 1
    for (let k = count - 1; k >= 0; k--) {
      const bit = (value >>> k) & 1
      this.bit(probs + m, bit)
      m = (m << 1) | bit
    }
  }

  /** `count` bits of `value` from the least significant, through a bit tree at `probs`. */
  reverse(probs: number, count: number, value: number): void {
    let m = 1
    for (let k = 0; k < count; k++) {
      const bit = (value >>> k) & 1
      this.bit(probs + m, bit)
      m = (m << 1) | bit
    }
  }

  flush(): number[] {
    for (let i = 0; i < 5; i++) this.shiftLow()
    return this.out
  }

  private normalize(): void {
    while (this.range < 1 << 24) {
      this.range = (this.range << 8) >>> 0
      this.shiftLow()
    }
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 2 ** 32) {
      const carry = this.low >= 2 ** 32 ? 1 : 0
      let byte = this.cache
      do {
        this.out.push((byte + carry) & 0xff)
        byte = 0xff
      } while (--this.cacheSize !== 0)
      this.cache = (this.low >>> 24) & 0xff
    }
    this.cacheSize++
    this.low = (this.low & 0x00ffffff) * 256
  }
}

/** LZMA over one Block, a chunk at a time, keeping its model between chunks as LZMA2 allows. */
class LzmaEncoder {
  private readonly probs = new Uint16Array(PROBS)
  private state = 0
  private rep0 = 0
  private readonly head = new Map<number, number>()
  private readonly prev: Int32Array

  constructor(
    private readonly data: Uint8Array,
    private readonly window: number,
    private readonly lc: number,
    private readonly lp: number,
    private readonly pb: number
  ) {
    this.prev = new Int32Array(data.length).fill(-1)
  }

  /** A state reset: the model starts over, the dictionary stays. */
  reset(): void {
    this.probs.fill(1024)
    this.state = 0
    this.rep0 = 0
  }

  /** The range-coded bytes of `data[from..to)`. */
  chunk(from: number, to: number): number[] {
    const rc = new RangeEncoder(this.probs)
    const data = this.data
    let i = from
    while (i < to) {
      const posState = i & ((1 << this.pb) - 1)
      const isMatch = IS_MATCH + this.state * POS_STATES_MAX + posState
      const max = Math.min(MATCH_MAX, to - i)
      const repLen = this.rep0 < i ? this.common(i, i - this.rep0 - 1, max) : 0
      const [bestLen, bestDist] = this.find(i, max)
      if (repLen >= MATCH_MIN && repLen + 1 >= bestLen) {
        rc.bit(isMatch, 1)
        rc.bit(IS_REP + this.state, 1)
        rc.bit(IS_REP0 + this.state, 0)
        rc.bit(IS_REP0_LONG + this.state * POS_STATES_MAX + posState, 1)
        this.encodeLength(rc, REP_LEN, repLen, posState)
        this.state = this.state < LIT_STATES ? 8 : 11
        this.advance(i, repLen)
        i += repLen
      } else if (bestLen >= 3) {
        rc.bit(isMatch, 1)
        rc.bit(IS_REP + this.state, 0)
        this.encodeLength(rc, MATCH_LEN, bestLen, posState)
        this.distance(rc, bestDist - 1, bestLen)
        this.rep0 = bestDist - 1
        this.state = this.state < LIT_STATES ? 7 : 10
        this.advance(i, bestLen)
        i += bestLen
      } else if (repLen === 1) {
        rc.bit(isMatch, 1)
        rc.bit(IS_REP + this.state, 1)
        rc.bit(IS_REP0 + this.state, 0)
        rc.bit(IS_REP0_LONG + this.state * POS_STATES_MAX + posState, 0)
        this.state = this.state < LIT_STATES ? 9 : 11
        this.advance(i, 1)
        i++
      } else {
        rc.bit(isMatch, 0)
        this.literal(rc, i)
        this.state = this.state <= 3 ? 0 : this.state <= 9 ? this.state - 3 : this.state - 6
        this.advance(i, 1)
        i++
      }
    }
    return rc.flush()
  }

  private literal(rc: RangeEncoder, i: number): void {
    const data = this.data
    const prevByte = i > 0 ? data[i - 1] : 0
    const probs = LITERAL + 0x300 * (((i & ((1 << this.lp) - 1)) << this.lc) + (prevByte >> (8 - this.lc)))
    const byte = data[i]
    if (this.state < LIT_STATES) {
      rc.tree(probs, 8, byte)
      return
    }
    // After a match: each bit is coded in the context of the byte at rep0 while they agree.
    let matchByte = data[i - this.rep0 - 1] << 1
    let symbol = 1
    let offset = 0x100
    for (let k = 7; k >= 0; k--) {
      const bit = (byte >> k) & 1
      const matchBit = matchByte & offset
      matchByte <<= 1
      rc.bit(probs + offset + matchBit + symbol, bit)
      symbol = (symbol << 1) | bit
      offset = bit ? matchBit : offset ^ matchBit
    }
  }

  private encodeLength(rc: RangeEncoder, coder: number, len: number, posState: number): void {
    const l = len - MATCH_MIN
    if (l < 8) {
      rc.bit(coder + LEN_CHOICE, 0)
      rc.tree(coder + LEN_LOW + posState * 8, 3, l)
    } else if (l < 16) {
      rc.bit(coder + LEN_CHOICE, 1)
      rc.bit(coder + LEN_CHOICE2, 0)
      rc.tree(coder + LEN_MID + posState * 8, 3, l - 8)
    } else {
      rc.bit(coder + LEN_CHOICE, 1)
      rc.bit(coder + LEN_CHOICE2, 1)
      rc.tree(coder + LEN_HIGH, 8, l - 16)
    }
  }

  /** A match distance minus one: its slot, then the bits below the slot's top two. */
  private distance(rc: RangeEncoder, dist: number, len: number): void {
    const n = 31 - Math.clz32(dist)
    const slot = dist < 4 ? dist : (n << 1) | ((dist >>> (n - 1)) & 1)
    rc.tree(DIST_SLOT + Math.min(len - MATCH_MIN, 3) * 64, 6, slot)
    if (slot < 4) return
    const bits = (slot >> 1) - 1
    const base = (2 | (slot & 1)) << bits
    const rest = dist - base
    if (slot < 14) {
      rc.reverse(DIST_SPECIAL + base - slot - 1, bits, rest)
    } else {
      rc.direct(rest >>> 4, bits - 4)
      rc.reverse(DIST_ALIGN, 4, rest & 15)
    }
  }

  /** How many bytes at `i` equal those at `from`, up to `max`. */
  private common(i: number, from: number, max: number): number {
    let n = 0
    while (n < max && this.data[from + n] === this.data[i + n]) n++
    return n
  }

  /** The longest earlier match at `i` through hash chains of three-byte prefixes. */
  private find(i: number, max: number): [number, number] {
    if (max < 3) return [0, 0]
    let best = 0
    let bestDist = 0
    let candidate = this.head.get(this.hash(i)) ?? -1
    for (let depth = 0; candidate >= 0 && i - candidate <= this.window && depth < 48; depth++) {
      const n = this.common(i, candidate, max)
      if (n > best) {
        best = n
        bestDist = i - candidate
      }
      candidate = this.prev[candidate]
    }
    return [best, bestDist]
  }

  private hash(i: number): number {
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2]
  }

  private advance(i: number, n: number): void {
    for (let k = i; k < i + n; k++) {
      if (k + 3 > this.data.length) return
      const h = this.hash(k)
      this.prev[k] = this.head.get(h) ?? -1
      this.head.set(h, k)
    }
  }
}

/** The LZMA2 data of one Block: LZMA chunks, or stored chunks where LZMA does not shrink. */
function lzma2(block: Uint8Array, o: Required<XzOptions>): number[] {
  const out: number[] = []
  const lzma = new LzmaEncoder(block, o.window, o.lc, o.lp, o.pb)
  let first = true
  let needProps = true
  let needReset = true
  for (let at = 0; at < block.length; ) {
    const end = Math.min(at + o.chunkSize, block.length)
    const u = end - at - 1
    if (needProps || needReset) lzma.reset()
    const packed = lzma.chunk(at, end)
    if (packed.length < end - at && packed.length <= 0x10000) {
      const control = first ? 0xe0 : needProps ? 0xc0 : needReset ? 0xa0 : 0x80
      const c = packed.length - 1
      out.push(control | (u >> 16), (u >> 8) & 0xff, u & 0xff, c >> 8, c & 0xff)
      if (control >= 0xc0) out.push((o.pb * 5 + o.lp) * 9 + o.lc)
      append(out, packed)
      needProps = false
      needReset = false
    } else {
      // Stored chunks hold at most 64 KiB, and the model is reset before the next LZMA chunk.
      for (let s = at; s < end; s += 0x10000) {
        const e = Math.min(s + 0x10000, end)
        out.push(first ? 0x01 : 0x02, (e - s - 1) >> 8, (e - s - 1) & 0xff)
        append(out, block.subarray(s, e))
        if (first) needProps = true
        first = false
      }
      needReset = true
    }
    first = false
    at = end
  }
  out.push(0x00)
  return out
}

function vli(value: number): number[] {
  const out: number[] = []
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
  return out
}

/** Appends without spreading, which overflows the stack for long arrays. */
function append(out: number[], items: ArrayLike<number>): void {
  for (let i = 0; i < items.length; i++) out.push(items[i])
}

const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]
const padTo4 = (out: number[], from: number) => {
  while ((out.length - from) % 4 !== 0) out.push(0)
}

let crc64Table: bigint[] | null = null

/** CRC-64/XZ, bit by bit, independent of the decoder's. */
export function xzCrc64(bytes: Uint8Array): number[] {
  if (!crc64Table) {
    crc64Table = []
    for (let i = 0; i < 256; i++) {
      let c = BigInt(i)
      for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ 0xc96c5795d7870f42n : c >> 1n
      crc64Table.push(c)
    }
  }
  let c = 0xffffffffffffffffn
  for (const b of bytes) c = crc64Table[Number((c ^ BigInt(b)) & 0xffn)] ^ (c >> 8n)
  c ^= 0xffffffffffffffffn
  return Array.from({ length: 8 }, (_, i) => Number((c >> BigInt(8 * i)) & 0xffn))
}

/** One .xz Stream of `data`. */
export function xz(data: Uint8Array, options: XzOptions = {}): Uint8Array {
  const dictSize = options.dictSize ?? 1 << 20
  const o: Required<XzOptions> = {
    check: options.check ?? 'crc64',
    blockSize: options.blockSize ?? Math.max(data.length, 1),
    dictSize,
    window: options.window ?? dictSize,
    sizes: options.sizes ?? false,
    chunkSize: options.chunkSize ?? 1 << 15,
    lc: options.lc ?? 3,
    lp: options.lp ?? 0,
    pb: options.pb ?? 2
  }
  let dictProps = 0
  while ((2 + (dictProps & 1)) * 2 ** ((dictProps >> 1) + 11) < dictSize) dictProps++
  const checkId = CHECK_IDS[o.check]
  const flags = [0x00, checkId]
  const out: number[] = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, ...flags, ...le32(crc32(Uint8Array.from(flags)))]

  const records: number[][] = []
  for (let at = 0; at < data.length; at += o.blockSize) {
    const block = data.subarray(at, Math.min(at + o.blockSize, data.length))
    const packed = lzma2(block, o)
    const fields = [o.sizes ? 0xc0 : 0x00, ...(o.sizes ? [...vli(packed.length), ...vli(block.length)] : [])]
    fields.push(0x21, 0x01, dictProps)
    const header = [0, ...fields]
    while ((header.length + 4) % 4 !== 0) header.push(0)
    header[0] = (header.length + 4) / 4 - 1
    header.push(...le32(crc32(Uint8Array.from(header))))
    out.push(...header)
    const start = out.length
    append(out, packed)
    padTo4(out, start)
    const check = o.check === 'none' ? [] : o.check === 'crc32' ? le32(crc32(block)) : xzCrc64(block)
    out.push(...check)
    records.push([header.length + packed.length + check.length, block.length])
  }

  const index = out.length
  out.push(0x00, ...vli(records.length))
  for (const [unpadded, size] of records) out.push(...vli(unpadded), ...vli(size))
  padTo4(out, index)
  out.push(...le32(crc32(Uint8Array.from(out.slice(index)))))
  const backward = [...le32((out.length - index) / 4 - 1), ...flags]
  out.push(...le32(crc32(Uint8Array.from(backward))), ...backward, 0x59, 0x5a)
  return Uint8Array.from(out)
}
