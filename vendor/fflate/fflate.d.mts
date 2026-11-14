// The parts of fflate 0.8.3 (MIT, https://github.com/101arrowz/fflate) Archive Viewer uses.
export type FlateStreamHandler = (data: Uint8Array, final: boolean) => void
export declare function inflateSync(data: Uint8Array, opts?: { out?: Uint8Array }): Uint8Array
export declare class Inflate {
  constructor(cb?: FlateStreamHandler)
  ondata: FlateStreamHandler
  push(chunk: Uint8Array, final?: boolean): void
}
export declare class Gunzip {
  constructor(cb?: FlateStreamHandler)
  ondata: FlateStreamHandler
  onmember?: (offset: number) => void
  push(chunk: Uint8Array, final?: boolean): void
}
export declare function deflateSync(data: Uint8Array, opts?: { level?: number }): Uint8Array
export declare function gzipSync(data: Uint8Array, opts?: { filename?: string; mtime?: number | Date }): Uint8Array
export declare function zipSync(
  data: Record<string, Uint8Array | [Uint8Array, { level?: number }]>,
  opts?: { level?: number }
): Uint8Array
