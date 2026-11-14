// A bzip2 decoder written for Archive Viewer from the format's description: Huffman-coded MTF and
// run-length symbols, inverse Burrows–Wheeler transform, then the final run-length step. Supports
// concatenated streams (pbzip2) and checks each block's CRC; randomised blocks (bzip2 0.9.0, 1998)
// are refused.

import { DamagedError, Sink, asDecodeError } from './sink'

const MAX_CODE_LENGTH = 20
const GROUP_SIZE = 50

class BitReader {
  pos = 0
  private buf = 0
  private count = 0
  private readonly data: Uint8Array

  constructor(data: Uint8Array) {
    this.data = data
  }

  /** Up to 24 bits, most significant first. */
  bits(n: number): number {
    while (this.count < n) {
      if (this.pos >= this.data.length) {
        throw new DamagedError('bzip2 data ends early')
      }
      this.buf = (this.buf << 8) | this.data[this.pos++]
      this.count += 8
    }
    this.count -= n
    return (this.buf >>> this.count) & ((1 << n) - 1)
  }

  bit(): number {
    if (this.count === 0) {
      if (this.pos >= this.data.length) {
        throw new DamagedError('bzip2 data ends early')
      }
      this.buf = this.data[this.pos++]
      this.count = 8
    }
    this.count--
    return (this.buf >>> this.count) & 1
  }

  /** Drops the bits left in the current byte; streams start on a byte boundary. */
  align(): void {
    this.count -= this.count % 8
  }

  /** Bytes not read yet, counting whole bytes still in the buffer. */
  remaining(): number {
    return this.data.length - this.pos + (this.count >> 3)
  }

  /** The next whole bytes without consuming them (after `align`). */
  peek(n: number): number[] {
    const out: number[] = []
    let held = this.count >> 3
    for (let i = 0; i < n; i++) {
      if (held > 0) {
        held--
        out.push((this.buf >>> (held * 8)) & 0xff)
      } else {
        out.push(this.data[this.pos + i - (this.count >> 3)] ?? -1)
      }
    }
    return out
  }
}

type Table = { counts: Int32Array; symbols: Uint16Array }

function buildTable(lengths: Uint8Array, alphaSize: number): Table {
  const counts = new Int32Array(MAX_CODE_LENGTH + 1)
  for (let i = 0; i < alphaSize; i++) counts[lengths[i]]++
  const offsets = new Int32Array(MAX_CODE_LENGTH + 2)
  for (let len = 1; len <= MAX_CODE_LENGTH; len++) offsets[len + 1] = offsets[len] + counts[len]
  const symbols = new Uint16Array(alphaSize)
  for (let i = 0; i < alphaSize; i++) symbols[offsets[lengths[i]]++] = i
  return { counts, symbols }
}

/** Canonical Huffman decoding, one bit at a time (codes are at most 20 bits). */
function decodeSymbol(r: BitReader, table: Table): number {
  const { counts, symbols } = table
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
    code |= r.bit()
    const count = counts[len]
    if (code - first < count) {
      return symbols[index + code - first]
    }
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new DamagedError('bad bzip2 Huffman code')
}

let crcTable: Uint32Array | null = null

/** bzip2's CRC-32: polynomial 0x04C11DB7, most significant bit first. */
function crcTableBE(): Uint32Array {
  if (crcTable) return crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    t[n] = c >>> 0
  }
  return (crcTable = t)
}

/** Every stream of bzip2 data, joined; `truncate` keeps the first `limit` bytes instead of throwing. */
export function bunzip2(
  data: Uint8Array,
  limit: number,
  truncate = false
): { bytes: Uint8Array; truncated: boolean } {
  const sink = new Sink(limit, truncate)
  try {
    const r = new BitReader(data)
    let streams = 0
    while (!sink.full) {
      if (streams > 0) {
        r.align()
        const next = r.peek(3)
        if (r.remaining() < 4 || next[0] !== 0x42 || next[1] !== 0x5a || next[2] !== 0x68) {
          break // trailing bytes after the last stream
        }
      }
      if (r.bits(8) !== 0x42 || r.bits(8) !== 0x5a || r.bits(8) !== 0x68) {
        throw new DamagedError('not bzip2 data')
      }
      const level = r.bits(8) - 0x30
      if (level < 1 || level > 9) {
        throw new DamagedError('bad bzip2 block size')
      }
      decodeStream(r, level * 100000, sink)
      streams++
    }
  } catch (error) {
    throw asDecodeError(error, 'bzip2')
  }
  return { bytes: sink.result(), truncated: sink.full }
}

function decodeStream(r: BitReader, blockMax: number, sink: Sink): void {
  const tt = new Uint32Array(blockMax)
  for (;;) {
    const hi = r.bits(24)
    const lo = r.bits(24)
    const crc = ((r.bits(16) << 16) | r.bits(16)) >>> 0
    if (hi === 0x314159 && lo === 0x265359) {
      decodeBlock(r, tt, blockMax, sink, crc)
      if (sink.full) return
    } else if (hi === 0x177245 && lo === 0x385090) {
      return
    } else {
      throw new DamagedError('bad bzip2 block header')
    }
  }
}

function decodeBlock(r: BitReader, tt: Uint32Array, blockMax: number, sink: Sink, expectedCrc: number): void {
  if (r.bit()) {
    throw new DamagedError('randomised bzip2 blocks are not supported')
  }
  const origPtr = r.bits(24)

  const seqToUnseq = new Uint8Array(256)
  let inUse = 0
  const groupsUsed = r.bits(16)
  for (let i = 0; i < 16; i++) {
    if (groupsUsed & (0x8000 >> i)) {
      const used = r.bits(16)
      for (let j = 0; j < 16; j++) {
        if (used & (0x8000 >> j)) seqToUnseq[inUse++] = i * 16 + j
      }
    }
  }
  if (inUse === 0) throw new DamagedError('empty bzip2 symbol map')
  const alphaSize = inUse + 2
  const endOfBlock = inUse + 1

  const groups = r.bits(3)
  if (groups < 2 || groups > 6) throw new DamagedError('bad bzip2 group count')
  const selectorCount = r.bits(15)
  if (selectorCount === 0) throw new DamagedError('no bzip2 selectors')
  const order = [0, 1, 2, 3, 4, 5]
  const selectors = new Uint8Array(selectorCount)
  for (let i = 0; i < selectorCount; i++) {
    let j = 0
    while (r.bit()) {
      if (++j >= groups) throw new DamagedError('bad bzip2 selector')
    }
    const value = order[j]
    for (let k = j; k > 0; k--) order[k] = order[k - 1]
    order[0] = value
    selectors[i] = value
  }

  const tables: Table[] = []
  const lengths = new Uint8Array(alphaSize)
  for (let t = 0; t < groups; t++) {
    let length = r.bits(5)
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (length < 1 || length > MAX_CODE_LENGTH) throw new DamagedError('bad bzip2 code length')
        if (!r.bit()) break
        length += r.bit() ? -1 : 1
      }
      lengths[i] = length
    }
    tables.push(buildTable(lengths, alphaSize))
  }

  // Huffman symbols → run lengths and move-to-front indexes → bytes in tt.
  const mtf = new Uint8Array(256)
  for (let i = 0; i < 256; i++) mtf[i] = i
  const byteCount = new Int32Array(256)
  let size = 0
  let selector = 0
  let left = 0
  let table = tables[0]
  let run = 0
  let weight = 1
  for (;;) {
    if (left === 0) {
      if (selector >= selectorCount) throw new DamagedError('bzip2 selectors run out')
      table = tables[selectors[selector++]]
      left = GROUP_SIZE
    }
    left--
    const symbol = decodeSymbol(r, table)
    if (symbol <= 1) {
      // RUNA adds 1×weight, RUNB 2×weight; the weight doubles with each digit.
      run += (symbol + 1) * weight
      weight <<= 1
      if (run > blockMax) throw new DamagedError('bzip2 run too long')
      continue
    }
    if (run > 0) {
      const value = seqToUnseq[mtf[0]]
      if (size + run > blockMax) throw new DamagedError('bzip2 block too long')
      tt.fill(value, size, size + run)
      byteCount[value] += run
      size += run
      run = 0
      weight = 1
    }
    if (symbol === endOfBlock) break
    const index = symbol - 1
    const value = mtf[index]
    mtf.copyWithin(1, 0, index)
    mtf[0] = value
    const byte = seqToUnseq[value]
    if (size >= blockMax) throw new DamagedError('bzip2 block too long')
    byteCount[byte]++
    tt[size++] = byte
  }
  if (origPtr >= size) throw new DamagedError('bad bzip2 origin pointer')

  // Inverse Burrows–Wheeler: link each position to the next, then walk from the origin.
  const start = new Int32Array(256)
  for (let i = 0, sum = 0; i < 256; i++) {
    start[i] = sum
    sum += byteCount[i]
  }
  for (let i = 0; i < size; i++) {
    const byte = tt[i] & 0xff
    tt[start[byte]++] |= i << 8
  }

  // Walk the links, undo the first run-length step (4 equal bytes + a repeat count) and check the CRC.
  const crcs = crcTableBE()
  let crc = 0xffffffff
  const chunk = new Uint8Array(1 << 16)
  let at = 0
  let pos = tt[origPtr] >>> 8
  let last = -1
  let same = 0
  const emit = (byte: number, times: number) => {
    for (let k = 0; k < times; k++) {
      crc = ((crc << 8) ^ crcs[((crc >>> 24) ^ byte) & 0xff]) >>> 0
      chunk[at++] = byte
      if (at === chunk.length) {
        sink.push(chunk)
        at = 0
      }
    }
  }
  for (let i = 0; i < size && !sink.full; i++) {
    pos = tt[pos]
    const byte = pos & 0xff
    pos >>>= 8
    if (same === 4) {
      emit(last, byte)
      same = 0
      continue
    }
    if (byte === last) {
      same++
    } else {
      last = byte
      same = 1
    }
    emit(byte, 1)
  }
  sink.push(chunk.subarray(0, at))
  if (!sink.full && (crc ^ 0xffffffff) >>> 0 !== expectedCrc) {
    throw new DamagedError('bzip2 block CRC mismatch')
  }
}
