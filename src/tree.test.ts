import { assert, test } from 'orca/testing'
import type { Entry } from './archive/model'
import { FOLDER_BUDGET, ancestors, buildTree, findNode, folderPaths, renamedPaths, shownPath, visibleRows } from './tree'

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

test('folders nested 8,000 deep build, filter, expand and list without recursion', () => {
  // 8,000 is about as deep as one path gets within FOLDER_BUDGET; parsers stop at 1,024.
  const depth = 8000
  const deep: Entry[] = []
  let path = ''
  for (let d = 0; d < depth; d++) {
    path += 'd/'
    if (d % 1000 === 999) deep.push(file(d, `${path}x${d}.txt`, 1))
  }
  // The deepest file first, so every folder above it is made in one go.
  deep.reverse()
  const root = buildTree(deep)
  assert.equal(root.cut, undefined)
  assert.equal(root.files, 8)
  assert.equal(root.folders, depth)
  assert.equal(visibleRows(root, new Set(), 'x7999').length, depth + 1)
  const all = folderPaths(root)
  assert.equal(all.length, depth)
  assert.equal(visibleRows(root, new Set(all), '').length, depth + 8)
  assert.deepEqual(visibleRows(root, new Set(['d']), '').map((r) => r.node.path), ['d', 'd/d'])
  assert.equal(ancestors(deep[0].path).length, depth)
  assert.equal(ancestors(deep[0].path)[depth - 1], deep[0].path.slice(0, -'/x7999.txt'.length))
})

test('folder paths stay within their budget, whatever the engine shares', () => {
  // Every folder keeps its whole path. Node's V8 shares those prefixes with the full string, so
  // memory alone would not show the cost here; Orca's V8 copies them, and 300 entries like these
  // held 651 MiB there before the budget. So the characters are counted instead.
  const segments = Array(1023).fill('abc').join('/')
  const many: Entry[] = Array.from({ length: 300 }, (_, i) => file(i, `r${i}/${segments}/f.txt`, 1))
  many.push({ index: 300, path: `r299/${segments}/dir`, dir: true, size: 0 })
  const started = Date.now()
  const root = buildTree(many)
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`)
  assert.equal(root.cut, true)
  let held = 0
  for (const path of folderPaths(root)) held += path.length
  // Plus the empty folder row made past the budget, which reuses its entry's own path string.
  const extra = many[300].path.length
  assert.ok(held <= FOLDER_BUDGET + extra && held > FOLDER_BUDGET / 2, `${held} characters`)
  // Every entry is still in the tree once, found by its path, and matched by the filter.
  assert.equal(root.files, 300)
  for (const entry of many) assert.equal(findNode(root, entry.path)?.entry, entry, entry.path)
  assert.equal(visibleRows(root, new Set(), 'f.txt').filter((row) => !row.node.dir).length, 300)
  // Past the budget an entry hangs under the deepest folder made, named by the rest of its path.
  const last = findNode(root, many[299].path)!
  assert.ok(last.name.endsWith('/f.txt') || last.name === many[299].path, last.name.slice(0, 40))
  assert.equal(findNode(root, many[300].path)?.dir, true)
})

test('a ZIP name listed twice gives each copy its own marked row; a tar keeps the last', () => {
  const twice: Entry[] = [
    file(0, 'a.txt', 1),
    file(1, 'dir/dup.txt', 10),
    file(2, 'b/c.txt', 1),
    file(3, 'dir/dup.txt', 11),
    file(4, 'dir/dup.txt', 12)
  ]
  const zipTree = buildTree(twice, { duplicates: true })
  assert.equal(zipTree.files, 5)
  const dir = findNode(zipTree, 'dir')!
  assert.deepEqual(dir.children.map((n) => [n.name, n.entry?.index, n.duplicate]), [
    ['dup.txt', 1, { copy: 1, copies: 3 }],
    ['dup.txt', 3, { copy: 2, copies: 3 }],
    ['dup.txt', 4, { copy: 3, copies: 3 }]
  ])
  // Rows are told apart by path; every copy shows and copies the name the archive gives it.
  const paths = dir.children.map((n) => n.path)
  assert.equal(new Set(paths).size, 3)
  assert.deepEqual(dir.children.map(shownPath), ['dir/dup.txt', 'dir/dup.txt', 'dir/dup.txt'])
  for (const node of dir.children) assert.equal(findNode(zipTree, node.path), node)
  assert.deepEqual(ancestors(paths[2]), ['dir'])
  assert.equal(visibleRows(zipTree, new Set(), 'dup').length, 4)
  assert.equal(findNode(zipTree, 'a.txt')?.duplicate, undefined)
  // An appended tar: the later copy replaces the earlier one.
  const tarTree = buildTree(twice)
  assert.equal(tarTree.files, 3)
  assert.deepEqual(findNode(tarTree, 'dir')!.children.map((n) => [n.entry?.index, n.duplicate]), [[4, undefined]])
})
