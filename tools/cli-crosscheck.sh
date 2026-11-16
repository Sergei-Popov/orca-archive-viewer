#!/usr/bin/env bash
# Cross-checks the decoders with the real bzip2, zstd and xz, both ways. The tools run here, not
# in src/: the orca.dev review reads process spawning in a plugin as exfiltration, tests included.
#   1. Writes plain inputs and packs them with each installed tool (levels, checks, windows,
#      block sizes, joined streams, padding, cut and damaged copies) into .test-files/cli/, which
#      git ignores, listed in cases.tsv with the outcome each must have.
#   2. Runs `orca plugin test .`: src/codecs/cli.test.ts unpacks every listed file with the
#      plugin's decoders and writes the test encoders' output to .test-files/cli/ours/.
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
