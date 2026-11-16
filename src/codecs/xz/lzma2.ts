// LZMA2 and LZMA decoding, ported to TypeScript from XZ Embedded's xz_dec_lzma2.c and
// xz_lzma2.h (version and changes in stream.ts). The range decoder, the probability model and
// the LZMA2 chunk layer follow the C code step by step, with its names. What differs:
// - The whole input is in memory, so there is no temporary input buffer between calls: a chunk
//   is decoded from the input directly, and a cut chunk stops where the C code would wait for
//   input that never comes (LZMA_IN_REQUIRED bytes before the end of the data).
// - The output doubles as the dictionary, as in XZ Embedded's single-call mode: a match copies
//   from bytes already written since the last dictionary reset, within the dictionary size the
//   Block Header gave. Memory is the output itself, which the limit caps.
// - A chunk's uncompressed size is checked against the limit before it is decoded.
// - The first byte of an LZMA chunk must be zero, as liblzma requires; XZ Embedded ignores it.

import { DamagedError, TooLargeError } from '../sink'

// Range decoder (xz_lzma2.h).
const RC_TOP_VALUE = 1 << 24
const RC_BIT_MODEL_TOTAL_BITS = 11
const RC_BIT_MODEL_TOTAL = 1 << RC_BIT_MODEL_TOTAL_BITS
const RC_MOVE_BITS = 5
/** Range decoder initialization eats the first five bytes of each LZMA chunk. */
const RC_INIT_BYTES = 5
/** One LZMA symbol reads at most 20 bytes, plus one for the normalization after the loop. */
const LZMA_IN_REQUIRED = 21

// enum lzma_state: the types of the latest symbols.
const STATE_LIT_LIT = 0
const STATE_SHORTREP_LIT_LIT = 3
const STATE_LIT_MATCH = 7
const STATE_LIT_LONGREP = 8
const STATE_LIT_SHORTREP = 9
const STATE_NONLIT_MATCH = 10
const STATE_NONLIT_REP = 11
const STATES = 12
const LIT_STATES = 7

const POS_STATES_MAX = 1 << 4
const LITERAL_CODER_SIZE = 0x300
const LITERAL_CODERS_MAX = 1 << 4
const MATCH_LEN_MIN = 2
const LEN_LOW_SYMBOLS = 1 << 3
const LEN_MID_SYMBOLS = 1 << 3
const LEN_HIGH_SYMBOLS = 1 << 8
const DIST_STATES = 4
const DIST_SLOTS = 1 << 6
const DIST_MODEL_START = 4
const DIST_MODEL_END = 14
const FULL_DISTANCES = 1 << (DIST_MODEL_END / 2)
const ALIGN_BITS = 4
const ALIGN_SIZE = 1 << ALIGN_BITS

// struct lzma_dec's probability arrays, laid out in one array in the same order.
const IS_MATCH = 0
const IS_REP = IS_MATCH + STATES * POS_STATES_MAX
const IS_REP0 = IS_REP + STATES
const IS_REP1 = IS_REP0 + STATES
const IS_REP2 = IS_REP1 + STATES
const IS_REP0_LONG = IS_REP2 + STATES
const DIST_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX
const DIST_SPECIAL = DIST_SLOT + DIST_STATES * DIST_SLOTS
const DIST_ALIGN = DIST_SPECIAL + FULL_DISTANCES - DIST_MODEL_END
// struct lzma_len_dec: choice, choice2, low[16][8], mid[16][8], high[256].
const LEN_CHOICE = 0
const LEN_CHOICE2 = 1
const LEN_LOW = 2
const LEN_MID = LEN_LOW + POS_STATES_MAX * LEN_LOW_SYMBOLS
const LEN_HIGH = LEN_MID + POS_STATES_MAX * LEN_MID_SYMBOLS
const LEN_SIZE = LEN_HIGH + LEN_HIGH_SYMBOLS
const MATCH_LEN_DEC = DIST_ALIGN + ALIGN_SIZE
const REP_LEN_DEC = MATCH_LEN_DEC + LEN_SIZE
const LITERAL = REP_LEN_DEC + LEN_SIZE
const PROBS_TOTAL = LITERAL + LITERAL_CODERS_MAX * LITERAL_CODER_SIZE // 1846 + 16 × 0x300, as in C

/** Decoded bytes, in one buffer that grows by doubling up to `limit`; also the dictionary. */
export class Output {
  buf = new Uint8Array(0)
  pos = 0
  /** True once the limit was reached in `truncate` mode. */
  full = false
  readonly limit: number
  readonly truncate: boolean

  /** `hint`: the expected size, so the buffer is allocated once. */
  constructor(limit: number, truncate: boolean, hint = 0) {
    this.limit = limit
    this.truncate = truncate
    this.buf = new Uint8Array(Math.max(0, Math.min(hint, limit)))
  }

  /** How many of `n` more bytes may be written: all, or what fits when truncating. */
  room(n: number): number {
    const left = this.limit - this.pos
    if (n <= left) return n
    if (!this.truncate) throw new TooLargeError(this.limit)
    return left
  }

  /** Makes the buffer hold `n` more bytes (within the limit). */
  reserve(n: number): void {
    const need = this.pos + n
    if (need <= this.buf.length) return
    const next = new Uint8Array(Math.min(this.limit, Math.max(need, this.buf.length * 2, 1 << 16)))
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  /** Marks the output full when truncating and the limit is reached; true if so. */
  reached(): boolean {
    if (this.truncate && this.pos >= this.limit) this.full = true
    return this.full
  }

  /**
   * The bytes so far. The buffer is also LZMA's dictionary, so it is one piece: sized from the
   * Index when the file has one, else grown by doubling. Its unused end was never written and
   * costs no memory, so it is cut off (a copy) only when more than half is unused, after a
   * hint that was far too large: then the copy frees more than it costs.
   */
  result(): Uint8Array {
    if (this.buf.length - this.pos > Math.max(1 << 16, this.pos)) this.buf = this.buf.slice(0, this.pos)
    return this.buf.subarray(0, this.pos)
  }
}

const endsEarly = () => new DamagedError('xz data ends early')

/** The LZMA2 decoder of one Block at a time (struct xz_dec_lzma2). */
export class Lzma2Decoder {
  private readonly out: Output

  // struct dictionary: the output since the last dictionary reset, within `dictSize`.
  private dictStart = 0
  private dictSize = 0

  // struct rc_dec
  private range = 0
  private code = 0
  private input: Uint8Array = new Uint8Array(0)
  private inPos = 0

  // struct lzma_dec
  private state = STATE_LIT_LIT
  private rep0 = 0
  private rep1 = 0
  private rep2 = 0
  private rep3 = 0
  private len = 0
  private lc = 0
  private literalPosMask = 0
  private posMask = 0
  private readonly probs = new Uint16Array(PROBS_TOTAL)

  // struct lzma2_dec
  private needDictReset = true
  private needProps = true

  constructor(out: Output) {
    this.out = out
  }

  /** xz_dec_lzma2_reset: a new Block whose LZMA2 data must start with a dictionary reset. */
  reset(dictSize: number): void {
    this.dictSize = dictSize
    this.needDictReset = true
  }

  /**
   * xz_dec_lzma2_run over the whole LZMA2 data at `data[at]`: returns the position after the
   * end marker, or -1 once the output is full in truncate mode.
   */
  run(data: Uint8Array, at: number): number {
    for (;;) {
      if (at >= data.length) throw endsEarly()
      // LZMA2 control byte
      //   0x00        end marker
      //   0x01        dictionary reset followed by an uncompressed chunk
      //   0x02        uncompressed chunk (no dictionary reset)
      //   0xE0-0xFF   dictionary reset, new properties and state reset, LZMA chunk
      //   0xC0-0xDF   new properties and state reset, LZMA chunk
      //   0xA0-0xBF   state reset using old properties, LZMA chunk
      //   0x80-0x9F   LZMA chunk (no dictionary or state reset)
      // The lowest five bits of an LZMA chunk's control byte are bits 16-20 of its uncompressed
      // size. The data must begin with a dictionary reset, and the first LZMA chunk must set
      // new properties.
      const control = data[at++]
      if (control === 0x00) return at
      if (control >= 0xe0 || control === 0x01) {
        this.needProps = true
        this.needDictReset = false
        this.dictStart = this.out.pos
      } else if (this.needDictReset) {
        throw new DamagedError('xz LZMA2 data does not start with a dictionary reset')
      }
      if (control >= 0x80) {
        if (at + 4 > data.length) throw endsEarly()
        const uncompressed = (control & 0x1f) * 65536 + data[at] * 256 + data[at + 1] + 1
        const compressed = data[at + 2] * 256 + data[at + 3] + 1
        at += 4
        if (control >= 0xc0) {
          // When there are new properties, the state is reset with them.
          this.needProps = false
          if (at >= data.length) throw endsEarly()
          if (!this.lzmaProps(data[at++])) throw new DamagedError('bad xz LZMA properties')
        } else if (this.needProps) {
          throw new DamagedError('xz LZMA chunk without properties')
        } else if (control >= 0xa0) {
          this.lzmaReset()
        }
        if (compressed < RC_INIT_BYTES) throw new DamagedError('xz LZMA chunk too short')
        at = this.lzmaChunk(data, at, compressed, uncompressed)
        if (at < 0) return -1
      } else {
        if (control > 0x02) throw new DamagedError('bad xz LZMA2 control byte')
        if (at + 2 > data.length) throw endsEarly()
        const size = data[at] * 256 + data[at + 1] + 1
        at += 2
        if (at + size > data.length) throw endsEarly()
        const n = this.out.room(size)
        this.out.reserve(n)
        this.out.buf.set(data.subarray(at, at + n), this.out.pos)
        this.out.pos += n
        at += size
        if (this.out.reached()) return -1
      }
    }
  }

  /** SEQ_LZMA_PREPARE and SEQ_LZMA_RUN of one chunk; returns the position after it, or -1. */
  private lzmaChunk(data: Uint8Array, at: number, compressed: number, uncompressed: number): number {
    const end = at + compressed
    if (at + RC_INIT_BYTES > data.length) throw endsEarly()
    // rc_read_init: the first five bytes. The first is always zero: XZ Embedded ignores it, and
    // here it is checked as liblzma (xz -d) does.
    if (data[at] !== 0) throw new DamagedError('xz LZMA chunk does not start with a zero byte')
    this.range = 0xffffffff
    this.code = 0
    for (let i = 0; i < RC_INIT_BYTES; i++) this.code = ((this.code << 8) | data[at + i]) >>> 0
    this.input = data
    this.inPos = at + RC_INIT_BYTES
    const want = this.out.room(uncompressed)
    this.out.reserve(want)
    const target = this.out.pos + want
    // A chunk cut off by the end of the data is decoded as far as the C code would decode it
    // before waiting for more input.
    const cut = end > data.length
    this.lzmaMain(target, cut ? data.length - LZMA_IN_REQUIRED : end)
    // In truncate mode the output can fill up within a chunk: what was decoded is kept.
    if (this.out.pos === target && this.out.reached()) return -1
    if (cut) throw endsEarly()
    if (this.out.pos < target) throw new DamagedError('xz LZMA chunk ends before its size')
    if (this.inPos !== end || this.len > 0 || this.code !== 0) {
      throw new DamagedError('xz LZMA chunk does not end where its header says')
    }
    return end
  }

  // Range decoder

  /** rc_normalize: reads the next input byte if needed. Past the end of the data it reads 0. */
  private normalize(): void {
    if (this.range < RC_TOP_VALUE) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this.input[this.inPos++]) >>> 0
    }
  }

  /** rc_bit: decodes one bit with the probability at `i` and adapts it. */
  private bit(i: number): number {
    this.normalize()
    const prob = this.probs[i]
    const bound = (this.range >>> RC_BIT_MODEL_TOTAL_BITS) * prob
    if (this.code < bound) {
      this.range = bound
      this.probs[i] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
      return 0
    }
    this.range = (this.range - bound) >>> 0
    this.code = (this.code - bound) >>> 0
    this.probs[i] = prob - (prob >>> RC_MOVE_BITS)
    return 1
  }

  /** rc_bittree: a bittree from the most significant bit; returns symbol + limit. */
  private bittree(probs: number, limit: number): number {
    let symbol = 1
    do {
      symbol = (symbol << 1) | this.bit(probs + symbol)
    } while (symbol < limit)
    return symbol
  }

  /** rc_bittree_reverse: `limit` bits from the least significant one. */
  private bittreeReverse(probs: number, limit: number): number {
    let symbol = 1
    let value = 0
    for (let i = 0; i < limit; i++) {
      const bit = this.bit(probs + symbol)
      symbol = (symbol << 1) | bit
      value |= bit << i
    }
    return value
  }

  /** rc_direct: `limit` bits of fixed fifty-fifty probability, appended to `dest`. */
  private direct(dest: number, limit: number): number {
    do {
      this.normalize()
      this.range >>>= 1
      this.code = (this.code - this.range) >>> 0
      const mask = this.code >>> 31 ? 0xffffffff : 0
      this.code = (this.code + (this.range & mask)) >>> 0
      dest = ((dest << 1) + (mask ? 0 : 1)) >>> 0
    } while (--limit > 0)
    return dest
  }

  // LZMA

  /** lzma_main: decodes symbols until the output reaches `target` or the input passes `limit`. */
  private lzmaMain(target: number, limit: number): void {
    const out = this.out
    while (out.pos < target && this.inPos <= limit) {
      const posState = (out.pos - this.dictStart) & this.posMask
      if (!this.bit(IS_MATCH + this.state * POS_STATES_MAX + posState)) {
        this.literal()
      } else {
        if (this.bit(IS_REP + this.state)) this.repMatch(posState)
        else this.match(posState)
        if (!this.repeat(target)) throw new DamagedError('xz match reaches before the start of the dictionary')
      }
    }
    // Always leave the range decoder normalized, so the end of the chunk is easy to check.
    this.normalize()
  }

  /** dict_get(dist): the byte `dist + 1` back, or 0 while the dictionary is empty. */
  private dictGet(dist: number): number {
    const out = this.out
    return out.pos > this.dictStart ? out.buf[out.pos - dist - 1] : 0
  }

  /** dict_repeat: copies `len` bytes from `rep0 + 1` back, up to `target`; false if invalid. */
  private repeat(target: number): boolean {
    const out = this.out
    const dist = this.rep0
    if (dist >= out.pos - this.dictStart || dist >= this.dictSize) return false
    const left = Math.min(target - out.pos, this.len)
    this.len -= left
    const buf = out.buf
    let back = out.pos - dist - 1
    if (dist + 1 >= left) {
      buf.copyWithin(out.pos, back, back + left)
      out.pos += left
    } else {
      // Overlapping: each byte may be one this copy just wrote.
      for (let k = 0; k < left; k++) buf[out.pos++] = buf[back++]
    }
    return true
  }

  /** lzma_literal: one 8-bit byte, matched against the byte at rep0 after a match. */
  private literal(): void {
    const out = this.out
    const prevByte = this.dictGet(0)
    const low = prevByte >> (8 - this.lc)
    const high = ((out.pos - this.dictStart) & this.literalPosMask) << this.lc
    const probs = LITERAL + LITERAL_CODER_SIZE * (low + high)
    let symbol: number
    if (this.state < LIT_STATES) {
      symbol = this.bittree(probs, 0x100)
    } else {
      symbol = 1
      let matchByte = this.dictGet(this.rep0) << 1
      let offset = 0x100
      do {
        const matchBit = matchByte & offset
        matchByte <<= 1
        const i = offset + matchBit + symbol
        if (this.bit(probs + i)) {
          symbol = (symbol << 1) + 1
          offset &= matchBit
        } else {
          symbol <<= 1
          offset &= ~matchBit
        }
      } while (symbol < 0x100)
    }
    out.buf[out.pos++] = symbol & 0xff
    // lzma_state_literal
    if (this.state <= STATE_SHORTREP_LIT_LIT) this.state = STATE_LIT_LIT
    else if (this.state <= STATE_LIT_SHORTREP) this.state -= 3
    else this.state -= 6
  }

  /** lzma_len: a match length into `len`. */
  private matchLength(dec: number, posState: number): void {
    let probs: number
    let limit: number
    if (!this.bit(dec + LEN_CHOICE)) {
      probs = dec + LEN_LOW + posState * LEN_LOW_SYMBOLS
      limit = LEN_LOW_SYMBOLS
      this.len = MATCH_LEN_MIN
    } else if (!this.bit(dec + LEN_CHOICE2)) {
      probs = dec + LEN_MID + posState * LEN_MID_SYMBOLS
      limit = LEN_MID_SYMBOLS
      this.len = MATCH_LEN_MIN + LEN_LOW_SYMBOLS
    } else {
      probs = dec + LEN_HIGH
      limit = LEN_HIGH_SYMBOLS
      this.len = MATCH_LEN_MIN + LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS
    }
    this.len += this.bittree(probs, limit) - limit
  }

  /** lzma_match: a match with a new distance, into rep0. */
  private match(posState: number): void {
    this.state = this.state < LIT_STATES ? STATE_LIT_MATCH : STATE_NONLIT_MATCH
    this.rep3 = this.rep2
    this.rep2 = this.rep1
    this.rep1 = this.rep0
    this.matchLength(MATCH_LEN_DEC, posState)
    const distState = this.len < DIST_STATES + MATCH_LEN_MIN ? this.len - MATCH_LEN_MIN : DIST_STATES - 1
    const distSlot = this.bittree(DIST_SLOT + distState * DIST_SLOTS, DIST_SLOTS) - DIST_SLOTS
    if (distSlot < DIST_MODEL_START) {
      this.rep0 = distSlot
      return
    }
    const limit = (distSlot >> 1) - 1
    let rep0 = 2 + (distSlot & 1)
    if (distSlot < DIST_MODEL_END) {
      rep0 = (rep0 << limit) >>> 0
      rep0 = (rep0 + this.bittreeReverse(DIST_SPECIAL + rep0 - distSlot - 1, limit)) >>> 0
    } else {
      rep0 = this.direct(rep0, limit - ALIGN_BITS)
      rep0 = (rep0 * ALIGN_SIZE + this.bittreeReverse(DIST_ALIGN, ALIGN_BITS)) % 2 ** 32
    }
    this.rep0 = rep0
  }

  /** lzma_rep_match: a match at one of the four latest distances, moved to rep0. */
  private repMatch(posState: number): void {
    if (!this.bit(IS_REP0 + this.state)) {
      if (!this.bit(IS_REP0_LONG + this.state * POS_STATES_MAX + posState)) {
        this.state = this.state < LIT_STATES ? STATE_LIT_SHORTREP : STATE_NONLIT_REP
        this.len = 1
        return
      }
    } else {
      let tmp: number
      if (!this.bit(IS_REP1 + this.state)) {
        tmp = this.rep1
      } else {
        if (!this.bit(IS_REP2 + this.state)) {
          tmp = this.rep2
        } else {
          tmp = this.rep3
          this.rep3 = this.rep2
        }
        this.rep2 = this.rep1
      }
      this.rep1 = this.rep0
      this.rep0 = tmp
    }
    this.state = this.state < LIT_STATES ? STATE_LIT_LONGREP : STATE_NONLIT_REP
    this.matchLength(REP_LEN_DEC, posState)
  }

  /** lzma_reset: the LZMA state and range decoder; the dictionary stays. */
  private lzmaReset(): void {
    this.state = STATE_LIT_LIT
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
    this.len = 0
    this.probs.fill(RC_BIT_MODEL_TOTAL / 2)
  }

  /** lzma_props: lc/lp/pb from one byte, then a state reset; false if invalid. */
  private lzmaProps(props: number): boolean {
    if (props > (4 * 5 + 4) * 9 + 8) return false
    const pb = Math.floor(props / (9 * 5))
    props -= pb * 9 * 5
    const lp = Math.floor(props / 9)
    const lc = props - lp * 9
    if (lc + lp > 4) return false
    this.posMask = (1 << pb) - 1
    this.literalPosMask = (1 << lp) - 1
    this.lc = lc
    this.lzmaReset()
    return true
  }
}
