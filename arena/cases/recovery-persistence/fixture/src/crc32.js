const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  let c = 0xffffffff
  for (const byte of bytes) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Eight lowercase hex digits. */
export function crcHex(input) {
  return crc32(input).toString(16).padStart(8, '0')
}
