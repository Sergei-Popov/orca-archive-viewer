import { assert, test } from 'orca/testing'
import { concat, pax, tar, tarHeader, utf8 } from '../fixtures/build'
import { base64, smallTarBz2, smallTarXz, smallTarZst } from '../fixtures/samples'
import { EntryError } from './model'
import { openArchive } from './open'
import { parsePax, parseTar } from './tar'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('ustar names with a prefix, modes, dates, folders and data', () => {
  const archive = parseTar(
    tar([
      { name: 'pkg/', type: '5', mode: 0o755 },
      { name: 'file.txt', prefix: 'pkg/deep', data: utf8('payload'), mtime: 1700000000 }
    ]),
    'cp437'
  )
  assert.equal(archive.format, 'TAR')
  assert.deepEqual(archive.entries.map((e) => e.path), ['pkg', 'pkg/deep/file.txt'])
  const file = archive.entries[1]
  assert.equal(file.mode, 0o100644)
  assert.equal(file.mtime, 1700000000000)
  assert.equal(text(archive.read(file, 100).bytes), 'payload')
  assert.equal(archive.entries[0].mode, 0o040755)
})

test('GNU long names, PAX paths and sizes, base-256 sizes, V7 headers', () => {
  const long = 'a/'.repeat(80) + 'end.txt'
  const archive = parseTar(
    tar([
      { name: '././@LongLink', type: 'L', data: utf8(long + '\0') },
      { name: 'truncated', data: utf8('long') },
      pax({ path: 'unicode/файл.txt', mtime: '1700000000.5' }),
      { name: 'ignored', data: utf8('pax') },
      { name: 'b256.bin', data: utf8('b256'), base256: true },
      { name: 'old.txt', data: utf8('v7'), v7: true }
    ]),
    'cp437'
  )
  assert.deepEqual(archive.entries.map((e) => e.path), [long, 'unicode/файл.txt', 'b256.bin', 'old.txt'])
  assert.equal(archive.entries[1].mtime, 1700000000500)
  assert.equal(text(archive.read(archive.entries[2], 100).bytes), 'b256')
  assert.equal(text(archive.read(archive.entries[3], 100).bytes), 'v7')
})

test('symbolic and hard links', () => {
  const archive = parseTar(
    tar([
      { name: 'real.txt', data: utf8('target data') },
      { name: 'soft', type: '2', link: 'real.txt' },
      { name: 'hard', type: '1', link: 'real.txt' },
      { name: 'dangling', type: '1', link: 'nowhere' }
    ]),
    'cp437'
  )
  assert.deepEqual(archive.entries[1].link, { target: 'real.txt', hard: false })
  assert.equal(archive.entries[1].mode! & 0o170000, 0o120000)
  assert.equal(text(archive.read(archive.entries[2], 100).bytes), 'target data')
  assert.throws(() => archive.read(archive.entries[3], 100), (e: unknown) => e instanceof EntryError && e.code === 'missing')
})

test('a bad checksum after good entries marks the archive damaged and keeps them', () => {
  const archive = parseTar(
    tar([{ name: 'ok.txt', data: utf8('ok') }, { name: 'bad.txt', data: utf8('bad'), badChecksum: true }]),
    'cp437'
  )
  assert.equal(archive.damaged, true)
  assert.deepEqual(archive.entries.map((e) => e.path), ['ok.txt'])
})

test('legacy names re-decode', () => {
  const name = new Uint8Array([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0x2e, 0x74, 0x78, 0x74]) // "Привет.txt" in CP866
  const archive = parseTar(tar([{ name, data: utf8('x') }]), 'cp866')
  assert.equal(archive.entries[0].path, 'Привет.txt')
  assert.equal(archive.legacyNames, true)
  assert.notEqual(archive.withEncoding('windows-1251').entries[0].path, 'Привет.txt')
})

test('parsePax reads length-prefixed records', () => {
  assert.deepEqual(parsePax(utf8('18 path=a/b/c.txt\n11 size=42\n')), { path: 'a/b/c.txt', size: '42' })
})

test('tar inside bzip2, xz and zstd', async () => {
  for (const [sample, format] of [
    [smallTarBz2, 'TAR + BZIP2'],
    [smallTarXz, 'TAR + XZ'],
    [smallTarZst, 'TAR + ZSTD']
  ]) {
    const archive = await openArchive(base64(sample), { encoding: 'cp437' })
    assert.equal(archive.format, format)
    assert.deepEqual(archive.entries.map((e) => e.path), ['docs', 'docs/readme.txt'])
    assert.equal(text(archive.read(archive.entries[1], 100).bytes), 'hello from tar\n')
  }
})

test('a PAX size that is not a plain number falls back to the header size and marks damage', () => {
  for (const size of ['abc', '', '1e3', '-5', ' 3']) {
    const archive = parseTar(
      tar([pax({ size }), { name: 'a.txt', data: utf8('aaa') }, { name: 'b.txt', data: utf8('bbb') }]),
      'cp437'
    )
    assert.equal(archive.damaged, true, `size=${JSON.stringify(size)}`)
    assert.deepEqual(archive.entries.map((e) => [e.path, e.size]), [['a.txt', 3], ['b.txt', 3]])
    assert.equal(text(archive.read(archive.entries[1], 100).bytes), 'bbb')
  }
  const good = parseTar(tar([pax({ size: '3' }), { name: 'a.txt', data: utf8('aaa') }]), 'cp437')
  assert.equal(good.damaged, false)
})

test('a tar cut inside a header or inside data is damaged; one without end blocks is not', () => {
  const first = tar([{ name: 'a.txt', data: utf8('aaa') }], { end: false })
  const midHeader = parseTar(concat(first, tarHeader({ name: 'b.txt' }, 10).subarray(0, 100)), 'cp437')
  assert.equal(midHeader.damaged, true)
  assert.deepEqual(midHeader.entries.map((e) => e.path), ['a.txt'])
  const midData = parseTar(concat(first, tarHeader({ name: 'b.txt' }, 1000), utf8('only this')), 'cp437')
  assert.equal(midData.damaged, true)
  assert.equal(parseTar(first, 'cp437').damaged, false)
  assert.equal(parseTar(concat(tar([{ name: 'a.txt', data: utf8('aaa') }]), utf8('after the end')), 'cp437').damaged, false)
})
