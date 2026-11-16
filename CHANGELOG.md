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

### Fixed

- The file tree no longer keeps its keyboard focus ring after mouse clicks.
- TAR dates before 1970 that GNU tar stores in base-256 show their real date instead of
  "Invalid Date", a date of 0 shows as 1970-01-01 instead of none, and a date past what a
  calendar can show is left out.

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
