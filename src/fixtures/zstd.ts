// A Zstandard encoder for tests only, written from RFC 8878 so the tests build their .zst data in
// code instead of carrying it. Frames have a window descriptor or are single-segment, with or
// without a content size. Blocks are raw, RLE or compressed; a compressed block holds raw or RLE
// literals and sequences from a greedy match search over the whole window, so matches reach
// back into earlier blocks the way a streaming decoder's window must keep them. Sequences use
// the RLE symbol mode: all sequences of a block share their literal length, offset and match
// length codes, and a sequence that needs other codes starts a new block. No Huffman or FSE
// tables, no checksum. When the real `zstd` is installed, src/codecs/cli.test.ts checks that it
// reads this output.

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const MAX_BLOCK = 128 * 1024
const MIN_MATCH = 3

const LL_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128,
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536
]
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16
]
const ML_BASE = [
  ...Array.from({ length: 32 }, (_, i) => i + 3),
  35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771,
  65539
]
const ML_BITS = [
  ...Array<number>(32).fill(0),
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
]

export type ZstdOptions = {
  /** Window size 2^windowLog. Without it the frame is single-segment: its window is its size. */
  windowLog?: number
  /** Write Frame_Content_Size (default true; a single-segment frame always has it). */
  contentSize?: boolean
  /** Most bytes per block before codes split it further; at most the window and 128 KiB. */
  blockSize?: number
}

type Sequence = { literals: number; offset: number; length: number }

const codeOf = (base: number[], value: number) => {
  let code = 0
  while (code + 1 < base.length && base[code + 1] <= value) code++
  return code
}

/** Code and extra bits of one sequence's three fields, as the decoder reads them. */
function fields(s: Sequence) {
  const ll = codeOf(LL_BASE, s.literals)
  const ml = codeOf(ML_BASE, s.length)
  const offBase = s.offset + 3 // never a repeat offset
  const of = 31 - Math.clz32(offBase)
  return {
    codes: [ll, of, ml],
    ll: [s.literals - LL_BASE[ll], LL_BITS[ll]],
    ml: [s.length - ML_BASE[ml], ML_BITS[ml]],
    of: [offBase - 2 ** of, of]
  }
}

/** Literals section: raw, or RLE when every literal is the same byte. */
function literalsSection(literals: number[]): number[] {
  const rle = literals.length > 1 && literals.every((b) => b === literals[0])
  const type = rle ? 1 : 0
  const n = literals.length
  const header =
    n < 32
      ? [(n << 3) | type]
      : n < 4096
        ? [((n << 4) | (1 << 2) | type) & 0xff, n >> 4]
        : [((n << 4) | (3 << 2) | type) & 0xff, (n >> 4) & 0xff, n >> 12]
  return [...header, ...(rle ? [literals[0]] : literals)]
}

/** The sequences' extra bits, last sequence first, read back to front behind a closing 1 bit. */
function bitstream(sequences: Sequence[]): number[] {
  const bits: number[] = []
  const put = ([value, n]: number[]) => {
    for (let j = 0; j < n; j++) bits.push(Math.floor(value / 2 ** j) & 1)
  }
  for (let k = sequences.length - 1; k >= 0; k--) {
    const f = fields(sequences[k])
    put(f.ll)
    put(f.ml)
    put(f.of)
  }
  bits.push(1)
  const out = new Array<number>(Math.ceil(bits.length / 8)).fill(0)
  bits.forEach((b, i) => (out[i >> 3] |= b << (i & 7)))
  return out
}

function compressedBlock(sequences: Sequence[], literals: number[]): number[] {
  const out = literalsSection(literals)
  const n = sequences.length
  out.push(...(n < 128 ? [n] : n < 0x7f00 ? [(n >> 8) + 128, n & 0xff] : [255, (n - 0x7f00) & 0xff, (n - 0x7f00) >> 8]))
  if (n === 0) return out
  out.push(0x54) // RLE mode for literal lengths, offsets and match lengths
  out.push(...fields(sequences[0]).codes)
  out.push(...bitstream(sequences))
  return out
}

/** One Zstandard frame of `data`. */
export function zstd(data: Uint8Array, options: ZstdOptions = {}): Uint8Array {
  const single = options.windowLog === undefined
  const windowLog = options.windowLog ?? 17
  const window = single ? Math.max(data.length, 1) : 2 ** windowLog
  const contentSize = single || options.contentSize !== false
  const blockMax = Math.min(options.blockSize ?? MAX_BLOCK, window, MAX_BLOCK)

  const out: number[] = [...MAGIC]
  const size = data.length
  const fcsFlag = !contentSize ? 0 : single && size < 256 ? 0 : size >= 256 && size < 65792 ? 1 : 2
  out.push((fcsFlag << 6) | ((single ? 1 : 0) << 5))
  if (!single) out.push((windowLog - 10) << 3)
  if (contentSize) {
    if (fcsFlag === 0) out.push(size)
    else if (fcsFlag === 1) out.push((size - 256) & 0xff, (size - 256) >> 8)
    else out.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >>> 24)
  }

  const blocks: { type: number; body: number[]; size: number }[] = []
  const rawBlock = (from: number, to: number) => {
    const bytes = Array.from(data.subarray(from, to))
    if (bytes.length > 1 && bytes.every((b) => b === bytes[0])) {
      blocks.push({ type: 1, body: [bytes[0]], size: bytes.length })
    } else {
      blocks.push({ type: 0, body: bytes, size: bytes.length })
    }
  }

  // Greedy matches through hash chains of three-byte prefixes, over the whole window.
  const head = new Map<number, number>()
  const prev = new Int32Array(data.length).fill(-1)
  const hash = (i: number) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
  const insert = (i: number) => {
    if (i + MIN_MATCH > data.length) return
    const h = hash(i)
    prev[i] = head.get(h) ?? -1
    head.set(h, i)
  }

  for (let start = 0; start < data.length; start += blockMax) {
    const end = Math.min(start + blockMax, data.length)
    const sequences: Sequence[] = []
    let i = start
    let literalStart = start
    while (i < end) {
      let best = 0
      let bestOffset = 0
      if (i + MIN_MATCH <= end) {
        let candidate = head.get(hash(i)) ?? -1
        for (let depth = 0; candidate >= 0 && i - candidate <= window && depth < 64; depth++) {
          let length = 0
          while (i + length < end && data[candidate + length] === data[i + length]) length++
          if (length > best) {
            best = length
            bestOffset = i - candidate
          }
          candidate = prev[candidate]
        }
      }
      if (best >= MIN_MATCH) {
        sequences.push({ literals: i - literalStart, offset: bestOffset, length: best })
        for (let k = 0; k < best; k++) insert(i + k)
        i += best
        literalStart = i
      } else {
        insert(i)
        i++
      }
    }

    // Split where the codes change; the last piece carries the trailing literals.
    let at = start
    let k = 0
    while (k < sequences.length) {
      const codes = fields(sequences[k]).codes.join()
      const run: Sequence[] = []
      let pieceEnd = at
      while (k < sequences.length && fields(sequences[k]).codes.join() === codes) {
        pieceEnd += sequences[k].literals + sequences[k].length
        run.push(sequences[k++])
      }
      if (k === sequences.length) pieceEnd = end
      const literals: number[] = []
      let p = at
      for (const s of run) {
        literals.push(...data.subarray(p, p + s.literals))
        p += s.literals + s.length
      }
      literals.push(...data.subarray(p, pieceEnd))
      const body = compressedBlock(run, literals)
      if (body.length < pieceEnd - at) blocks.push({ type: 2, body, size: pieceEnd - at })
      else rawBlock(at, pieceEnd)
      at = pieceEnd
    }
    if (at < end) rawBlock(at, end)
  }
  if (blocks.length === 0) blocks.push({ type: 0, body: [], size: 0 })

  blocks.forEach((block, n) => {
    const last = n === blocks.length - 1 ? 1 : 0
    const header = last | (block.type << 1) | ((block.type === 1 ? block.size : block.body.length) << 3)
    out.push(header & 0xff, (header >> 8) & 0xff, header >> 16, ...block.body)
  })
  return Uint8Array.from(out)
}
