import { assert, test } from 'orca/testing'
import { zip } from './fixtures/build'
import { classify, decodeText, hexDump, imageType, nameKind } from './content'

const bytes = (...values: number[]) => new Uint8Array(values)

test('imageType sniffs bytes and only trusts the name for SVG, BMP and ICO', () => {
  assert.equal(imageType('x.dat', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)), 'image/png')
  assert.equal(imageType('photo', bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
  assert.equal(imageType('a.svg', new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml')
  assert.equal(imageType('a.txt', new TextEncoder().encode('<svg/>')), null)
  assert.equal(imageType('a.bmp', bytes(0x42, 0x4d, 0, 0)), 'image/bmp')
  assert.equal(imageType('a.txt', bytes(0x42, 0x4d, 0, 0)), null)
})

test('decodeText: BOMs, UTF-8, a legacy fallback, and binary', () => {
  assert.equal(decodeText(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69), false, 'windows-1252')?.text, 'hi')
  assert.equal(decodeText(bytes(0xff, 0xfe, 0x68, 0, 0x69, 0), false, 'windows-1252')?.encoding, 'UTF-16 LE')
  assert.equal(decodeText(new TextEncoder().encode('привет'), false, 'windows-1251')?.encoding, 'UTF-8')
  assert.equal(decodeText(bytes(0xef, 0xf0, 0xe8), false, 'windows-1251')?.text, 'при')
  assert.equal(decodeText(bytes(0x68, 0, 0x69), false, 'windows-1252'), null)
  assert.equal(decodeText(bytes(1, 2, 3, 4, 5, 6, 7, 8), false, 'windows-1252'), null)
})

test('decodeText tolerates a character cut at the preview limit', () => {
  const full = new TextEncoder().encode('ab€')
  assert.equal(decodeText(full.subarray(0, 4), true, 'windows-1252')?.text, 'ab')
})

test('classify spots nested archives', () => {
  assert.equal(classify('inner.zip', zip([]), false, 'windows-1252').kind, 'archive')
  assert.equal(classify('a.txt', new TextEncoder().encode('text'), false, 'windows-1252').kind, 'text')
  assert.equal(classify('a.bin', bytes(0, 1, 2), false, 'windows-1252').kind, 'binary')
  // A disk image starts with zeros, then its data: binary, not an empty tar.
  const image = new Uint8Array(4096)
  image[1080] = 0x53
  assert.equal(classify('rootfs.ext4', image, false, 'windows-1252').kind, 'binary')
})

test('hexDump writes offset, hex and ASCII columns', () => {
  const dump = hexDump(new TextEncoder().encode('Hello, archive!!\n'))
  assert.equal(
    dump.split('\n')[0],
    '00000000  48 65 6c 6c 6f 2c 20 61  72 63 68 69 76 65 21 21  Hello, archive!!'
  )
  assert.equal(dump.split('\n')[1], '00000010  0a                                                .')
})

test('nameKind picks the tree icon from the name', () => {
  assert.equal(nameKind('lib.JAR'), 'archive')
  assert.equal(nameKind('backup.tar.zst'), 'archive')
  assert.equal(nameKind('logo.svg'), 'image')
  assert.equal(nameKind('README'), 'text')
  assert.equal(nameKind('.gitignore'), 'text')
  assert.equal(nameKind('MANIFEST.MF'), 'text')
  assert.equal(nameKind('app.exe'), 'file')
})

test('7-Zip, RAR, lzip, compress and Cabinet files inside an archive are classed as unsupported archives', () => {
  const cases: [string, number[], string][] = [
    ['backup.7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4], '7-Zip'],
    ['old.rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 1, 0], 'RAR'],
    ['logs.tar.lz', [0x4c, 0x5a, 0x49, 0x50, 1, 0x0c], 'lzip'],
    ['README.md.Z', [0x1f, 0x9d, 0x90, 0x23], 'compress (.Z)'],
    // CFHEADER: reserved, cbCabinet 64, reserved, coffFiles 44, reserved, version 1.3, 1 folder, 1 file
    ['setup.cab', [0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 3, 1, 1, 0, 1, 0], 'Cabinet (.cab)']
  ]
  for (const [name, start, format] of cases) {
    const bytes = new Uint8Array(64)
    bytes.set(start)
    assert.deepEqual(classify(name, bytes, false, 'windows-1252'), { kind: 'unsupported', format }, name)
    // By its bytes, not its name.
    assert.deepEqual(classify('renamed.bin', bytes, false, 'windows-1252'), { kind: 'unsupported', format }, name)
  }
  assert.deepEqual(classify('notes.txt', new TextEncoder().encode('plain text'), false, 'windows-1252').kind, 'text')
})

test('text that starts with "LZIP" or "MSCF" is text, not an unsupported archive', () => {
  const texts = [
    'LZIP files start with the four letters LZIP and a version byte.\n',
    'LZIP_OPTS=-9\nexport LZIP_OPTS\n',
    'MSCF is the signature of a Microsoft Cabinet file.\n',
    'MSCFLAGS = -O2 -Wall\nall: build\n',
    'LZIP',
    'MSCF'
  ]
  for (const content of texts) {
    const bytes = new TextEncoder().encode(content)
    const kind = classify('notes.txt', bytes, false, 'windows-1252')
    assert.equal(kind.kind, 'text', content)
    assert.equal(kind.kind === 'text' && kind.decoded.text, content)
  }
  // Almost a header: an lzip version other than 1 or a dictionary size out of range, and a
  // Cabinet header with a reserved field set or another format version.
  const near: number[][] = [
    [0x4c, 0x5a, 0x49, 0x50, 0, 0x0c],
    [0x4c, 0x5a, 0x49, 0x50, 1, 0x0b],
    [0x4c, 0x5a, 0x49, 0x50, 1, 0x1e],
    [0x4c, 0x5a, 0x49, 0x50, 1, 0x2c],
    [0x4d, 0x53, 0x43, 0x46, 1, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 3, 1],
    [0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 3, 2]
  ]
  for (const start of near) {
    const bytes = new Uint8Array(64)
    bytes.set(start)
    assert.equal(classify('x.bin', bytes, false, 'windows-1252').kind, 'binary', start.join(','))
  }
  // A dictionary of 2^13 less 7/16 and the largest, 2^29, are valid.
  for (const ds of [0xed, 0x1d]) {
    const bytes = new Uint8Array(64)
    bytes.set([0x4c, 0x5a, 0x49, 0x50, 1, ds])
    assert.equal(classify('x.lz', bytes, false, 'windows-1252').kind, 'unsupported', ds.toString(16))
  }
})
