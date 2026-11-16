# Vendored libraries

Plugin frames load no npm packages and have no network, so the two libraries Archive Viewer uses
are copied here as readable, unminified ES modules. fflate is unchanged; fzstd carries two
patches. The XZ decoder is not vendored: it is a TypeScript port in `src/codecs/xz/` (below).

| File                | Library                                       | Version        | Licence |
| ------------------- | --------------------------------------------- | -------------- | ------- |
| `fflate/fflate.mjs` | [fflate](https://github.com/101arrowz/fflate) | 0.8.3          | MIT     |
| `fzstd/fzstd.mjs`   | [fzstd](https://github.com/101arrowz/fzstd)   | 0.1.1, patched | MIT     |

## fflate

- **Why:** DEFLATE, for ZIP entries (method 8) and GZIP streams; `src/codecs/deflate.ts` drives
  the streaming `Inflate` in slices so a capped sink can stop it. The tests also use `gzipSync`
  and `deflateSync`.
- **Source:** the npm package `fflate@0.8.3`, file `esm/browser.js`, copied unchanged.
- **SHA-256 of `fflate.mjs`:** `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1`
- **Licence:** `fflate/LICENSE` (MIT), from the same package, unchanged (SHA-256
  `0a1df3a083d0c010560aa342e87959c8c1070e6fd54545741f083f22d0c8b551`).
- **Types:** `fflate/fflate.d.mts` declares a small part of fflate's API, which covers what
  Archive Viewer and its tests import.

## fzstd

- **Why:** Zstandard, for `.zst` and `.tar.zst` files and ZIP entries (method 93);
  `src/codecs/zstd.ts` reads the frame headers itself (windows, sizes) before fzstd runs.
- **Source:** the npm package `fzstd@0.1.1`, file `esm/index.mjs` (SHA-256
  `1a901fc5a58c349bbdb4f2aa1e688637ef56891ec58243a9f0cd863166b0d2a4`), with the two patches below.
- **SHA-256 of `fzstd.mjs` as patched:**
  `083975ce0310b87745d69bec4c3fb66402f2d68a884d37595d77e64714cfb19e`
- **Licence:** `fzstd/LICENSE` (MIT), from the same package, unchanged (SHA-256
  `62249119bb7df6e54300f37a37145c26a6d4420410aac8881a119c5b427cf751`).
- **Types:** `fzstd/fzstd.d.mts` declares only what Archive Viewer imports.

### Local patches

Search `fzstd.mjs` for `Archive Viewer patch` and reapply after an update. The diff against
upstream has three hunks:

1. **A sliding window** (the new `wsl` and `slw` before `rzfh`, the window's room in `rzfh`, and
   `slw(this.s, blk)` in `Decompress.push`). fzstd 0.1.1 moved the whole streaming window after
   every block, so a stream of many tiny blocks cost blocks × window size. The window is now a
   view into a larger area: it moves forward and is copied back to the start only when it
   reaches the end, which copies each byte about three times at most.
2. **The output buffer sentinel** (in `rzfh`). `w` is the number 1 or the caller's output
   buffer, and fzstd compared it with `==`, which turned the buffer into a string of every byte:
   a frame that records its size over 256 MiB threw "Invalid string length", and smaller ones
   built a string of twice their size. The comparisons are now `===` and `!==`. The test
   `unzstd unpacks a frame that records a content size over 256 MiB` fails on the upstream file.

### Re-check

```sh
mkdir -p upstream/fflate upstream/fzstd && cd upstream
npm pack fflate@0.8.3 fzstd@0.1.1
tar xzf fflate-0.8.3.tgz -C fflate && tar xzf fzstd-0.1.1.tgz -C fzstd
cmp fflate/package/esm/browser.js ../vendor/fflate/fflate.mjs
cmp fflate/package/LICENSE ../vendor/fflate/LICENSE
cmp fzstd/package/LICENSE ../vendor/fzstd/LICENSE
diff -u fzstd/package/esm/index.mjs ../vendor/fzstd/fzstd.mjs   # the three hunks above
shasum -a 256 ../vendor/*/*.mjs
```

## XZ Embedded (ported, not vendored)

`src/codecs/xz/` is a TypeScript port of [XZ Embedded](https://tukaani.org/xz/embedded.html)
v2024-12-30 (git commit `ae63ae3a36ed01724674e8f3d750dc47bf125410`, mirrored at
https://github.com/tukaani-project/xz-embedded) by Lasse Collin and Igor Pavlov, released under
the BSD Zero Clause License (0BSD). 0BSD asks for no notice; the credit is kept here, in the
README's License section and in each ported file's header.

| Ported file               | From (`linux/lib/xz/`)                         |
| ------------------------- | ---------------------------------------------- |
| `src/codecs/xz/stream.ts` | `xz_dec_stream.c`, `xz_stream.h`               |
| `src/codecs/xz/lzma2.ts`  | `xz_dec_lzma2.c`, `xz_lzma2.h`                 |
| `src/codecs/xz/crc64.ts`  | `xz_crc64.c` (CRC-32 is `src/codecs/crc32.ts`) |

Each file's header says what changed from the C code. In short: the whole input is in memory, so
there is no multi-call state machine; the LZMA2 filter only, with CRC-32, CRC-64 or no check and
dictionaries up to 64 MiB; the Index is compared with the Blocks record by record; the first byte
of each LZMA chunk must be zero; and the decoders yield between LZMA2 chunks (`src/codecs/steps.ts`).
Version 0.1.0 shipped XZ Embedded as WebAssembly instead; that file is gone.

To compare with upstream, read the port beside the C files of that commit:

```sh
git clone https://github.com/tukaani-project/xz-embedded.git
git -C xz-embedded checkout ae63ae3a36ed01724674e8f3d750dc47bf125410
ls xz-embedded/linux/lib/xz/
```

`tools/cli-crosscheck.sh` checks the port against the real `xz` both ways (files `xz` writes
unpack here; the test encoder's files unpack with `xz -d`).
