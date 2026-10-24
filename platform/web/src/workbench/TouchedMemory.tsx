import { Fragment, type ReactNode } from 'react'

/**
 * Memory as the program uses it: only the rows (16 bytes) its own instructions have read or written, in blocks of
 * neighbouring rows, like a diff shows the changed lines of a file. What the last instruction wrote and read is
 * marked, what changed since the step before is marked, what was touched earlier is tinted; ▲ / ▼ at a block's
 * ends open the row above or below, and the gap between two blocks opens with a click. Used by the Machine view
 * (live, while stepping) and by the guide's step-through (recorded).
 */

export interface Touch {
  /** Linear address. */
  address: number
  size: number
  write: boolean
}

interface Props {
  /** What the last instruction read and wrote. */
  now: Touch[]
  /** Every byte the program touched before (linear address -> written ever). */
  earlier: Map<number, boolean>
  /** A row's 16 bytes (row = linear address >> 4), when known; a byte may be unknown (a recording keeps only some). */
  bytes: (row: number) => ArrayLike<number | undefined> | undefined
  /** The row before the last instruction, to mark what it changed. */
  before?: (row: number) => ArrayLike<number | undefined> | undefined
  /** Names at linear addresses (the variables). */
  names?: Map<number, string>
  /** CS DS ES SS (and SP): an address is written in the first one it falls in, DS first, but SS from SP up (the stack). */
  segs: { cs: number; ds: number; es: number; ss: number; sp?: number }
  /** Rows opened by hand beyond the touched ones (the caller keeps them, so they stay from step to step). */
  opened: Set<number>
  onOpen: (rows: number[]) => void
  /** Shown when nothing has been touched yet. */
  empty?: ReactNode
}

const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')
const h4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')

/** A linear address the way the program sees it: DS:0124, SS:FFFC, else B800:0000 / 0000:046C. */
export function addressOf(lin: number, segs: Props['segs']): string {
  const inStack = lin - segs.ss * 16
  if (segs.sp !== undefined && inStack >= (segs.sp & 0xfff0) && inStack < 0x10000) return `SS:${h4(inStack)}`
  for (const [name, seg] of [['DS', segs.ds], ['ES', segs.es], ['SS', segs.ss], ['CS', segs.cs]] as const) {
    const off = lin - seg * 16
    if (off >= 0 && off < 0x10000) return `${name}:${h4(off)}`
  }
  const seg = (lin >>> 4) & 0xff00
  return `${h4(seg)}:${h4(lin - seg * 16)}`
}

export function TouchedMemory({ now, earlier, bytes, before, names, segs, opened, onOpen, empty }: Props) {
  // The bytes of the last instruction: written / read.
  const nowW = new Set<number>(), nowR = new Set<number>()
  for (const t of now) for (let i = 0; i < t.size; i++) (t.write ? nowW : nowR).add(t.address + i)
  const rows = new Set<number>(opened)
  for (const a of earlier.keys()) rows.add(a >>> 4)
  for (const a of [...nowW, ...nowR]) rows.add(a >>> 4)
  const sorted = [...rows].sort((a, b) => a - b)
  if (!sorted.length) return <div className="tm-empty muted small">{empty ?? 'Nothing touched yet.'}</div>

  // Blocks of neighbouring rows.
  const blocks: number[][] = []
  for (const r of sorted) {
    const last = blocks[blocks.length - 1]
    if (last && r === last[last.length - 1] + 1) last.push(r)
    else blocks.push([r])
  }
  const nameAt = (lin: number) => names?.get(lin)

  const row = (r: number) => {
    const b = bytes(r)
    const p = before?.(r)
    const cells: ReactNode[] = []
    const chars: string[] = []
    const labels: string[] = []
    for (let i = 0; i < 16; i++) {
      const lin = r * 16 + i
      const v = b?.[i]
      const was = p?.[i]
      const touched = earlier.get(lin)
      const cls = [
        nowW.has(lin) ? 'w' : nowR.has(lin) ? 'r' : '',
        v !== undefined && was !== undefined && v !== was ? 'changed' : '',
        touched === true ? 'tw' : touched === false ? 'tr' : '',
        i === 8 ? 'mid' : '',
      ].filter(Boolean).join(' ')
      const n = nameAt(lin)
      if (n) labels.push(n)
      const what = nowW.has(lin) ? ' · written by the last instruction' : nowR.has(lin) ? ' · read by the last instruction' : touched === true ? ' · written earlier' : touched === false ? ' · read earlier' : ''
      cells.push(
        <span key={i} data-lin={lin} className={`tm-b ${cls}`} title={`${addressOf(lin, segs)}${n ? ` ${n}` : ''} = ${v === undefined ? '?' : `${h2(v)} (${v})`}${what}`}>
          {n && <i className="tm-name-mark" />}{v === undefined ? '··' : h2(v)}
        </span>,
      )
      chars.push(v === undefined ? ' ' : v >= 32 && v < 127 ? String.fromCharCode(v) : '·')
    }
    return (
      <div key={r} className="tm-row">
        <span className="tm-addr">{addressOf(r * 16, segs)}</span>
        <span className="tm-bytes">{cells}</span>
        <span className="tm-chars">{chars.join('')}</span>
        <span className="tm-names">{labels.join(' ')}</span>
      </div>
    )
  }

  return (
    <div className="tm">
      {blocks.map((blk, k) => {
        const first = blk[0], last = blk[blk.length - 1]
        const next = blocks[k + 1]
        const gap = next ? next[0] - last - 1 : 0
        return (
          <Fragment key={first}>
            {k === 0 && first > 0 && <button className="tm-more" onClick={() => onOpen([first - 1])} title="Show the row above">▲</button>}
            {blk.map(row)}
            {next
              ? (gap <= 4
                  ? <button className="tm-gap" onClick={() => onOpen(Array.from({ length: gap }, (_, i) => last + 1 + i))} title="Show the rows between">⋯ {gap * 16} bytes ⋯</button>
                  : (
                    <div className="tm-gap split">
                      <button className="tm-more" onClick={() => onOpen([last + 1])} title="Show the row below">▼</button>
                      <span className="muted">⋯ {(gap * 16).toLocaleString()} bytes ⋯</span>
                      <button className="tm-more" onClick={() => onOpen([next[0] - 1])} title="Show the row above">▲</button>
                    </div>
                  ))
              : <button className="tm-more" onClick={() => onOpen([last + 1])} title="Show the row below">▼</button>}
          </Fragment>
        )
      })}
    </div>
  )
}
