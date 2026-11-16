# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). `scripts/release-plugin.sh` in the hub turns
`[Unreleased]` into the released version.

## [Unreleased]

### Changed

- Listing images and description: a new cover and five screenshots in the hub's house
  style, made from fictional demo archives (`tools/make-listing-samples.py`,
  `tools/listing.json`); a full-bleed plugin and tab icon; the description fits orca.dev's
  300 characters.
- XZ is decoded by a TypeScript port of XZ Embedded (0BSD) instead of its WebAssembly build, so
  the plugin carries no WebAssembly. The same files open, with the same limits; damage that the
  WebAssembly build let through is now reported, as `xz -d` reports it.

### Added

- Sparse TAR files: GNU `S` headers and the PAX GNU.sparse formats 0.0, 0.1 and 1.0 (macOS
  `tar -cf` writes 1.0 for any file with holes) show their real name and size, and the preview
  and Save get the file with its holes as zeros. A sparse map the viewer cannot read says so
  instead of showing the packed bytes. `tools/cli-crosscheck.sh` compares the tar reader with
  Python's tarfile on archives from macOS tar, GNU tar and tarfile.

### Fixed

- The file tree no longer keeps its keyboard focus ring after mouse clicks.
- TAR dates before 1970 that GNU tar stores in base-256 show their real date instead of
  "Invalid Date", a date of 0 shows as 1970-01-01 instead of none, and a date past what a
  calendar can show is left out.
- A PAX header with a malformed length field (a leading zero, over 20 digits, too short for its
  record) marks the archive damaged and stops there, instead of rescanning the field: a 288-byte
  crafted `.tar.gz` used to freeze the tab for 20 seconds.
- A TAR hard link reads the file it was made from, the last entry at its target path before the
  link, as tar does, instead of a later file with the same path in an appended archive.
- A cut-off or damaged `.tar.bz2`, `.tar.xz` or `.tar.zst` (and a single `.bz2`, `.xz` or
  `.zst` file) shows what could be read before the damage, with the damage notice, as `.tar.gz`
  already did, instead of only "The archive is damaged".
- Unpacking a compressed archive gives the tab's thread back every 40 ms, so the tab keeps
  painting and a newer version of the file, or leaving a nested archive, stops the work
  instead of waiting for it. Large `.bz2` and `.xz` files still take several seconds to open
  (see Known limits in the README).
- The README gave Orca's limit for opening a file in a plugin editor as 64 MB; Orca 1.4.258
  opens files of at most 50 MB there. Save… still goes up to 64 MB.
- The ZIP method "Stored" is translated (Russian "Без сжатия").
- A 7-Zip, RAR, lzip, `.Z` or `.cab` file inside an archive shows "… archives are not
  supported" above its hex dump, as the README promised, instead of only the hex dump.
- Unpacking needs less memory and keeps only what it unpacked: output is collected in blocks
  and joined once into a buffer of its exact size instead of doubling one buffer, a refused
  zip bomb holds at most the 512 MB limit (a 4 GiB GZIP bomb peaked at 1.7 GB, now about
  0.8 GB), XZ sizes its buffer from the file's Index (200 MiB of logs: 633 MB peak, now
  421 MB), and the GZIP size hint is used only when it fits one member. The 1 GB budget for
  archives inside archives counts the buffers each level really keeps.
- Names, titles, paths, link targets and breadcrumbs write out invisible characters as
  ⟨U+202E⟩ (format characters such as bidi controls, control characters, line separators), so a
  name like `photo` U+202E `gpj.exe` no longer reads "photoexe.jpg"; names are bidi-isolated, and
  Save… suggests the name without those characters.
- The filter highlight marks the right characters after a letter whose lowercase is longer,
  such as Turkish İ ("İstanbul notları" with "notlar").
- A name a ZIP lists more than once shows every copy as its own row, marked "copy 1 of 2"
  and so on, instead of only the last: ZIP readers differ on which copy they use. An appended
  tar still shows the last copy, as tar extracts it.
- Very deep paths no longer crash the tab: a name is cut at 1,024 folders or 4,096 characters
  and the archive marked damaged (a 313-byte .tar.gz with one path 70,000 folders deep ran the
  frame out of memory), the tree finds folders by name instead of by whole path, and all folder
  paths of one tree together stay under 64 Mi characters. Revealing a file and keeping open
  folders across a code page switch take time in line with the path's length, not its square.
- ZIP symbolic link targets are read when a row or the preview shows them, once per local
  header, instead of all while the archive opens and again on each code page switch: a 70 KB
  crafted ZIP used to freeze the tab for 12 seconds. Zstandard in a size-capped read stops as
  soon as it has the bytes it needs.
- Stored, bzip2 and Zstandard ZIP entries that unpack to more than their recorded size are
  damaged, as Deflate entries already were; bzip2 and Zstandard stop one byte past that size.
- A ZIP cut off before its end record (a partial download) lists the entries in front of the
  cut from their local headers, data descriptors included, with the damage notice; the central
  records that survive the cut still give modes and links.
- A `.zst` or `.tar.zst` frame that records a content size over 256 MB (what `zstd file.tar`
  writes) opens instead of being called damaged, and smaller ones open several times faster:
  fzstd compared its output buffer with `== 1`, which turned the buffer into a string.
- A file that starts with 1 KB of zeros and then has data (ext4 and other disk images, ISOs) is
  the single file of its `.gz`, `.xz` or `.zst` and a hex dump inside an archive, not an empty
  TAR; zeros are an empty TAR only when nothing else follows.

## [0.1.0] - 2026-11-14

### Added

- Archive Viewer editor for `.zip`, `.jar`, `.war`, `.ear`, `.aar`, `.apk`, `.whl`, `.nupkg`,
  `.vsix`, `.xpi`, `.ipa`, `.epub`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.tbz2`, `.tbz`, `.xz`,
  `.txz`, `.zst` and `.tzst`; formats are recognised by their bytes, 7-Zip, RAR, lzip, `.Z` and
  `.cab` get a clear "not supported" message.
- ZIP: end record search with self-extracting prefixes, ZIP64, data descriptors, Unix modes and
  symlinks, Info-ZIP Unicode paths and extended timestamps, NTFS times; stored, Deflate, bzip2
  and Zstandard entries with a CRC-32 check; encrypted and other methods are named, not unpacked.
- TAR: ustar, GNU long names and links, PAX headers, base-256 sizes, symbolic and hard links;
  GZIP (several members), bzip2, XZ and Zstandard streams, with the tar inside or a single file
  named from the GZIP header, each GZIP member checked against its CRC-32 and size. Unpacking
  stops at 512 MB; archives inside archives open up to 8 levels deep and 1 GB together.
- Clear messages for valid files beyond the decoders' limits: Zstandard windows over 128 MB, XZ
  dictionaries over 64 MB, and XZ with a SHA-256 check or BCJ or delta filters. A damaged or
  cut-off GZIP file shows what could be read with a notice.
- Names without UTF-8 marking in CP437, CP866 (default for a Russian UI) or Windows-1251,
  switchable in the toolbar.
- Virtualized file tree with size, packed and date columns; filter (`⌘F` / `Ctrl+F`), expand
  and collapse all, summary with the compression ratio, keyboard navigation.
- Preview: text with line numbers and wrapping, images, hex dump, details (method, date,
  permissions, CRC-32, link target); archives inside archives open in place with a trail back;
  Save… through Orca's save dialog and Copy path. The README is selected on opening.
- English and Russian UI, Orca's light and dark themes, plugin and tab icons.
