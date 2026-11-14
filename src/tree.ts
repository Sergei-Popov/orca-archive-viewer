// The folder tree built from an archive's flat entry list: folders the archive never lists get
// created from paths, folders sum their files, and children sort folders first, then by name in
// natural order ("file2" before "file10").

import type { Entry } from './archive/model'

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
}

export type Row = { node: Node; depth: number }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function folder(name: string, path: string): Node {
  return { name, path, dir: true, children: [], size: 0, packed: 0, files: 0, folders: 0, hasPacked: true }
}

export function buildTree(entries: readonly Entry[]): Node {
  const root = folder('', '')
  const folders = new Map<string, Node>([['', root]])
  const ensure = (path: string): Node => {
    let node = folders.get(path)
    if (node) return node
    const slash = path.lastIndexOf('/')
    const parent = ensure(slash < 0 ? '' : path.slice(0, slash))
    node = folder(path.slice(slash + 1), path)
    parent.children.push(node)
    folders.set(path, node)
    return node
  }
  const files = new Map<string, Node>()
  for (const entry of entries) {
    if (!entry.path) continue
    if (entry.dir) {
      const node = ensure(entry.path)
      node.entry = entry
      node.mtime = entry.mtime
      continue
    }
    const slash = entry.path.lastIndexOf('/')
    const parent = ensure(slash < 0 ? '' : entry.path.slice(0, slash))
    const existing = files.get(entry.path)
    if (existing) {
      // A later copy of the same path (an appended tar) replaces the earlier one.
      existing.entry = entry
      existing.size = entry.size
      existing.packed = entry.packed ?? 0
      existing.hasPacked = entry.packed !== undefined
      existing.mtime = entry.mtime
      continue
    }
    const node: Node = {
      name: entry.path.slice(slash + 1),
      path: entry.path,
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
    parent.children.push(node)
    files.set(entry.path, node)
  }
  total(root)
  return root
}

function total(node: Node): void {
  if (!node.dir) return
  node.size = 0
  node.packed = 0
  node.files = 0
  node.folders = 0
  node.hasPacked = true
  for (const child of node.children) {
    total(child)
    node.size += child.size
    node.packed += child.packed
    node.files += child.files
    node.folders += child.folders + (child.dir ? 1 : 0)
    node.hasPacked &&= child.hasPacked
  }
  node.children.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
}

/** Every folder path, for "expand all". */
export function folderPaths(root: Node): string[] {
  const out: string[] = []
  const walk = (node: Node) => {
    for (const child of node.children) {
      if (child.dir) {
        out.push(child.path)
        walk(child)
      }
    }
  }
  walk(root)
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
    const walk = (node: Node, depth: number) => {
      for (const child of node.children) {
        rows.push({ node: child, depth })
        if (child.dir && expanded.has(child.path)) walk(child, depth + 1)
      }
    }
    walk(root, 0)
    return rows
  }
  const matches = (node: Node): boolean => node.name.toLowerCase().includes(needle)
  const walk = (node: Node, depth: number): Row[] => {
    const out: Row[] = []
    for (const child of node.children) {
      const below = child.dir ? walk(child, depth + 1) : []
      if (matches(child) || below.length) {
        out.push({ node: child, depth }, ...below)
      }
    }
    return out
  }
  return walk(root, 0)
}

/** The node at `path`, or null. */
export function findNode(root: Node, path: string): Node | null {
  if (!path) return root
  let node: Node | undefined = root
  for (const part of path.split('/')) {
    node = node?.children.find((child) => child.name === part)
    if (!node) return null
  }
  return node
}

/** The folders that contain `path`, outermost first. */
export function ancestors(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}
