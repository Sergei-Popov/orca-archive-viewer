import { assert, test } from 'orca/testing'
import { gzipSync } from '../../vendor/fflate/fflate.mjs'
import { concat, utf8 } from '../fixtures/build'
import { bzip2 } from '../fixtures/bzip2'
import { base64, sha256Xz, x86Xz } from '../fixtures/samples'
import { xz } from '../fixtures/xz'
import { zstd } from '../fixtures/zstd'
import { bunzip2 } from './bzip2'
import { crc32 } from './crc32'
import { gunzip, gzipHeader, inflate } from './deflate'
import { DamagedError, Sink, TooLargeError, UnsupportedDataError } from './sink'
import { unxz } from './xz'
import { unzstd, zstdFrames } from './zstd'

const is = (type: abstract new (...args: never[]) => unknown) => (error: unknown) => error instanceof type
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const unsupported = (feature: string) => (error: unknown) =>
  error instanceof UnsupportedDataError && error.feature === feature

/** Letters from a fixed LCG: text that DEFLATE cannot shrink much. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length)
  let x = 12345
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = 97 + ((x >>> 16) % 26)
  }
  return out
}

const helloZst = zstd(utf8('hello xz\n'))
const helloXz = xz(utf8('hello xz\n'))

/** 1000 × 'a', 5000 letters, 300 × 'bbbbb' and a newline: both bzip2 run-length steps. */
const runs = concat(new Uint8Array(1000).fill(0x61), noise(5000), utf8('bbbbb'.repeat(300) + '\n'))
const runsBz2 = bzip2(runs)

/** 400 copies of 500 letters, one byte changed in each: matches 500 and 1,000 bytes back. */
function slidePlain(): Uint8Array {
  const base = noise(500)
  const plain = new Uint8Array(500 * 400)
  for (let i = 0; i < 400; i++) {
    plain.set(base, i * 500)
    plain[i * 500 + ((i * 7) % 500)] = 65 + (i % 26)
  }
  return plain
}

test('crc32 continues from a previous value', () => {
  const whole = utf8('123456789')
  assert.equal(crc32(whole.subarray(4), crc32(whole.subarray(0, 4))), 0xcbf43926)
})

test('Sink grows one buffer up to its limit and returns a view of it', () => {
  const sink = new Sink(1000)
  sink.push(new Uint8Array(600).fill(1))
  sink.push(new Uint8Array(300).fill(2))
  const bytes = sink.result()
  assert.equal(bytes.length, 900)
  assert.equal(bytes.buffer.byteLength, 1000)
  assert.equal(bytes[899], 2)
  assert.throws(() => sink.push(new Uint8Array(200)), is(TooLargeError))
  const sized = new Sink(1 << 20, false, 10)
  sized.push(new Uint8Array(10))
  assert.equal(sized.result().buffer.byteLength, 10)
})

test('crc32 matches the check value', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('bunzip2 undoes both run-length steps and checks block CRCs', () => {
  const { bytes, truncated } = bunzip2(runsBz2, 1 << 20)
  assert.equal(truncated, false)
  assert.equal(bytes.length, runs.length)
  assert.equal(crc32(bytes), crc32(runs))
})

test('bunzip2 reads several blocks and up to six Huffman tables', () => {
  const plain = concat(noise(150000), new Uint8Array(30000).fill(0x7a), noise(40000))
  const { bytes } = bunzip2(bzip2(plain, { level: 1 }), 1 << 20)
  assert.equal(bytes.length, plain.length)
  assert.equal(crc32(bytes), crc32(plain))
  for (let tables = 2; tables <= 6; tables++) {
    assert.equal(crc32(bunzip2(bzip2(runs, { tables }), 1 << 20).bytes), crc32(runs))
  }
  assert.deepEqual(bunzip2(bzip2(utf8('x')), 100).bytes, utf8('x'))
})

test('bunzip2 joins concatenated streams', () => {
  const { bytes } = bunzip2(concat(runsBz2, bzip2(utf8('second stream\n'))), 1 << 20)
  assert.equal(bytes.length, runs.length + 'second stream\n'.length)
  assert.equal(text(bytes.subarray(runs.length)), 'second stream\n')
})

test('bunzip2 stops at the limit in truncate mode and throws otherwise', () => {
  const cut = bunzip2(runsBz2, 1500, true)
  assert.equal(cut.bytes.length, 1500)
  assert.equal(cut.truncated, true)
  assert.equal(text(cut.bytes.subarray(0, 1000)), 'a'.repeat(1000))
  assert.throws(() => bunzip2(runsBz2, 1500), is(TooLargeError))
})

// Stream header "BZh9", end-of-stream marker, combined CRC 0: a stream with no blocks.
const emptyBz2 = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x17, 0x72, 0x45, 0x38, 0x50, 0x90, 0, 0, 0, 0])

test('bunzip2 gets through thousands of empty streams quickly', () => {
  assert.deepEqual(bzip2(new Uint8Array(0)), emptyBz2)
  const data = concat(...Array.from({ length: 50000 }, () => emptyBz2), runsBz2)
  const started = performance.now()
  const { bytes } = bunzip2(data, 1 << 20)
  // A block buffer per stream (3.6 MB at level 9) made this take over a second.
  assert.ok(performance.now() - started < 300)
  assert.equal(bytes.length, runs.length)
  assert.equal(crc32(bytes), crc32(runs))
  assert.equal(bunzip2(emptyBz2, 100).bytes.length, 0)
})

test('bunzip2 reports damaged data', () => {
  const data = runsBz2.slice()
  data[200] ^= 0xff
  assert.throws(() => bunzip2(data, 1 << 20), is(DamagedError))
  assert.throws(() => bunzip2(data.subarray(0, 100), 1 << 20), is(DamagedError))
  assert.throws(() => bunzip2(utf8('not bzip2'), 1 << 20), is(DamagedError))
})

test('unxz and unzstd unpack', () => {
  assert.equal(text(unxz(helloXz, 1024).bytes), 'hello xz\n')
  assert.equal(text(unzstd(helloZst, 1024).bytes), 'hello xz\n')
  const cut = unzstd(helloZst, 4, true)
  assert.equal(text(cut.bytes), 'hell')
  assert.equal(cut.truncated, true)
})

/** Bytes from a fixed LCG over all 256 values: data LZMA cannot shrink, so LZMA2 stores it. */
function randomBytes(length: number, seed = 99): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

/** The control bytes of the first Block's LZMA2 chunks, reduced to their kind. */
function chunkKinds(file: Uint8Array): number[] {
  const kinds: number[] = []
  let at = 12 + (file[12] + 1) * 4
  for (;;) {
    const control = file[at]
    if (control === 0) return kinds
    kinds.push(control >= 0x80 ? control & 0xe0 : control)
    if (control >= 0x80) at += 5 + (control >= 0xc0 ? 1 : 0) + file[at + 3] * 256 + file[at + 4] + 1
    else at += 3 + file[at + 1] * 256 + file[at + 2] + 1
  }
}

test('unxz reads every check, several Blocks, sizes in Block Headers and every LZMA2 chunk kind', () => {
  // Stored first, then LZMA with new properties, LZMA, stored, LZMA after a state reset.
  const mixed = concat(randomBytes(20000), noise(40000), randomBytes(20000, 7), noise(40000))
  const file = xz(mixed, { chunkSize: 20000 })
  assert.deepEqual(chunkKinds(file), [0x01, 0xc0, 0x80, 0x02, 0xa0, 0x80])
  assert.deepEqual(chunkKinds(xz(noise(50000), { chunkSize: 20000 })), [0xe0, 0x80, 0x80])
  for (const options of [
    {},
    { check: 'none' as const },
    { check: 'crc32' as const, sizes: true },
    { blockSize: 33333, chunkSize: 5000 },
    { lc: 0, lp: 4, pb: 0 },
    { lc: 4, lp: 0, pb: 4, dictSize: 4096 }
  ]) {
    assert.deepEqual(unxz(xz(mixed, options), 1 << 20).bytes, mixed)
  }
  assert.equal(unxz(xz(new Uint8Array(0)), 1024).bytes.length, 0)
})

test('unxz joins Streams and skips Stream Padding as xz -d does, and refuses what xz refuses', () => {
  const a = noise(3000)
  const b = utf8('second stream\n')
  const zeros = (n: number) => new Uint8Array(n)
  const joined = concat(xz(a), zeros(8), xz(b, { check: 'crc32' }), xz(new Uint8Array(0)), zeros(4))
  assert.deepEqual(unxz(joined, 1 << 20).bytes, concat(a, b))
  assert.throws(() => unxz(concat(xz(a), zeros(3)), 1 << 20), is(DamagedError))
  assert.throws(() => unxz(concat(xz(a), utf8('junk')), 1 << 20), is(DamagedError))
  assert.throws(() => unxz(concat(zeros(4), xz(a)), 1 << 20), is(DamagedError))
  assert.throws(() => unxz(new Uint8Array(0), 1024), is(DamagedError))
})

/** Fails unless `run` throws a DamagedError; `what` names the case. */
function assertDamaged(run: () => unknown, what: string): void {
  try {
    run()
  } catch (error) {
    if (error instanceof DamagedError) return
    throw error
  }
  assert.fail(`not reported as damaged: ${what}`)
}

test('unxz finds every cut and every changed byte', () => {
  const plain = concat(noise(700), randomBytes(300), noise(700))
  for (const check of ['crc32', 'crc64'] as const) {
    const first = xz(plain, { check, blockSize: 900, sizes: check === 'crc32' })
    const file = concat(first, xz(utf8('tail\n')))
    for (let length = 0; length < file.length; length++) {
      // Cut between the Streams, the file is the first Stream alone.
      if (length === first.length) assert.deepEqual(unxz(file.subarray(0, length), 1 << 20).bytes, plain)
      else assertDamaged(() => unxz(file.subarray(0, length), 1 << 20), `cut at ${length}`)
    }
    for (let at = 0; at < file.length; at++) {
      const changed = file.slice()
      changed[at] ^= 0x55
      assertDamaged(() => unxz(changed, 1 << 20), `byte ${at} changed`)
    }
  }
})

test('unxz refuses a match from farther back than the dictionary', () => {
  const twice = noise(10000)
  const plain = concat(twice, twice)
  assert.deepEqual(unxz(xz(plain, { dictSize: 16384 }), 1 << 20).bytes, plain)
  assert.throws(() => unxz(xz(plain, { dictSize: 4096, window: 16384 }), 1 << 20), is(DamagedError))
})

test('unxz keeps the first bytes in truncate mode, else stops at the limit', () => {
  const plain = concat(noise(50000), randomBytes(50000))
  const file = xz(plain, { blockSize: 30000 })
  for (const limit of [1, 1000, 30000, 65000, 99999]) {
    const cut = unxz(file, limit, true)
    assert.deepEqual(cut.bytes, plain.subarray(0, limit))
    assert.equal(cut.truncated, true)
    assert.throws(() => unxz(file, limit), is(TooLargeError))
  }
  assert.equal(unxz(file, plain.length, true).truncated, true)
  assert.equal(unxz(file, plain.length + 1, true).truncated, false)
})

test('unxz rejects truncated data', () => {
  assert.throws(() => unxz(helloXz.subarray(0, 30), 1024), is(DamagedError))
})

test('unxz says which valid files it cannot unpack instead of calling them damaged', () => {
  assert.equal(text(unxz(xz(utf8('hi'), { dictSize: 64 << 20 }), 1024).bytes), 'hi')
  assert.throws(() => unxz(xz(utf8('hi'), { dictSize: 96 << 20 }), 1024), unsupported('xz-dictionary'))
  assert.throws(() => unxz(base64(sha256Xz), 1024), unsupported('xz-options'))
  assert.throws(() => unxz(base64(x86Xz), 1024), unsupported('xz-options'))
})

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** A zstd frame with a window descriptor (no content size) and one raw block holding `body`. */
function zstdWindowFrame(windowDescriptor: number, body: string): Uint8Array {
  const data = utf8(body)
  const block = 1 | (data.length << 3)
  return concat(new Uint8Array([...ZSTD_MAGIC, 0, windowDescriptor, block & 0xff, (block >> 8) & 0xff, block >> 16]), data)
}

/** A single-segment zstd frame declaring `size` bytes, with one RLE block of `count` × `byte`. */
function zstdRleFrame(size: number, count: number, byte: number): Uint8Array {
  const block = 1 | (1 << 1) | (count << 3)
  return new Uint8Array([...ZSTD_MAGIC, 0x20, size, block & 0xff, (block >> 8) & 0xff, block >> 16, byte])
}

test('zstdFrames reads windows, content sizes and block bounds from the headers', () => {
  const [hello] = zstdFrames(helloZst)
  assert.equal(hello.size, 9)
  assert.equal(hello.window, 9)
  const [big] = zstdFrames(zstdWindowFrame(21 << 3, 'hello'))
  assert.equal(big.window, 2 ** 31)
  assert.equal(big.size, null)
  assert.equal(big.most, 5)
  const skippable = concat(new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 9, 9]), helloZst)
  assert.deepEqual(zstdFrames(skippable).map((frame) => frame.skippable), [true, false])
  assert.throws(() => zstdFrames(zstdWindowFrame(0, 'hello').subarray(0, 10)), is(DamagedError))
})

test('unzstd refuses a window over the cap before allocating it', () => {
  const huge = zstdWindowFrame(21 << 3, 'hello') // a 2 GiB window around five bytes
  const started = performance.now()
  assert.throws(() => unzstd(huge, 1024), unsupported('zstd-window'))
  assert.ok(performance.now() - started < 100)
  // The cap scaled down: 64 KiB is refused under a 32 KiB cap and unpacks under the real one.
  const small = zstdWindowFrame(6 << 3, 'hello')
  assert.throws(() => unzstd(small, 1024, false, 32 * 1024), unsupported('zstd-window'))
  assert.equal(text(unzstd(small, 1024).bytes), 'hello')
  assert.equal(text(unzstd(zstdWindowFrame(13 << 3, 'eight MiB window'), 1024).bytes), 'eight MiB window')
})

test('unzstd streams a frame without a content size through its sliding window', () => {
  // A 1 KiB window and no content size, as `zstd --zstd=wlog=10 --no-content-size` writes:
  // blocks of 1 KiB at most, matches reaching into earlier blocks, and over 128 KiB of output,
  // so the patched window moves back to the start of its area at least once.
  const plain = slidePlain()
  const slideZst = zstd(plain, { windowLog: 10, contentSize: false })
  const [frame] = zstdFrames(slideZst)
  assert.equal(frame.size, null)
  assert.equal(frame.window, 1024)
  const { bytes } = unzstd(slideZst, 1 << 20)
  assert.equal(bytes.length, plain.length)
  assert.equal(crc32(bytes), crc32(plain))
  const cut = unzstd(slideZst, 150000, true)
  assert.equal(crc32(cut.bytes), crc32(plain.subarray(0, 150000)))
})

test('unzstd gets through many tiny blocks in a large window quickly', () => {
  // An 8 MiB window and 20,000 blocks of one byte or none: fzstd moved the whole window after
  // every block, which took seconds here and hours for a 64 MB file with a 128 MiB window.
  const blocks = 20000
  const data = new Uint8Array(6 + blocks * 4)
  data.set([...ZSTD_MAGIC, 0, 13 << 3])
  let at = 6
  for (let i = 0; i < blocks; i++) {
    const size = i % 2
    const header = (size << 3) | (i === blocks - 1 ? 1 : 0)
    data.set([header, 0, 0], at)
    at += 3
    if (size) data[at++] = 0x41
  }
  const started = performance.now()
  const { bytes } = unzstd(data.subarray(0, at), 1 << 20)
  assert.ok(performance.now() - started < 500)
  assert.equal(text(bytes), 'A'.repeat(blocks / 2))
})

test('unzstd unpacks a frame of known size in place and checks it against its blocks', () => {
  const rle = unzstd(zstdRleFrame(100, 100, 0x78), 1024)
  assert.equal(text(rle.bytes), 'x'.repeat(100))
  assert.equal(rle.bytes.buffer.byteLength, 100)
  // A content size the blocks cannot reach is damage, not a reason to allocate.
  assert.throws(() => unzstd(zstdRleFrame(200, 100, 0x78), 1024), is(DamagedError))
  assert.throws(() => unzstd(zstdRleFrame(100, 100, 0x78), 50), is(TooLargeError))
  const cut = unzstd(zstdRleFrame(100, 100, 0x78), 50, true)
  assert.equal(cut.bytes.length, 50)
  assert.equal(cut.truncated, true)
})

test('inflate fills the declared size, or streams up to the limit', () => {
  const plain = utf8('abc'.repeat(10000))
  const packed = gzipSync(plain).subarray(10, -8)
  assert.equal(text(inflate(packed, plain.length, 1 << 20).bytes), text(plain))
  const cut = inflate(packed, plain.length, 100)
  assert.equal(cut.bytes.length, 100)
  assert.equal(cut.truncated, true)
})

test('inflate calls data longer than its declared size damaged, and stops one byte past it', () => {
  const plain = noise(200000)
  const packed = gzipSync(plain).subarray(10, -8)
  assert.throws(() => inflate(packed, 10, 1 << 20), is(DamagedError))
  // Cut in half, the data would fail at its end; refused first, it never gets there.
  const half = packed.subarray(0, packed.length >> 1)
  const lying = (error: unknown) => error instanceof DamagedError && /longer than the size/.test(error.message)
  assert.throws(() => inflate(half, 10, 1 << 20, 1024), lying)
  assert.throws(() => inflate(half, plain.length, 1 << 20, 1024), (e: unknown) => is(DamagedError)(e) && !lying(e))
  // The declared size is right: a limit below it truncates instead.
  const cut = inflate(packed, plain.length, 1000, 1024)
  assert.equal(cut.truncated, true)
  assert.equal(cut.bytes.length, 1000)
})

test('gunzip joins members, ignores zero padding and stops at the limit', () => {
  const both = concat(gzipSync(utf8('one ')), gzipSync(utf8('two')))
  assert.deepEqual(gunzip(both, 1024), { bytes: utf8('one two'), damaged: false })
  assert.deepEqual(gunzip(both, 1024, 3), { bytes: utf8('one two'), damaged: false })
  const padded = gunzip(concat(gzipSync(utf8('padded')), new Uint8Array(512)), 1024)
  assert.deepEqual(padded, { bytes: utf8('padded'), damaged: false })
  assert.throws(() => gunzip(gzipSync(new Uint8Array(5000)), 1000), is(TooLargeError))
  assert.throws(() => gunzip(utf8('nope'), 1000), is(DamagedError))
})

test('gunzip unpacks into one buffer of the recorded size, in slices that stop at the limit', () => {
  const plain = noise(100000)
  const { bytes } = gunzip(gzipSync(plain), 1 << 20, 1024)
  assert.equal(crc32(bytes), crc32(plain))
  assert.equal(bytes.buffer.byteLength, plain.length)
  // Half a bomb: the limit is hit in the first slices, long before the cut end.
  const bomb = gzipSync(new Uint8Array(4 << 20))
  assert.throws(() => gunzip(bomb.subarray(0, bomb.length >> 1), 64 * 1024, 256), is(TooLargeError))
})

test('gunzip checks CRC-32 and ISIZE and keeps what it read before damage', () => {
  const plain = utf8('hello world')
  const badCrc = gzipSync(plain)
  badCrc[badCrc.length - 8] ^= 1
  assert.deepEqual(gunzip(badCrc, 1024), { bytes: plain, damaged: true })
  const badSize = gzipSync(plain)
  badSize[badSize.length - 1] ^= 0x10
  assert.deepEqual(gunzip(badSize, 1024), { bytes: plain, damaged: true })
  // A cut download: the start comes back, marked damaged.
  const long = noise(50000)
  const packed = gzipSync(long)
  const cut = gunzip(packed.subarray(0, packed.length >> 1), 1 << 20, 1024)
  assert.equal(cut.damaged, true)
  assert.ok(cut.bytes.length > 1000 && cut.bytes.length < long.length)
  assert.equal(text(cut.bytes), text(long.subarray(0, cut.bytes.length)))
  // The trailer missing, and junk after a member.
  assert.equal(gunzip(gzipSync(plain).subarray(0, -4), 1024).damaged, true)
  assert.deepEqual(gunzip(concat(gzipSync(plain), utf8('junk')), 1024), { bytes: plain, damaged: true })
  assert.deepEqual(gunzip(concat(gzipSync(plain), new Uint8Array(3), utf8('x')), 1024), { bytes: plain, damaged: true })
  // Nothing readable at all is an error, not an empty file.
  assert.throws(() => gunzip(gzipSync(plain).subarray(0, 11), 1024), is(DamagedError))
})

test('gzipHeader reads FNAME and MTIME', () => {
  const header = gzipHeader(gzipSync(utf8('x'), { filename: 'notes.txt', mtime: 1700000000000 }))
  assert.equal(text(header.name ?? new Uint8Array(0)), 'notes.txt')
  assert.equal(header.mtime, 1700000000000)
})
