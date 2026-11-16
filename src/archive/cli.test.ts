// Cross-checks the tar reader with Python's tarfile, prepared by tools/cli-crosscheck.sh: the
// script writes archives with macOS tar, GNU tar (when installed) and tarfile itself into
// .test-files/cli/tar/ (git-ignored), sparse files among them, and lists what tarfile reads from
// every member in cases.tsv. Here each archive is read with the plugin and every member compared.
// Without that folder, as in a plain `orca plugin test .`, this passes with a note. Nothing here
// starts a process: the script runs the tools.

import { assert, test } from 'orca/testing'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseTar } from './tar'

const DIR = decodeURIComponent(new URL('../../.test-files/cli/', import.meta.url).pathname)

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

test('tar archives read here as Python tarfile reads them (tools/cli-crosscheck.sh)', () => {
  if (!existsSync(DIR + 'tar/cases.tsv')) {
    console.log('  no .test-files/cli/tar/: run tools/cli-crosscheck.sh to check against tarfile')
    return
  }
  const failures: string[] = []
  const counts = new Map<string, number>()
  const archives = new Map<string, ReturnType<typeof parseTar>>()
  for (const line of readFileSync(DIR + 'tar/cases.tsv', 'utf8').split('\n').filter(Boolean)) {
    const [file, index, name, size, mtime, content] = line.split('\t')
    let archive = archives.get(file)
    if (!archive) {
      archive = parseTar(new Uint8Array(readFileSync(DIR + file)), 'cp437')
      archives.set(file, archive)
      if (archive.damaged) failures.push(`${file}: marked damaged`)
    }
    const entry = archive.entries[Number(index)]
    const what = `${file} #${index} ${name}`
    if (!entry) {
      failures.push(`${what}: missing`)
      continue
    }
    if (entry.path !== name) failures.push(`${what}: named ${entry.path}`)
    if (!entry.link && entry.size !== Number(size)) failures.push(`${what}: size ${entry.size}, tarfile ${size}`)
    if (entry.mtime === undefined || Math.abs(entry.mtime - Number(mtime) * 1000) >= 1) {
      failures.push(`${what}: mtime ${entry.mtime}, tarfile ${mtime} s`)
    }
    if (content !== '-') {
      const want = new Uint8Array(readFileSync(DIR + content))
      try {
        const got = archive.read(entry, want.length + 1)
        if (got.truncated || !equal(got.bytes, want)) failures.push(`${what}: content differs`)
      } catch (error) {
        failures.push(`${what}: ${String(error)}`)
      }
    }
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  for (const [file, archive] of archives) {
    if (archive.entries.length !== counts.get(file)) {
      failures.push(`${file}: ${archive.entries.length} entries, tarfile ${counts.get(file)}`)
    }
  }
  const lines = [...counts].map(([file, n]) => `${file}: ${n} members as tarfile reads them`)
  writeFileSync(DIR + 'tar/results.txt', lines.join('\n') + '\n')
  assert.deepEqual(failures, [])
})
