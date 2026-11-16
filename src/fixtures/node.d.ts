// Node's fs, which only src/codecs/cli.test.ts uses (tests run in Node): it reads the files that
// tools/cli-crosscheck.sh made with the real bzip2, zstd and xz, and writes the tests' encoders'
// output back for the script. Nothing in src/ starts a process.
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string): Uint8Array
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: Uint8Array | string): void
  export function mkdirSync(path: string, options: { recursive: boolean }): void
}
