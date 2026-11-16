// CRC-64 (ECMA-182, reflected; polynomial 0xC96C5795D7870F42) as .xz uses it, ported from
// XZ Embedded's xz_crc64.c with the 64-bit value held in two 32-bit halves.

let tableLo: Uint32Array | null = null
let tableHi: Uint32Array | null = null

function tables(): [Uint32Array, Uint32Array] {
  if (!tableLo || !tableHi) {
    tableLo = new Uint32Array(256)
    tableHi = new Uint32Array(256)
    const polyLo = 0xd7870f42
    const polyHi = 0xc96c5795
    for (let i = 0; i < 256; i++) {
      let lo = i
      let hi = 0
      for (let j = 0; j < 8; j++) {
        const odd = lo & 1
        lo = ((lo >>> 1) | (hi << 31)) >>> 0
        hi >>>= 1
        if (odd) {
          lo = (lo ^ polyLo) >>> 0
          hi = (hi ^ polyHi) >>> 0
        }
      }
      tableLo[i] = lo
      tableHi[i] = hi
    }
  }
  return [tableLo, tableHi]
}

/** The CRC-64 of `bytes`, as its low and high 32 bits. */
export function crc64(bytes: Uint8Array): [number, number] {
  const [tLo, tHi] = tables()
  let lo = 0xffffffff
  let hi = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    const index = (lo ^ bytes[i]) & 0xff
    lo = (((lo >>> 8) | (hi << 24)) ^ tLo[index]) >>> 0
    hi = ((hi >>> 8) ^ tHi[index]) >>> 0
  }
  return [~lo >>> 0, ~hi >>> 0]
}
