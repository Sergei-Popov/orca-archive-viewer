// A bzip2 encoder for tests only, written from the format so the tests build their .bz2 data in
// code instead of carrying it: the first run-length step, the Burrows–Wheeler transform,
// move-to-front with RUNA/RUNB runs, and canonical Huffman codes in 2–6 tables chosen per group
// of 50 symbols. Small and slow (a prefix-doubling sort); fine for fixtures of a few hundred KB.
// When the real `bzip2` is installed, src/codecs/cli.test.ts checks that it reads this output.

const GROUP_SIZE = 50
const MAX_CODE_LENGTH = 17

export type Bzip2Options = {
  /** Block size level 1–9 (× 100,000 bytes): a small level splits the input into blocks. */
  level?: number
  /** Huffman tables per block, 2–6. Groups use them in turn, so every table is used. */
  tables?: number
}

class BitWriter {
  private readonly out: number[] = []
  private byte = 0
  private count = 0

  bit(b: number): void {
    this.byte = (this.byte << 1) | b
    if (++this.count === 8) {
      this.out.push(this.byte)
      this.byte = 0
      this.count = 0
    }
  }

  /** `n` bits of `value`, most significant first. */
  bits(n: number, value: number): void {
    for (let i = n - 1; i >= 0; i--) this.bit((value >>> i) & 1)
  }

  done(): Uint8Array {
    if (this.count) this.out.push(this.byte << (8 - this.count))
    return Uint8Array.from(this.out)
  }
}

let crcTable: Uint32Array | null = null

/** bzip2's CRC-32: polynomial 0x04C11DB7, most significant bit first. */
export function bzip2Crc(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n << 24
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

/** The first run-length step from `start`: 4–255 equal bytes become 4 bytes and a count. */
function runLength(data: Uint8Array, start: number, room: number): { out: number[]; end: number } {
  const out: number[] = []
  let i = start
  while (i < data.length) {
    const byte = data[i]
    let run = 1
    while (run < 255 && i + run < data.length && data[i + run] === byte) run++
    const piece = run >= 4 ? [byte, byte, byte, byte, run - 4] : Array(run).fill(byte)
    if (out.length + piece.length > room) break
    out.push(...piece)
    i += run
  }
  return { out, end: i }
}

/** Sorted rotations by prefix doubling; equal rotations (periodic blocks) may come in any order. */
function bwt(block: Uint8Array): { last: Uint8Array; origin: number } {
  const n = block.length
  let rank = Int32Array.from(block)
  const order = new Int32Array(n).map((_, i) => i)
  for (let k = 1; k < 2 * n; k <<= 1) {
    const r = rank
    const second = (i: number) => r[(i + k) % n]
    order.sort((a, b) => r[a] - r[b] || second(a) - second(b))
    const next = new Int32Array(n)
    for (let j = 1; j < n; j++) {
      const a = order[j - 1]
      const b = order[j]
      next[b] = next[a] + (r[a] !== r[b] || second(a) !== second(b) ? 1 : 0)
    }
    rank = next
    if (n === 0 || rank[order[n - 1]] === n - 1) break
  }
  const last = new Uint8Array(n)
  for (let j = 0; j < n; j++) last[j] = block[(order[j] + n - 1) % n]
  return { last, origin: order.indexOf(0) }
}

/** Huffman code lengths of at most 17 bits; every symbol gets a code, as bzip2 requires. */
function codeLengths(freq: number[]): number[] {
  let weights = freq.map((f) => Math.max(f, 1))
  for (;;) {
    type Node = { w: number; symbol?: number; kids?: [Node, Node] }
    const nodes: Node[] = weights.map((w, symbol) => ({ w, symbol }))
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.w - b.w)
      const [a, b] = nodes.splice(0, 2)
      nodes.push({ w: a.w + b.w, kids: [a, b] })
    }
    const lengths = new Array<number>(freq.length).fill(0)
    const walk = (node: Node, depth: number): void => {
      if (node.kids) {
        walk(node.kids[0], depth + 1)
        walk(node.kids[1], depth + 1)
      } else {
        lengths[node.symbol ?? 0] = Math.max(depth, 1)
      }
    }
    walk(nodes[0], 0)
    if (Math.max(...lengths) <= MAX_CODE_LENGTH) return lengths
    weights = weights.map((w) => 1 + (w >> 1))
  }
}

/** Canonical codes: shorter first, then by symbol, as the decoder rebuilds them. */
function canonicalCodes(lengths: number[]): number[] {
  const codes = new Array<number>(lengths.length).fill(0)
  let code = 0
  for (let length = 1; length <= MAX_CODE_LENGTH; length++) {
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      if (lengths[symbol] === length) codes[symbol] = code++
    }
    code <<= 1
  }
  return codes
}

function writeBlock(w: BitWriter, block: Uint8Array, crc: number, tables: number): void {
  const { last, origin } = bwt(block)

  // Move-to-front over the bytes in use; runs of index 0 become RUNA/RUNB digits (bijective base 2).
  const used = new Array<boolean>(256).fill(false)
  for (const b of block) used[b] = true
  const seq = new Array<number>(256).fill(-1)
  let inUse = 0
  for (let v = 0; v < 256; v++) if (used[v]) seq[v] = inUse++
  const mtf = Array.from({ length: inUse }, (_, i) => i)
  const symbols: number[] = []
  let zeros = 0
  const flush = () => {
    for (let run = zeros; run > 0; ) {
      if (run & 1) {
        symbols.push(0)
        run = (run - 1) / 2
      } else {
        symbols.push(1)
        run = (run - 2) / 2
      }
    }
    zeros = 0
  }
  for (const b of last) {
    const j = mtf.indexOf(seq[b])
    if (j === 0) {
      zeros++
      continue
    }
    flush()
    symbols.push(j + 1)
    mtf.splice(j, 1)
    mtf.unshift(seq[b])
  }
  flush()
  const alphaSize = inUse + 2
  symbols.push(inUse + 1)

  const selectors = Array.from({ length: Math.ceil(symbols.length / GROUP_SIZE) }, (_, g) => g % tables)
  const lengths: number[][] = []
  for (let t = 0; t < tables; t++) {
    const freq = new Array<number>(alphaSize).fill(0)
    symbols.forEach((s, k) => {
      if (selectors[Math.floor(k / GROUP_SIZE)] === t) freq[s]++
    })
    lengths.push(codeLengths(freq))
  }
  const codes = lengths.map(canonicalCodes)

  w.bits(24, 0x314159)
  w.bits(24, 0x265359)
  w.bits(32, crc)
  w.bit(0) // not randomised
  w.bits(24, origin)
  let groupsUsed = 0
  for (let i = 0; i < 16; i++) if (used.slice(i * 16, i * 16 + 16).includes(true)) groupsUsed |= 0x8000 >> i
  w.bits(16, groupsUsed)
  for (let i = 0; i < 16; i++) {
    if (!(groupsUsed & (0x8000 >> i))) continue
    let mask = 0
    for (let j = 0; j < 16; j++) if (used[i * 16 + j]) mask |= 0x8000 >> j
    w.bits(16, mask)
  }
  w.bits(3, tables)
  w.bits(15, selectors.length)
  const order = Array.from({ length: tables }, (_, i) => i)
  for (const s of selectors) {
    const j = order.indexOf(s)
    for (let k = 0; k < j; k++) w.bit(1)
    w.bit(0)
    order.splice(j, 1)
    order.unshift(s)
  }
  for (const table of lengths) {
    let current = table[0]
    w.bits(5, current)
    for (const length of table) {
      for (; current < length; current++) w.bits(2, 0b10)
      for (; current > length; current--) w.bits(2, 0b11)
      w.bit(0)
    }
  }
  symbols.forEach((s, k) => {
    const t = selectors[Math.floor(k / GROUP_SIZE)]
    w.bits(lengths[t][s], codes[t][s])
  })
}

/** One bzip2 stream of `data`. Empty data gives a stream with no blocks, as `bzip2` writes it. */
export function bzip2(data: Uint8Array, options: Bzip2Options = {}): Uint8Array {
  const level = options.level ?? 9
  const tables = options.tables ?? 2
  const w = new BitWriter()
  w.bits(24, 0x425a68) // "BZh"
  w.bits(8, 0x30 + level)
  let combined = 0
  for (let start = 0; start < data.length; ) {
    const { out, end } = runLength(data, start, level * 100000 - 19)
    const crc = bzip2Crc(data.subarray(start, end))
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0
    writeBlock(w, Uint8Array.from(out), crc, tables)
    start = end
  }
  w.bits(24, 0x177245)
  w.bits(24, 0x385090)
  w.bits(32, combined)
  return w.done()
}
