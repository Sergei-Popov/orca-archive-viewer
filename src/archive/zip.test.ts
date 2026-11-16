import { assert, test } from 'orca/testing'
import { concat, utf8, zip } from '../fixtures/build'
import { DamagedError } from '../codecs/sink'
import { EntryError } from './model'
import { decodeLegacy } from './names'
import { dosTime, parseZip } from './zip'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const cp866 = (s: string) => Uint8Array.from(s, (c) => {
  const code = c.charCodeAt(0)
  if (code < 0x80) return code
  if (code >= 0x410 && code <= 0x43f) return 0x80 + (code - 0x410)
  if (code >= 0x440 && code <= 0x44f) return 0xe0 + (code - 0x440)
  throw new Error(`no cp866 for ${c}`)
})

test('lists stored and deflated entries and reads them with a CRC check', () => {
  const archive = parseZip(
    zip([
      { name: 'src/', host: 3, external: (0o040755 << 16) >>> 0 },
      { name: 'src/a.txt', data: utf8('hello'), method: 8 },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }
    ], { comment: 'build 42' }),
    'cp437'
  )
  assert.equal(archive.format, 'ZIP')
  assert.equal(archive.comment, 'build 42')
  assert.deepEqual(archive.entries.map((e) => [e.path, e.dir]), [['src', true], ['src/a.txt', false], ['b.bin', false]])
  const a = archive.entries[1]
  assert.equal(a.method, 'Deflate')
  assert.equal(a.size, 5)
  assert.equal(a.mode, 0o100644)
  const read = archive.read(a, 1024)
  assert.equal(text(read.bytes), 'hello')
  assert.equal(read.crcOk, true)
  assert.throws(() => archive.read(archive.entries[0], 10), (e: unknown) => e instanceof EntryError)
})

test('a wrong CRC is reported, a short limit truncates', () => {
  const archive = parseZip(zip([{ name: 'x.txt', data: utf8('0123456789'), crc: 1 }]), 'cp437')
  assert.equal(archive.read(archive.entries[0], 100).crcOk, false)
  const cut = archive.read(archive.entries[0], 4)
  assert.equal(text(cut.bytes), '0123')
  assert.equal(cut.truncated, true)
})

test('names: UTF-8 flag, valid UTF-8, and legacy code pages with re-decoding', () => {
  const archive = parseZip(
    zip([
      { name: 'привет.txt', flags: 0x800 },
      { name: utf8('ünïcode.txt') },
      { name: cp866('Отчёт'.replace('ё', 'е') + '.doc'), host: 0 }
    ]),
    'cp866'
  )
  assert.equal(archive.entries[0].path, 'привет.txt')
  assert.equal(archive.entries[1].path, 'ünïcode.txt')
  assert.equal(archive.entries[2].path, 'Отчет.doc')
  assert.equal(archive.legacyNames, true)
  const western = archive.withEncoding('cp437')
  assert.equal(western.entries[2].path, decodeLegacy(cp866('Отчет.doc'), 'cp437'))
  assert.equal(western.entries[2].legacy, true)
  assert.equal(western.entries[0].legacy, false)
})

test('a UTF-8 flag on bytes that are not UTF-8 falls back to the code page', () => {
  const archive = parseZip(zip([{ name: cp866('Фото/Дача.png'), flags: 0x800 }]), 'cp866')
  assert.equal(archive.entries[0].path, 'Фото/Дача.png')
  assert.equal(archive.legacyNames, true)
})

test('Info-ZIP Unicode Path extra overrides a legacy name', () => {
  const raw = cp866('Файл.txt'.replace('й', 'и'))
  const unicode = utf8('Файл.txt')
  const extra = new Uint8Array(4 + 5 + unicode.length)
  const view = new DataView(extra.buffer)
  view.setUint16(0, 0x7075, true)
  view.setUint16(2, 5 + unicode.length, true)
  extra[4] = 1
  // CRC-32 of the raw name, little-endian.
  let c = 0xffffffff
  for (const b of raw) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  view.setUint32(5, (c ^ 0xffffffff) >>> 0, true)
  extra.set(unicode, 9)
  const archive = parseZip(zip([{ name: raw, extra }]), 'cp437')
  assert.equal(archive.entries[0].path, 'Файл.txt')
  assert.equal(archive.legacyNames, false)
})

test('ZIP64 fields and records, and a self-extractor prefix', () => {
  const archive = parseZip(
    zip([{ name: 'big.txt', data: utf8('zip64 data'), zip64: true }], {
      prefix: utf8('MZ fake stub '.repeat(10)),
      zip64End: true
    }),
    'cp437'
  )
  assert.equal(archive.entries.length, 1)
  assert.equal(archive.entries[0].size, 10)
  assert.equal(text(archive.read(archive.entries[0], 100).bytes), 'zip64 data')
})

test('DOS paths use backslashes; Unix symlinks show their target', () => {
  const archive = parseZip(
    zip([
      { name: 'dir\\file.txt', host: 0, data: utf8('x') },
      { name: 'link', host: 3, external: (0o120777 << 16) >>> 0, data: utf8('dir/file.txt') }
    ]),
    'cp437'
  )
  assert.equal(archive.entries[0].path, 'dir/file.txt')
  assert.deepEqual(archive.entries[1].link, { target: 'dir/file.txt', hard: false })
})

test('encrypted and unsupported entries throw EntryError codes', () => {
  const archive = parseZip(
    zip([
      { name: 'secret.txt', data: utf8('x'), flags: 1 },
      { name: 'lzma.bin', data: utf8('x'), method: 14 }
    ]),
    'cp437'
  )
  assert.equal(archive.entries[0].encrypted, true)
  assert.throws(() => archive.read(archive.entries[0], 10), (e: unknown) => e instanceof EntryError && e.code === 'encrypted')
  assert.throws(() => archive.read(archive.entries[1], 10), (e: unknown) => e instanceof EntryError && e.code === 'method' && e.detail === 'LZMA')
})

test('an empty ZIP, and one whose central directory is damaged', () => {
  assert.equal(parseZip(zip([]), 'cp437').entries.length, 0)
  const whole = zip([{ name: 'a.txt', data: utf8('aaaa') }, { name: 'b.txt', data: utf8('bbbb') }])
  const centrals: number[] = []
  for (let i = 0; i + 4 <= whole.length; i++) {
    if (whole[i] === 0x50 && whole[i + 1] === 0x4b && whole[i + 2] === 1 && whole[i + 3] === 2) centrals.push(i)
  }
  assert.equal(centrals.length, 2)
  whole[centrals[1] + 2] = 9
  const archive = parseZip(whole, 'cp437')
  assert.equal(archive.damaged, true)
  assert.deepEqual(archive.entries.map((e) => e.path), ['a.txt'])
})

test('dosTime reads local date and time', () => {
  const ms = dosTime((44 << 9) | (11 << 5) | 14, (13 << 11) | (45 << 5) | 15)
  const d = new Date(ms ?? 0)
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2024, 11, 14, 13, 45, 30])
  assert.equal(dosTime(0, 0), undefined)
})

test('a Deflate entry longer than its declared size is damaged', () => {
  const archive = parseZip(zip([{ name: 'bomb.txt', data: utf8('abc'.repeat(10000)), method: 8, size: 10 }]), 'cp437')
  assert.equal(archive.entries[0].size, 10)
  assert.throws(() => archive.read(archive.entries[0], 1 << 20), (e: unknown) => e instanceof EntryError && e.code === 'damaged')
})

test('a Zstandard entry with a window too large to unpack is unsupported, not damaged', () => {
  // Frame header with a 2 GiB window, then one raw block holding "hi".
  const frame = concat(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 21 << 3, 1 | (2 << 3), 0, 0]), utf8('hi'))
  const archive = parseZip(zip([{ name: 'big-window.bin', data: frame, method: 93, size: 2 }]), 'cp437')
  assert.throws(
    () => archive.read(archive.entries[0], 1024),
    (e: unknown) => e instanceof EntryError && e.code === 'unsupported' && e.detail === 'zstd-window'
  )
})

test('a ZIP cut off before its end record is read from its local headers, marked damaged', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    name: `dir/file${i}.txt`,
    data: utf8(`line ${i}\n`.repeat(200 + i)),
    method: 8 as const,
    descriptor: i % 3 === 0 ? ('signed' as const) : i % 3 === 1 ? undefined : ('bare' as const)
  }))
  const whole = zip(items)
  for (const cut of [Math.floor(whole.length / 2), Math.floor(whole.length * 0.2)]) {
    const archive = parseZip(whole.subarray(0, cut), 'cp437')
    assert.equal(archive.damaged, true)
    const n = archive.entries.length
    assert.ok(n > 3 && n < 50, `${n} entries at ${cut}`)
    assert.deepEqual(archive.entries.map((e) => e.path), items.slice(0, n).map((item) => item.name))
    // The last listed entry can be the one cut through: listed, and damaged when read.
    for (const entry of archive.entries.slice(0, n - 1)) {
      const read = archive.read(entry, 1 << 20)
      assert.equal(read.crcOk, true, entry.path)
      assert.deepEqual(read.bytes, items[entry.index].data, entry.path)
      assert.equal(entry.size, items[entry.index].data.length, entry.path)
    }
  }
})

test('a ZIP cut inside its central directory uses the records it has, and one cut in a header is refused', () => {
  const whole = zip([
    { name: 'a.txt', data: utf8('aaaa') },
    { name: 'link', data: utf8('a.txt'), external: (0o120777 << 16) >>> 0 },
    { name: 'b.txt', data: utf8('bbbb'), descriptor: 'signed' }
  ])
  // Cut the end record off, then also the last central record: the local scan reaches the
  // central directory and takes the records it still has.
  for (const cut of [10, 22 + 20]) {
    const archive = parseZip(whole.subarray(0, whole.length - cut), 'cp437')
    assert.equal(archive.damaged, true)
    assert.deepEqual(archive.entries.map((e) => e.path), ['a.txt', 'link', 'b.txt'])
    assert.deepEqual(archive.entries[1].link, { target: 'a.txt', hard: false })
    assert.equal(text(archive.read(archive.entries[2], 100).bytes), 'bbbb')
    assert.equal(archive.read(archive.entries[2], 100).crcOk, true)
  }
  // A local header cut before its name ends lists nothing, so it is an error.
  assert.throws(() => parseZip(whole.subarray(0, 32), 'cp437'), (e: unknown) => e instanceof DamagedError)
  // An entry cut through its data with the size in its header is listed and damaged when read.
  const big = zip([{ name: 'big.bin', data: new Uint8Array(5000).fill(7) }])
  const cut = parseZip(big.subarray(0, 2000), 'cp437')
  assert.deepEqual(cut.entries.map((e) => [e.path, e.size]), [['big.bin', 5000]])
  assert.throws(() => cut.read(cut.entries[0], 1 << 20), (e: unknown) => e instanceof EntryError && e.code === 'damaged')
})
