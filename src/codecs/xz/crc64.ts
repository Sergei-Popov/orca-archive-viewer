// CRC-64 (ECMA-182, reflected; polynomial 0xC96C5795D7870F42) as .xz uses it, ported from
// XZ Embedded's xz_crc64.c with the 64-bit value held in two 32-bit halves. xz_crc64.c goes one
// byte at a time; here eight bytes go at once ("slicing by 8", as liblzma does), with eight
// tables: table k gives the CRC of a byte followed by k zero bytes.

/** Eight tables of 256 entries: low halves at [k * 256 + n], high halves 2048 entries later. */
let table: Uint32Array | null = null
const HI = 8 * 256

function makeTable(): Uint32Array {
  const t = new Uint32Array(2 * HI)
  const polyLo = 0xd7870f42
  const polyHi = 0xc96c5795
  for (let n = 0; n < 256; n++) {
    let lo = n
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
    t[n] = lo
    t[HI + n] = hi
  }
  for (let k = 1; k < 8; k++) {
    for (let n = 0; n < 256; n++) {
      const lo = t[(k - 1) * 256 + n]
      const hi = t[HI + (k - 1) * 256 + n]
      t[k * 256 + n] = ((lo >>> 8) | (hi << 24)) ^ t[lo & 0xff]
      t[HI + k * 256 + n] = (hi >>> 8) ^ t[HI + (lo & 0xff)]
    }
  }
  return t
}

/** The CRC-64 of `bytes`, as its low and high 32 bits. */
export function crc64(bytes: Uint8Array): [number, number] {
  const t = (table ??= makeTable())
  let lo = -1
  let hi = -1
  const length = bytes.length
  const whole = length - (length % 8)
  let i = 0
  for (; i < whole; i += 8) {
    const a = lo ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))
    const b = hi ^ (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24))
    const a0 = 7 * 256 + (a & 0xff)
    const a1 = 6 * 256 + ((a >>> 8) & 0xff)
    const a2 = 5 * 256 + ((a >>> 16) & 0xff)
    const a3 = 4 * 256 + (a >>> 24)
    const b0 = 3 * 256 + (b & 0xff)
    const b1 = 2 * 256 + ((b >>> 8) & 0xff)
    const b2 = 256 + ((b >>> 16) & 0xff)
    const b3 = b >>> 24
    lo = t[a0] ^ t[a1] ^ t[a2] ^ t[a3] ^ t[b0] ^ t[b1] ^ t[b2] ^ t[b3]
    hi = t[HI + a0] ^ t[HI + a1] ^ t[HI + a2] ^ t[HI + a3] ^ t[HI + b0] ^ t[HI + b1] ^ t[HI + b2] ^ t[HI + b3]
  }
  for (; i < length; i++) {
    const index = (lo ^ bytes[i]) & 0xff
    lo = ((lo >>> 8) | (hi << 24)) ^ t[index]
    hi = (hi >>> 8) ^ t[HI + index]
  }
  return [~lo >>> 0, ~hi >>> 0]
}
