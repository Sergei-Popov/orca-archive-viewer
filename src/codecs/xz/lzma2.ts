// LZMA2 and LZMA decoding, ported to TypeScript from XZ Embedded's xz_dec_lzma2.c and
// xz_lzma2.h (version and changes in stream.ts). The range decoder, the probability model and
// the LZMA2 chunk layer follow the C code step by step, with its names. What differs:
// - The range decoder's functions and the LZMA symbol decoders are written out inside lzmaMain,
//   with their state in locals, each part named after its C function (see there).
// - The whole input is in memory, so there is no temporary input buffer between calls: a chunk
//   is decoded from the input directly, and a cut chunk stops where the C code would wait for
//   input that never comes (LZMA_IN_REQUIRED bytes before the end of the data).
// - The output doubles as the dictionary, as in XZ Embedded's single-call mode: a match copies
//   from bytes already written since the last dictionary reset, within the dictionary size the
//   Block Header gave. Memory is the output itself, which the limit caps.
// - A chunk's uncompressed size is checked against the limit before it is decoded.
// - The first byte of an LZMA chunk must be zero, as liblzma requires; XZ Embedded ignores it.

import { DamagedError, TooLargeError } from '../sink'
import type { Steps } from '../steps'

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

  // struct rc_dec; range and code as int32 bit patterns (see lzmaMain)
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
   * end marker, or -1 once the output is full in truncate mode. Yields after each chunk.
   */
  *run(data: Uint8Array, at: number): Steps<number> {
    for (let first = true; ; first = false) {
      if (!first) yield
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
    this.range = 0xffffffff | 0
    this.code = 0
    for (let i = 0; i < RC_INIT_BYTES; i++) this.code = (this.code << 8) | data[at + i]
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

  // LZMA. The range decoder (rc_normalize, rc_bit, rc_bittree, rc_bittree_reverse, rc_direct)
  // and lzma_literal, lzma_len, lzma_match, lzma_rep_match and dict_repeat are written out inside
  // lzmaMain: nearly all of the time goes there, and keeping the range, the code, the input and
  // output positions and the LZMA state in locals instead of fields, with no calls per bit, makes
  // it two to three times as fast. Each written-out rc_bit is the same steps:
  //   rc_normalize:  if range < RC_TOP_VALUE: range <<= 8, code = code << 8 | next input byte
  //   bound = (range >>> RC_BIT_MODEL_TOTAL_BITS) * prob
  //   code < bound:  range = bound, prob += (RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS, bit 0
  //   else:          range -= bound, code -= bound, prob -= prob >>> RC_MOVE_BITS, bit 1
  // `range` and `code` are kept as int32 bit patterns and compared unsigned (`>>> 0`). Past the end
  // of the data the next input byte reads as 0 (`code << 8 | undefined`).

  /** lzma_main: decodes symbols until the output reaches `target` or the input passes `limit`. */
  private lzmaMain(target: number, limit: number): void {
    const probs = this.probs
    const input = this.input
    const buf = this.out.buf
    const dictStart = this.dictStart
    const dictSize = this.dictSize
    const posMask = this.posMask
    const lc = this.lc
    const literalPosMask = this.literalPosMask
    let range = this.range | 0
    let code = this.code | 0
    let inPos = this.inPos
    let pos = this.out.pos
    let state = this.state
    let rep0 = this.rep0
    let rep1 = this.rep1
    let rep2 = this.rep2
    let rep3 = this.rep3
    let len = this.len
    let p = 0
    let prob = 0
    let bound = 0
    let symbol = 0
    let invalid = false
    while (pos < target && inPos <= limit) {
      const posState = (pos - dictStart) & posMask

      // rc_bit(is_match[state][pos_state])
      p = IS_MATCH + state * POS_STATES_MAX + posState
      if ((range & 0xff000000) === 0) {
        range <<= 8
        code = (code << 8) | input[inPos++]
      }
      prob = probs[p]
      bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
      if (code >>> 0 < bound >>> 0) {
        range = bound
        probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)

        // lzma_literal: one 8-bit byte, matched against the byte at rep0 after a match.
        const prevByte = pos > dictStart ? buf[pos - 1] : 0
        const coder = LITERAL + LITERAL_CODER_SIZE * ((prevByte >> (8 - lc)) + (((pos - dictStart) & literalPosMask) << lc))
        symbol = 1
        if (state < LIT_STATES) {
          // rc_bittree(probs, 0x100)
          do {
            p = coder + symbol
            if ((range & 0xff000000) === 0) {
              range <<= 8
              code = (code << 8) | input[inPos++]
            }
            prob = probs[p]
            bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
            if (code >>> 0 < bound >>> 0) {
              range = bound
              probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
              symbol <<= 1
            } else {
              range = (range - bound) | 0
              code = (code - bound) | 0
              probs[p] = prob - (prob >>> RC_MOVE_BITS)
              symbol = (symbol << 1) | 1
            }
          } while (symbol < 0x100)
        } else {
          let matchByte = (pos > dictStart ? buf[pos - rep0 - 1] : 0) << 1
          let offset = 0x100
          do {
            const matchBit = matchByte & offset
            matchByte <<= 1
            p = coder + offset + matchBit + symbol
            if ((range & 0xff000000) === 0) {
              range <<= 8
              code = (code << 8) | input[inPos++]
            }
            prob = probs[p]
            bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
            if (code >>> 0 < bound >>> 0) {
              range = bound
              probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
              symbol <<= 1
              offset &= ~matchBit
            } else {
              range = (range - bound) | 0
              code = (code - bound) | 0
              probs[p] = prob - (prob >>> RC_MOVE_BITS)
              symbol = (symbol << 1) + 1
              offset &= matchBit
            }
          } while (symbol < 0x100)
        }
        buf[pos++] = symbol & 0xff
        // lzma_state_literal
        if (state <= STATE_SHORTREP_LIT_LIT) state = STATE_LIT_LIT
        else if (state <= STATE_LIT_SHORTREP) state -= 3
        else state -= 6
        continue
      }
      range = (range - bound) | 0
      code = (code - bound) | 0
      probs[p] = prob - (prob >>> RC_MOVE_BITS)

      // The length decoder to use: MATCH_LEN_DEC for a new distance, REP_LEN_DEC for a repeated
      // one, -1 for a short rep (length 1).
      let dec = MATCH_LEN_DEC
      // rc_bit(is_rep[state])
      p = IS_REP + state
      if ((range & 0xff000000) === 0) {
        range <<= 8
        code = (code << 8) | input[inPos++]
      }
      prob = probs[p]
      bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
      if (code >>> 0 < bound >>> 0) {
        range = bound
        probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
        // lzma_match: a match with a new distance, into rep0 (after its length, below).
        state = state < LIT_STATES ? STATE_LIT_MATCH : STATE_NONLIT_MATCH
        rep3 = rep2
        rep2 = rep1
        rep1 = rep0
      } else {
        range = (range - bound) | 0
        code = (code - bound) | 0
        probs[p] = prob - (prob >>> RC_MOVE_BITS)
        // lzma_rep_match: a match at one of the four latest distances, moved to rep0.
        dec = REP_LEN_DEC
        // rc_bit(is_rep0[state])
        p = IS_REP0 + state
        if ((range & 0xff000000) === 0) {
          range <<= 8
          code = (code << 8) | input[inPos++]
        }
        prob = probs[p]
        bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
        if (code >>> 0 < bound >>> 0) {
          range = bound
          probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
          // rc_bit(is_rep0_long[state][pos_state])
          p = IS_REP0_LONG + state * POS_STATES_MAX + posState
          if ((range & 0xff000000) === 0) {
            range <<= 8
            code = (code << 8) | input[inPos++]
          }
          prob = probs[p]
          bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
          if (code >>> 0 < bound >>> 0) {
            range = bound
            probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
            state = state < LIT_STATES ? STATE_LIT_SHORTREP : STATE_NONLIT_REP
            len = 1
            dec = -1
          } else {
            range = (range - bound) | 0
            code = (code - bound) | 0
            probs[p] = prob - (prob >>> RC_MOVE_BITS)
          }
        } else {
          range = (range - bound) | 0
          code = (code - bound) | 0
          probs[p] = prob - (prob >>> RC_MOVE_BITS)
          let tmp: number
          // rc_bit(is_rep1[state])
          p = IS_REP1 + state
          if ((range & 0xff000000) === 0) {
            range <<= 8
            code = (code << 8) | input[inPos++]
          }
          prob = probs[p]
          bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
          if (code >>> 0 < bound >>> 0) {
            range = bound
            probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
            tmp = rep1
          } else {
            range = (range - bound) | 0
            code = (code - bound) | 0
            probs[p] = prob - (prob >>> RC_MOVE_BITS)
            // rc_bit(is_rep2[state])
            p = IS_REP2 + state
            if ((range & 0xff000000) === 0) {
              range <<= 8
              code = (code << 8) | input[inPos++]
            }
            prob = probs[p]
            bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
            if (code >>> 0 < bound >>> 0) {
              range = bound
              probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
              tmp = rep2
            } else {
              range = (range - bound) | 0
              code = (code - bound) | 0
              probs[p] = prob - (prob >>> RC_MOVE_BITS)
              tmp = rep3
              rep3 = rep2
            }
            rep2 = rep1
          }
          rep1 = rep0
          rep0 = tmp
        }
        if (dec >= 0) state = state < LIT_STATES ? STATE_LIT_LONGREP : STATE_NONLIT_REP
      }

      if (dec >= 0) {
        // lzma_len: the match length into `len`.
        let lengths: number
        let symbols: number
        // rc_bit(choice)
        p = dec + LEN_CHOICE
        if ((range & 0xff000000) === 0) {
          range <<= 8
          code = (code << 8) | input[inPos++]
        }
        prob = probs[p]
        bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
        if (code >>> 0 < bound >>> 0) {
          range = bound
          probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
          lengths = dec + LEN_LOW + posState * LEN_LOW_SYMBOLS
          symbols = LEN_LOW_SYMBOLS
          len = MATCH_LEN_MIN
        } else {
          range = (range - bound) | 0
          code = (code - bound) | 0
          probs[p] = prob - (prob >>> RC_MOVE_BITS)
          // rc_bit(choice2)
          p = dec + LEN_CHOICE2
          if ((range & 0xff000000) === 0) {
            range <<= 8
            code = (code << 8) | input[inPos++]
          }
          prob = probs[p]
          bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
          if (code >>> 0 < bound >>> 0) {
            range = bound
            probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
            lengths = dec + LEN_MID + posState * LEN_MID_SYMBOLS
            symbols = LEN_MID_SYMBOLS
            len = MATCH_LEN_MIN + LEN_LOW_SYMBOLS
          } else {
            range = (range - bound) | 0
            code = (code - bound) | 0
            probs[p] = prob - (prob >>> RC_MOVE_BITS)
            lengths = dec + LEN_HIGH
            symbols = LEN_HIGH_SYMBOLS
            len = MATCH_LEN_MIN + LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS
          }
        }
        // rc_bittree(lengths, symbols)
        symbol = 1
        do {
          p = lengths + symbol
          if ((range & 0xff000000) === 0) {
            range <<= 8
            code = (code << 8) | input[inPos++]
          }
          prob = probs[p]
          bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
          if (code >>> 0 < bound >>> 0) {
            range = bound
            probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
            symbol <<= 1
          } else {
            range = (range - bound) | 0
            code = (code - bound) | 0
            probs[p] = prob - (prob >>> RC_MOVE_BITS)
            symbol = (symbol << 1) | 1
          }
        } while (symbol < symbols)
        len += symbol - symbols

        if (dec === MATCH_LEN_DEC) {
          // lzma_match, continued: the distance.
          const distState = len < DIST_STATES + MATCH_LEN_MIN ? len - MATCH_LEN_MIN : DIST_STATES - 1
          // rc_bittree(dist_slot[dist_state], DIST_SLOTS)
          const slots = DIST_SLOT + distState * DIST_SLOTS
          symbol = 1
          do {
            p = slots + symbol
            if ((range & 0xff000000) === 0) {
              range <<= 8
              code = (code << 8) | input[inPos++]
            }
            prob = probs[p]
            bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
            if (code >>> 0 < bound >>> 0) {
              range = bound
              probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
              symbol <<= 1
            } else {
              range = (range - bound) | 0
              code = (code - bound) | 0
              probs[p] = prob - (prob >>> RC_MOVE_BITS)
              symbol = (symbol << 1) | 1
            }
          } while (symbol < DIST_SLOTS)
          const distSlot = symbol - DIST_SLOTS
          if (distSlot < DIST_MODEL_START) {
            rep0 = distSlot
          } else {
            const bits = (distSlot >> 1) - 1
            rep0 = 2 + (distSlot & 1)
            // rc_bittree_reverse: `count` bits from the least significant one.
            let reverse: number
            let count: number
            if (distSlot < DIST_MODEL_END) {
              rep0 = (rep0 << bits) >>> 0
              reverse = DIST_SPECIAL + rep0 - distSlot - 1
              count = bits
            } else {
              // rc_direct(&rep0, bits - ALIGN_BITS): bits of fixed fifty-fifty probability.
              let n = bits - ALIGN_BITS
              do {
                if ((range & 0xff000000) === 0) {
                  range <<= 8
                  code = (code << 8) | input[inPos++]
                }
                range >>>= 1
                code = (code - range) | 0
                const mask = code >> 31
                code = (code + (range & mask)) | 0
                rep0 = ((rep0 << 1) + (mask + 1)) >>> 0
              } while (--n > 0)
              rep0 = (rep0 * ALIGN_SIZE) % 2 ** 32
              reverse = DIST_ALIGN
              count = ALIGN_BITS
            }
            symbol = 1
            let value = 0
            for (let i = 0; i < count; i++) {
              p = reverse + symbol
              if ((range & 0xff000000) === 0) {
                range <<= 8
                code = (code << 8) | input[inPos++]
              }
              prob = probs[p]
              bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob)
              if (code >>> 0 < bound >>> 0) {
                range = bound
                probs[p] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS)
                symbol <<= 1
              } else {
                range = (range - bound) | 0
                code = (code - bound) | 0
                probs[p] = prob - (prob >>> RC_MOVE_BITS)
                symbol = (symbol << 1) | 1
                value |= 1 << i
              }
            }
            rep0 = (rep0 + value) % 2 ** 32
          }
        }
      }

      // dict_repeat: copies `len` bytes from rep0 + 1 back, up to `target`.
      if (rep0 >= pos - dictStart || rep0 >= dictSize) {
        invalid = true
        break
      }
      const n = Math.min(target - pos, len)
      len -= n
      let back = pos - rep0 - 1
      if (n > 32 && rep0 + 1 >= n) {
        buf.copyWithin(pos, back, back + n)
        pos += n
      } else {
        // Short or overlapping: byte by byte, since each byte may be one this copy just wrote.
        for (let k = 0; k < n; k++) buf[pos++] = buf[back++]
      }
    }
    if (!invalid && (range & 0xff000000) === 0) {
      // Always leave the range decoder normalized, so the end of the chunk is easy to check.
      range <<= 8
      code = (code << 8) | input[inPos++]
    }
    this.range = range
    this.code = code
    this.inPos = inPos
    this.out.pos = pos
    this.state = state
    this.rep0 = rep0
    this.rep1 = rep1
    this.rep2 = rep2
    this.rep3 = rep3
    this.len = len
    if (invalid) throw new DamagedError('xz match reaches before the start of the dictionary')
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
