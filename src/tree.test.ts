import { assert, test } from 'orca/testing'
import type { Entry } from './archive/model'
import { ancestors, buildTree, findNode, folderPaths, renamedPaths, visibleRows } from './tree'

const file = (index: number, path: string, size: number, packed?: number): Entry => ({ index, path, dir: false, size, packed })

const entries: Entry[] = [
  file(0, 'src/file10.ts', 10, 4),
  file(1, 'src/file2.ts', 20, 8),
  file(2, 'README.md', 5, 5),
  { index: 3, path: 'empty', dir: true, size: 0 },
  file(4, 'src/lib/deep.ts', 30, 10)
]

test('builds implicit folders, sorts folders first and names naturally, sums sizes', () => {
  const root = buildTree(entries)
  assert.deepEqual(root.children.map((n) => n.name), ['empty', 'src', 'README.md'])
  const src = findNode(root, 'src')!
  assert.deepEqual(src.children.map((n) => n.name), ['lib', 'file2.ts', 'file10.ts'])
  assert.equal(src.size, 60)
  assert.equal(src.packed, 22)
  assert.equal(src.files, 3)
  assert.equal(src.folders, 1)
  assert.equal(root.files, 4)
  assert.equal(root.folders, 3)
  assert.equal(findNode(root, 'empty')?.entry?.index, 3)
})

test('visible rows follow expanded folders', () => {
  const root = buildTree(entries)
  assert.deepEqual(visibleRows(root, new Set(), '').map((r) => r.node.path), ['empty', 'src', 'README.md'])
  const open = visibleRows(root, new Set(['src']), '')
  assert.deepEqual(open.map((r) => [r.node.path, r.depth]), [
    ['empty', 0],
    ['src', 0],
    ['src/lib', 1],
    ['src/file2.ts', 1],
    ['src/file10.ts', 1],
    ['README.md', 0]
  ])
  assert.deepEqual(folderPaths(root).sort(), ['empty', 'src', 'src/lib'])
})

test('a filter shows matches with their folders, case-insensitive', () => {
  const root = buildTree(entries)
  assert.deepEqual(visibleRows(root, new Set(), 'DEEP').map((r) => r.node.path), ['src', 'src/lib', 'src/lib/deep.ts'])
  assert.deepEqual(visibleRows(root, new Set(), 'nothing'), [])
})

test('a repeated path keeps the last entry', () => {
  const root = buildTree([file(0, 'a.txt', 1), file(1, 'a.txt', 2)])
  assert.equal(root.children.length, 1)
  assert.equal(root.children[0].entry?.index, 1)
  assert.equal(root.size, 2)
})

test('ancestors lists the folders above a path', () => {
  assert.deepEqual(ancestors('a/b/c.txt'), ['a', 'a/b'])
  assert.deepEqual(ancestors('top.txt'), [])
})

test('renamedPaths maps files and folders to their names in another code page', () => {
  const before: Entry[] = [file(0, 'ЎаЇЄ /д ©«.txt', 1), file(1, 'same.txt', 1)]
  const after: Entry[] = [file(0, 'папка/файл.txt', 1), file(1, 'same.txt', 1)]
  const map = renamedPaths(before, after)
  assert.equal(map.get('ЎаЇЄ '), 'папка')
  assert.equal(map.get('ЎаЇЄ /д ©«.txt'), 'папка/файл.txt')
  assert.equal(map.size, 2)
  assert.equal(map.has('same.txt'), false)
})

test('a filter over a folder of 200,000 matches returns them all', () => {
  const many: Entry[] = Array.from({ length: 200000 }, (_, i) => file(i, `logs/day-${i}.txt`, 1))
  const root = buildTree(many)
  const rows = visibleRows(root, new Set(), 'day-')
  assert.equal(rows.length, 200001)
  assert.equal(rows[0].node.path, 'logs')
  assert.equal(visibleRows(root, new Set(), 'day-19999').length, 1 + 11)
  assert.equal(visibleRows(root, new Set(), 'nothing').length, 0)
})

test('folders nested 20,000 deep build, filter, expand and list without recursion', () => {
  const depth = 20000
  const deep: Entry[] = []
  let path = ''
  for (let d = 0; d < depth; d++) {
    path += 'd/'
    if (d % 1000 === 999) deep.push(file(d, `${path}x${d}.txt`, 1))
  }
  // The deepest file first, so every folder above it is made in one go.
  deep.reverse()
  const root = buildTree(deep)
  assert.equal(root.files, 20)
  assert.equal(root.folders, depth)
  assert.equal(visibleRows(root, new Set(), 'x19999').length, depth + 1)
  const all = folderPaths(root)
  assert.equal(all.length, depth)
  assert.equal(visibleRows(root, new Set(all), '').length, depth + 20)
  assert.deepEqual(visibleRows(root, new Set(['d']), '').map((r) => r.node.path), ['d', 'd/d'])
})
