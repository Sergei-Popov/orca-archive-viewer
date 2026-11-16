import { assert, test } from 'orca/testing'
import { gzipSync } from '../../vendor/fflate/fflate.mjs'
import { DamagedError, UnsupportedDataError } from '../codecs/sink'
import { concat, tar, utf8, zip } from '../fixtures/build'
import { xz } from '../fixtures/xz'
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
