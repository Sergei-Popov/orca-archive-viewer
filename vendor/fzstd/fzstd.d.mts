// The parts of fzstd 0.1.1 (MIT, https://github.com/101arrowz/fzstd) Archive Viewer uses.
export declare function decompress(dat: Uint8Array, buf?: Uint8Array): Uint8Array
export declare class Decompress {
  constructor(ondata?: (data: Uint8Array, final?: boolean) => unknown)
  ondata: (data: Uint8Array, final?: boolean) => unknown
  push(chunk: Uint8Array, final?: boolean): unknown
}
