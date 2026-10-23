import { useEffect, useMemo, useRef, useState } from 'react'
import { touches } from './operands'
import { flows, type Anchor } from './flows'
import { h2, lookupInt } from './interrupts'
import { REGIONS } from './MemoryMapPanel'
import { Icon } from './icons'
import { DebugButtons, type DebugControls } from './DebugButtons'
import { hex, type Debugger, type MemAccess, type MemWindow, type Registers } from './useDebugger'

/**
 * The machine, drawn: memory as a field of cells (a minimap of the data
 * segment, zoomable from 4 KB at a byte per cell to 64 KB), the stack top
 * as a strip, the CPU as a row of register cells and the flag bits, and
 * the instructions as a conveyor feeding the CPU. Cells carry heat: every
 * read warms them cool-blue, every write warm-orange, and heat decays
 * with each instruction, so a loop's working set glows while cold data
 * fades. The cell under IP is marked and executed cells stay tinted.
 *
 * Two sources drive it. Live: every stop of the debugger (step, play,
 * breakpoint), with the emulator's access log when the box has one.
 * Replay: a recording (⏺) of a few thousand instructions, each with its
 * registers and accesses, played back here at any speed and scrubbed.
 */

interface Props {
  dbg: Debugger
  /** The workspace's controls, the same the editor's bar has (continue, pause, step out, stop). */
  controls: DebugControls
  /** The current instruction is an INT: show its function in the reference. */
  onShowInterrupt?: (int: number, ax: number) => void
  /** What the box runs (COMMAND when nothing does). */
  program?: string
}


const COLS = 64
const paper = { empty: '#efeeea', ink: '#35342f', exec: '#d5dce6', ip: '#3b63a8', write: [224, 120, 90] as const, read: [90, 143, 216] as const, sp: '#5f5a4e' }

/** Heat per cell: how much it was read and written lately. */
interface Heat { r: number; w: number }
const DECAY = 0.7       // per instruction
const HEAT_MAX = 6
const HEAT_SPAN = 14    // instructions of history a replay frame's heat is built from

function shade(v: number): string {
  // 1..255: light to dark grey, so data stands out from zeros without shouting.
  const t = 0.25 + 0.55 * (v / 255)
  const c = Math.round(236 - t * 150)
  return `rgb(${c},${c - 2},${c - 6})`
}

/** The colour of a cell's heat: hue from the read/write mix, alpha from the amount. */
function heatColor(h: Heat): string {
  const total = h.r + h.w
  const ws = h.w / total
  const c = paper.read.map((v, i) => Math.round(v + (paper.write[i] - v) * ws))
  const a = 0.2 + 0.8 * Math.min(1, total / 3)
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}

function decayAll(heat: Map<number, Heat>) {
  for (const [k, h] of heat) {
    h.r *= DECAY; h.w *= DECAY
    if (h.r + h.w < 0.05) heat.delete(k)
  }
}
function bump(heat: Map<number, Heat>, accesses: MemAccess[]) {
  for (const a of accesses) {
    for (let i = 0; i < a.size; i++) {
      const k = a.address + i
      const h = heat.get(k) ?? { r: 0, w: 0 }
      if (a.write) h.w = Math.min(HEAT_MAX, h.w + 1); else h.r = Math.min(HEAT_MAX, h.r + 1)
      heat.set(k, h)
    }
  }
}

export function Machine({ dbg, controls, onShowInterrupt, program }: Props) {
  const { regs, prevRegs, mem, stack, ip, lines, stopped, accesses, recording } = dbg
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const stackRef = useRef<HTMLCanvasElement>(null)
  const prevMem = useRef<MemWindow | null>(null)
  const prevIp = useRef<number | null>(null)
  const heat = useRef(new Map<number, Heat>())   // linear address -> heat
  const executed = useRef(new Set<number>())     // linear addresses IP has been at
  const execUpTo = useRef(0)                      // replay: frames whose IP is in `executed`
  // The cell under the mouse: which canvas, which cell, its box on screen and where the mouse is (root-relative).
  type Hover = { kind: 'field' | 'stack'; c: number; box: { left: number; top: number; width: number; height: number }; mx: number; my: number }
  const [hover, setHover] = useState<Hover | null>(null)
  const [tick, setTick] = useState(0)
  const [speed, setSpeed] = useState(5)
  const [recordN, setRecordN] = useState(2000)
  const [frame, setFrame] = useState(0)
  const [replaying, setReplaying] = useState(false)
  const [fps, setFps] = useState(10)
  const rootRef = useRef<HTMLDivElement>(null)
  const [arrows, setArrows] = useState<{ d: string; warm: boolean }[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  const linear = (seg: number, off: number) => (seg << 4) + off

  // What the view shows: the replay frame when there is a recording, else the live stop.
  const frames = recording?.frames ?? null
  const at = frames ? Math.min(frame, frames.length - 1) : 0
  const cur = frames && frames.length ? frames[at] : null
  const vRegs: Registers | null = cur ? cur.regs : regs
  const vPrev: Registers | null = cur ? (at > 0 ? frames![at - 1].regs : null) : prevRegs
  const vIp: number | null = cur ? cur.ip : ip
  const vCs = cur ? cur.cs : (regs ? parseInt(regs.segments.cs, 16) & 0xffff : 0)
  const vText = cur ? cur.text : lines.find((l) => l.offset === ip)?.text
  const live = !cur

  // Where the data of the shown instruction goes: the arrows between the tape, the registers, the flags and the cells.
  const flowList = useMemo(() => (vText && vRegs && (cur || stopped) ? flows(vText, vRegs) : []), [vText, vRegs, cur, stopped])

  // A new live stop: decay the heat, add what the last step touched (exact log, or diff + decode), note where IP is.
  useEffect(() => {
    if (!live || !mem || !regs) return
    decayAll(heat.current)
    let done: MemAccess[] = []
    if (accesses) done = accesses
    else {
      // Worked out: writes by diffing the window, reads by decoding the next instruction's operands.
      const p = prevMem.current
      if (p && p.seg === mem.seg && p.base === mem.base && p.bytes.length === mem.bytes.length && p.stop !== mem.stop) {
        for (let i = 0; i < mem.bytes.length; i++) if (mem.bytes[i] !== p.bytes[i]) done.push({ address: linear(mem.seg, mem.base + i), size: 1, write: true, cs: 0, ip: 0 })
      }
      if (vText) for (const t of touches(vText, regs)) done.push({ address: linear(t.seg, t.offset), size: t.size, write: t.kind === 'write', cs: 0, ip: 0 })
    }
    bump(heat.current, done)
    prevMem.current = mem
    prevIp.current = ip
    if (ip !== null) executed.current.add(linear(parseInt(regs.segments.cs, 16) & 0xffff, ip))
    setTick((t) => t + 1)
  }, [mem, regs, ip, accesses, live]) // eslint-disable-line react-hooks/exhaustive-deps

  // A replay frame: heat from the last HEAT_SPAN instructions (so scrubbing anywhere is exact), executed up to here.
  useEffect(() => {
    if (!frames || !cur) return
    heat.current.clear()
    for (let k = Math.max(0, at - HEAT_SPAN); k < at; k++) { decayAll(heat.current); bump(heat.current, frames[k].accesses) }
    if (at < execUpTo.current) { executed.current.clear(); execUpTo.current = 0 }
    for (let k = execUpTo.current; k <= at; k++) executed.current.add(linear(frames[k].cs, frames[k].ip))
    execUpTo.current = at + 1
    setTick((t) => t + 1)
  }, [frames, at]) // eslint-disable-line react-hooks/exhaustive-deps

  // A recording arrives or goes: start from its first frame, with a clean field.
  useEffect(() => {
    heat.current.clear(); executed.current.clear(); execUpTo.current = 0
    setFrame(0); setReplaying(false)
    setTick((t) => t + 1)
  }, [recording])

  // Replay on a timer.
  useEffect(() => {
    if (!replaying || !frames) return
    const id = window.setInterval(() => setFrame((f) => {
      if (f + 1 >= frames.length) { setReplaying(false); return f }
      return f + 1
    }), Math.max(16, Math.round(1000 / fps)))
    return () => window.clearInterval(id)
  }, [replaying, fps, frames])

  // Forget everything when the session ends.
  useEffect(() => {
    if (!dbg.session) { heat.current.clear(); executed.current.clear(); prevMem.current = null; prevIp.current = null; setTick((t) => t + 1) }
  }, [dbg.session])

  // The field.
  useEffect(() => {
    const canvas = fieldRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cell = Math.max(3, Math.floor(canvas.clientWidth / COLS))
    const bytesPerCell = mem ? Math.max(1, Math.floor(mem.bytes.length / (COLS * COLS))) : 1
    const rows = mem ? Math.ceil(mem.bytes.length / bytesPerCell / COLS) : COLS
    if (canvas.width !== cell * COLS || canvas.height !== cell * rows) { canvas.width = cell * COLS; canvas.height = cell * rows }
    ctx.fillStyle = paper.empty
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!mem) return
    const ipLin = vIp !== null ? linear(vCs, vIp) : -1
    const base = linear(mem.seg, mem.base)
    for (let c = 0; c < COLS * rows; c++) {
      const i0 = c * bytesPerCell
      if (i0 >= mem.bytes.length) break
      let max = 0, any = false, hr = 0, hw = 0, isIp = false, wasExec = false
      for (let i = i0; i < i0 + bytesPerCell && i < mem.bytes.length; i++) {
        const v = mem.bytes[i]
        if (v) { any = true; if (v > max) max = v }
        const a = base + i
        const h = heat.current.get(a)
        if (h) { if (h.r > hr) hr = h.r; if (h.w > hw) hw = h.w }
        if (a === ipLin) isIp = true
        if (executed.current.has(a)) wasExec = true
      }
      const x = (c % COLS) * cell, y = Math.floor(c / COLS) * cell
      ctx.fillStyle = wasExec ? paper.exec : any ? shade(max) : paper.empty
      ctx.fillRect(x, y, cell - 1, cell - 1)
      if (hr + hw > 0) { ctx.fillStyle = heatColor({ r: hr, w: hw }); ctx.fillRect(x, y, cell - 1, cell - 1) }
      if (isIp) { ctx.fillStyle = paper.ip; ctx.fillRect(x, y, cell - 1, cell - 1) }
    }
  }, [mem, vIp, vCs, tick])

  // The stack strip: 256 bytes, SP marked, heat as in the field.
  useEffect(() => {
    const canvas = stackRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cell = Math.max(3, Math.floor(canvas.clientWidth / COLS))
    // Always 4 rows (the 256 bytes of a full window): near the top of the segment the window is shorter, and a
    // strip that changed height with SP moved everything below it from one step to the next.
    const rows = 4
    if (canvas.width !== cell * COLS || canvas.height !== cell * rows) { canvas.width = cell * COLS; canvas.height = cell * rows }
    ctx.fillStyle = paper.empty
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!stack || !vRegs) return
    const sp = parseInt(vRegs.general.esp, 16) & 0xffff
    const base = linear(stack.seg, stack.base)
    for (let i = 0; i < stack.bytes.length; i++) {
      const x = (i % COLS) * cell, y = Math.floor(i / COLS) * cell
      const v = stack.bytes[i]
      const off = stack.base + i
      ctx.fillStyle = off < sp ? paper.empty : v ? shade(v) : '#e4e3de'
      ctx.fillRect(x, y, cell - 1, cell - 1)
      const h = heat.current.get(base + i)
      if (h) { ctx.fillStyle = heatColor(h); ctx.fillRect(x, y, cell - 1, cell - 1) }
      if (off === sp) { ctx.fillStyle = paper.sp; ctx.fillRect(x, y, cell - 1, cell - 1) }
    }
  }, [stack, vRegs, tick])

  // Redraw the arrows when the panel changes size.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => setSize({ w: root.clientWidth, h: root.clientHeight }))
    ro.observe(root)
    return () => ro.disconnect()
  }, [])

  // The arrows: after the canvases are drawn (this effect comes after theirs), find each anchor on screen.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const rr = root.getBoundingClientRect()
    type Box = { x: number; y: number; w: number; h: number }
    const box = (a: Anchor): Box | null => {
      if (a.kind === 'mem') {
        const lin = linear(a.seg, a.offset)
        const windows: [HTMLCanvasElement | null, MemWindow | null, number][] = [
          [fieldRef.current, mem, mem ? Math.max(1, Math.floor(mem.bytes.length / (COLS * COLS))) : 1],
          [stackRef.current, stack, 1],
        ]
        for (const [canvas, w, perCell] of windows) {
          if (!canvas || !w || canvas.width === 0) continue
          const i = lin - linear(w.seg, w.base)
          if (i < 0 || i >= w.bytes.length) continue
          const c = Math.floor(i / perCell)
          const r = canvas.getBoundingClientRect()
          const scale = r.width / canvas.width
          const cell = (canvas.width / COLS) * scale
          return { x: r.left - rr.left + (c % COLS) * cell, y: r.top - rr.top + Math.floor(c / COLS) * cell, w: cell, h: cell }
        }
        return null
      }
      const sel = a.kind === 'reg' ? `[data-anchor="reg:${a.name}"]` : `[data-anchor="${a.kind}"]`
      const el = root.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height }
    }
    // The point on a box's edge in the direction of another point.
    const edge = (b: Box, to: { x: number; y: number }) => {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2
      const dx = to.x - cx, dy = to.y - cy
      if (!dx && !dy) return { x: cx, y: cy }
      const t = Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity)
      return { x: cx + dx * t, y: cy + dy * t }
    }
    const out: { d: string; warm: boolean }[] = []
    for (const f of flowList) {
      const a = box(f.from), b = box(f.to)
      if (!a || !b) continue
      const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      const p = edge(a, bc), q = edge(b, ac)
      let d: string
      if (Math.abs(q.y - p.y) < 24) {
        // Side by side: an arc over the top.
        const lift = Math.max(18, Math.abs(q.x - p.x) / 4)
        d = `M${p.x},${a.y} C${p.x},${a.y - lift} ${q.x},${b.y - lift} ${q.x},${b.y}`
      } else {
        const my = (p.y + q.y) / 2
        d = `M${p.x},${p.y} C${p.x},${my} ${q.x},${my} ${q.x},${q.y}`
      }
      out.push({ d, warm: f.to.kind === 'mem' })
    }
    setArrows(out)
  }, [flowList, tick, mem, stack, size])

  // Accesses the field and the stack strip cannot show, named by the memory map region: "the DOS read the BIOS data area".
  const justDone: MemAccess[] | null = cur ? (at > 0 ? frames![at - 1].accesses : []) : accesses
  const elsewhere = useMemo(() => {
    if (!justDone || !justDone.length) return []
    const inside = (a: number) => (mem && a >= linear(mem.seg, mem.base) && a < linear(mem.seg, mem.base) + mem.bytes.length)
      || (stack && a >= linear(stack.seg, stack.base) && a < linear(stack.seg, stack.base) + stack.bytes.length)
    const groups = new Map<string, { name: string; reads: number; writes: number; lo: number; hi: number }>()
    for (const a of justDone) {
      if (inside(a.address)) continue
      const region = REGIONS.find((r) => a.address >= r.from && a.address <= r.to)
      const name = region ? region.name : `${(a.address >> 4).toString(16).toUpperCase().padStart(4, '0')}:xxxx`
      let g = groups.get(name)
      if (!g) { g = { name, reads: 0, writes: 0, lo: a.address, hi: a.address }; groups.set(name, g) }
      if (a.write) g.writes += a.size; else g.reads += a.size
      g.lo = Math.min(g.lo, a.address); g.hi = Math.max(g.hi, a.address + a.size - 1)
    }
    return [...groups.values()]
  }, [justDone, mem, stack])

  // The cell under the mouse on a 64-column canvas. The drawing is stretched to the panel's width, so a cell on
  // screen is the canvas's on-screen width / 64 (not the drawing's cell size, which drifted a cell or more by the
  // right edge and wrapped onto the next row).
  const onHover = (e: React.MouseEvent<HTMLCanvasElement>, kind: Hover['kind']) => {
    const canvas = e.currentTarget
    const root = rootRef.current?.getBoundingClientRect()
    if (!root || !canvas.width) return
    const r = canvas.getBoundingClientRect()
    const rows = Math.max(1, Math.round(canvas.height / (canvas.width / COLS)))
    const cw = r.width / COLS, ch = r.height / rows
    const col = Math.floor((e.clientX - r.left) / cw), row = Math.floor((e.clientY - r.top) / ch)
    if (col < 0 || col >= COLS || row < 0 || row >= rows) { setHover(null); return }
    setHover({ kind, c: row * COLS + col, box: { left: r.left - root.left + col * cw, top: r.top - root.top + row * ch, width: cw, height: ch }, mx: e.clientX - root.left, my: e.clientY - root.top })
  }
  const h4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
  // What the hovered cell holds, from the data on show now (it follows steps and replay while the mouse rests).
  const hoverText = (() => {
    if (!hover) return ''
    const w = hover.kind === 'field' ? mem : stack
    if (!w) return ''
    const bytesPerCell = hover.kind === 'field' ? Math.max(1, Math.floor(w.bytes.length / (COLS * COLS))) : 1
    const i = hover.c * bytesPerCell
    if (i >= w.bytes.length) return ''
    const off = w.base + i
    const shown = [...w.bytes.subarray(i, Math.min(i + Math.min(bytesPerCell, 4), w.bytes.length))]
    const v = shown[0]
    const h = heat.current.get(linear(w.seg, off))
    const label = hover.kind === 'field' ? 'DS' : 'SS'
    const sp = hover.kind === 'stack' && vRegs && off === (parseInt(vRegs.general.esp, 16) & 0xffff) ? ' · SP' : ''
    const ipHere = hover.kind === 'field' && vIp !== null && linear(w.seg, off) <= linear(vCs, vIp) && linear(vCs, vIp) < linear(w.seg, off) + bytesPerCell ? ' · IP' : ''
    return `${label}:${h4(off)}${bytesPerCell > 1 ? `..${h4(off + bytesPerCell - 1)}` : ''} = ${shown.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}${bytesPerCell > 4 ? ' …' : ''}${bytesPerCell === 1 && v >= 32 && v < 127 ? ` '${String.fromCharCode(v)}'` : ''}${sp}${ipHere}${h ? ` · heat r${h.r.toFixed(1)} w${h.w.toFixed(1)}` : ''}`
  })()

  const changed = (k: string, v: string) => vPrev && vRegs && vPrev !== vRegs && ((vPrev.general[k] ?? vPrev.segments[k]) !== v) ? 'changed' : ''
  const flagBits: [number, string][] = [[0x800, 'OF'], [0x400, 'DF'], [0x200, 'IF'], [0x100, 'TF'], [0x80, 'SF'], [0x40, 'ZF'], [0x10, 'AF'], [0x4, 'PF'], [0x1, 'CF']]
  const flags = vRegs ? parseInt(vRegs.flags, 16) : 0
  const prevFlags = vPrev ? parseInt(vPrev.flags, 16) : flags

  // The conveyor: the instruction just executed (faded), the one in the CPU slot, the queue after it.
  type Item = { key: string; offset: number; text: string; bytes: string; state: 'done' | 'now' | 'next' }
  const tape: Item[] = useMemo(() => {
    if (cur && frames) {
      return frames.slice(Math.max(0, at - 1), at + 6).map((f, i) => ({
        key: `f${f.seq}`, offset: f.ip, text: f.text, bytes: '', state: f === cur ? 'now' : (at > 0 && i === 0 ? 'done' : 'next'),
      }))
    }
    if (ip === null) return []
    const items: Item[] = []
    const done = prevIp.current !== null && prevIp.current !== ip ? lines.find((l) => l.offset === prevIp.current) : undefined
    if (done) items.push({ key: `o${done.offset}`, offset: done.offset, text: done.text, bytes: done.bytes, state: 'done' })
    for (const l of lines.filter((l) => l.offset >= ip).slice(0, 7)) items.push({ key: `o${l.offset}`, offset: l.offset, text: l.text, bytes: l.bytes, state: l.offset === ip ? 'now' : 'next' })
    return items
  }, [cur, frames, at, ip, lines])

  // About to call an interrupt: name the function from AH (or AX).
  const intCall = useMemo(() => {
    if (!vText || !vRegs) return null
    const m = /^int\s+([0-9a-f]+)h?$/i.exec(vText.trim())
    if (!m) return null
    const int = parseInt(m[1], 16)
    const ax = parseInt(vRegs.general.eax, 16) & 0xffff
    const hit = lookupInt(int, ax)
    return { int, ax, vector: hit?.vector, fn: hit?.fn }
  }, [vText, vRegs])

  const liveOff = dbg.busy || !stopped || dbg.playing || !!frames
  return (
    <div className="machine" ref={rootRef}>
      <svg className="machine-arrows" width={size.w} height={size.h} aria-hidden>
        <defs>
          <marker id="arrow-cool" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.5 L8,4 L0,7.5 z" fill="#3b63a8" /></marker>
          <marker id="arrow-warm" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.5 L8,4 L0,7.5 z" fill="#e0785a" /></marker>
        </defs>
        {arrows.map((a, i) => <path key={i} d={a.d} className={`flow ${a.warm ? 'warm' : 'cool'}`} markerEnd={`url(#arrow-${a.warm ? 'warm' : 'cool'})`} />)}
      </svg>
      {hover && hoverText && (
        <>
          <div className="machine-cellhover" style={hover.box} />
          <div
            className="machine-celltip"
            style={{ left: hover.mx + (hover.mx > size.w * 0.6 ? -12 : 12), top: hover.my + 14, transform: hover.mx > size.w * 0.6 ? 'translateX(-100%)' : undefined }}
          >{hoverText}</div>
        </>
      )}
      <div className="machine-mem">
        <div className="machine-label">
          <span>memory · DS:{mem ? mem.base.toString(16).toUpperCase().padStart(4, '0') : '----'}</span>
          <select value={dbg.memSize} onChange={(e) => dbg.setMemWindow(dbg.memBase, Number(e.target.value))} title="window">
            <option value={4096}>4 KB · byte per cell</option>
            <option value={16384}>16 KB · 4 bytes per cell</option>
            <option value={65536}>64 KB · 16 bytes per cell</option>
          </select>
        </div>
        <canvas ref={fieldRef} className="machine-field" onMouseMove={(e) => onHover(e, 'field')} onMouseLeave={() => setHover(null)} />
        <div className="machine-label"><span>stack · SS:{stack ? stack.base.toString(16).toUpperCase().padStart(4, '0') : '----'} ▸ SP</span></div>
        <canvas ref={stackRef} className="machine-stack" onMouseMove={(e) => onHover(e, 'stack')} onMouseLeave={() => setHover(null)} />
        <div className="machine-legend"><i style={{ background: paper.ip }} /> IP <i style={{ background: paper.exec }} /> executed <i style={{ background: `rgb(${paper.write.join(',')})` }} /> written <i style={{ background: `rgb(${paper.read.join(',')})` }} /> {accesses || cur ? 'read' : 'about to be read'} · heat fades with each instruction <i style={{ background: paper.sp }} /> SP <span className="legend-arrow">→</span> data flow of the next instruction</div>
        {/* Always there, one line high, so the controls below do not move from one step to the next. */}
        <div className="machine-elsewhere" title={elsewhere.map((g) => g.name).join(', ')}>
          {elsewhere.length > 0 && <span className="muted">also touched:</span>}
          {elsewhere.map((g) => (
            <span key={g.name} title={`${g.lo.toString(16).toUpperCase().padStart(5, '0')}–${g.hi.toString(16).toUpperCase().padStart(5, '0')}`}>
              {g.name}{g.reads ? <em className="r"> r{g.reads}</em> : null}{g.writes ? <em className="w"> w{g.writes}</em> : null}
            </span>
          ))}
          {live && elsewhere.length > 0 && dbg.accessesDropped > 0 && <span className="muted">+{dbg.accessesDropped} more</span>}
        </div>
      </div>

      <div className="machine-cpu">
        <div className="machine-label"><span>cpu</span></div>
        <div className="cpu-regs">
          {(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'] as const).map((k) => (
            <div key={k} data-anchor={`reg:${k.slice(1)}`} className={`cpu-cell ${vRegs ? changed(k, vRegs.general[k]) : ''}`}><b>{k.slice(1).toUpperCase()}</b><span>{vRegs ? hex(vRegs.general[k]).slice(-4) : '----'}</span></div>
          ))}
          {(['cs', 'ds', 'es', 'ss'] as const).map((k) => (
            <div key={k} data-anchor={`reg:${k}`} className={`cpu-cell seg ${vRegs ? changed(k, vRegs.segments[k]) : ''}`}><b>{k.toUpperCase()}</b><span>{vRegs ? hex(vRegs.segments[k]).slice(-4) : '----'}</span></div>
          ))}
          <div className={`cpu-cell ip ${vPrev && vRegs && vPrev !== vRegs && vPrev.instruction_pointer !== vRegs.instruction_pointer ? 'changed' : ''}`}><b>IP</b><span>{vRegs ? hex(vRegs.instruction_pointer).slice(-4) : '----'}</span></div>
        </div>
        <div className="cpu-flags" data-anchor="flags">
          {flagBits.map(([bit, name]) => (
            <div key={name} className={`cpu-flag ${flags & bit ? 'on' : ''} ${(flags & bit) !== (prevFlags & bit) ? 'changed' : ''}`} title={name}>{name}</div>
          ))}
        </div>
      </div>

      <div className="machine-controls">
        <div className="machine-tools">
          <DebugButtons c={controls} unit="instruction" onStep={(mode) => dbg.step(mode)} hold={!!frames || dbg.playing}>
            {dbg.playing
              ? <button className="media-btn" onClick={dbg.pausePlay} title="Pause stepping">{Icon.pause}</button>
              : <button className="media-btn" onClick={() => dbg.play(speed)} disabled={!stopped || !!frames} title="Step on its own, one instruction at a time at the speed beside">{Icon.steps}</button>}
            <select value={speed} onChange={(e) => { setSpeed(Number(e.target.value)); if (dbg.playing) dbg.play(Number(e.target.value)) }} title="steps per second">
              {[1, 2, 5, 10, 20].map((n) => <option key={n} value={n}>{n}/s</option>)}
            </select>
          </DebugButtons>
          <span className="media" role="group" aria-label="record">
            <button className="media-btn stop" onClick={() => dbg.record(recordN)} disabled={liveOff} title="Record: run this many instructions, each with what it touched, then replay them here">{Icon.record}</button>
            <select value={recordN} onChange={(e) => setRecordN(Number(e.target.value))} title="instructions to record">
              {[500, 2000, 5000, 10000].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </span>
          <span className="muted small machine-state">{frames ? `replay · ${recording!.end}` : dbg.session ? `${dbg.session.state}${dbg.session.stop_reason ? ` · ${dbg.session.stop_reason.kind}` : ''}` : program && program.toUpperCase() !== 'COMMAND' ? `${program} running` : ''}</span>
        </div>
        {frames && (
          <div className="machine-replay">
            <span className="media" role="group" aria-label="replay">
              <button className="media-btn" onClick={() => { setReplaying(false); setFrame(0) }} title="First instruction">{Icon.first}</button>
              <button className="media-btn" onClick={() => { setReplaying(false); setFrame((f) => Math.max(0, f - 1)) }} title="Back one">{Icon.back}</button>
              {replaying
                ? <button className="media-btn" onClick={() => setReplaying(false)} title="Pause">{Icon.pause}</button>
                : <button className="media-btn" onClick={() => { if (at >= frames.length - 1) setFrame(0); setReplaying(true) }} title="Play the recording">{Icon.start}</button>}
              <button className="media-btn" onClick={() => { setReplaying(false); setFrame((f) => Math.min(frames.length - 1, f + 1)) }} title="Forward one">{Icon.forward}</button>
            </span>
            <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={at} onChange={(e) => { setReplaying(false); setFrame(Number(e.target.value)) }} title="scrub" />
            <span className="muted">{at + 1} / {frames.length}</span>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))} title="instructions per second">
              {[2, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n}/s</option>)}
            </select>
            <button className="ghost" onClick={() => { setReplaying(false); dbg.clearRecording() }} title="Back to the live machine">✕ replay</button>
          </div>
        )}
      </div>

      <div className="machine-instr">
        <div className="machine-label"><span>instructions</span></div>
        {intCall && (
          <div className="machine-int">
            <span>
              <b>INT {h2(intCall.int)}</b>{intCall.vector ? ` · ${intCall.vector.title}` : ''}
              {intCall.fn ? ` · ${intCall.fn.ax ? 'AX' : 'AH'}=${(intCall.fn.ax ? intCall.ax : intCall.ax >> 8).toString(16).toUpperCase().padStart(intCall.fn.ax ? 4 : 2, '0')}h: ${intCall.fn.name}` : ` · AH=${(intCall.ax >> 8).toString(16).toUpperCase().padStart(2, '0')}h`}
            </span>
            {onShowInterrupt && <button className="ghost" onClick={() => onShowInterrupt(intCall.int, intCall.ax)}>reference</button>}
          </div>
        )}
        <div className="cpu-tape">
          {tape.map((l) => (
            <div
              key={l.key}
              data-anchor={l.state === 'now' ? 'imm' : undefined}
              className={`tape-item ${l.state} ${live && dbg.breakpoints.has(l.offset) ? 'bp' : ''}`}
              title={live ? `${hex(dbg.cs).slice(-4)}:${l.offset.toString(16).toUpperCase().padStart(4, '0')} — click: run to here; ●: breakpoint` : `${vCs.toString(16).toUpperCase().padStart(4, '0')}:${l.offset.toString(16).toUpperCase().padStart(4, '0')}`}
              onClick={() => live && l.state === 'next' && dbg.runTo(l.offset)}
            >
              <span className="tape-addr">{l.offset.toString(16).toUpperCase().padStart(4, '0')}</span>
              <span className="tape-text">{l.text}</span>
              <span className="tape-bytes">{l.bytes.replace(/(..)/g, '$1 ').trim()}</span>
              {live
                ? <span className="tape-bp" onClick={(e) => { e.stopPropagation(); dbg.toggleBreakpoint(l.offset) }}>{dbg.breakpoints.has(l.offset) ? '●' : '○'}</span>
                : <span className="tape-bp" />}
            </div>
          ))}
          {tape.length === 0 && <div className="muted small">{dbg.session ? 'running…' : 'Debug a program to see it run.'}</div>}
        </div>
      </div>
    </div>
  )
}
