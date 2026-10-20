import { useEffect, useMemo, useRef, useState } from 'react'
import { touches } from './operands'
import { hex, type Debugger, type DisLine, type MemWindow } from './useDebugger'

/**
 * The machine, drawn: memory as a field of cells (a minimap of the data
 * segment, zoomable from 4 KB at a byte per cell to 64 KB), the stack top
 * as a strip, the CPU as a row of register cells and the flag bits, and
 * the instructions as a tape feeding the CPU. On every stop: cells the
 * step wrote flash warm and fade, the cells the next instruction will
 * touch flash cool, the cell under IP is marked, cells that have been
 * executed stay tinted; changed registers flash. Play steps on its own.
 */

interface Props {
  dbg: Debugger
}

const COLS = 64
const paper = { empty: '#efeeea', ink: '#35342f', exec: '#d5dce6', ip: '#3b63a8', write: [224, 120, 90] as const, read: [90, 143, 216] as const, sp: '#5f5a4e' }

/** One flash per cell: how recent (1 → 0) and what. */
interface Flash { age: number; kind: 'read' | 'write' }

function shade(v: number): string {
  // 1..255: light to dark grey, so data stands out from zeros without shouting.
  const t = 0.25 + 0.55 * (v / 255)
  const c = Math.round(236 - t * 150)
  return `rgb(${c},${c - 2},${c - 6})`
}

function mix(base: string, rgb: readonly [number, number, number], a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, Math.max(0, a))})`.replace('rgba', 'rgba') || base
}

export function Machine({ dbg }: Props) {
  const { regs, prevRegs, mem, stack, ip, lines, stopped } = dbg
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const stackRef = useRef<HTMLCanvasElement>(null)
  const prevMem = useRef<MemWindow | null>(null)
  const flashes = useRef(new Map<number, Flash>()) // linear address -> flash
  const executed = useRef(new Set<number>()) // linear addresses IP has been at
  const [hover, setHover] = useState<string>('')
  const [tick, setTick] = useState(0)
  const [speed, setSpeed] = useState(5)

  const current: DisLine | undefined = useMemo(() => lines.find((l) => l.offset === ip), [lines, ip])
  const linear = (seg: number, off: number) => (seg << 4) + off

  // A new stop: age the flashes, add the writes (diff) and the reads (decoded), note where IP is.
  useEffect(() => {
    if (!mem || !regs) return
    for (const [k, f] of flashes.current) {
      f.age -= 0.3
      if (f.age <= 0) flashes.current.delete(k)
    }
    const p = prevMem.current
    if (p && p.seg === mem.seg && p.base === mem.base && p.bytes.length === mem.bytes.length && p.stop !== mem.stop) {
      for (let i = 0; i < mem.bytes.length; i++) {
        if (mem.bytes[i] !== p.bytes[i]) flashes.current.set(linear(mem.seg, mem.base + i), { age: 1, kind: 'write' })
      }
    }
    prevMem.current = mem
    if (current) {
      for (const t of touches(current.text, regs)) {
        for (let i = 0; i < t.size; i++) {
          const a = linear(t.seg, (t.offset + i) & 0xffff)
          if (!flashes.current.has(a) || flashes.current.get(a)!.kind === 'read') flashes.current.set(a, { age: 1, kind: t.kind === 'write' ? 'write' : 'read' })
        }
      }
    }
    if (ip !== null) executed.current.add(linear(parseInt(regs.segments.cs, 16) & 0xffff, ip))
    setTick((t) => t + 1)
  }, [mem, regs, ip, current])

  // Forget everything when the session ends.
  useEffect(() => {
    if (!dbg.session) { flashes.current.clear(); executed.current.clear(); prevMem.current = null; setTick((t) => t + 1) }
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
    const csLin = regs ? linear(parseInt(regs.segments.cs, 16) & 0xffff, 0) : -1
    const ipLin = ip !== null && regs ? csLin + ip : -1
    const base = linear(mem.seg, mem.base)
    for (let c = 0; c < COLS * rows; c++) {
      const i0 = c * bytesPerCell
      if (i0 >= mem.bytes.length) break
      let max = 0, any = false, f: Flash | null = null, isIp = false, wasExec = false
      for (let i = i0; i < i0 + bytesPerCell && i < mem.bytes.length; i++) {
        const v = mem.bytes[i]
        if (v) { any = true; if (v > max) max = v }
        const a = base + i
        const fl = flashes.current.get(a)
        if (fl && (!f || fl.age > f.age)) f = fl
        if (a === ipLin) isIp = true
        if (executed.current.has(a)) wasExec = true
      }
      const x = (c % COLS) * cell, y = Math.floor(c / COLS) * cell
      ctx.fillStyle = wasExec ? paper.exec : any ? shade(max) : paper.empty
      ctx.fillRect(x, y, cell - 1, cell - 1)
      if (f) {
        ctx.fillStyle = mix(paper.empty, f.kind === 'write' ? paper.write : paper.read, 0.25 + 0.75 * f.age)
        ctx.fillRect(x, y, cell - 1, cell - 1)
      }
      if (isIp) {
        ctx.fillStyle = paper.ip
        ctx.fillRect(x, y, cell - 1, cell - 1)
      }
    }
  }, [mem, ip, regs, tick])

  // The stack strip: 256 bytes, SP marked, the pushed words warm.
  useEffect(() => {
    const canvas = stackRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cell = Math.max(3, Math.floor(canvas.clientWidth / COLS))
    const rows = stack ? Math.ceil(stack.bytes.length / COLS) : 4
    if (canvas.width !== cell * COLS || canvas.height !== cell * rows) { canvas.width = cell * COLS; canvas.height = cell * rows }
    ctx.fillStyle = paper.empty
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!stack || !regs) return
    const sp = parseInt(regs.general.esp, 16) & 0xffff
    const base = linear(stack.seg, stack.base)
    for (let i = 0; i < stack.bytes.length; i++) {
      const x = (i % COLS) * cell, y = Math.floor(i / COLS) * cell
      const v = stack.bytes[i]
      const off = stack.base + i
      ctx.fillStyle = off < sp ? paper.empty : v ? shade(v) : '#e4e3de'
      ctx.fillRect(x, y, cell - 1, cell - 1)
      const f = flashes.current.get(base + i)
      if (f) { ctx.fillStyle = mix(paper.empty, f.kind === 'write' ? paper.write : paper.read, 0.25 + 0.75 * f.age); ctx.fillRect(x, y, cell - 1, cell - 1) }
      if (off === sp) { ctx.fillStyle = paper.sp; ctx.fillRect(x, y, cell - 1, cell - 1) }
    }
  }, [stack, regs, tick])

  const onHover = (e: React.MouseEvent<HTMLCanvasElement>, w: MemWindow | null, label: string) => {
    if (!w) return
    const r = e.currentTarget.getBoundingClientRect()
    const cell = Math.max(3, Math.floor(e.currentTarget.clientWidth / COLS))
    const bytesPerCell = label === 'DS' ? Math.max(1, Math.floor(w.bytes.length / (COLS * COLS))) : 1
    const c = Math.floor((e.clientX - r.left) / cell) + Math.floor((e.clientY - r.top) / cell) * COLS
    const i = c * bytesPerCell
    if (i < 0 || i >= w.bytes.length) { setHover(''); return }
    const v = w.bytes[i]
    const off = w.base + i
    setHover(`${label}:${off.toString(16).toUpperCase().padStart(4, '0')}${bytesPerCell > 1 ? `..${(off + bytesPerCell - 1).toString(16).toUpperCase().padStart(4, '0')}` : ''} = ${v.toString(16).toUpperCase().padStart(2, '0')}${v >= 32 && v < 127 ? ` '${String.fromCharCode(v)}'` : ''}`)
  }

  const changed = (k: string, v: string) => prevRegs && regs && prevRegs !== regs && ((prevRegs.general[k] ?? prevRegs.segments[k]) !== v) ? 'changed' : ''
  const flagBits: [number, string][] = [[0x800, 'OF'], [0x400, 'DF'], [0x200, 'IF'], [0x100, 'TF'], [0x80, 'SF'], [0x40, 'ZF'], [0x10, 'AF'], [0x4, 'PF'], [0x1, 'CF']]
  const flags = regs ? parseInt(regs.flags, 16) : 0
  const prevFlags = prevRegs ? parseInt(prevRegs.flags, 16) : flags
  const tape = ip !== null ? lines.filter((l) => l.offset >= ip).slice(0, 7) : []

  return (
    <div className="machine">
      <div className="machine-tools">
        <button onClick={() => dbg.step('into')} disabled={dbg.busy || !stopped || dbg.playing} title="Step (F7)">↓</button>
        <button onClick={() => dbg.step('over')} disabled={dbg.busy || !stopped || dbg.playing} title="Step over a call (F8)">↷</button>
        {dbg.playing
          ? <button onClick={dbg.pausePlay} title="Pause">‖</button>
          : <button onClick={() => dbg.play(speed)} disabled={!stopped} title="Play: step on its own">▶</button>}
        <select value={speed} onChange={(e) => { setSpeed(Number(e.target.value)); if (dbg.playing) dbg.play(Number(e.target.value)) }} title="steps per second">
          {[1, 2, 5, 10, 20].map((n) => <option key={n} value={n}>{n}/s</option>)}
        </select>
        <button onClick={dbg.cont} disabled={dbg.busy || !stopped || dbg.playing} title="Run to the next breakpoint (F9)">▶▶</button>
        <button className="danger" onClick={dbg.stop} disabled={dbg.busy} title="Stop the program">■</button>
        <span className="muted small">{dbg.session ? `${dbg.session.state}${dbg.session.stop_reason ? ` · ${dbg.session.stop_reason.kind}` : ''}` : ''}</span>
      </div>

      <div className="machine-mem">
        <div className="machine-label">
          <span>memory · DS:{mem ? mem.base.toString(16).toUpperCase().padStart(4, '0') : '----'}</span>
          <select value={dbg.memSize} onChange={(e) => dbg.setMemWindow(dbg.memBase, Number(e.target.value))} title="window">
            <option value={4096}>4 KB · byte per cell</option>
            <option value={16384}>16 KB · 4 bytes per cell</option>
            <option value={65536}>64 KB · 16 bytes per cell</option>
          </select>
          <span className="muted">{hover}</span>
        </div>
        <canvas ref={fieldRef} className="machine-field" onMouseMove={(e) => onHover(e, mem, 'DS')} onMouseLeave={() => setHover('')} />
        <div className="machine-label"><span>stack · SS:{stack ? stack.base.toString(16).toUpperCase().padStart(4, '0') : '----'} ▸ SP</span></div>
        <canvas ref={stackRef} className="machine-stack" onMouseMove={(e) => onHover(e, stack, 'SS')} onMouseLeave={() => setHover('')} />
        <div className="machine-legend"><i style={{ background: paper.ip }} /> IP <i style={{ background: paper.exec }} /> executed <i style={{ background: `rgb(${paper.write.join(',')})` }} /> written <i style={{ background: `rgb(${paper.read.join(',')})` }} /> about to be read <i style={{ background: paper.sp }} /> SP</div>
      </div>

      <div className="machine-cpu">
        <div className="machine-label"><span>cpu</span></div>
        <div className="cpu-regs">
          {(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'] as const).map((k) => (
            <div key={k} className={`cpu-cell ${regs ? changed(k, regs.general[k]) : ''}`}><b>{k.slice(1).toUpperCase()}</b><span>{regs ? hex(regs.general[k]).slice(-4) : '----'}</span></div>
          ))}
          {(['cs', 'ds', 'es', 'ss'] as const).map((k) => (
            <div key={k} className={`cpu-cell seg ${regs ? changed(k, regs.segments[k]) : ''}`}><b>{k.toUpperCase()}</b><span>{regs ? hex(regs.segments[k]).slice(-4) : '----'}</span></div>
          ))}
          <div className={`cpu-cell ip ${prevRegs && regs && prevRegs !== regs && prevRegs.instruction_pointer !== regs.instruction_pointer ? 'changed' : ''}`}><b>IP</b><span>{regs ? hex(regs.instruction_pointer).slice(-4) : '----'}</span></div>
        </div>
        <div className="cpu-flags">
          {flagBits.map(([bit, name]) => (
            <div key={name} className={`cpu-flag ${flags & bit ? 'on' : ''} ${(flags & bit) !== (prevFlags & bit) ? 'changed' : ''}`} title={name}>{name}</div>
          ))}
        </div>
        <div className="machine-label"><span>instructions</span></div>
        <div className="cpu-tape">
          {tape.map((l, i) => (
            <div key={l.offset} className={`tape-item ${i === 0 ? 'now' : ''} ${dbg.breakpoints.has(l.offset) ? 'bp' : ''}`} title={`${hex(dbg.cs).slice(-4)}:${l.offset.toString(16).toUpperCase().padStart(4, '0')} — click: run to here; ●: breakpoint`} onClick={() => i > 0 && dbg.runTo(l.offset)}>
              <span className="tape-addr">{l.offset.toString(16).toUpperCase().padStart(4, '0')}</span>
              <span className="tape-text">{l.text}</span>
              <span className="tape-bytes">{l.bytes.replace(/(..)/g, '$1 ').trim()}</span>
              <span className="tape-bp" onClick={(e) => { e.stopPropagation(); dbg.toggleBreakpoint(l.offset) }}>{dbg.breakpoints.has(l.offset) ? '●' : '○'}</span>
            </div>
          ))}
          {tape.length === 0 && <div className="muted small">{dbg.session ? 'running…' : 'Debug a program to see it run.'}</div>}
        </div>
      </div>
    </div>
  )
}
