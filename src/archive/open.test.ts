import { assert, test } from 'orca/testing'
import { gzipSync } from '../../vendor/fflate/fflate.mjs'
import { DamagedError, UnsupportedDataError } from '../codecs/sink'
import { CancelledError } from '../codecs/steps'
import { concat, tar, utf8, zip } from '../fixtures/build'
import { bzip2 } from '../fixtures/bzip2'
import { xz } from '../fixtures/xz'
import { zstd } from '../fixtures/zstd'
import { detect } from './detect'
import { NotArchiveError, UnsupportedFormatError, innerName, isArchive, openArchive } from './open'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const is = (type: abstract new (...args: never[]) => unknown) => (error: unknown) => error instanceof type

test('detect recognises formats by their first bytes', () => {
  assert.equal(detect(zip([{ name: 'a' }])), 'zip')
  assert.equal(detect(tar([{ name: 'a' }])), 'tar')
  assert.equal(detect(gzipSync(utf8('x'))), 'gzip')
  assert.equal(detect(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])), '7z')
  assert.equal(detect(utf8('Rar!\x1a\x07\x01\x00')), 'rar')
  assert.equal(detect(concat(utf8('#!/bin/sh stub\n'), zip([{ name: 'a' }]))), 'zip')
  assert.equal(detect(utf8('plain text')), 'unknown')
})

test('a .tar.gz opens as its tar', async () => {
  const packed = gzipSync(tar([{ name: 'x/y.txt', data: utf8('in tgz') }]))
  const archive = await openArchive(packed, { encoding: 'cp437' })
  assert.equal(archive.format, 'TAR + GZIP')
  assert.equal(archive.kind, 'tar')
  assert.equal(archive.archiveSize, packed.length)
  assert.equal(archive.withEncoding('cp866').archiveSize, packed.length)
  assert.equal(text(archive.read(archive.entries[0], 100).bytes), 'in tgz')
})

test('a single-file .gz shows one entry named from FNAME, else from the archive name', async () => {
  const named = await openArchive(gzipSync(utf8('{"a":1}'), { filename: 'data.json' }), { encoding: 'cp437' })
  assert.equal(named.kind, 'single')
  assert.equal(named.entries[0].path, 'data.json')
  assert.equal(text(named.read(named.entries[0], 100).bytes), '{"a":1}')
  const unnamed = await openArchive(gzipSync(utf8('log')), { encoding: 'cp437', name: 'server.log.gz' })
  assert.equal(unnamed.entries[0].path, 'server.log')
  const anonymous = await openArchive(gzipSync(utf8('log')), { encoding: 'cp437' })
  assert.equal(anonymous.entries[0].path, 'file')
})

test('7z, RAR and non-archives are refused with their own errors', async () => {
  await assert.rejects(() => openArchive(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), { encoding: 'cp437' }), is(UnsupportedFormatError))
  await assert.rejects(() => openArchive(utf8('just text'), { encoding: 'cp437' }), is(NotArchiveError))
  await assert.rejects(() => openArchive(new Uint8Array(0), { encoding: 'cp437' }), is(DamagedError))
})

test('innerName strips compression suffixes', () => {
  assert.equal(innerName('notes.txt.gz', 'gzip'), 'notes.txt')
  assert.equal(innerName('src.tgz', 'gzip'), 'src.tar')
  assert.equal(innerName('dump.sql.zst', 'zstd'), 'dump.sql')
  assert.equal(innerName('a.bz2', 'bzip2'), 'a')
  assert.equal(innerName('.gz', 'gzip'), undefined)
  assert.equal(innerName(undefined, 'gzip'), undefined)
})

test('isArchive is true for archives and compressed streams only', () => {
  assert.equal(isArchive(zip([])), true)
  assert.equal(isArchive(gzipSync(utf8('x'))), true)
  assert.equal(isArchive(utf8('hello')), false)
})

test('damage found while unpacking GZIP marks the archive damaged and keeps what was read', async () => {
  const tgz = gzipSync(tar([{ name: 'a.txt', data: utf8('kept') }]))
  tgz[tgz.length - 8] ^= 1
  const archive = await openArchive(tgz, { encoding: 'cp437' })
  assert.equal(archive.format, 'TAR + GZIP')
  assert.equal(archive.damaged, true)
  assert.equal(text(archive.read(archive.entries[0], 100).bytes), 'kept')
  const gz = gzipSync(utf8('a log line\n'.repeat(50)), { filename: 'app.log' })
  const cut = await openArchive(gz.subarray(0, gz.length - 6), { encoding: 'cp437' })
  assert.equal(cut.kind, 'single')
  assert.equal(cut.damaged, true)
  assert.equal(text(cut.read(cut.entries[0], 1 << 20).bytes), 'a log line\n'.repeat(50))
  assert.equal((await openArchive(gzipSync(utf8('fine')), { encoding: 'cp437' })).damaged, false)
})

test('a valid XZ file the decoder cannot take is refused as unsupported', async () => {
  await assert.rejects(
    () => openArchive(xz(utf8('hello xz\n'), { dictSize: 1536 << 20 }), { encoding: 'cp437' }),
    (e: unknown) => e instanceof UnsupportedDataError && e.feature === 'xz-dictionary'
  )
})

test('zeros at the start are an empty tar only when nothing else follows', async () => {
  // Like an ext4 image: 1 KiB of zeros, then a superblock and data.
  const image = concat(new Uint8Array(1024), utf8('superblock'), new Uint8Array(3000).fill(7))
  assert.equal(detect(image), 'unknown')
  assert.equal(isArchive(image), false)
  for (const packed of [gzipSync(image), xz(image)]) {
    const archive = await openArchive(packed, { encoding: 'cp437', name: 'disk.img.gz' })
    assert.equal(archive.kind, 'single')
    assert.equal(archive.entries[0].size, image.length)
  }
  const empty = new Uint8Array(10240)
  assert.equal(detect(empty), 'tar')
  const archive = await openArchive(gzipSync(empty), { encoding: 'cp437' })
  assert.equal(archive.format, 'TAR + GZIP')
  assert.deepEqual(archive.entries, [])
  // An archive with zeros before a zip stays a zip.
  assert.equal(detect(concat(new Uint8Array(2048), zip([{ name: 'a' }]))), 'zip')
  // An empty tar joined with a tar (`cat empty.tar dups.tar`) is a tar, which tar lists as
  // empty; zeros and then a block that is not a tar header are still a single file.
  const joined = concat(new Uint8Array(1024), tar([{ name: 'a.txt', data: utf8('a') }]))
  assert.equal(detect(joined), 'tar')
  assert.equal(detect(concat(new Uint8Array(4096), tar([{ name: 'a.txt', data: utf8('a') }]))), 'tar')
  const listed = await openArchive(joined, { encoding: 'cp437', name: 'joined.tar' })
  assert.equal(listed.format, 'TAR')
  assert.deepEqual(listed.entries, [])
  assert.equal((await openArchive(gzipSync(joined), { encoding: 'cp437', name: 'joined.tar.gz' })).format, 'TAR + GZIP')
  assert.equal(detect(concat(new Uint8Array(1024), new Uint8Array(512).fill(0x41), new Uint8Array(512))), 'unknown')
})

/** Text that compresses like prose, not like a repeated line. */
function prose(seed: number, length: number): Uint8Array {
  const words = ['archive', 'tree', 'block', 'stream', 'entry', 'folder', 'name', 'size', 'date', 'hole']
  let text = ''
  let x = seed
  while (text.length < length) {
    x = (x * 1103515245 + 12345) >>> 0
    text += words[x % words.length] + (x & 0x100 ? '\n' : ' ')
  }
  return utf8(text.slice(0, length))
}

test('a cut-off .tar.bz2, .tar.xz and .tar.zst show the entries before the cut, marked damaged', async () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ name: `dir/file${i}.txt`, data: prose(i + 1, 10000) }))
  const plain = tar(files)
  for (const [label, packed] of [
    ['BZIP2', bzip2(plain, { level: 1 })],
    ['XZ', xz(plain)],
    ['ZSTD', zstd(plain)]
  ] as const) {
    const whole = await openArchive(packed, { encoding: 'cp437' })
    assert.equal(whole.damaged, false, label)
    assert.equal(whole.entries.length, 30, label)
    const cut = await openArchive(packed.subarray(0, Math.floor(packed.length * 0.6)), { encoding: 'cp437' })
    assert.equal(cut.format, `TAR + ${label}`)
    assert.equal(cut.damaged, true, label)
    assert.ok(cut.entries.length >= 5 && cut.entries.length < 30, `${label}: ${cut.entries.length} entries`)
    assert.deepEqual(cut.read(cut.entries[0], 1 << 20).bytes, files[0].data, label)
    // Too little to read anything is still an error.
    await assert.rejects(openArchive(packed.subarray(0, 20), { encoding: 'cp437' }), is(DamagedError))
  }
})

test('a cut-off single-file .bz2, .xz and .zst shows the part before the cut', async () => {
  const data = prose(7, 400000)
  for (const packed of [bzip2(data, { level: 1 }), xz(data), zstd(data)]) {
    const archive = await openArchive(packed.subarray(0, Math.floor(packed.length * 0.7)), { encoding: 'cp437', name: 'notes.txt.bz2' })
    assert.equal(archive.kind, 'single')
    assert.equal(archive.damaged, true)
    const { bytes } = archive.read(archive.entries[0], 1 << 20)
    assert.ok(bytes.length > 0 && bytes.length < data.length, `${bytes.length} bytes`)
    assert.deepEqual(bytes, data.subarray(0, bytes.length))
  }
})

test('with pacing, a compressed archive unpacks in steps, and a cancelled one stops', async () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.bin`, data: new Uint8Array(30000).map((_, k) => (k * (i + 7)) ^ (k >> 3)) }))
  const packed = bzip2(tar(files), { level: 1 })
  const plain = await openArchive(packed, { encoding: 'cp437' })
  let checks = 0
  const paced = await openArchive(packed, { encoding: 'cp437', pacing: { cancelled: () => (checks++, false), every: 0 } })
  assert.ok(checks >= 5, `${checks} pauses`)
  assert.deepEqual(paced.entries.map((e) => [e.path, e.size]), plain.entries.map((e) => [e.path, e.size]))
  assert.deepEqual(paced.read(paced.entries[39], 1 << 20).bytes, files[39].data)
  await assert.rejects(
    openArchive(packed, { encoding: 'cp437', pacing: { cancelled: () => true, every: 0 } }),
    (e: unknown) => e instanceof CancelledError
  )
})
