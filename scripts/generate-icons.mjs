// Generates the PWA PNG icons (public/icons/*.png) with no image dependencies.
// Run: npm run icons
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const MAROON = [0x8b, 0x00, 0x00]
const GOLD = [0xcf, 0xb5, 0x3b]
const OFFWHITE = [0xf8, 0xf5, 0xf0]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Draw on a 64-unit design grid (same as favicon.svg), optionally inset for maskable icons. */
function render(size, inset) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const scale = (size * (1 - 2 * inset)) / 64
  const off = size * inset
  const brackets = [
    [12, 22, 12, 12], [12, 12, 22, 12],
    [42, 12, 52, 12], [52, 12, 52, 22],
    [52, 42, 52, 52], [52, 52, 42, 52],
    [22, 52, 12, 52], [12, 52, 12, 42],
  ]
  const check = [
    [22, 33, 29, 40],
    [29, 40, 43, 25],
  ]
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      // 2x2 supersampling for smooth edges
      let r = 0, g = 0, b = 0
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const u = (x + sx - off) / scale
        const v = (y + sy - off) / scale
        let col = MAROON
        if (brackets.some(([a, b2, c, d]) => distToSegment(u, v, a, b2, c, d) <= 2.5)) col = GOLD
        if (check.some(([a, b2, c, d]) => distToSegment(u, v, a, b2, c, d) <= 3)) col = OFFWHITE
        r += col[0]; g += col[1]; b += col[2]
      }
      const i = y * (size * 4 + 1) + 1 + x * 4
      raw[i] = r / 4; raw[i + 1] = g / 4; raw[i + 2] = b / 4; raw[i + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'icon-192.png'), render(192, 0))
writeFileSync(join(OUT, 'icon-512.png'), render(512, 0))
writeFileSync(join(OUT, 'icon-maskable-512.png'), render(512, 0.1))
console.log('Icons written to', OUT)
