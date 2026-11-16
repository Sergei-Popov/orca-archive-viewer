#!/usr/bin/env bash
# Cross-checks the decoders with the real bzip2, zstd and xz, both ways, and the tar reader with
# Python's tarfile on archives from macOS tar, GNU tar and tarfile itself. The tools run here, not
# in src/: the orca.dev review reads process spawning in a plugin as exfiltration, tests included.
#   1. Writes plain inputs and packs them with each installed tool (levels, checks, windows,
#      dictionaries, block sizes, joined streams, padding, cut and damaged copies, and options the
#      viewer refuses) into .test-files/cli/, which git ignores, listed in cases.tsv with the
#      outcome each must have.
#      Tar archives go to tar/, with what tarfile reads from each member in tar/cases.tsv.
#   2. Runs `orca plugin test .`: src/codecs/cli.test.ts unpacks every listed file with the
#      plugin's decoders and writes the test encoders' output to .test-files/cli/ours/;
#      src/archive/cli.test.ts compares the plugin's tar entries with tarfile's.
#   3. Unpacks those with the tools and compares them with the plain inputs.
# Usage: tools/cli-crosscheck.sh (from anywhere). Missing tools are skipped. Some inputs are
# random on each run; after a failure the files stay in .test-files/cli/ to reproduce it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.test-files/cli"
rm -rf "$dir"
mkdir -p "$dir/plain"
cd "$dir"

has() { command -v "$1" > /dev/null; }
add() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-ok}" >> cases.tsv; }
size() { wc -c < "$1" | tr -d ' '; }
# Overwrites the byte at offset $2 of file $1 with its complement.
flip() {
  local byte
  byte=$(od -An -tu1 -j "$2" -N1 "$1" | tr -d ' ')
  printf "\\$(printf '%03o' $((byte ^ 255)))" | dd of="$1" bs=1 seek="$2" conv=notrunc 2> /dev/null
}

# Plain inputs: empty, one byte, text, long runs, letters, random bytes, 3 MB of varied lines.
: > plain/empty.bin
printf x > plain/byte.bin
yes 'The quick brown fox jumps over the lazy dog.' | head -n 3000 > plain/text.bin || true
{ head -c 70000 /dev/zero; printf 'ab%.0s' $(seq 5000); head -c 300 /dev/zero | tr '\0' '\377'; } > plain/runs.bin
awk 'BEGIN { srand(7); for (i = 0; i < 260000; i++) printf "%c", 97 + int(rand() * 26) }' > plain/letters.bin
head -c 150000 /dev/urandom > plain/random.bin
awk 'BEGIN { srand(3); for (i = 0; i < 120000; i++) printf "%06d %s line %d\n", int(rand() * 1000000), (rand() < 0.5 ? "alpha" : "beta"), i }' > plain/big.bin
inputs=(empty byte text runs letters random big)
cat plain/text.bin plain/runs.bin > plain/text-runs.bin
for n in "${inputs[@]}"; do echo "plain/$n.bin"; done > plain.txt
: > cases.tsv
versions=()

if has bzip2; then
  mkdir -p bzip2
  versions+=("$(bzip2 --help 2>&1 | head -n 1)")
  for n in "${inputs[@]}"; do
    for level in 1 9; do
      bzip2 -c "-$level" < "plain/$n.bin" > "bzip2/$n.$level.bz2"
      add "bzip2/$n.$level.bz2" "plain/$n.bin"
    done
  done
  cat bzip2/text.9.bz2 bzip2/runs.1.bz2 > bzip2/two-streams.bz2
  add bzip2/two-streams.bz2 plain/text-runs.bin
  head -c $(($(size bzip2/letters.9.bz2) / 2)) bzip2/letters.9.bz2 > bzip2/letters.cut.bz2
  add bzip2/letters.cut.bz2 plain/letters.bin damaged
  cp bzip2/letters.9.bz2 bzip2/letters.flip.bz2
  flip bzip2/letters.flip.bz2 $(($(size bzip2/letters.flip.bz2) / 2))
  add bzip2/letters.flip.bz2 plain/letters.bin damaged
fi

if has zstd; then
  mkdir -p zstd
  versions+=("$(zstd --version)")
  settings=('-1' '-3 --no-check' '-19' '--ultra -22' '--zstd=wlog=10' '--long=24 -5' '-B4096 -3')
  for n in "${inputs[@]}"; do
    for options in "${settings[@]}"; do
      label=$(echo "$options" | tr -d ' =-')
      # From stdin zstd records no content size; --stream-size makes it record one.
      # shellcheck disable=SC2086
      zstd -q -c $options < "plain/$n.bin" > "zstd/$n.$label.zst"
      # shellcheck disable=SC2086
      zstd -q -c $options --stream-size="$(size "plain/$n.bin")" < "plain/$n.bin" > "zstd/$n.$label.sized.zst"
      add "zstd/$n.$label.zst" "plain/$n.bin"
      add "zstd/$n.$label.sized.zst" "plain/$n.bin"
    done
  done
  cat zstd/text.19.zst zstd/runs.1.zst > zstd/two-frames.zst
  add zstd/two-frames.zst plain/text-runs.bin
  head -c $(($(size zstd/letters.19.zst) / 2)) zstd/letters.19.zst > zstd/letters.cut.zst
  add zstd/letters.cut.zst plain/letters.bin damaged
fi

if has xz; then
  mkdir -p xz
  versions+=("$(xz --version | head -n 1)")
  # -T1 keeps one Block; the later -T2 writes Blocks with their sizes in the headers.
  settings=('-0' '-6' '-9e' '-1 -C none' '-6 -C crc32' '-3 --block-size=40000' '-3 -T2 --block-size=50000'
    '--lzma2=dict=4KiB,lc=4,pb=0' '--lzma2=lc=0,lp=4,mode=fast')
  for n in "${inputs[@]}"; do
    for options in "${settings[@]}"; do
      label=$(echo "$options" | tr -c 'a-zA-Z0-9\n' '_')
      # shellcheck disable=SC2086
      xz -q -c -T1 $options < "plain/$n.bin" > "xz/$n.$label.xz"
      add "xz/$n.$label.xz" "plain/$n.bin"
    done
  done
  cat xz/text._6.xz xz/runs._0.xz > xz/two-streams.xz
  add xz/two-streams.xz plain/text-runs.bin
  { cat xz/text._6.xz; head -c 8 /dev/zero; cat xz/runs._0.xz; head -c 4 /dev/zero; } > xz/padded-streams.xz
  add xz/padded-streams.xz plain/text-runs.bin
  { cat xz/text._6.xz; head -c 3 /dev/zero; } > xz/bad-padding.xz
  add xz/bad-padding.xz plain/text.bin damaged
  head -c $(($(size xz/letters._6.xz) / 2)) xz/letters._6.xz > xz/letters.cut.xz
  add xz/letters.cut.xz plain/letters.bin damaged
  cp xz/letters._6.xz xz/letters.flip.xz
  flip xz/letters.flip.xz $(($(size xz/letters.flip.xz) / 2))
  add xz/letters.flip.xz plain/letters.bin damaged
  # Valid files the viewer does not decode.
  xz -q -c -T1 -C sha256 < plain/text.bin > xz/text.sha256.xz
  add xz/text.sha256.xz plain/text.bin unsupported:xz-options
  xz -q -c -T1 --x86 --lzma2 < plain/text.bin > xz/text.x86.xz
  add xz/text.x86.xz plain/text.bin unsupported:xz-options
  xz -q -c -T1 --delta=dist=4 --lzma2 < plain/text.bin > xz/text.delta.xz
  add xz/text.delta.xz plain/text.bin unsupported:xz-options
  xz -q -c -T1 --lzma2=dict=65MiB,mode=fast < plain/text.bin > xz/text.dict65m.xz
  add xz/text.dict65m.xz plain/text.bin unsupported:xz-dictionary
fi

# Tar archives against Python's tarfile: sparse files as macOS tar (bsdtar) writes them with a
# plain `tar -cf`, GNU tar's sparse formats when GNU tar is there ($GNU_TAR, gtar, or a GNU
# `tar`), and odd entries tarfile writes (pre-1970 and zero times, links to appended copies).
# tarfile lists each member's name, size, time and content in tar/cases.tsv for
# src/archive/cli.test.ts to compare with the plugin.
if has python3; then
  mkdir -p tar/out holes
  # Files with holes: data at the ends and the middle, a hole at the end, no data at all, and 120
  # islands (a map longer than a block, and old GNU extension blocks). APFS fills gaps under about
  # 16 MiB with zero blocks when a file is written with seeks, so on macOS the gaps are punched
  # out with F_PUNCHHOLE.
  python3 -I - << 'PY'
import fcntl, os, struct, sys

def holes(name, size, runs):
    path = f"holes/{name}"
    with open(path, "wb") as f:
        f.truncate(size)
        for offset, text in runs:
            f.seek(offset)
            f.write(text.encode())
    if sys.platform != "darwin":
        return
    used = {b for offset, text in runs for b in range(offset // 4096, (offset + len(text) - 1) // 4096 + 1)}
    fd = os.open(path, os.O_RDWR)
    block = 0
    while block < size // 4096:
        if block in used:
            block += 1
            continue
        end = block
        while end < size // 4096 and end not in used:
            end += 1
        fcntl.fcntl(fd, 99, struct.pack("=IIqq", 0, 0, block * 4096, (end - block) * 4096))  # F_PUNCHHOLE
        block = end
    os.close(fd)

holes("holes.bin", 64 << 20, [(0, "START"), (32 << 20, "MIDDLE-DATA"), ((64 << 20) - 3, "END")])
holes("tail-hole.bin", 8 << 20, [(1 << 20, "only-this")])
holes("all-hole.bin", 4 << 20, [])
holes("islands.bin", 120 * 65536, [(i * 65536 + 4096, f"island-{i}") for i in range(120)])
PY
  echo 'plain text' > holes/plain.txt
  sparse=(holes.bin tail-hole.bin all-hole.bin islands.bin plain.txt)
  # bsdtar's ustar and gnutar formats store the holes as zeros, so only these two are sparse.
  tar -cf tar/bsdtar-default.tar -C holes "${sparse[@]}"
  tar --format=pax -cf tar/bsdtar-pax.tar -C holes "${sparse[@]}"
  versions+=("$(tar --version | head -n 1)")
  gnu=${GNU_TAR:-}
  if [[ -z $gnu ]]; then
    if has gtar; then gnu=gtar; elif tar --version 2> /dev/null | grep -q 'GNU tar'; then gnu=tar; fi
  fi
  if [[ -n $gnu ]]; then
    versions+=("$($gnu --version | head -n 1)")
    $gnu --format=gnu -S -cf tar/gnu-S.tar -C holes "${sparse[@]}"
    for version in 0.0 0.1 1.0; do
      $gnu --format=pax -S --sparse-version=$version -cf "tar/gnu-pax-$version.tar" -C holes "${sparse[@]}"
    done
  fi
  versions+=("Python $(python3 -I -c 'import sys; print(sys.version.split()[0])') tarfile")
  python3 -I - << 'PY'
import io, tarfile

def add(tar, name, data=b"", **fields):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = fields.pop("mtime", 1700000000)
    for key, value in fields.items():
        setattr(info, key, value)
    tar.addfile(info, io.BytesIO(data) if data else None)

for fmt, label in ((tarfile.GNU_FORMAT, "gnu"), (tarfile.PAX_FORMAT, "pax"), (tarfile.USTAR_FORMAT, "ustar")):
    with tarfile.open(f"tar/python-{label}.tar", "w", format=fmt) as tar:
        add(tar, "zero.txt", b"0", mtime=0)
        add(tar, "one.txt", b"1", mtime=1)
        add(tar, "f.txt", b"v1\n")
        add(tar, "h", type=tarfile.LNKTYPE, linkname="f.txt")
        add(tar, "f.txt", b"version two\n")
        add(tar, "h2", type=tarfile.LNKTYPE, linkname="h")
        add(tar, "dir", type=tarfile.DIRTYPE)
        add(tar, "dir/soft", type=tarfile.SYMTYPE, linkname="../f.txt")
        if fmt != tarfile.USTAR_FORMAT:
            add(tar, "old.txt", b"1966", mtime=-100000000)
            add(tar, "unicode/файл.txt", "текст".encode())
        if fmt == tarfile.PAX_FORMAT:
            add(tar, "fraction.txt", b"f", mtime=1700000000.25)

import glob
rows = []
for path in sorted(glob.glob("tar/*.tar")):
    with tarfile.open(path) as tar:
        for index, member in enumerate(tar.getmembers()):
            content = "-"
            if member.isfile() or member.islnk():
                content = f"tar/out/{path[4:-4]}.{index}.bin"
                with open(content, "wb") as out:
                    out.write(tar.extractfile(member).read())
            size = member.size if member.isfile() else 0
            rows.append(f"{path}\t{index}\t{member.name}\t{size}\t{member.mtime!r}\t{content}\n")
with open("tar/cases.tsv", "w") as out:
    out.writelines(rows)
PY
  echo "made $(ls tar/*.tar | wc -l | tr -d ' ') tar files, $(wc -l < tar/cases.tsv | tr -d ' ') members listed by tarfile"
fi

if [[ ${#versions[@]} -eq 0 ]]; then
  echo "cli-crosscheck: none of bzip2, zstd or xz is installed" >&2
  exit 1
fi
printf 'tools: %s\n' "${versions[@]}"
echo "made $(wc -l < cases.tsv | tr -d ' ') files with the tools"

# 2. The plugin's decoders on the tools' files; the test encoders' files for step 3.
if ! output=$(cd "$root" && orca plugin test . 2>&1); then
  echo "$output" | grep -vE '^✔' >&2
  echo "cli-crosscheck: FAILED in orca plugin test (files kept in .test-files/cli/)" >&2
  exit 1
fi
echo "$output" | grep -E '^ℹ (tests|pass|fail)'
cat results.txt
[[ -f tar/results.txt ]] && cat tar/results.txt

# 3. The tools on the test encoders' files.
checked=0
failed=0
while IFS=$'\t' read -r packed plain tool; do
  has "$tool" || continue
  if "$tool" -dc < "$packed" 2> /dev/null | cmp -s - "$plain"; then
    checked=$((checked + 1))
  else
    echo "  $tool cannot unpack $packed to $plain" >&2
    failed=$((failed + 1))
  fi
done < ours/cases.tsv
echo "test encoders' files unpacked by the tools: $checked"
if [[ $failed -gt 0 ]]; then
  echo "cli-crosscheck: FAILED, $failed files (kept in .test-files/cli/)" >&2
  exit 1
fi
echo "cli-crosscheck: passed"
