/**
 * Live memory from the box: the sidecar mirrors the first megabyte (DOSBox-X copies it into shared memory while
 * someone watches) and sends the 4 KB tiles a viewer asked for ({mem: [tiles]}), each again whenever it changes.
 *
 *   "M" 1 flags:u8 n:u16 then n × (tile:u16, mirrored:u8, bytes[4096]), the body deflated when flags bit 0
 *   flags bit 1: the box has no mirror (an older image)
 */

export const TILE = 4096
export const TILES = 256

export interface MemTile {
  tile: number
  /** False: the box does not mirror this page (unmapped, or video memory in a graphics mode); bytes are 0. */
  mirrored: boolean
  bytes: Uint8Array
}

export interface MemUpdate {
  tiles: MemTile[]
  /** The box has no memory mirror: nothing will come (restart it onto a newer image). */
  unavailable: boolean
}

async function inflate(body: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A memory message, or null when the bytes are not one. */
export async function decodeMem(buf: ArrayBuffer): Promise<MemUpdate | null> {
  const head = new Uint8Array(buf, 0, Math.min(5, buf.byteLength))
  if (head.length < 5 || head[0] !== 0x4d || head[1] !== 1) return null
  const flags = head[2], n = head[3] | (head[4] << 8)
  if (flags & 2) return { tiles: [], unavailable: true }
  let body: Uint8Array<ArrayBuffer> = new Uint8Array(buf, 5)
  if (flags & 1) body = await inflate(body)
  const tiles: MemTile[] = []
  for (let i = 0; i < n; i++) {
    const at = i * (3 + TILE)
    if (at + 3 + TILE > body.length) break
    tiles.push({ tile: body[at] | (body[at + 1] << 8), mirrored: body[at + 2] === 1, bytes: body.slice(at + 3, at + 3 + TILE) })
  }
  return { tiles, unavailable: false }
}
