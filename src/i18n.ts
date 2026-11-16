// UI strings in English and Russian; Orca's UI language picks one (`orca.locale`).

type Plural = (n: number) => string

const enPlural = (one: string, many: string): Plural => (n) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** Russian plural forms: 1 файл, 2 файла, 5 файлов, 21 файл. */
const ruPlural = (one: string, few: string, many: string): Plural => (n) => {
  const tens = n % 100
  const ones = n % 10
  const word = tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many
  return `${n.toLocaleString('ru')} ${word}`
}

const en = {
  archive: 'Archive',
  archiveOf: '{format} archive',
  files: enPlural('file', 'files'),
  folders: enPlural('folder', 'folders'),
  filter: 'Filter by name',
  filterHint: 'Filter by name (⌘F)',
  expandAll: 'Expand all folders',
  collapseAll: 'Collapse all folders',
  names: 'Names',
  encodingHint: 'Code page for file names the archive stores without UTF-8',
  cp437: 'CP437 · DOS Western',
  cp866: 'CP866 · DOS Cyrillic',
  'windows-1251': 'Windows-1251 · Cyrillic',
  colName: 'Name',
  colSize: 'Size',
  colPacked: 'Packed',
  colModified: 'Modified',
  empty: 'This archive is empty.',
  noMatches: 'No names contain “{q}”.',
  damaged: 'The archive is damaged or cut off. It shows the files that could be read.',
  damagedFile: 'The archive is damaged or cut off. It shows the part of the file that could be read.',
  overviewHint: 'Select a file to preview it. ↑ ↓ move, ← → fold, Enter opens an archive inside.',
  comment: 'Comment',
  format: 'Format',
  contents: 'Contents',
  size: 'Size',
  packed: 'Packed',
  ratio: 'Ratio',
  method: 'Method',
  modified: 'Modified',
  mode: 'Permissions',
  crc: 'CRC-32',
  link: 'Link to',
  hardLink: 'Hard link to',
  encoding: 'Encoding',
  dimensions: 'Dimensions',
  save: 'Save…',
  saveHint: 'Save this file with Orca’s save dialog',
  saveTooBig: 'Files over 64 MB cannot be saved from Archive Viewer',
  saved: 'Saved',
  saveFailed: 'Could not save the file',
  copyPath: 'Copy path',
  copied: 'Path copied',
  copyFailed: 'Could not copy the path',
  open: 'Open archive',
  openHint: 'Browse the files of this archive (Enter)',
  nestedTitle: 'This file is an archive',
  nestedText: 'Open it to browse the files inside. The trail above leads back.',
  opening: 'Opening…',
  wrap: 'Wrap long lines',
  textCut: 'Showing the first {size}.',
  binary: 'Binary file. The first {size} as hex:',
  folderTitle: 'Folder',
  encrypted: 'This file is encrypted. Archive Viewer cannot decrypt it.',
  unsupportedMethod: 'This file is compressed with {method}, which Archive Viewer cannot unpack.',
  damagedEntry: 'This file is damaged and cannot be unpacked.',
  missing: 'The file this link points to is not in the archive.',
  crcBad: 'CRC check failed: the unpacked file differs from what the archive recorded.',
  loading: 'Opening the archive…',
  errorTitle: 'This archive cannot be opened',
  unsupported: '{format} archives are not supported. Archive Viewer opens ZIP, TAR, GZIP, bzip2, XZ and Zstandard.',
  notArchive: 'This file is not an archive Archive Viewer can read.',
  tooLarge: 'It unpacks to more than {size}, which is too much to open in a tab.',
  damagedArchive: 'The archive is damaged.',
  textContent: 'Orca sent this file as text; Archive Viewer needs its raw bytes.',
  noHost: 'This page runs as an Orca custom editor.',
  tooDeep: 'Archive Viewer opens archives inside archives up to {n} levels deep.',
  features: {
    'zstd-window': 'It is Zstandard with a window over 128 MB, more than Archive Viewer unpacks in a tab.',
    'xz-dictionary': 'It is XZ with a dictionary over 64 MB, more than Archive Viewer unpacks.',
    'xz-options': 'It is XZ with a SHA-256 check or a BCJ or delta filter, which Archive Viewer cannot unpack.',
    'tar-sparse': 'This is a sparse file whose map of holes Archive Viewer cannot read, so it is neither shown nor saved.'
  },
  units: { b: 'B', kb: 'KB', mb: 'MB', gb: 'GB' }
}

export type Strings = typeof en

const ru: Strings = {
  archive: 'Архив',
  archiveOf: 'Архив {format}',
  files: ruPlural('файл', 'файла', 'файлов'),
  folders: ruPlural('папка', 'папки', 'папок'),
  filter: 'Фильтр по имени',
  filterHint: 'Фильтр по имени (⌘F)',
  expandAll: 'Раскрыть все папки',
  collapseAll: 'Свернуть все папки',
  names: 'Имена',
  encodingHint: 'Кодировка имён файлов, которые архив хранит не в UTF-8',
  cp437: 'CP437 · DOS, латиница',
  cp866: 'CP866 · DOS, кириллица',
  'windows-1251': 'Windows-1251 · кириллица',
  colName: 'Имя',
  colSize: 'Размер',
  colPacked: 'Сжато',
  colModified: 'Изменён',
  empty: 'Архив пуст.',
  noMatches: 'Нет имён, содержащих «{q}».',
  damaged: 'Архив повреждён или обрезан. Показаны файлы, которые удалось прочитать.',
  damagedFile: 'Архив повреждён или обрезан. Показана часть файла, которую удалось прочитать.',
  overviewHint: 'Выберите файл для просмотра. ↑ ↓ — по списку, ← → — свернуть и раскрыть, Enter — открыть вложенный архив.',
  comment: 'Комментарий',
  format: 'Формат',
  contents: 'Содержимое',
  size: 'Размер',
  packed: 'Сжато',
  ratio: 'Степень сжатия',
  method: 'Метод',
  modified: 'Изменён',
  mode: 'Права',
  crc: 'CRC-32',
  link: 'Ссылка на',
  hardLink: 'Жёсткая ссылка на',
  encoding: 'Кодировка',
  dimensions: 'Размеры',
  save: 'Сохранить…',
  saveHint: 'Сохранить файл через диалог Orca',
  saveTooBig: 'Файлы больше 64 МБ нельзя сохранить из Archive Viewer',
  saved: 'Сохранено',
  saveFailed: 'Не удалось сохранить файл',
  copyPath: 'Копировать путь',
  copied: 'Путь скопирован',
  copyFailed: 'Не удалось скопировать путь',
  open: 'Открыть архив',
  openHint: 'Показать файлы этого архива (Enter)',
  nestedTitle: 'Этот файл — архив',
  nestedText: 'Откройте его, чтобы увидеть файлы внутри. Цепочка сверху ведёт обратно.',
  opening: 'Открываю…',
  wrap: 'Переносить длинные строки',
  textCut: 'Показаны первые {size}.',
  binary: 'Двоичный файл. Первые {size} в шестнадцатеричном виде:',
  folderTitle: 'Папка',
  encrypted: 'Файл зашифрован. Archive Viewer не умеет его расшифровать.',
  unsupportedMethod: 'Файл сжат методом {method}, его Archive Viewer не распаковывает.',
  damagedEntry: 'Файл повреждён и не распаковывается.',
  missing: 'Файла, на который указывает ссылка, нет в архиве.',
  crcBad: 'Контрольная сумма не сошлась: распакованный файл отличается от записанного в архиве.',
  loading: 'Открываю архив…',
  errorTitle: 'Архив не открывается',
  unsupported: 'Архивы {format} не поддерживаются. Archive Viewer открывает ZIP, TAR, GZIP, bzip2, XZ и Zstandard.',
  notArchive: 'Это не архив, который умеет читать Archive Viewer.',
  tooLarge: 'В распакованном виде он больше {size} — слишком много для вкладки.',
  damagedArchive: 'Архив повреждён.',
  textContent: 'Orca передала файл как текст, а просмотрщику нужны исходные байты.',
  noHost: 'Эта страница работает как редактор Orca.',
  tooDeep: 'Archive Viewer открывает вложенные архивы не глубже {n} уровней.',
  features: {
    'zstd-window': 'Это Zstandard с окном больше 128 МБ — больше, чем Archive Viewer распаковывает во вкладке.',
    'xz-dictionary': 'Это XZ со словарём больше 64 МБ — больше, чем распаковывает Archive Viewer.',
    'xz-options': 'Это XZ с проверкой SHA-256 или фильтром BCJ или delta — такое Archive Viewer не распаковывает.',
    'tar-sparse': 'Это разреженный файл, карту пропусков которого Archive Viewer не может прочитать, поэтому он не показывается и не сохраняется.'
  },
  units: { b: 'Б', kb: 'КБ', mb: 'МБ', gb: 'ГБ' }
}

/** Strings for a BCP-47 tag: Russian for `ru*`, English otherwise. */
export function stringsFor(locale: string | undefined): Strings {
  return (locale ?? '').toLowerCase().startsWith('ru') ? ru : en
}

/** Fills `{name}` placeholders. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}
