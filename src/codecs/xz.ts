// XZ through xz-embedded built to WebAssembly (vendor/xz). Compiling the module is asynchronous,
// so `loadXz` runs once before the first archive that needs it; decoding is then synchronous.
// The context protocol follows xz-decompress's XzContext (MIT, Tim Perry, Steve Sanderson).

import wasmBase64 from '../../vendor/xz/xz-embedded.mjs'
import { DamagedError, Sink, asDecodeError } from './sink'

type XzExports = {
  memory: WebAssembly.Memory
  create_context(): number
  destroy_context(ptr: number): void
  supply_input(ptr: number, length: number): void
  get_next_output(ptr: number): number
}

const XZ_OK = 0
const XZ_STREAM_END = 1

let instance: Promise<XzExports> | null = null

export function loadXz(): Promise<XzExports> {
  instance ??= (async () => {
    const binary = atob(wasmBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const { instance: module } = await WebAssembly.instantiate(bytes, {})
    return module.exports as unknown as XzExports
  })()
  return instance
}

/** One XZ stream, unpacked; `truncate` keeps the first `limit` bytes instead of throwing. */
export async function unxz(
  data: Uint8Array,
  limit: number,
  truncate = false
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const xz = await loadXz()
  const sink = new Sink(limit, truncate)
  const ptr = xz.create_context()
  try {
    const view = () => ({
      mem8: new Uint8Array(xz.memory.buffer, ptr),
      mem32: new Uint32Array(xz.memory.buffer, ptr)
    })
    const { mem32 } = view()
    const bufSize = mem32[0]
    const inStart = mem32[1] - ptr
    const outStart = mem32[4] - ptr
    let at = 0
    for (;;) {
      let { mem8, mem32: m32 } = view()
      const needsInput = m32[2] === m32[3]
      let supplied = 0
      if (needsInput) {
        supplied = Math.min(bufSize, data.length - at)
        mem8.set(data.subarray(at, at + supplied), inStart)
        xz.supply_input(ptr, supplied)
        at += supplied
        ;({ mem8, mem32: m32 } = view())
      }
      const status = xz.get_next_output(ptr)
      ;({ mem8, mem32: m32 } = view())
      if (status !== XZ_OK && status !== XZ_STREAM_END) {
        throw new DamagedError(`xz error ${status}`)
      }
      const produced = m32[5]
      sink.push(mem8.subarray(outStart, outStart + produced))
      m32[5] = 0
      if (status === XZ_STREAM_END || sink.full) {
        break
      }
      if (needsInput && supplied === 0 && produced === 0) {
        throw new DamagedError('xz data ends early')
      }
    }
  } catch (error) {
    throw asDecodeError(error, 'xz')
  } finally {
    xz.destroy_context(ptr)
  }
  return { bytes: sink.result(), truncated: sink.full }
}
