// The folder tree built from an archive's flat entry list: folders the archive never lists get
// created from paths, folders sum their files, and children sort folders first, then by name in
// natural order ("file2" before "file10").

import type { Archive, Entry } from './archive/model'

export type Node = {
  name: string
  /** Full path; "" for the root. */
  path: string
  dir: boolean
  entry?: Entry
  children: Node[]
  /** Folders: totals over every file below. */
  size: number
  packed: number
  files: number
  folders: number
  mtime?: number
  /** Packed sizes are known for every file below. */
  hasPacked: boolean
  /** The root only: FOLDER_BUDGET ran out, so some entries hang under a folder above their own. */
  cut?: boolean
  /** A ZIP file whose name other entries share: which copy this is, counting from 1. */
  duplicate?: { copy: number; copies: number }
}

/**
 * The path to show for a node. It is `node.path` except for the second and later copies of a
 * ZIP name, whose `path` adds a NUL and the entry index to tell their rows apart.
 */
export function shownPath(node: Node): string {
  return node.entry?.path ?? node.path
}

export type Row = { node: Node; depth: number }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Most characters the folder paths of one tree may hold together. Every folder keeps its whole
 * path, so a folder 1,000 deep costs 1,000 prefixes: Orca's V8 copies each one (Node's shares
 * them, which hides the cost in tests), and a few thousand crafted entries that deep would take
 * gigabytes. Past the budget no new folder is made: an entry hangs under the deepest folder
 * already there, named by the rest of its path, and the tree is marked cut. Real archives use a
 * few megabytes at most.
 */
export const FOLDER_BUDGET = 64 * 1024 * 1024

function folder(name: string, path: string): Node {
  return { name, path, dir: true, children: [], size: 0, packed: 0, files: 0, folders: 0, hasPacked: true }
}

/**
 * The tree of `entries`. A later file at the same path replaces the earlier one (an appended
 * tar), unless `duplicates` is set (ZIP): then every copy is a row of its own, marked.
 */
export function buildTree(entries: readonly Entry[], options: { duplicates?: boolean } = {}): Node {
  const root = folder('', '')
  // Subfolders by name. Archives can nest folders hundreds deep, so none of the walks here
  // recurse, and the walk down goes by name so that only a new folder copies its path.
  const subfolders = new Map<Node, Map<string, Node>>()
  let spent = 0
  /** The folder at `path`, made as needed; past the budget, the deepest one on the way to it. */
  const ensure = (path: string): Node => {
    let node = root
    for (let start = 0; path && start <= path.length; ) {
      const slash = path.indexOf('/', start)
      const end = slash < 0 ? path.length : slash
      const name = path.slice(start, end)
      let names = subfolders.get(node)
      let next = names?.get(name)
      if (!next) {
        if (spent + end > FOLDER_BUDGET) {
          root.cut = true
          return node
        }
        spent += end
        next = folder(name, path.slice(0, end))
        node.children.push(next)
        if (!names) subfolders.set(node, (names = new Map()))
        names.set(name, next)
      }
      node = next
      start = end + 1
    }
    return node
  }
  /** `path` below `parent`: one name, or after the budget ran out, the rest of the path. */
  const rest = (parent: Node, path: string): string => path.slice(parent.path ? parent.path.length + 1 : 0)
  const files = new Map<string, Node>()
  const repeats = new Map<string, Node[]>()
  for (const entry of entries) {
    if (!entry.path) continue
    if (entry.dir) {
      let node = ensure(entry.path)
      if (node.path !== entry.path) {
        // Past the budget: an empty folder row, which nothing else can go into.
        const leaf = folder(rest(node, entry.path), entry.path)
        node.children.push(leaf)
        node = leaf
      }
      node.entry = entry
      node.mtime = entry.mtime
      continue
    }
    const slash = entry.path.lastIndexOf('/')
    const parent = ensure(slash < 0 ? '' : entry.path.slice(0, slash))
    const existing = files.get(entry.path)
    if (existing && options.duplicates) {
      const copies = repeats.get(entry.path) ?? [existing]
      repeats.set(entry.path, copies)
      const node = fileNode(entry, rest(parent, entry.path), `${entry.path}\0${entry.index}`)
      copies.push(node)
      parent.children.push(node)
      continue
    }
    if (existing) {
      // A later copy of the same path (an appended tar) replaces the earlier one.
      existing.entry = entry
      existing.size = entry.size
      existing.packed = entry.packed ?? 0
      existing.hasPacked = entry.packed !== undefined
      existing.mtime = entry.mtime
      continue
    }
    const node = fileNode(entry, rest(parent, entry.path), entry.path)
    parent.children.push(node)
    files.set(entry.path, node)
  }
  for (const copies of repeats.values()) {
    copies.forEach((node, i) => (node.duplicate = { copy: i + 1, copies: copies.length }))
  }
  total(root)
  return root
}

/**
 * The tree the view shows for `archive`, on opening and after every code page switch. A ZIP can
 * list a name twice, and readers differ on which copy wins, so every copy is shown; tar extracts
 * the last.
 */
export function archiveTree(archive: Pick<Archive, 'entries' | 'kind'>): Node {
  return buildTree(archive.entries, { duplicates: archive.kind === 'zip' })
}

function fileNode(entry: Entry, name: string, path: string): Node {
  return {
    name,
    path,
    dir: false,
    entry,
    children: [],
    size: entry.size,
    packed: entry.packed ?? 0,
    files: 1,
    folders: 0,
    mtime: entry.mtime,
    hasPacked: entry.packed !== undefined
  }
}

/** Sums sizes and counts into every folder and sorts its children. */
function total(root: Node): void {
  // Folders in an order where each comes before the folders inside it; summed in reverse.
  const order: Node[] = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    order.push(node)
    for (const child of node.children) if (child.dir) stack.push(child)
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]
    node.size = 0
    node.packed = 0
    node.files = 0
    node.folders = 0
    node.hasPacked = true
    for (const child of node.children) {
      node.size += child.size
      node.packed += child.packed
      node.files += child.files
      node.folders += child.folders + (child.dir ? 1 : 0)
      node.hasPacked &&= child.hasPacked
    }
    node.children.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
  }
}

/** Every folder path, for "expand all". */
export function folderPaths(root: Node): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node !== root) out.push(node.path)
    for (let i = node.children.length - 1; i >= 0; i--) {
      if (node.children[i].dir) stack.push(node.children[i])
    }
  }
  return out
}

/**
 * The rows to draw. Without a filter: children of expanded folders. With one: nodes whose name
 * contains it (case-insensitive) and the folders leading to them, all open.
 */
export function visibleRows(root: Node, expanded: ReadonlySet<string>, filter: string): Row[] {
  const rows: Row[] = []
  const needle = filter.trim().toLowerCase()
  if (!needle) {
    const stack: Row[] = []
    const pushChildren = (node: Node, depth: number) => {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth })
    }
    pushChildren(root, 0)
    while (stack.length) {
      const row = stack.pop()!
      rows.push(row)
      if (row.node.dir && expanded.has(row.node.path)) pushChildren(row.node, row.depth + 1)
    }
    return rows
  }
  const matches = (node: Node): boolean => node.name.toLowerCase().includes(needle)
  // Depth first with an explicit stack. A folder's row goes in when the walk enters it and is
  // taken out again on the way back when neither it nor anything below it matched.
  type Frame = { node: Node; depth: number; next: number; row: number; keep: boolean }
  const stack: Frame[] = [{ node: root, depth: 0, next: 0, row: 0, keep: false }]
  while (stack.length) {
    const frame = stack[stack.length - 1]
    if (frame.next < frame.node.children.length) {
      const child = frame.node.children[frame.next++]
      const row = rows.length
      rows.push({ node: child, depth: frame.depth })
      if (child.children.length) stack.push({ node: child, depth: frame.depth + 1, next: 0, row, keep: matches(child) })
      else if (matches(child)) frame.keep = true
      else rows.length = row
      continue
    }
    stack.pop()
    const parent = stack[stack.length - 1]
    if (!parent) break
    if (frame.keep) parent.keep = true
    else rows.length = frame.row
  }
  return rows
}

/** The node at `path`, or null. */
export function findNode(root: Node, path: string): Node | null {
  if (!path) return root
  let node: Node = root
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    const next: Node | undefined = node.children.find((child) => child.name === parts[i])
    if (next) {
      node = next
      continue
    }
    // A tree past its folder budget names some entries by the rest of their path, and a repeated
    // ZIP name's later copies have a path of their own.
    return node.children.find((child) => child.path === path) ?? null
  }
  return node
}

/** The folders that contain `path`, outermost first; each prefix extends the one before. */
export function ancestors(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  let prefix = ''
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = i ? `${prefix}/${parts[i]}` : parts[i]
    out.push(prefix)
  }
  return out
}

/**
 * Old path → new path for every file and folder, after the same archive's names were decoded
 * with another code page. Entries keep their `index`, and `/` is ASCII in every code page, so a
 * path keeps its depth.
 */
export function renamedPaths(before: readonly Entry[], after: readonly Entry[]): Map<string, string> {
  const next = new Map<number, string>()
  for (const entry of after) next.set(entry.index, entry.path)
  const out = new Map<string, string>()
  for (const entry of before) {
    const renamed = next.get(entry.index)
    if (renamed === undefined || renamed === entry.path) continue
    const from = entry.path.split('/')
    const to = renamed.split('/')
    if (from.length !== to.length) continue
    // Each prefix extends the one before, so a path costs its length, not its length squared.
    let a = ''
    let b = ''
    for (let depth = 0; depth < from.length; depth++) {
      a = depth ? `${a}/${from[depth]}` : from[depth]
      b = depth ? `${b}/${to[depth]}` : to[depth]
      out.set(a, b)
    }
  }
  return out
}
