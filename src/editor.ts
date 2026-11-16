// The custom editor: Orca opens an archive in a main editor tab here — from the file tree, a file
// link in a chat, or `orca file open` — and sends its bytes. Orca 1.4.258 reads at most 50 MiB
// for a tab (its 64 MiB plugin bridge limit is never reached) and shows its own notice for larger
// files instead. The viewer never edits, so Orca never saves the
// tab; an outside write reopens the archive and keeps the open folders and the selection.

import { defaultLegacyEncoding } from './archive/names'
import { openArchive } from './archive/open'
import { stringsFor } from './i18n'
import { installStyles } from './styles'
import { ArchiveView, describeOpenError } from './view'

const locale = globalThis.orca?.locale || navigator.language || 'en'
const strings = stringsFor(locale)
installStyles()
const view = new ArchiveView({
  strings,
  locale,
  encoding: defaultLegacyEncoding(locale),
  saveAs: globalThis.orca?.files?.saveAs
})
document.body.append(view.root)
view.showLoading()

const api = globalThis.orca?.document
if (!api) {
  view.showError(strings.errorTitle, strings.noHost)
} else {
  let generation = 0
  let loaded = false
  api.onDidChange(async (doc) => {
    const current = ++generation
    if (doc.content.kind !== 'bytes') {
      loaded = false
      view.showError(strings.errorTitle, strings.textContent)
      return
    }
    if (!loaded) view.showLoading()
    // Let the spinner paint before a big .tar.gz is unpacked on this thread.
    await new Promise((resolve) => setTimeout(resolve, 16))
    if (current !== generation) return
    const bytes = new Uint8Array(doc.content.bytes)
    try {
      // Orca never tells an editor the file's name; the matched suffix names a lone .gz's file.
      const name = doc.fileType ? `file.${doc.fileType}` : undefined
      const archive = await openArchive(bytes, { encoding: view.encoding, name })
      if (current !== generation) return
      view.show(archive)
      loaded = true
    } catch (error) {
      if (current !== generation) return
      console.warn('[archive-viewer] cannot open the archive', error)
      loaded = false
      view.showError(strings.errorTitle, describeOpenError(error, strings, locale))
    }
  })
}
