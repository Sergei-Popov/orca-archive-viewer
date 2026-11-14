import { assert, test } from 'orca/testing'
import { formatCrc, formatMode, formatRatio, formatSize } from './display'

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
