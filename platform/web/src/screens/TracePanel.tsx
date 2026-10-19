import { useMemo, useRef, useState } from 'react'
import type { RPC } from './DebugPanel'

/**
 * The execution timeline: record N instructions with the agent's CPU trace
 * (trace.start, continue until the trace is full, trace.read), then show
 * them as a strip and a table. Interrupts are decoded (INT 21h, 10h, 16h,
 * 33h functions by AH, reconstructed from the register changes) and port
 * I/O is named, so a learner sees what a program asked DOS and the BIOS
 * for, and which hardware it touched.
 */

interface Registers {
  general: Record<string, string>
  segments: Record<string, string>
  instruction_pointer: string
}

interface Event {
  sequence: number
  address: { segment?: string; offset?: string }
  instruction: string
  register_changes: Record<string, string>
}

interface Row extends Event {
  kind: 'int' | 'io' | 'jump' | 'call' | 'ret' | 'plain'
  note: string
  ah?: number
}

interface Props {
  rpc: RPC
  sessionId: string
  stopped: boolean
  regs: Registers | null
  /** Starts a trace of n instructions and continues until it is full. */
  onRecord: (n: number) => Promise<void>
}

const hex = (s: string | undefined) => (s ?? '').replace(/^0x/i, '').toUpperCase()

const dosFn: Record<number, string> = {
  0x01: 'read char (echo)', 0x02: 'print char DL', 0x06: 'console I/O', 0x07: 'read char (no echo)', 0x08: 'read char',
  0x09: 'print string DS:DX', 0x0a: 'buffered input', 0x0b: 'check keyboard', 0x0c: 'flush+read', 0x0e: 'select disk',
  0x19: 'get disk', 0x1a: 'set DTA', 0x25: 'set interrupt vector AL', 0x2a: 'get date', 0x2c: 'get time', 0x2f: 'get DTA',
  0x30: 'get DOS version', 0x31: 'TSR', 0x33: 'break check', 0x35: 'get interrupt vector AL', 0x36: 'disk free space',
  0x39: 'mkdir', 0x3a: 'rmdir', 0x3b: 'chdir', 0x3c: 'create file', 0x3d: 'open file', 0x3e: 'close handle BX',
  0x3f: 'read BX, CX bytes', 0x40: 'write BX, CX bytes', 0x41: 'delete file', 0x42: 'seek BX', 0x43: 'file attributes',
  0x44: 'IOCTL', 0x45: 'dup handle', 0x47: 'get cwd', 0x48: 'allocate BX paragraphs', 0x49: 'free block ES',
  0x4a: 'resize block ES to BX', 0x4b: 'exec', 0x4c: 'exit AL', 0x4d: 'get return code', 0x4e: 'find first',
  0x4f: 'find next', 0x56: 'rename', 0x57: 'file time', 0x5b: 'create new file', 0x62: 'get PSP',
}
const biosVideoFn: Record<number, string> = {
  0x00: 'set video mode AL', 0x01: 'cursor shape', 0x02: 'set cursor position', 0x03: 'get cursor', 0x05: 'select page',
  0x06: 'scroll up', 0x07: 'scroll down', 0x08: 'read char/attr', 0x09: 'write char/attr', 0x0a: 'write char',
  0x0b: 'set palette', 0x0c: 'write pixel', 0x0d: 'read pixel', 0x0e: 'teletype AL', 0x0f: 'get video mode',
  0x10: 'palette/DAC', 0x11: 'font', 0x12: 'EGA/VGA info', 0x13: 'write string', 0x1a: 'display code',
}
const kbdFn: Record<number, string> = { 0x00: 'read key', 0x01: 'check key', 0x02: 'shift flags', 0x10: 'read key (ext)', 0x11: 'check key (ext)' }
const mouseFn: Record<number, string> = { 0x00: 'reset', 0x01: 'show cursor', 0x02: 'hide cursor', 0x03: 'position/buttons', 0x04: 'set position', 0x07: 'x range', 0x08: 'y range', 0x0c: 'set handler' }

const ports: [number, number, string][] = [
  [0x20, 0x21, 'PIC 1'], [0xa0, 0xa1, 'PIC 2'], [0x40, 0x43, 'PIT timer'], [0x60, 0x60, 'keyboard data'], [0x61, 0x61, 'speaker/keyboard ctl'],
  [0x64, 0x64, 'keyboard status'], [0x70, 0x71, 'CMOS/RTC'], [0x80, 0x8f, 'DMA page'], [0x00, 0x0f, 'DMA'], [0xc0, 0xdf, 'DMA 2'],
  [0x1f0, 0x1f7, 'IDE'], [0x200, 0x207, 'game port'], [0x220, 0x22f, 'Sound Blaster'], [0x388, 0x38b, 'AdLib'],
  [0x378, 0x37f, 'LPT1'], [0x3f8, 0x3ff, 'COM1'], [0x2f8, 0x2ff, 'COM2'], [0x3b4, 0x3b5, 'MDA CRTC'], [0x3c0, 0x3c1, 'VGA attribute'],
  [0x3c2, 0x3c2, 'VGA misc'], [0x3c4, 0x3c5, 'VGA sequencer'], [0x3c6, 0x3c9, 'VGA DAC'], [0x3ce, 0x3cf, 'VGA graphics'],
  [0x3d4, 0x3d5, 'CRTC'], [0x3da, 0x3da, 'VGA status (retrace)'], [0x3d8, 0x3d9, 'CGA mode/colour'],
]
const portName = (p: number) => ports.find(([a, b]) => p >= a && p <= b)?.[2] ?? ''

/** Decode a trace into rows, tracking AX and DX across the register changes. */
export function annotate(events: Event[], start: Registers | null): Row[] {
  let ax = start ? parseInt(start.general.eax ?? start.general.ax ?? '0', 16) & 0xffff : 0
  let dx = start ? parseInt(start.general.edx ?? start.general.dx ?? '0', 16) & 0xffff : 0
  const rows: Row[] = []
  for (const e of events) {
    const ins = e.instruction.trim().toLowerCase()
    const op = ins.split(/\s+/)[0]
    let kind: Row['kind'] = 'plain'
    let note = ''
    let ah: number | undefined
    if (op === 'int') {
      kind = 'int'
      const n = parseInt(ins.slice(3).trim().replace(/h$/, ''), 16)
      ah = ax >> 8
      const al = ax & 0xff
      const fn = n === 0x21 ? dosFn[ah] : n === 0x10 ? biosVideoFn[ah] : n === 0x16 ? kbdFn[ah] : n === 0x33 ? mouseFn[ax] : undefined
      const who = n === 0x21 ? 'DOS' : n === 0x10 ? 'BIOS video' : n === 0x16 ? 'BIOS keyboard' : n === 0x33 ? 'mouse' : n === 0x1a ? 'BIOS time' : n === 0x13 ? 'BIOS disk' : n === 0x15 ? 'BIOS system' : `INT ${n.toString(16).toUpperCase()}h`
      note = `${who}: ${fn ?? `function ${ah.toString(16).toUpperCase().padStart(2, '0')}h`}${n === 0x21 && ah === 0x4c ? ` (code ${al})` : ''}`
      if (n === 0x21 && ah === 0x02) note += ` '${String.fromCharCode(dx & 0xff)}'`
    } else if (op === 'in' || op === 'out' || op === 'insb' || op === 'insw' || op === 'outsb' || op === 'outsw') {
      kind = 'io'
      const m = /(?:^|[, ])(?:0x)?([0-9a-f]{2,4})h?(?:,|$)/.exec(ins.replace(/^(in|out)\s+/, ''))
      const port = ins.includes('dx') ? dx : m ? parseInt(m[1], 16) : -1
      note = port >= 0 ? `port ${port.toString(16).toUpperCase().padStart(3, '0')}h ${portName(port)}`.trim() : ''
    } else if (op === 'call') kind = 'call'
    else if (op === 'ret' || op === 'retn' || op === 'retf' || op === 'iret') kind = 'ret'
    else if (/^(jmp|j[a-z]{1,3}|loop[a-z]*|jcxz|jecxz)$/.test(op)) kind = 'jump'
    rows.push({ ...e, kind, note, ah })
    for (const [k, v] of Object.entries(e.register_changes ?? {})) {
      const key = k.toLowerCase()
      if (key === 'eax' || key === 'ax') ax = parseInt(v, 16) & 0xffff
      else if (key === 'ah') ax = (ax & 0xff) | ((parseInt(v, 16) & 0xff) << 8)
      else if (key === 'al') ax = (ax & 0xff00) | (parseInt(v, 16) & 0xff)
      else if (key === 'edx' || key === 'dx') dx = parseInt(v, 16) & 0xffff
      else if (key === 'dh') dx = (dx & 0xff) | ((parseInt(v, 16) & 0xff) << 8)
      else if (key === 'dl') dx = (dx & 0xff00) | (parseInt(v, 16) & 0xff)
    }
  }
  return rows
}

export function TracePanel({ rpc, sessionId, stopped, regs, onRecord }: Props) {
  const [count, setCount] = useState(500)
  const [events, setEvents] = useState<Event[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'int' | 'io' | 'flow'>('all')
  const [selected, setSelected] = useState<number | null>(null)
  const startRegs = useRef<Registers | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const record = async () => {
    setBusy(true)
    setError(null)
    setEvents([])
    startRegs.current = regs
    try {
      await onRecord(count)
      const all: Event[] = []
      let cursor: string | null = null
      for (let page = 0; page < 200; page++) {
        const r = (await rpc('trace.read', { session_id: sessionId, limit: 500, ...(cursor ? { cursor } : {}) })) as
          { events: Event[]; next_cursor: string | null }
        all.push(...r.events)
        cursor = r.next_cursor
        if (!cursor) break
      }
      setEvents(all)
      await rpc('trace.stop', { session_id: sessionId }).catch(() => undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rows = useMemo(() => annotate(events, startRegs.current), [events])
  const shown = rows.filter((r) => filter === 'all' || (filter === 'int' && r.kind === 'int') || (filter === 'io' && r.kind === 'io') || (filter === 'flow' && (r.kind === 'jump' || r.kind === 'call' || r.kind === 'ret')))
  const counts = { int: rows.filter((r) => r.kind === 'int').length, io: rows.filter((r) => r.kind === 'io').length, flow: rows.filter((r) => r.kind === 'jump' || r.kind === 'call' || r.kind === 'ret').length }

  const jumpTo = (seq: number) => {
    setSelected(seq)
    setFilter('all')
    requestAnimationFrame(() => tableRef.current?.querySelector(`tr[data-seq="${seq}"]`)?.scrollIntoView({ block: 'center' }))
  }

  return (
    <div className="trace">
      <div className="bar">
        <span className="muted small">Timeline</span>
        <input type="number" min={10} max={20000} step={10} value={count} onChange={(e) => setCount(Number(e.target.value))} title="instructions to record" />
        <button className="primary" disabled={busy || !stopped} onClick={record}>{busy ? 'Recording…' : 'Record'}</button>
        {rows.length > 0 && (
          <>
            <span className="muted small">{rows.length} instructions · {counts.int} interrupts · {counts.io} port I/O · {counts.flow} branches</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">everything</option>
              <option value="int">interrupts</option>
              <option value="io">port I/O</option>
              <option value="flow">jumps, calls, returns</option>
            </select>
          </>
        )}
      </div>
      {error && <p className="auth-error small">{error}</p>}
      {rows.length > 0 && (
        <div className="trace-strip" title="each tick is one instruction; click to jump">
          {rows.map((r) => (
            <span key={r.sequence} className={`${r.kind} ${selected === r.sequence ? 'sel' : ''}`} style={{ width: `${100 / rows.length}%` }} onClick={() => jumpTo(r.sequence)} />
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div className="trace-table" ref={tableRef}>
          <table>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sequence} data-seq={r.sequence} className={`${r.kind} ${selected === r.sequence ? 'sel' : ''}`} onClick={() => setSelected(r.sequence)}>
                  <td className="muted">{r.sequence}</td>
                  <td className="addr">{hex(r.address.segment)}:{hex(r.address.offset).slice(-4)}</td>
                  <td>{r.instruction}</td>
                  <td className="note">{r.note}</td>
                  <td className="chg">{Object.entries(r.register_changes ?? {}).map(([k, v]) => `${k.toUpperCase()}=${hex(v)}`).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && !busy && <p className="muted small">Record runs the program for the given number of instructions (the target pauses when the trace is full) and lists what it did: every instruction, interrupts decoded, ports named.</p>}
    </div>
  )
}
