// The archive browser: a toolbar, a virtualized folder tree and a preview of the selected entry.
// An archive inside the archive opens in place as a new level; the breadcrumb trail leads back.
// Nothing here writes to the document: the viewer is read-only.

import { type Archive, type Entry, EntryError, type ReadResult } from './archive/model'
import { LEGACY_ENCODINGS, type LegacyEncoding } from './archive/names'
import { NotArchiveError, UnsupportedFormatError, isArchive, openArchive } from './archive/open'
import { DamagedError, TooLargeError, UnsupportedDataError, type UnsupportedFeature } from './codecs/sink'
import { CancelledError } from './codecs/steps'
import { type ContentKind, IMAGE_TYPES, classify, extension, hexDump, imageType, nameKind } from './content'
import { formatBytes, formatCrc, formatDate, formatMode, formatRatio, formatShortDate, formatSize, saveName, visibleText } from './display'
import { append, h, highlight, svg } from './dom'
import { pointerFocus } from './focus'
import { type Strings, fill } from './i18n'
import { type IconName, icon } from './icons'
import { TooDeepError, autoOpens, heldBytes, nestedLimit } from './nesting'
import {
  type Node as TreeNode,
  type Row,
  ancestors,
  archiveTree,
  findNode,
  folderPaths,
  renamedPaths,
  shownPath,
  visibleRows
} from './tree'

const ROW = 24
const OVERSCAN = 8
/** Read for the preview: enough to tell text, images and archives apart and show text. */
const TEXT_LIMIT = 2 * 1024 * 1024
const IMAGE_LIMIT = 32 * 1024 * 1024
/** Orca's save dialog takes at most 64 MiB. */
const SAVE_LIMIT = 64 * 1024 * 1024
const HEX_LIMIT = 64 * 1024
/** Entries up to this size preview at once; bigger ones after a short pause. */
const QUICK_PREVIEW = 512 * 1024
/** Lines longer than this wrap from the start: a minified bundle on one line. */
const LONG_LINE = 10_000
const README = /^read[ _-]?me(\.(md|markdown|txt|rst|adoc|org))?$/i

type Level = {
  archive: Archive
  /** Breadcrumb label: "Archive" for the file Orca opened, the entry name for nested ones. */
  label: string
  root: TreeNode
  expanded: Set<string>
  selected: string | null
  filter: string
  scrollTop: number
  dates: boolean
  /** Bytes this level keeps in memory besides the document Orca passed in. */
  held: number
}

type SaveAs = (options: {
  suggestedName?: string
  mimeType?: string
  data: string | ArrayBuffer | ArrayBufferView
}) => Promise<{ status: 'saved' | 'cancelled' }>

export type ViewOptions = {
  strings: Strings
  locale: string
  encoding: LegacyEncoding
  /** `orca.files.saveAs`; Save… is hidden without it. */
  saveAs?: SaveAs
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 16))

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage can be off in a frame; the preference just does not stick.
  }
}

/** A ZIP method as the details show it: "Stored" is a word, the others are names. */
export function methodLabel(method: string | undefined, t: Strings): string {
  return method === 'Stored' ? t.stored : (method ?? '')
}

/** The message for an archive that cannot be opened. */
export function describeOpenError(error: unknown, t: Strings, locale: string): string {
  if (error instanceof UnsupportedFormatError) return fill(t.unsupported, { format: error.format })
  if (error instanceof NotArchiveError) return t.notArchive
  if (error instanceof TooLargeError) return fill(t.tooLarge, { size: formatSize(error.limit, locale, t.units) })
  if (error instanceof UnsupportedDataError) return t.features[error.feature]
  if (error instanceof TooDeepError) return fill(t.tooDeep, { n: String(error.levels) })
  if (error instanceof EntryError) {
    if (error.code === 'encrypted') return t.encrypted
    if (error.code === 'method') return fill(t.unsupportedMethod, { method: error.detail })
    if (error.code === 'unsupported') return t.features[error.detail as UnsupportedFeature] ?? t.damagedArchive
  }
  if (error instanceof DamagedError) return t.damagedArchive
  return t.damagedArchive
}

export class ArchiveView {
  readonly root: HTMLDivElement
  /** Code page for names without UTF-8 marking; the editor reopens a changed file with it. */
  encoding: LegacyEncoding

  private readonly t: Strings
  private readonly locale: string
  private readonly saveAs: SaveAs | undefined
  /** Single-byte code page for text that is not UTF-8. */
  private readonly fallback: string

  private levels: Level[] = []
  private rows: Row[] = []
  private previewToken = 0
  private previewTimer: ReturnType<typeof setTimeout> | undefined
  private previewKind: ContentKind['kind'] | null = null
  private imageUrl: string | null = null
  private body: HTMLElement | null = null
  private opening = false
  private frame = 0
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private wrap = storageGet('archive-viewer.wrap') === '1'

  private readonly layout: HTMLDivElement
  private readonly crumbs: HTMLElement
  private readonly badge: HTMLSpanElement
  private readonly summary: HTMLSpanElement
  private readonly encodingField: HTMLLabelElement
  private readonly encodingSelect: HTMLSelectElement
  private readonly filterInput: HTMLInputElement
  private readonly expandButton: HTMLButtonElement
  private readonly collapseButton: HTMLButtonElement
  private readonly notice: HTMLDivElement
  private readonly noticeText: HTMLSpanElement
  private readonly main: HTMLDivElement
  private readonly tree: HTMLElement
  private readonly scroll: HTMLDivElement
  private readonly sizer: HTMLDivElement
  private readonly rowsEl: HTMLDivElement
  private readonly empty: HTMLDivElement
  private readonly split: HTMLDivElement
  private readonly preview: HTMLElement
  private readonly toast: HTMLDivElement

  constructor(options: ViewOptions) {
    const t = options.strings
    this.t = t
    this.locale = options.locale
    this.encoding = options.encoding
    this.saveAs = options.saveAs
    this.fallback = this.locale.toLowerCase().startsWith('ru') ? 'windows-1251' : 'windows-1252'
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)

    this.root = h('div', { className: 'av-root' })
    this.crumbs = h('nav', { className: 'av-crumbs', 'aria-label': t.archive })
    this.badge = h('span', { className: 'av-badge' })
    this.summary = h('span', { className: 'av-summary' })
    this.encodingSelect = h('select', { className: 'av-select', 'aria-label': t.names })
    for (const encoding of LEGACY_ENCODINGS) {
      this.encodingSelect.append(h('option', { value: encoding }, t[encoding]))
    }
    this.encodingField = h('label', { className: 'av-field', title: t.encodingHint }, t.names, this.encodingSelect)
    this.filterInput = h('input', {
      type: 'search',
      placeholder: t.filter,
      'aria-label': t.filter,
      title: mac ? t.filterHint : t.filterHint.replace('⌘F', 'Ctrl+F'),
      spellcheck: 'false',
      autocomplete: 'off'
    })
    const search = h('label', { className: 'av-search' }, svg(icon('search')), this.filterInput)
    this.expandButton = h(
      'button',
      { className: 'av-btn av-square', type: 'button', title: t.expandAll, 'aria-label': t.expandAll },
      svg(icon('expand'))
    )
    this.collapseButton = h(
      'button',
      { className: 'av-btn av-square', type: 'button', title: t.collapseAll, 'aria-label': t.collapseAll },
      svg(icon('collapse'))
    )
    const bar = h(
      'div',
      { className: 'av-bar' },
      this.crumbs,
      this.badge,
      this.summary,
      h('span', { className: 'av-spacer' }),
      this.encodingField,
      search,
      this.expandButton,
      this.collapseButton
    )
    this.noticeText = h('span', {}, t.damaged)
    this.notice = h('div', { className: 'av-notice', role: 'status' }, svg(icon('warning')), this.noticeText)

    const cols = h(
      'div',
      { className: 'av-cols', 'aria-hidden': 'true' },
      h('span', {}, t.colName),
      h('span', { className: 'av-c-size' }, t.colSize),
      h('span', { className: 'av-c-packed' }, t.colPacked),
      h('span', { className: 'av-c-date' }, t.colModified)
    )
    this.sizer = h('div')
    this.sizer.style.width = '1px'
    this.rowsEl = h('div', { className: 'av-rows' })
    this.empty = h('div', { className: 'av-empty' })
    this.scroll = h(
      'div',
      { className: 'av-scroll', tabindex: 0, role: 'tree', 'aria-label': t.contents },
      this.sizer,
      this.rowsEl,
      this.empty
    )
    this.tree = h('section', { className: 'av-tree' }, cols, this.scroll)
    this.split = h('div', { className: 'av-split', role: 'separator', 'aria-orientation': 'vertical' })
    this.preview = h('section', { className: 'av-preview' })
    this.main = h('div', { className: 'av-main' }, this.tree, this.split, this.preview)
    this.toast = h('div', { className: 'av-toast', role: 'status' })
    this.layout = h('div', { className: 'av-app' }, bar, this.notice, this.main, this.toast)

    const width = Number(storageGet('archive-viewer.tree'))
    if (width > 0) this.main.style.setProperty('--tree', `${width}px`)
    this.wire()
  }

  private get level(): Level | undefined {
    return this.levels[this.levels.length - 1]
  }

  // States

  showLoading(): void {
    this.levels = []
    this.root.replaceChildren(
      h('div', { className: 'av-center', role: 'status' }, h('div', { className: 'av-spinner' }), h('p', {}, this.t.loading))
    )
  }

  showError(title: string, text: string): void {
    this.levels = []
    this.clearPreview()
    this.root.replaceChildren(
      h('div', { className: 'av-center', role: 'alert' }, svg(icon('warning')), h('h2', {}, title), h('p', {}, text))
    )
  }

  /** Shows the archive Orca opened. A second call (the file changed on disk) keeps the open
   *  folders, the selection and the filter wherever they still exist. */
  show(archive: Archive): void {
    const previous = this.levels[0]
    const level = this.newLevel(archive, this.t.archive, !previous)
    level.held = heldBytes(archive, 0)
    if (previous) {
      for (const path of previous.expanded) {
        if (findNode(level.root, path)?.dir) level.expanded.add(path)
      }
      if (previous.selected && findNode(level.root, previous.selected)) level.selected = previous.selected
      level.filter = previous.filter
      level.scrollTop = this.levels.length === 1 ? this.scroll.scrollTop : previous.scrollTop
    }
    this.encoding = archive.encoding
    this.levels = [level]
    if (this.root.firstChild !== this.layout) this.root.replaceChildren(this.layout)
    this.renderLevel(!previous)
    if (!previous) this.autoOpen(level)
  }

  /** A compressed archive (`bundle.zip.gz`) opens straight into the archive inside it. */
  private autoOpen(level: Level): void {
    if (!autoOpens(this.levels.length, level.archive) || this.level !== level) return
    const node = level.root.children[0]
    if (!node?.entry || node.dir) return
    try {
      if (!isArchive(level.archive.read(node.entry, 64 * 1024).bytes)) return
    } catch {
      return
    }
    void this.openNested(node, undefined, false)
  }

  private newLevel(archive: Archive, label: string, fresh: boolean): Level {
    const root = archiveTree(archive)
    const level: Level = {
      archive,
      label,
      root,
      expanded: new Set(),
      selected: null,
      filter: '',
      scrollTop: 0,
      dates: archive.entries.some((entry) => entry.mtime !== undefined),
      held: 0
    }
    if (fresh) {
      // One folder at the top (a typical .tar.gz or GitHub zip): open it.
      if (root.children.length === 1 && root.children[0].dir) level.expanded.add(root.children[0].path)
      // A .gz of one file: show the file right away; otherwise a README at the top, like GitHub.
      if (root.files === 1 && root.folders === 0) {
        level.selected = root.children[0]?.path ?? null
      } else {
        const top = root.children.length === 1 && root.children[0].dir ? root.children[0] : root
        const readme = top.children.find((child) => !child.dir && README.test(child.name))
        if (readme) level.selected = readme.path
      }
    }
    return level
  }

  private renderLevel(focus: boolean): void {
    const level = this.level
    if (!level) return
    this.renderBar()
    this.filterInput.value = level.filter
    this.updateColumns()
    this.refreshRows()
    this.scroll.scrollTop = level.scrollTop
    if (level.selected) this.reveal(level.selected)
    this.renderRows()
    this.renderPreview()
    if (focus) this.scroll.focus({ preventScroll: true })
  }

  // Toolbar

  private renderBar(): void {
    const level = this.level
    if (!level) return
    const { archive, root } = level
    const t = this.t

    this.crumbs.replaceChildren()
    this.crumbs.hidden = this.levels.length < 2
    this.levels.forEach((item, index) => {
      if (index) this.crumbs.append(h('span', { className: 'av-crumb-sep', 'aria-hidden': 'true' }, svg(icon('chevron'))))
      const current = index === this.levels.length - 1
      const crumb = h(
        'button',
        { className: 'av-crumb', type: 'button', title: visibleText(item.label), 'aria-current': current ? 'true' : undefined },
        visibleText(item.label)
      )
      if (!current) crumb.addEventListener('click', () => this.goTo(index))
      this.crumbs.append(crumb)
    })

    this.badge.textContent = archive.format
    const parts = [t.files(root.files)]
    if (root.folders) parts.push(t.folders(root.folders))
    parts.push(this.size(root.size))
    if (this.compressed(archive)) {
      const packed = `${t.packed.toLowerCase()} ${this.size(archive.archiveSize)}`
      parts.push(this.saves(archive, root) ? `${packed} (${formatRatio(archive.archiveSize, root.size, this.locale)})` : packed)
    }
    this.summary.textContent = parts.join(' · ')
    this.summary.title = this.summary.textContent

    this.encodingField.hidden = !archive.legacyNames
    this.encodingSelect.value = archive.encoding
    // A tree past its folder budget is shown as damaged too: only crafted names get there.
    this.notice.hidden = !archive.damaged && !root.cut
    // A damaged .gz of one file shows the part of that file that came before the damage.
    this.noticeText.textContent = archive.kind === 'single' ? t.damagedFile : t.damaged
    const folders = root.folders > 0
    this.expandButton.disabled = !folders
    this.collapseButton.disabled = !folders
  }

  /** ZIP and compressed streams: the archive file has its own, packed size. */
  private compressed(archive: Archive): boolean {
    return archive.format !== 'TAR'
  }

  /** A ratio is worth showing: the archive is smaller than what it holds (tiny archives are not,
   *  and a damaged one may list only part of its contents). */
  private saves(archive: Archive, root: TreeNode): boolean {
    return !archive.damaged && root.size > 0 && archive.archiveSize < root.size
  }

  private size(bytes: number): string {
    return formatSize(bytes, this.locale, this.t.units)
  }

  private exact(bytes: number): string {
    return `${formatBytes(bytes, this.locale)} ${this.t.units.b}`
  }

  // Tree

  private updateColumns(): void {
    const level = this.level
    if (!level) return
    const width = this.tree.clientWidth || 600
    const size = width >= 290
    const packed = level.archive.kind === 'zip' && width >= 390
    const date = level.dates && width >= 470
    this.tree.dataset.size = size ? 'on' : 'off'
    this.tree.dataset.packed = packed ? 'on' : 'off'
    this.tree.dataset.date = date ? 'on' : 'off'
    const columns = ['minmax(0, 1fr)']
    if (size) columns.push('64px')
    if (packed) columns.push('64px')
    if (date) columns.push('112px')
    this.tree.style.setProperty('--columns', columns.join(' '))
  }

  private refreshRows(): void {
    const level = this.level
    if (!level) return
    this.rows = visibleRows(level.root, level.expanded, level.filter)
    this.sizer.style.height = `${this.rows.length * ROW}px`
    const query = level.filter.trim()
    this.empty.hidden = this.rows.length > 0
    this.empty.textContent = query ? fill(this.t.noMatches, { q: query }) : this.t.empty
  }

  private scheduleRows(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderRows()
    })
  }

  private renderRows(): void {
    const level = this.level
    if (!level) return
    const top = this.scroll.scrollTop
    const height = this.scroll.clientHeight || 800
    const start = Math.max(0, Math.floor(top / ROW) - OVERSCAN)
    const end = Math.min(this.rows.length, Math.ceil((top + height) / ROW) + OVERSCAN)
    this.rowsEl.style.transform = `translateY(${start * ROW}px)`
    const items: HTMLElement[] = []
    for (let index = start; index < end; index++) items.push(this.rowElement(index, level))
    this.rowsEl.replaceChildren(...items)
  }

  private isOpen(node: TreeNode, level: Level): boolean {
    return node.dir && (level.filter.trim() !== '' || level.expanded.has(node.path))
  }

  private kindIcon(node: TreeNode): [IconName, string] {
    if (node.dir) return ['folder', 'av-folder']
    const entry = node.entry
    if (entry?.encrypted) return ['lock', 'av-lock']
    if (entry?.link && !entry.link.hard) return ['link', '']
    const kind = nameKind(node.name)
    if (kind === 'archive') return ['archive', 'av-arch']
    if (kind === 'image') return ['image', 'av-pic']
    if (kind === 'text') return ['text', '']
    return ['file', '']
  }

  private rowElement(index: number, level: Level): HTMLElement {
    const { node, depth } = this.rows[index]
    const open = this.isOpen(node, level)
    const [kind, kindClass] = this.kindIcon(node)
    const name = h('span', { className: 'av-name' }, highlight(node.name, level.filter))
    if (node.entry?.link) append(name, h('span', { className: 'av-target' }, `→ ${visibleText(node.entry.link.target)}`))
    if (node.duplicate) {
      const { copy, copies } = node.duplicate
      append(name, h('span', { className: 'av-dup' }, fill(this.t.duplicate, { n: String(copy), count: String(copies) })))
    }
    const packedKnown = node.dir ? node.hasPacked && node.files > 0 : node.entry?.packed !== undefined
    const row = h(
      'div',
      {
        className: node.dir ? 'av-row av-dir' : 'av-row',
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-selected': node.path === level.selected ? 'true' : 'false',
        'aria-expanded': node.dir ? String(open) : undefined,
        'data-index': index,
        title: visibleText(shownPath(node))
      },
      h('span', { className: 'av-twisty', 'data-open': String(open) }, node.dir && node.children.length ? svg(icon('chevron')) : null),
      h('span', { className: `av-kind ${kindClass}` }, svg(icon(kind))),
      name,
      h('span', { className: 'av-cell av-c-size', title: this.exact(node.size) }, node.dir && !node.files ? '' : this.size(node.size)),
      h('span', { className: 'av-cell av-c-packed' }, packedKnown ? this.size(node.packed) : ''),
      h('span', { className: 'av-cell av-c-date' }, formatShortDate(node.mtime, this.locale))
    )
    row.style.paddingLeft = `${8 + depth * 16}px`
    return row
  }

  private rowAt(event: Event): Row | null {
    const target = event.target instanceof Element ? event.target.closest('.av-row') : null
    const index = Number(target?.getAttribute('data-index'))
    return target && Number.isInteger(index) ? (this.rows[index] ?? null) : null
  }

  private select(path: string | null): void {
    const level = this.level
    if (!level || level.selected === path) return
    level.selected = path
    if (path) this.reveal(path)
    this.renderRows()
    this.renderPreview()
  }

  /** Scrolls the row into view, opening the folders above it when it is folded away. */
  private reveal(path: string): void {
    const level = this.level
    if (!level) return
    let index = this.rows.findIndex((row) => row.node.path === path)
    if (index < 0 && !level.filter.trim()) {
      for (const folder of ancestors(path)) level.expanded.add(folder)
      this.refreshRows()
      index = this.rows.findIndex((row) => row.node.path === path)
    }
    if (index < 0) return
    const top = index * ROW
    const height = this.scroll.clientHeight
    if (top < this.scroll.scrollTop) this.scroll.scrollTop = top
    else if (height && top + ROW > this.scroll.scrollTop + height) this.scroll.scrollTop = top + ROW - height
  }

  private toggle(node: TreeNode, open?: boolean): void {
    const level = this.level
    if (!level || !node.dir || level.filter.trim()) return
    const next = open ?? !level.expanded.has(node.path)
    if (next) level.expanded.add(node.path)
    else level.expanded.delete(node.path)
    const hidesSelection = !next && level.selected?.startsWith(`${node.path}/`)
    if (hidesSelection) level.selected = node.path
    this.refreshRows()
    this.renderRows()
    if (hidesSelection) this.renderPreview()
  }

  private setAll(open: boolean): void {
    const level = this.level
    if (!level) return
    level.expanded = open ? new Set(folderPaths(level.root)) : new Set()
    if (!open && level.selected?.includes('/')) level.selected = level.selected.split('/')[0]
    this.refreshRows()
    this.renderRows()
    this.renderPreview()
  }

  private setFilter(value: string): void {
    const level = this.level
    if (!level) return
    level.filter = value
    if (this.filterInput.value !== value) this.filterInput.value = value
    this.refreshRows()
    this.scroll.scrollTop = 0
    if (level.selected) this.reveal(level.selected)
    this.renderRows()
  }

  private setEncoding(encoding: LegacyEncoding): void {
    const level = this.level
    if (!level || level.archive.encoding === encoding) return
    this.encoding = encoding
    const archive = level.archive.withEncoding(encoding)
    const renamed = renamedPaths(level.archive.entries, archive.entries)
    const rename = (path: string) => renamed.get(path) ?? path
    level.archive = archive
    level.root = archiveTree(archive)
    level.expanded = new Set([...level.expanded].map(rename))
    if (level.selected) level.selected = rename(level.selected)
    level.scrollTop = this.scroll.scrollTop
    this.renderLevel(false)
  }

  private goTo(index: number): void {
    if (index < 0 || index >= this.levels.length - 1) return
    this.levels.length = index + 1
    this.renderLevel(true)
  }

  // Events

  private wire(): void {
    this.scroll.addEventListener('scroll', () => {
      const level = this.level
      if (level) level.scrollTop = this.scroll.scrollTop
      this.scheduleRows()
    })
    new ResizeObserver(() => {
      this.updateColumns()
      this.scheduleRows()
    }).observe(this.tree)

    this.rowsEl.addEventListener('mousedown', (event) => {
      // Keep keyboard focus on the tree, not on the row under the mouse.
      if (event.button === 0) event.preventDefault()
      this.scroll.focus({ preventScroll: true })
    })
    this.rowsEl.addEventListener('click', (event) => {
      const row = this.rowAt(event)
      if (!row) return
      const onTwisty = event.target instanceof Element && event.target.closest('.av-twisty')
      if (onTwisty && row.node.dir) this.toggle(row.node)
      this.select(row.node.path)
    })
    this.rowsEl.addEventListener('dblclick', (event) => {
      const row = this.rowAt(event)
      if (!row) return
      if (event.target instanceof Element && event.target.closest('.av-twisty')) return
      if (row.node.dir) this.toggle(row.node)
      else if (this.canOpen(row.node)) void this.openNested(row.node)
    })
    this.scroll.addEventListener('keydown', (event) => this.onTreeKey(event))
    pointerFocus(this.scroll)

    this.filterInput.addEventListener('input', () => this.setFilter(this.filterInput.value))
    this.filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (this.filterInput.value) this.setFilter('')
        else this.scroll.focus({ preventScroll: true })
        event.preventDefault()
      } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
        const level = this.level
        const shown = level && this.rows.some((row) => row.node.path === level.selected)
        if (level && !shown && this.rows.length) this.select(this.rows[0].node.path)
        this.scroll.focus({ preventScroll: true })
        event.preventDefault()
      }
    })
    this.encodingSelect.addEventListener('change', () => this.setEncoding(this.encodingSelect.value as LegacyEncoding))
    this.expandButton.addEventListener('click', () => this.setAll(true))
    this.collapseButton.addEventListener('click', () => this.setAll(false))

    document.addEventListener('keydown', (event) => {
      if (!this.level || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.code === 'KeyF' || event.key.toLowerCase() === 'f') {
        event.preventDefault()
        this.filterInput.focus()
        this.filterInput.select()
      }
    })

    this.split.addEventListener('pointerdown', (event) => {
      if (getComputedStyle(this.split).cursor !== 'col-resize') return
      event.preventDefault()
      this.split.setPointerCapture(event.pointerId)
      this.split.classList.add('av-dragging')
      const box = this.main.getBoundingClientRect()
      let width = 0
      const move = (moveEvent: PointerEvent) => {
        width = Math.round(clamp(moveEvent.clientX - box.left, 240, Math.max(240, box.width - 280)))
        this.main.style.setProperty('--tree', `${width}px`)
      }
      const end = () => {
        this.split.classList.remove('av-dragging')
        this.split.removeEventListener('pointermove', move)
        if (width) storageSet('archive-viewer.tree', String(width))
      }
      this.split.addEventListener('pointermove', move)
      this.split.addEventListener('pointerup', end, { once: true })
      this.split.addEventListener('pointercancel', end, { once: true })
    })
    this.split.addEventListener('dblclick', () => {
      this.main.style.removeProperty('--tree')
      storageSet('archive-viewer.tree', null)
    })
  }

  private onTreeKey(event: KeyboardEvent): void {
    const level = this.level
    if (!level || event.metaKey || event.ctrlKey || event.altKey) return
    const rows = this.rows
    const index = level.selected === null ? -1 : rows.findIndex((row) => row.node.path === level.selected)
    const row = index >= 0 ? rows[index] : undefined
    const page = Math.max(1, Math.floor(this.scroll.clientHeight / ROW) - 1)
    const move = (to: number) => {
      if (rows.length) this.select(rows[clamp(to, 0, rows.length - 1)].node.path)
    }
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1)
        break
      case 'ArrowUp':
        move(index < 0 ? rows.length - 1 : index - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(rows.length - 1)
        break
      case 'PageDown':
        move(index + page)
        break
      case 'PageUp':
        move(index - page)
        break
      case 'ArrowRight':
        if (row?.node.dir) {
          if (!this.isOpen(row.node, level)) this.toggle(row.node, true)
          else if (row.node.children.length) move(index + 1)
        }
        break
      case 'ArrowLeft':
        if (!row) break
        if (row.node.dir && this.isOpen(row.node, level) && !level.filter.trim()) this.toggle(row.node, false)
        else if (parentPath(row.node.path)) this.select(parentPath(row.node.path))
        break
      case 'Enter':
        if (!row) break
        if (row.node.dir) this.toggle(row.node)
        else if (this.canOpen(row.node)) void this.openNested(row.node)
        break
      case 'Escape':
        if (level.filter) this.setFilter('')
        else if (this.levels.length > 1) this.goTo(this.levels.length - 2)
        else if (level.selected !== null) this.select(null)
        else return
        break
      case 'Backspace':
        if (this.levels.length < 2) return
        this.goTo(this.levels.length - 2)
        break
      default:
        return
    }
    event.preventDefault()
  }

  private canOpen(node: TreeNode): boolean {
    if (node.dir || !node.entry || node.entry.encrypted) return false
    if (node.path === this.level?.selected && this.previewKind) return this.previewKind === 'archive'
    return nameKind(node.name) === 'archive'
  }

  // Preview

  private clearPreview(): void {
    this.previewToken++
    clearTimeout(this.previewTimer)
    this.previewKind = null
    this.body = null
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = null
    }
  }

  private renderPreview(): void {
    this.clearPreview()
    const level = this.level
    if (!level) return
    const node = level.selected === null ? null : findNode(level.root, level.selected)
    if (!node || node === level.root) this.preview.replaceChildren(this.overview(level))
    else if (node.dir) this.preview.replaceChildren(this.folderView(node, level))
    else this.preview.replaceChildren(...this.fileView(node, level))
  }

  private meta(): { list: HTMLDListElement; add: (label: string, value: string, options?: { mono?: boolean; title?: string }) => void } {
    const list = h('dl', { className: 'av-meta' })
    const add = (label: string, value: string, options: { mono?: boolean; title?: string } = {}) => {
      if (!value) return
      append(list, h('dt', {}, label), h('dd', { className: options.mono ? 'av-mono' : undefined, title: options.title }, value))
    }
    return { list, add }
  }

  private overview(level: Level): HTMLElement {
    const { archive, root } = level
    const t = this.t
    const { list, add } = this.meta()
    add(t.format, archive.format)
    add(t.contents, [t.files(root.files), root.folders ? t.folders(root.folders) : ''].filter(Boolean).join(', '))
    add(t.size, this.size(root.size), { title: this.exact(root.size) })
    if (this.compressed(archive)) {
      add(t.packed, this.size(archive.archiveSize), { title: this.exact(archive.archiveSize) })
      if (this.saves(archive, root)) add(t.ratio, formatRatio(archive.archiveSize, root.size, this.locale))
    }
    if (archive.legacyNames) add(t.encoding, t[archive.encoding])
    const title = this.levels.length > 1 ? visibleText(level.label) : fill(t.archiveOf, { format: archive.format })
    return h(
      'div',
      { className: 'av-body' },
      h(
        'div',
        { className: 'av-overview' },
        h('div', { className: 'av-big' }, svg(icon('archive'))),
        h('h2', {}, title),
        list,
        archive.comment ? h('div', {}, h('p', {}, t.comment), h('pre', { className: 'av-comment' }, archive.comment)) : null,
        h('p', {}, root.files || root.folders ? t.overviewHint : t.empty)
      )
    )
  }

  private head(node: TreeNode, iconName: IconName, iconClass: string, list: HTMLElement, actions: HTMLElement): HTMLElement {
    return h(
      'header',
      { className: 'av-head' },
      h('div', { className: 'av-title' }, svg(icon(iconName, iconClass)), h('h2', { title: visibleText(node.name) }, visibleText(node.name))),
      shownPath(node).includes('/') ? h('div', { className: 'av-path' }, visibleText(shownPath(node))) : null,
      list,
      actions
    )
  }

  private button(iconName: IconName, label: string, options: { primary?: boolean; title?: string } = {}): HTMLButtonElement {
    return h(
      'button',
      { className: options.primary ? 'av-btn av-primary' : 'av-btn', type: 'button', title: options.title },
      svg(icon(iconName)),
      label
    )
  }

  private copyButton(path: string): HTMLButtonElement {
    const button = this.button('copy', this.t.copyPath)
    button.addEventListener('click', () => void this.copy(path))
    return button
  }

  private folderView(node: TreeNode, level: Level): HTMLElement {
    const t = this.t
    const { list, add } = this.meta()
    add(t.contents, [t.files(node.files), node.folders ? t.folders(node.folders) : ''].filter(Boolean).join(', '))
    add(t.size, this.size(node.size), { title: this.exact(node.size) })
    if (level.archive.kind === 'zip' && node.hasPacked && node.files) {
      const ratio = node.packed < node.size ? ` · ${formatRatio(node.packed, node.size, this.locale)}` : ''
      add(t.packed, `${this.size(node.packed)}${ratio}`)
    }
    add(t.modified, formatDate(node.mtime, this.locale))
    if (node.entry?.mode !== undefined) add(t.mode, this.mode(node.entry.mode), { mono: true })
    const actions = h('div', { className: 'av-actions' }, this.copyButton(shownPath(node)))
    return this.head(node, 'folder', 'av-folder', list, actions)
  }

  private mode(mode: number): string {
    return `${formatMode(mode)}  ${(mode & 0o7777).toString(8).padStart(4, '0')}`
  }

  private fileView(node: TreeNode, level: Level): HTMLElement[] {
    const t = this.t
    const entry = node.entry as Entry
    const [kind, kindClass] = this.kindIcon(node)
    const { list, add } = this.meta()
    add(t.size, this.size(entry.size), { title: this.exact(entry.size) })
    if (level.archive.kind === 'zip' && entry.packed !== undefined) {
      const ratio = entry.packed < entry.size ? formatRatio(entry.packed, entry.size, this.locale) : ''
      add(t.packed, ratio ? `${this.size(entry.packed)} · ${ratio}` : this.size(entry.packed), { title: this.exact(entry.packed) })
    }
    add(t.method, methodLabel(entry.method, t))
    add(t.modified, formatDate(entry.mtime, this.locale))
    if (entry.mode !== undefined) add(t.mode, this.mode(entry.mode), { mono: true })
    if (entry.crc !== undefined && level.archive.kind === 'zip') add(t.crc, formatCrc(entry.crc), { mono: true })
    if (entry.link) add(entry.link.hard ? t.hardLink : t.link, visibleText(entry.link.target), { mono: true })
    if (node.duplicate) {
      const { copy, copies } = node.duplicate
      add(t.duplicateLabel, fill(t.duplicateHint, { n: String(copy), count: String(copies) }))
    }

    const actions = h('div', { className: 'av-actions' })
    const symlink = !!entry.link && !entry.link.hard
    let save: HTMLButtonElement | null = null
    if (this.saveAs) {
      save = this.button('save', t.save, { title: entry.size > SAVE_LIMIT ? t.saveTooBig : t.saveHint })
      save.disabled = symlink || !!entry.encrypted || entry.size > SAVE_LIMIT
      save.addEventListener('click', () => this.save(node, entry))
      actions.append(save)
    }
    actions.append(this.copyButton(shownPath(node)))

    const body = h('div', { className: 'av-body' })
    this.body = body
    if (symlink) {
      body.append(this.callout('link', '', `${t.link} ${visibleText(entry.link?.target ?? '')}`))
    } else if (entry.encrypted) {
      body.append(this.callout('lock', 'av-warn', t.encrypted))
    } else {
      const token = this.previewToken
      if (entry.size <= QUICK_PREVIEW) {
        this.loadBody(node, entry, token, body, add, actions, save)
      } else {
        // A short wait, so holding ↓ through big files does not unpack each of them.
        body.append(h('div', { className: 'av-center' }, h('div', { className: 'av-spinner' })))
        this.previewTimer = setTimeout(() => this.loadBody(node, entry, token, body, add, actions, save), 60)
      }
    }
    return [this.head(node, kind, kindClass, list, actions), body]
  }

  private loadBody(
    node: TreeNode,
    entry: Entry,
    token: number,
    body: HTMLElement,
    addMeta: (label: string, value: string, options?: { mono?: boolean; title?: string }) => void,
    actions: HTMLElement,
    save: HTMLButtonElement | null
  ): void {
    const level = this.level
    if (!level || token !== this.previewToken) return
    const t = this.t
    let result: ReadResult
    try {
      result = level.archive.read(entry, TEXT_LIMIT)
    } catch (error) {
      body.replaceChildren(this.entryError(error, entry))
      if (save) save.disabled = true
      return
    }
    // Names in a Cyrillic code page suggest the text inside is Cyrillic too.
    const fallback = level.archive.legacyNames && level.archive.encoding !== 'cp437' ? 'windows-1251' : this.fallback
    let content = classify(node.name, result.bytes, result.truncated, fallback)
    if (content.kind !== 'image' && result.truncated && entry.size <= IMAGE_LIMIT) {
      const mime = imageType(node.name, result.bytes)
      if (mime) {
        try {
          const whole = level.archive.read(entry, IMAGE_LIMIT)
          if (!whole.truncated) {
            result = whole
            content = { kind: 'image', mime }
          }
        } catch {
          // Shown as binary below.
        }
      }
    }
    this.previewKind = content.kind
    const parts: HTMLElement[] = []
    if (result.crcOk === false) parts.push(this.callout('warning', 'av-warn', t.crcBad))

    if (content.kind === 'image') {
      parts.push(this.imageBody(node, result.bytes, content.mime, addMeta, body))
    } else if (content.kind === 'archive') {
      const open = this.button('open', t.open, { primary: true, title: t.openHint })
      open.addEventListener('click', () => void this.openNested(node, open))
      actions.prepend(open)
      parts.push(this.callout('archive', '', t.nestedTitle, t.nestedText))
    } else if (content.kind === 'text') {
      addMeta(t.encoding, content.decoded.encoding)
      if (result.truncated) parts.push(h('p', { className: 'av-note' }, fill(t.textCut, { size: this.size(result.bytes.length) })))
      parts.push(this.textBody(content.decoded.text, actions))
    } else {
      // An archive in a format the viewer does not open says so, above its first bytes.
      if (content.kind === 'unsupported') parts.push(this.callout('archive', 'av-warn', fill(t.unsupported, { format: content.format })))
      const shown = Math.min(result.bytes.length, HEX_LIMIT)
      parts.push(h('p', { className: 'av-note' }, fill(t.binary, { size: this.size(shown) })))
      parts.push(h('pre', { className: 'av-hex' }, hexDump(result.bytes, HEX_LIMIT)))
    }
    body.replaceChildren(...parts)
  }

  private textBody(raw: string, actions: HTMLElement): HTMLElement {
    const text = raw.replace(/\r\n?/g, '\n')
    let lines = 1
    let longest = 0
    let start = 0
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        longest = Math.max(longest, i - start)
        start = i + 1
        if (i < text.length - 1) lines++
      }
    }
    longest = Math.max(longest, text.length - start)
    const numbers = new Array<number>(lines)
    for (let i = 0; i < lines; i++) numbers[i] = i + 1
    const code = h(
      'div',
      { className: 'av-code' },
      h('pre', { className: 'av-gutter', 'aria-hidden': 'true' }, numbers.join('\n')),
      h('pre', { className: 'av-text' }, text)
    )
    const forced = longest > LONG_LINE
    const wrap = h('button', { className: 'av-btn av-square', type: 'button', title: this.t.wrap, 'aria-label': this.t.wrap }, svg(icon('wrap')))
    const apply = (on: boolean) => {
      code.classList.toggle('av-wrapped', on)
      wrap.setAttribute('aria-pressed', String(on))
    }
    apply(this.wrap || forced)
    wrap.addEventListener('click', () => {
      const on = !code.classList.contains('av-wrapped')
      apply(on)
      this.wrap = on
      storageSet('archive-viewer.wrap', on ? '1' : null)
    })
    actions.append(wrap)
    return code
  }

  private imageBody(
    node: TreeNode,
    bytes: Uint8Array,
    mime: string,
    addMeta: (label: string, value: string) => void,
    body: HTMLElement
  ): HTMLElement {
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }))
    this.imageUrl = url
    const img = h('img', { alt: node.name, src: url, decoding: 'async', draggable: 'false' })
    img.addEventListener('load', () => {
      if (img.naturalWidth) addMeta(this.t.dimensions, `${img.naturalWidth} × ${img.naturalHeight}`)
    })
    img.addEventListener('error', () => {
      if (this.imageUrl !== url) return
      const shown = Math.min(bytes.length, HEX_LIMIT)
      body.replaceChildren(
        h('p', { className: 'av-note' }, fill(this.t.binary, { size: this.size(shown) })),
        h('pre', { className: 'av-hex' }, hexDump(bytes, HEX_LIMIT))
      )
    })
    return h('div', { className: 'av-image' }, img)
  }

  private callout(iconName: IconName, tone: string, title: string, text?: string, ...extra: HTMLElement[]): HTMLElement {
    return h(
      'div',
      { className: tone ? `av-callout ${tone}` : 'av-callout', role: tone === 'av-danger' ? 'alert' : undefined },
      svg(icon(iconName)),
      h('div', {}, text ? h('strong', {}, title) : h('p', {}, title), text ? h('p', {}, text) : null, ...extra)
    )
  }

  private entryError(error: unknown, entry: Entry): HTMLElement {
    const t = this.t
    if (error instanceof EntryError) {
      if (error.code === 'encrypted') return this.callout('lock', 'av-warn', t.encrypted)
      if (error.code === 'method') {
        return this.callout('warning', 'av-warn', fill(t.unsupportedMethod, { method: error.detail || entry.method || '?' }))
      }
      if (error.code === 'missing') return this.callout('link', 'av-warn', t.missing)
      if (error.code === 'unsupported') {
        const text = t.features[error.detail as UnsupportedFeature]
        if (text) return this.callout('warning', 'av-warn', text)
      }
    }
    console.warn('[archive-viewer] cannot unpack', entry.path, error)
    return this.callout('warning', 'av-danger', t.damagedEntry)
  }

  // Actions

  private async openNested(node: TreeNode, button?: HTMLButtonElement, wait = true): Promise<void> {
    const level = this.level
    const entry = node.entry
    if (!level || !entry || this.opening) return
    this.opening = true
    const selected = level.selected
    // The tree stays usable while a big archive unpacks: leaving this level or selecting another
    // row stops the work.
    const moved = () => this.level !== level || level.selected !== selected
    const label = button?.lastChild?.textContent ?? ''
    if (button) {
      button.disabled = true
      if (button.lastChild) button.lastChild.textContent = this.t.opening
    }
    try {
      // Let "Opening…" paint before a big archive is unpacked on this thread.
      if (wait) await pause()
      const held = this.levels.reduce((sum, item) => sum + item.held, 0)
      const budget = nestedLimit(this.levels.length, held)
      const result = level.archive.read(entry, budget)
      if (result.truncated) throw new TooLargeError(budget)
      const archive = await openArchive(result.bytes, {
        encoding: this.encoding,
        name: node.name,
        limit: budget - result.bytes.length,
        pacing: { cancelled: moved }
      })
      if (moved()) return
      level.selected = node.path
      level.scrollTop = this.scroll.scrollTop
      const next = this.newLevel(archive, node.name, true)
      next.held = heldBytes(archive, result.bytes.length)
      this.levels.push(next)
      this.renderLevel(true)
    } catch (error) {
      if (this.level !== level || level.selected !== node.path || error instanceof CancelledError) return
      const expected = [UnsupportedFormatError, NotArchiveError, TooLargeError, TooDeepError, UnsupportedDataError]
      if (!expected.some((type) => error instanceof type)) {
        console.warn('[archive-viewer] cannot open nested archive', node.path, error)
      }
      const message = this.callout('warning', 'av-danger', this.t.errorTitle, describeOpenError(error, this.t, this.locale))
      this.body?.replaceChildren(message)
    } finally {
      this.opening = false
      if (button?.isConnected) {
        button.disabled = false
        if (button.lastChild) button.lastChild.textContent = label
      }
    }
  }

  private save(node: TreeNode, entry: Entry): void {
    const saveAs = this.saveAs
    const level = this.level
    if (!saveAs || !level) return
    let result: ReadResult
    try {
      result = level.archive.read(entry, SAVE_LIMIT)
    } catch (error) {
      console.warn('[archive-viewer] cannot unpack for saving', entry.path, error)
      const feature = error instanceof EntryError && error.code === 'unsupported' ? this.t.features[error.detail as UnsupportedFeature] : ''
      this.showToast(feature || this.t.saveFailed)
      return
    }
    if (result.truncated) {
      this.showToast(this.t.saveTooBig)
      return
    }
    // A copy: the entry can be a view into the whole archive.
    // Without hidden characters, so the name the dialog offers is the one it looks like.
    saveAs({ suggestedName: saveName(node.name, 'file'), mimeType: IMAGE_TYPES[extension(node.name)], data: result.bytes.slice() }).then(
      (outcome) => {
        if (outcome.status === 'saved') this.showToast(this.t.saved)
      },
      (error: unknown) => {
        console.warn('[archive-viewer] save failed', error)
        this.showToast(this.t.saveFailed)
      }
    )
  }

  private async copy(text: string): Promise<void> {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // The frame may not have clipboard access; try the old way.
      const area = h('textarea', { readonly: true, 'aria-hidden': 'true' })
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      area.style.pointerEvents = 'none'
      const focused = document.activeElement
      document.body.append(area)
      area.select()
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      area.remove()
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
    }
    this.showToast(ok ? this.t.copied : this.t.copyFailed)
  }

  private showToast(text: string): void {
    this.toast.textContent = text
    this.toast.classList.add('av-show')
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => this.toast.classList.remove('av-show'), 1800)
  }
}
