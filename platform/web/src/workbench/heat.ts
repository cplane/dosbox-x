/**
 * Live heat: the box's debug build counts reads and writes per 16-byte
 * paragraph of the first megabyte while a program runs at full speed; the
 * sidecar sends the paragraphs touched since the last tick, ten times a
 * second. This keeps a decaying picture of it for the machine view.
 */

export interface HeatTick {
  /** The first tick since heat was switched on: start afresh. */
  fresh: boolean
  /** (paragraph, reads, writes) × n. */
  entries: Uint16Array
}

export const PARA = 16
export const PARAS = 65536
export const HEAT_DECAY = 0.75 // per tick (100 ms)

export interface Hot { r: number; w: number }

/** Heat per paragraph, decaying; counts are compressed (log2) so a tight loop and a stray read both show. */
export class LiveHeat {
  readonly map = new Map<number, Hot>()

  apply(tick: HeatTick) {
    if (tick.fresh) this.map.clear()
    for (const [k, h] of this.map) {
      h.r *= HEAT_DECAY; h.w *= HEAT_DECAY
      if (h.r + h.w < 0.05) this.map.delete(k)
    }
    const e = tick.entries
    for (let i = 0; i + 2 < e.length; i += 3) {
      const b = e[i], r = e[i + 1], w = e[i + 2]
      const h = this.map.get(b) ?? { r: 0, w: 0 }
      if (r) h.r = Math.min(16, h.r + Math.log2(1 + r))
      if (w) h.w = Math.min(16, h.w + Math.log2(1 + w))
      this.map.set(b, h)
    }
  }

  /** The hottest reading over a range of paragraphs. */
  over(from: number, to: number): Hot | null {
    let r = 0, w = 0, any = false
    for (let b = from; b < to; b++) {
      const h = this.map.get(b)
      if (h) { any = true; if (h.r > r) r = h.r; if (h.w > w) w = h.w }
    }
    return any ? { r, w } : null
  }
}
