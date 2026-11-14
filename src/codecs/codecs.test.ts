import { assert, test } from 'orca/testing'
import { gzipSync } from '../../vendor/fflate/fflate.mjs'
import { concat, utf8 } from '../fixtures/build'
import { base64, helloXz, helloZst, multiBz2, runsBz2, runsCrc32, runsLength } from '../fixtures/samples'
import { bunzip2 } from './bzip2'
import { crc32 } from './crc32'
import { gunzip, gzipHeader, inflate } from './deflate'
import { DamagedError, TooLargeError } from './sink'
import { unxz } from './xz'
import { unzstd } from './zstd'

const is = (type: abstract new (...args: never[]) => unknown) => (error: unknown) => error instanceof type
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('crc32 matches the check value', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('bunzip2 undoes both run-length steps and checks block CRCs', () => {
  const { bytes, truncated } = bunzip2(base64(runsBz2), 1 << 20)
  assert.equal(truncated, false)
  assert.equal(bytes.length, runsLength)
  assert.equal(crc32(bytes), runsCrc32)
})

test('bunzip2 joins concatenated streams', () => {
  const { bytes } = bunzip2(base64(multiBz2), 1 << 20)
  assert.equal(bytes.length, runsLength + 'second stream\n'.length)
  assert.equal(text(bytes.subarray(runsLength)), 'second stream\n')
})

test('bunzip2 stops at the limit in truncate mode and throws otherwise', () => {
  const cut = bunzip2(base64(runsBz2), 1500, true)
  assert.equal(cut.bytes.length, 1500)
  assert.equal(cut.truncated, true)
  assert.equal(text(cut.bytes.subarray(0, 1000)), 'a'.repeat(1000))
  assert.throws(() => bunzip2(base64(runsBz2), 1500), is(TooLargeError))
})

test('bunzip2 reports damaged data', () => {
  const data = base64(runsBz2)
  data[200] ^= 0xff
  assert.throws(() => bunzip2(data, 1 << 20), is(DamagedError))
  assert.throws(() => bunzip2(data.subarray(0, 100), 1 << 20), is(DamagedError))
  assert.throws(() => bunzip2(utf8('not bzip2'), 1 << 20), is(DamagedError))
})

test('unxz and unzstd unpack', async () => {
  assert.equal(text((await unxz(base64(helloXz), 1024)).bytes), 'hello xz\n')
  assert.equal(text(unzstd(base64(helloZst), 1024).bytes), 'hello xz\n')
  const cut = unzstd(base64(helloZst), 4, true)
  assert.equal(text(cut.bytes), 'hell')
  assert.equal(cut.truncated, true)
})

test('unxz rejects truncated data', async () => {
  const data = base64(helloXz)
  await assert.rejects(() => unxz(data.subarray(0, 30), 1024), is(DamagedError))
})

test('inflate fills the declared size, or streams up to the limit', () => {
  const plain = utf8('abc'.repeat(10000))
  const packed = gzipSync(plain).subarray(10, -8)
  assert.equal(text(inflate(packed, plain.length, 1 << 20).bytes), text(plain))
  const cut = inflate(packed, plain.length, 100)
  assert.equal(cut.bytes.length, 100)
  assert.equal(cut.truncated, true)
  // A size field that lies low still stops at the limit.
  const lying = inflate(packed, 10, 1 << 20)
  assert.equal(lying.bytes.length, 10)
})

test('gunzip joins members, ignores zero padding and stops at the limit', () => {
  const both = concat(gzipSync(utf8('one ')), gzipSync(utf8('two')))
  assert.equal(text(gunzip(both, 1024)), 'one two')
  assert.equal(text(gunzip(concat(gzipSync(utf8('padded')), new Uint8Array(512)), 1024)), 'padded')
  assert.throws(() => gunzip(gzipSync(new Uint8Array(5000)), 1000), is(TooLargeError))
  assert.throws(() => gunzip(utf8('nope'), 1000), is(DamagedError))
})

test('gzipHeader reads FNAME and MTIME', () => {
  const header = gzipHeader(gzipSync(utf8('x'), { filename: 'notes.txt', mtime: 1700000000000 }))
  assert.equal(text(header.name ?? new Uint8Array(0)), 'notes.txt')
  assert.equal(header.mtime, 1700000000000)
})
