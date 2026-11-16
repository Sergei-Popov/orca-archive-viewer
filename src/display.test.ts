import { assert, test } from 'orca/testing'
import { formatCrc, formatMode, formatRatio, formatSize, highlightParts, saveName, visibleText } from './display'

const units = { b: 'B', kb: 'KB', mb: 'MB', gb: 'GB' }

test('formatSize picks a unit and one decimal below 10', () => {
  assert.equal(formatSize(512, 'en', units), '512 B')
  assert.equal(formatSize(1536, 'en', units), '1.5 KB')
  assert.equal(formatSize(20 * 1024 * 1024, 'en', units), '20 MB')
  assert.equal(formatSize(1536, 'ru', { b: 'Б', kb: 'КБ', mb: 'МБ', gb: 'ГБ' }), '1,5 КБ')
})

test('formatMode draws ls -l permissions', () => {
  assert.equal(formatMode(0o100644), '-rw-r--r--')
  assert.equal(formatMode(0o040755), 'drwxr-xr-x')
  assert.equal(formatMode(0o120777), 'lrwxrwxrwx')
  assert.equal(formatMode(0o104755), '-rwsr-xr-x')
})

test('formatRatio and formatCrc', () => {
  assert.equal(formatRatio(35, 100, 'en'), '35%')
  assert.equal(formatRatio(1, 0, 'en'), '')
  assert.equal(formatCrc(0xcbf43926), 'CBF43926')
  assert.equal(formatCrc(0x1f), '0000001F')
})

const RLO = String.fromCodePoint(0x202e)
const marked = (text: string, needle: string) =>
  highlightParts(text, needle).map((p) => (p.mark ? `[${p.text}]` : p.text)).join('')

test('hidden characters in names are written out, and left out of a name to save', () => {
  assert.equal(visibleText(`photo${RLO}gpj.exe`), 'photo⟨U+202E⟩gpj.exe')
  const cp = (...points: number[]) => String.fromCodePoint(...points)
  assert.equal(visibleText(`a${cp(0x200b)}b${cp(0x2066)}c${cp(0x2069)}${cp(9)}z${cp(0x2028)}`), 'a⟨U+200B⟩b⟨U+2066⟩c⟨U+2069⟩⟨U+0009⟩z⟨U+2028⟩')
  assert.equal(visibleText(String.fromCodePoint(0xe0001) + 'x'), '⟨U+E0001⟩x')
  assert.equal(visibleText('Отчёт 2024 — итог.pdf'), 'Отчёт 2024 — итог.pdf')
  assert.equal(saveName(`photo${RLO}gpj.exe`, 'file'), 'photogpj.exe')
  assert.equal(saveName(`deep/rest/of/${RLO}name.txt`, 'file'), 'name.txt')
  assert.equal(saveName(RLO, 'file'), 'file')
})

test('the filter highlight marks the matching characters, also after a letter whose lowercase is longer', () => {
  assert.equal(marked('İstanbul notları.txt', 'notlar'), 'İstanbul [notlar]ı.txt')
  assert.equal(marked('İİİ readme.md', 'README'), 'İİİ [readme].md')
  assert.equal(marked('ŞİŞLİ_rapor.pdf', 'rapor'), 'ŞİŞLİ_[rapor].pdf')
  assert.equal(marked('Straße.txt', 'straße'), '[Straße].txt')
  assert.equal(marked('abcABCabc', 'abc'), '[abc][ABC][abc]')
  // Matching part of İ (i, without its dot) marks the whole letter.
  assert.equal(marked('İzmir', 'i'), '[İ]zm[i]r')
  assert.equal(marked('😀 smile 😀', 'smile'), '😀 [smile] 😀')
  assert.equal(marked('name.txt', ''), 'name.txt')
  assert.equal(marked('name.txt', 'zzz'), 'name.txt')
  assert.equal(marked('', 'a'), '')
})
