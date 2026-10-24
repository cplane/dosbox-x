import { useEffect, useState } from 'react'
import { Icon } from './icons'
import type { Walk, WalkState } from './walks'

/**
 * A guide example step by step, as the Machine view would show it stopped before each instruction: the
 * instruction next, the registers and flags (what the instruction before changed marked), the example's variables
 * (with what it read and wrote), the top of the stack and what the program has printed so far.
 */
interface Props {
  walk: Walk
  at: number
  onAt: (i: number) => void
}

const REGS = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP'] as const
const SEGS = ['CS', 'DS', 'ES', 'SS'] as const
const FLAGS: [number, string][] = [[0x800, 'OF'], [0x400, 'DF'], [0x200, 'IF'], [0x100, 'TF'], [0x80, 'SF'], [0x40, 'ZF'], [0x10, 'AF'], [0x4, 'PF'], [0x1, 'CF']]
const h4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')
const bytesOf = (hex: string) => Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))

/** A variable's items as the program sees them: words and dwords little-endian, bytes with their character. */
function items(bytes: number[], unit: number): string[] {
  const out: string[] = []
  for (let i = 0; i + unit <= bytes.length && out.length < 16; i += unit) {
    let v = 0
    for (let k = unit - 1; k >= 0; k--) v = v * 256 + bytes[i + k]
    out.push(unit === 1 ? h2(v) : v.toString(16).toUpperCase().padStart(unit * 2, '0'))
  }
  if (bytes.length / unit > 16) out.push('…')
  return out
}
const chars = (bytes: number[]) => bytes.slice(0, 32).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('')

export function WalkView({ walk, at, onAt }: Props) {
  const n = walk.states.length
  const s: WalkState = walk.states[at]
  const prev: WalkState | undefined = walk.states[at - 1]
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    if (at >= n - 1) { setPlaying(false); return }
    const t = window.setTimeout(() => onAt(at + 1), 700)
    return () => window.clearTimeout(t)
  }, [playing, at, n, onAt])

  const r = s.r
  const p = prev?.r ?? r
  const data = bytesOf(s.data)
  const before = prev ? bytesOf(prev.data) : data
  const base = walk.seg * 16
  // What the instruction before read and wrote, by variable.
  const touched = (lo: number, len: number) => {
    let read = false, wrote = false
    for (const [lin, size, w] of s.acc) {
      const off = lin - base
      if (off < lo + len && off + size > lo) { if (w) wrote = true; else read = true }
    }
    return { read, wrote }
  }
  const stack = bytesOf(s.stack)
  const words = Array.from({ length: Math.floor(stack.length / 2) }, (_, i) => stack[i * 2] | (stack[i * 2 + 1] << 8)).slice(0, 8)
  const last = at === n - 1

  return (
    <div className="walk" tabIndex={0} onKeyDown={(e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); onAt(Math.min(n - 1, at + 1)) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onAt(Math.max(0, at - 1)) }
    }}>
      <div className="walk-bar">
        <button className="media-btn" onClick={() => { setPlaying(false); onAt(0) }} disabled={at === 0} title="The first instruction">{Icon.first}</button>
        <button className="media-btn" onClick={() => { setPlaying(false); onAt(Math.max(0, at - 1)) }} disabled={at === 0} title="Back one (←)">{Icon.back}</button>
        {playing
          ? <button className="media-btn" onClick={() => setPlaying(false)} title="Pause">{Icon.pause}</button>
          : <button className="media-btn" onClick={() => { if (last) onAt(0); setPlaying(true) }} title="Step on its own">{Icon.start}</button>}
        <button className="media-btn" onClick={() => { setPlaying(false); onAt(Math.min(n - 1, at + 1)) }} disabled={last} title="Forward one (→)">{Icon.forward}</button>
        <input type="range" min={0} max={n - 1} value={at} onChange={(e) => { setPlaying(false); onAt(Number(e.target.value)) }} />
        <span className="walk-count">{at + 1} / {n}</span>
      </div>
      <div className="walk-next">
        <span className="muted">{h4(r[8])}:{h4(r[12])}</span>
        <code>{s.text || '—'}</code>
        <span className="muted small">{s.bytes.replace(/(..)/g, '$1 ').trim()}</span>
        {s.line < 0 && <span className="muted small">{last && walk.end === 'exited' ? 'the skeleton\'s exit: the program ends here' : 'the skeleton around the example'}</span>}
      </div>

      <div className="cpu-regs">
        {REGS.map((k, i) => <div key={k} className={`cpu-cell ${r[i] !== p[i] ? 'changed' : ''}`}><b>{k}</b><span>{h4(r[i])}</span></div>)}
        {SEGS.map((k, i) => <div key={k} className={`cpu-cell seg ${r[8 + i] !== p[8 + i] ? 'changed' : ''}`}><b>{k}</b><span>{h4(r[8 + i])}</span></div>)}
        <div className="cpu-cell ip"><b>IP</b><span>{h4(r[12])}</span></div>
      </div>
      <div className="cpu-flags">
        {FLAGS.map(([bit, name]) => <div key={name} className={`cpu-flag ${r[13] & bit ? 'on' : ''} ${(r[13] & bit) !== (p[13] & bit) ? 'changed' : ''}`} title={name}>{name}</div>)}
      </div>

      {walk.vars.length > 0 && (
        <div className="walk-vars">
          {walk.vars.map((v) => {
            const lo = v.offset - walk.dataAt
            const now = data.slice(lo, lo + v.length)
            const was = before.slice(lo, lo + v.length)
            const changed = now.some((b, i) => b !== was[i])
            const t = touched(v.offset, v.length)
            return (
              <div key={v.name} className={`walk-var ${changed ? 'changed' : ''}`}>
                <b>{v.name}</b>
                <span className="muted small">{h4(v.offset)}</span>
                <code>{items(now, v.unit).join(' ')}</code>
                {v.unit === 1 && v.length > 1 && <span className="muted small">{chars(now)}</span>}
                {t.wrote ? <em className="w">written</em> : t.read ? <em className="r">read</em> : null}
              </div>
            )
          })}
        </div>
      )}
      {r[7] !== 0xfffe && words.length > 0 && (
        <div className="walk-stack">
          <span className="muted small">stack at SS:{h4(r[7])}</span>
          {words.map((w, i) => <code key={i}>{h4(w)}</code>)}
        </div>
      )}
      <div className="walk-out">
        <span className="muted small">printed</span>
        <pre>{s.out || ' '}</pre>
      </div>
    </div>
  )
}
