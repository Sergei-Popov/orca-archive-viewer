// Cross-checks with the real bzip2, zstd and xz, prepared by tools/cli-crosscheck.sh: the script
// packs plain inputs with each installed tool into .test-files/cli/ (git-ignored) and lists the
// files in cases.tsv with the outcome each must have; here every one is unpacked with the
// plugin's decoders. The tests' own encoders write their output to .test-files/cli/ours/ for the
// script to unpack with the tools. Without that folder, as in a plain `orca plugin test .`, these
// tests pass with a note. Nothing here starts a process: the script runs the tools.

import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { bzip2 } from '../fixtures/bzip2'
import { xz, type XzOptions } from '../fixtures/xz'
import { zstd, type ZstdOptions } from '../fixtures/zstd'
import { bunzip2 } from './bzip2'
import { DamagedError, UnsupportedDataError } from './sink'
import { unxz } from './xz'
import { indexedSize } from './xz/stream'
import { unzstd } from './zstd'

const DIR = decodeURIComponent(new URL('../../.test-files/cli/', import.meta.url).pathname)
const LIMIT = 64 << 20

function prepared(): boolean {
  if (existsSync(DIR + 'cases.tsv')) return true
  console.log('  no .test-files/cli/: run tools/cli-crosscheck.sh to check against bzip2, zstd and xz')
  return false
}

const lines = (file: string) => readFileSync(DIR + file, 'utf8').split('\n').filter(Boolean)

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function unpack(file: string, data: Uint8Array): Uint8Array {
  if (file.endsWith('.bz2')) return bunzip2(data, LIMIT).bytes
  if (file.endsWith('.zst')) return unzstd(data, LIMIT).bytes
  if (file.endsWith('.xz')) return unxz(data, LIMIT).bytes
  throw new Error(`no decoder for ${file}`)
}

test('files made by bzip2, zstd and xz unpack here (tools/cli-crosscheck.sh)', () => {
  if (!prepared()) return
  const failures: string[] = []
  const tally = new Map<string, number>()
  for (const line of lines('cases.tsv')) {
    const [packed, plain, expected] = line.split('\t')
    let outcome: string
    try {
      const data = readFileSync(DIR + packed)
      const bytes = unpack(packed, data)
      outcome = equal(bytes, readFileSync(DIR + plain)) ? 'ok' : 'wrong output'
      // Every file xz writes has an Index, so its size hint is exact.
      const hint = packed.endsWith('.xz') ? indexedSize(data) : bytes.length
      if (outcome === 'ok' && hint !== bytes.length) outcome = `index gives ${hint} bytes, not ${bytes.length}`
    } catch (error) {
      if (error instanceof UnsupportedDataError) outcome = `unsupported:${error.feature}`
      else if (error instanceof DamagedError) outcome = 'damaged'
      else outcome = `threw ${String(error)}`
    }
    if (outcome !== expected) failures.push(`${packed}: expected ${expected}, got ${outcome}`)
    const key = `${packed.split('/')[0]} files unpacked here, ${expected}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  writeFileSync(DIR + 'results.txt', [...tally].map(([key, n]) => `${key}: ${n}`).join('\n') + '\n')
  assert.deepEqual(failures, [])
})

const ZSTD_OPTIONS: [string, ZstdOptions][] = [
  ['single', {}],
  ['wlog10', { windowLog: 10, contentSize: false }],
  ['wlog17', { windowLog: 17 }],
  ['blocks1000', { windowLog: 12, blockSize: 1000 }]
]

const XZ_OPTIONS: [string, XzOptions][] = [
  ['default', {}],
  ['none', { check: 'none' }],
  ['crc32-sizes', { check: 'crc32', sizes: true }],
  ['blocks', { blockSize: 100000, chunkSize: 7000 }],
  ['lc0lp4pb0', { lc: 0, lp: 4, pb: 0 }],
  ['dict4k', { dictSize: 4096, lc: 4, pb: 4 }]
]

test('the test encoders write what bzip2, zstd and xz read (tools/cli-crosscheck.sh)', () => {
  if (!prepared()) return
  mkdirSync(DIR + 'ours', { recursive: true })
  const rows: string[] = []
  const write = (name: string, bytes: Uint8Array, plain: string, tool: string) => {
    writeFileSync(DIR + 'ours/' + name, bytes)
    rows.push(`ours/${name}\t${plain}\t${tool}`)
  }
  for (const plain of lines('plain.txt')) {
    const bytes = readFileSync(DIR + plain)
    const name = plain.replace(/^plain\//, '').replace(/\.bin$/, '')
    // The encoder's sort is slow; a few hundred KB still makes several blocks at level 1.
    if (bytes.length <= 300000) {
      for (const tables of [2, 6]) write(`${name}.t${tables}.bz2`, bzip2(bytes, { level: 1, tables }), plain, 'bzip2')
    }
    for (const [label, options] of ZSTD_OPTIONS) write(`${name}.${label}.zst`, zstd(bytes, options), plain, 'zstd')
    for (const [label, options] of XZ_OPTIONS) {
      if (label === 'default' || bytes.length <= 300000) write(`${name}.${label}.xz`, xz(bytes, options), plain, 'xz')
    }
  }
  writeFileSync(DIR + 'ours/cases.tsv', rows.join('\n') + '\n')
  assert.ok(rows.length > 0)
})
