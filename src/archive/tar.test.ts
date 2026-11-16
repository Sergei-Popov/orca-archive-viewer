import { assert, test } from 'orca/testing'
import { base256, concat, pax, tar, tarHeader, utf8 } from '../fixtures/build'
import { bzip2 } from '../fixtures/bzip2'
import { xz } from '../fixtures/xz'
import { zstd } from '../fixtures/zstd'
import { EntryError } from './model'
import { openArchive } from './open'
import { parsePax, parseTar, tarNumber } from './tar'

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

test('parsePax reads length-prefixed records in order, up to a NUL', () => {
  assert.deepEqual(parsePax(utf8('18 path=a/b/c.txt\n11 size=42\n6 k=v\n5 e=\n\0\0\0')), {
    records: [['path', 'a/b/c.txt'], ['size', '42'], ['k', 'v'], ['e', '']],
    damaged: false
  })
})

test('parsePax stops at a length with a leading zero, too many digits or too small, and marks damage', () => {
  const good = '11 size=42\n'
  for (const bad of ['011 size=42\n', '0'.repeat(30) + '11 size=42\n', '3 k=v\n', '4 k=\n', ' 11 size=42\n', '11 size=42 ', '11 size 42\n', '11size=42\n\n', '99 k=v\n']) {
    assert.deepEqual(parsePax(utf8(good + bad + good)), { records: [['size', '42']], damaged: true }, JSON.stringify(bad))
  }
  assert.deepEqual(parsePax(utf8('1'.repeat(21) + ' k=v\n')), { records: [], damaged: true })
  // A zero-padded length used to make each record rescan the padding: 288 B froze a tab for 20 s.
  const started = Date.now()
  const archive = parseTar(
    tar([{ name: 'PaxHeader', type: 'x', data: utf8('0'.repeat(1 << 20) + '1 x') }, { name: 'a.txt', data: utf8('after') }]),
    'cp437'
  )
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
  assert.equal(archive.damaged, true)
  assert.deepEqual(archive.entries.map((e) => e.path), ['a.txt'])
  // The same for a global header.
  const global = parseTar(tar([{ name: 'g', type: 'g', data: utf8('0'.repeat(1 << 20) + '1 x') }, { name: 'b.txt' }]), 'cp437')
  assert.equal(global.damaged, true)
  assert.deepEqual(global.entries.map((e) => e.path), ['b.txt'])
})

test('a PAX record named __proto__ is a record, not a prototype', () => {
  const archive = parseTar(tar([pax([['__proto__', 'x'], ['path', 'real.txt']]), { name: 'fake', data: utf8('x') }]), 'cp437')
  assert.deepEqual(archive.entries.map((e) => e.path), ['real.txt'])
})

test('tar inside bzip2, xz and zstd', async () => {
  const small = tar([
    { name: 'docs/', type: '5', mode: 0o755 },
    pax({ mtime: '1700000000.25' }),
    { name: 'docs/readme.txt', data: utf8('hello from tar\n') }
  ])
  for (const [data, format] of [
    [bzip2(small), 'TAR + BZIP2'],
    [xz(small), 'TAR + XZ'],
    [zstd(small), 'TAR + ZSTD']
  ] as const) {
    const archive = await openArchive(data, { encoding: 'cp437' })
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

test('base-256 numbers are signed: GNU tar writes pre-1970 times with a 0xff lead', () => {
  assert.equal(tarNumber(base256(-100000000, 12), 0, 12), -100000000)
  assert.equal(tarNumber(base256(-1, 12), 0, 12), -1)
  assert.equal(tarNumber(base256(2 ** 40 + 5, 12), 0, 12), 2 ** 40 + 5)
  const archive = parseTar(
    tar([
      { name: 'old.txt', data: utf8('1966'), mtime: -100000000 },
      // Past what a Date holds, either way: no date rather than "Invalid Date".
      { name: 'far.txt', data: utf8('far'), mtime: -(2 ** 52) },
      { name: 'future.txt', data: utf8('far'), mtime: 2 ** 52 },
      pax({ mtime: '-100000000.5' }),
      { name: 'pax.txt', data: utf8('pax') }
    ]),
    'cp437'
  )
  assert.deepEqual(
    archive.entries.map((e) => [e.path, e.mtime]),
    [['old.txt', -100000000000], ['far.txt', undefined], ['future.txt', undefined], ['pax.txt', -100000000500]]
  )
  assert.equal(new Date(archive.entries[0].mtime!).toISOString(), '1966-10-31T14:13:20.000Z')
})

test('an mtime of 0 is 1970-01-01; only an empty field means no date', () => {
  const empty = new Uint8Array(12)
  assert.equal(tarNumber(empty, 0, 12), null)
  assert.equal(tarNumber(utf8('           \0'), 0, 12), null)
  assert.equal(tarNumber(utf8('00000000000\0'), 0, 12), 0)
  const archive = parseTar(
    tar([
      { name: 'zero.txt', data: utf8('0'), mtime: 0 },
      { name: 'none.txt', data: utf8('-'), mtime: null },
      pax({ mtime: '0' }),
      { name: 'pax-zero.txt', data: utf8('0') }
    ]),
    'cp437'
  )
  assert.deepEqual(archive.entries.map((e) => [e.path, e.mtime]), [['zero.txt', 0], ['none.txt', undefined], ['pax-zero.txt', 0]])
})

test('a hard link reads the last entry at its target path before the link, on each hop', () => {
  const archive = parseTar(
    tar([
      { name: 'f.txt', data: utf8('v1\n') },
      { name: 'h', type: '1', link: 'f.txt' },
      { name: 'f.txt', data: utf8('version two\n') },
      { name: 'h2', type: '1', link: 'h' },
      { name: 'h', type: '1', link: 'f.txt' },
      { name: 'h3', type: '1', link: 'h' },
      { name: 'ahead', type: '1', link: 'later.txt' },
      { name: 'later.txt', data: utf8('later') }
    ]),
    'cp437'
  )
  const read = (index: number) => text(archive.read(archive.entries[index], 100).bytes)
  assert.equal(read(1), 'v1\n')
  assert.equal(read(2), 'version two\n')
  assert.equal(read(3), 'v1\n') // h2 → the first h → the first f.txt
  assert.equal(read(5), 'version two\n') // h3 → the second h → the second f.txt
  // tar and Python's tarfile cannot link to a file that only comes later either.
  assert.throws(() => archive.read(archive.entries[6], 100), (e: unknown) => e instanceof EntryError && e.code === 'missing')
})
