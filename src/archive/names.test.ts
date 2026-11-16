import { assert, test } from 'orca/testing'
import { pax, tar, utf8, zip } from '../fixtures/build'
import { MAX_PATH_LENGTH, MAX_PATH_SEGMENTS, normalizePath } from './names'
import { parseTar } from './tar'
import { parseZip } from './zip'

test('normalizePath tidies separators and cuts paths past 1,024 segments or 4,096 characters', () => {
  assert.deepEqual(normalizePath('./a//b/./c/', false), { path: 'a/b/c', cut: false })
  assert.deepEqual(normalizePath('\\a\\b', true), { path: 'a/b', cut: false })
  assert.deepEqual(normalizePath('a\\b', false), { path: 'a\\b', cut: false })
  const deep = normalizePath('a/'.repeat(70000) + 'f.txt', false)
  assert.deepEqual([deep.path.split('/').length, deep.cut], [MAX_PATH_SEGMENTS, true])
  assert.equal(normalizePath('a/'.repeat(MAX_PATH_SEGMENTS - 1) + 'f', false).cut, false)
  const long = normalizePath('x'.repeat(5000), false)
  assert.deepEqual([long.path.length, long.cut], [MAX_PATH_LENGTH, true])
  assert.equal(normalizePath('x'.repeat(MAX_PATH_LENGTH), false).cut, false)
  // The cut never splits a surrogate pair, and never leaves an empty last segment.
  const emoji = normalizePath('x'.repeat(MAX_PATH_LENGTH - 1) + String.fromCodePoint(0x1f600), false)
  assert.deepEqual([emoji.path, emoji.cut], ['x'.repeat(MAX_PATH_LENGTH - 1), true])
  const edge = normalizePath('x'.repeat(MAX_PATH_LENGTH - 2) + '/' + String.fromCodePoint(0x1f600), false)
  assert.deepEqual([edge.path, edge.cut], ['x'.repeat(MAX_PATH_LENGTH - 2), true])
})

test('a tar or ZIP name thousands of folders deep is cut, and the archive marked damaged', () => {
  const name = 'a/'.repeat(70000) + 'f.txt'
  const fromTar = parseTar(tar([pax({ path: name }), { name: 'placeholder', data: utf8('deep') }, { name: 'ok.txt' }]), 'cp437')
  assert.equal(fromTar.damaged, true)
  assert.deepEqual(fromTar.entries.map((e) => e.path.split('/').length), [MAX_PATH_SEGMENTS, 1])
  assert.equal(new TextDecoder().decode(fromTar.read(fromTar.entries[0], 100).bytes), 'deep')
  assert.equal(parseTar(tar([{ name: 'ok.txt' }]), 'cp437').damaged, false)
  // A ZIP name can be 65,535 bytes: 32,767 folders.
  const fromZip = parseZip(zip([{ name: 'a/'.repeat(32767) + 'f', data: utf8('z') }, { name: 'ok.txt' }]), 'cp437')
  assert.equal(fromZip.damaged, true)
  assert.deepEqual(fromZip.entries.map((e) => e.path.split('/').length), [MAX_PATH_SEGMENTS, 1])
  assert.equal(fromZip.withEncoding('cp866').damaged, true)
})
