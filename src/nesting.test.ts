import { assert, test } from 'orca/testing'
import { gzipSync } from '../vendor/fflate/fflate.mjs'
import { EntryError } from './archive/model'
import { MAX_UNPACKED, openArchive } from './archive/open'
import { parseZip } from './archive/zip'
import { TooLargeError, UnsupportedDataError, type UnsupportedFeature } from './codecs/sink'
import { concat, tar, utf8, zip } from './fixtures/build'
import { stringsFor } from './i18n'
import { MAX_HELD, MAX_LEVELS, TooDeepError, autoOpens, heldBytes, nestedLimit } from './nesting'
import { describeOpenError } from './view'

const is = (type: abstract new (...args: never[]) => unknown) => (error: unknown) => error instanceof type

test('only the archive Orca opened goes straight into its one file', async () => {
  const single = await openArchive(gzipSync(gzipSync(utf8('x'))), { encoding: 'cp437' })
  assert.equal(autoOpens(1, single), true)
  assert.equal(autoOpens(2, single), false)
  assert.equal(autoOpens(1, parseZip(zip([{ name: 'a.zip' }]), 'cp437')), false)
})

test('nestedLimit caps the depth and what all levels hold together', () => {
  assert.equal(nestedLimit(1, 0), Math.min(MAX_UNPACKED, MAX_HELD))
  assert.equal(nestedLimit(2, 900, 8, 1000), 100)
  assert.equal(nestedLimit(2, 5000, 8, 1000), 0)
  assert.equal(nestedLimit(MAX_LEVELS - 1, 0) > 0, true)
  assert.throws(() => nestedLimit(MAX_LEVELS, 0), (e: unknown) => e instanceof TooDeepError && e.levels === MAX_LEVELS)
})

test('heldBytes counts the whole buffer a compressed level unpacked into, and nothing for others', async () => {
  const inner = tar([{ name: 'a.txt', data: utf8('12345') }])
  const tgz = await openArchive(gzipSync(inner), { encoding: 'cp437' })
  assert.equal(heldBytes(tgz, 100), 100 + inner.length)
  assert.equal(heldBytes(tgz.withEncoding('cp866'), 100), 100 + inner.length)
  const single = await openArchive(gzipSync(utf8('12345')), { encoding: 'cp437' })
  assert.equal(heldBytes(single, 0), 5)
  assert.equal(heldBytes(parseZip(zip([{ name: 'a.txt', data: utf8('12345') }]), 'cp437'), 100), 100)
  assert.equal(heldBytes(await openArchive(inner, { encoding: 'cp437' }), 100), 100)
  // The buffer, not the entries: a stream that unpacks to more than its tar holds.
  const padded = await openArchive(gzipSync(concat(inner, new Uint8Array(1 << 20))), { encoding: 'cp437' })
  assert.equal(heldBytes(padded, 0), inner.length + (1 << 20))
})

test('a chain of .gz inside .gz stops at the level cap, and each level gets what is left', async () => {
  let bytes = gzipSync(utf8('core'))
  for (let i = 0; i < 12; i++) bytes = gzipSync(bytes)
  // As ArchiveView.openNested does it, with the cap at 4 levels.
  const levels = [await openArchive(bytes, { encoding: 'cp437' })]
  let held = heldBytes(levels[0], 0)
  const open = async () => {
    const level = levels[levels.length - 1]
    const budget = nestedLimit(levels.length, held, 4)
    const result = level.read(level.entries[0], budget)
    if (result.truncated) throw new TooLargeError(budget)
    const next = await openArchive(result.bytes, { encoding: 'cp437', limit: budget - result.bytes.length })
    held += heldBytes(next, result.bytes.length)
    levels.push(next)
  }
  await open()
  await open()
  await open()
  assert.equal(levels.length, 4)
  await assert.rejects(open, is(TooDeepError))
  // A level may unpack only what the budget leaves.
  await assert.rejects(() => openArchive(gzipSync(new Uint8Array(1000)), { encoding: 'cp437', limit: 50 }), is(TooLargeError))
})

test('messages for limits name the limit, in English and Russian', () => {
  for (const locale of ['en', 'ru']) {
    const t = stringsFor(locale)
    assert.ok(describeOpenError(new TooDeepError(8), t, locale).includes('8'))
    assert.notEqual(
      describeOpenError(new TooLargeError(1024), t, locale),
      describeOpenError(new TooLargeError(MAX_UNPACKED), t, locale)
    )
    for (const feature of ['zstd-window', 'xz-dictionary', 'xz-options'] as UnsupportedFeature[]) {
      const text = describeOpenError(new UnsupportedDataError(feature), t, locale)
      assert.ok(text.length > 20 && text !== t.damagedArchive, `${locale} ${feature}`)
      assert.equal(describeOpenError(new EntryError('unsupported', feature), t, locale), text)
    }
  }
})
