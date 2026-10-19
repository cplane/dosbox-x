import { useCallback, useEffect, useRef, useState } from 'react'
import type { RPC } from './DebugPanel'

/**
 * Memory for the debugger: a hex view of a segment:offset window that
 * follows the registers (DS, SS:SP, CS:IP, ES presets), highlights the
 * bytes that changed since the last stop and writes a byte on click; and a
 * map of the first megabyte from DOS's memory control block chain (the
 * debugger's MCBS listing), with the running program's block marked.
 */

interface Registers {
  general: Record<string, string>
  segments: Record<string, string>
  instruction_pointer: string
}

interface Props {
  rpc: RPC
  sessionId: string
  stopped: boolean
  regs: Registers | null
}

interface Block {
  seg: number   // MCB segment; the block's memory starts at seg+1
  bytes: number
  psp: number
  note: string  // "(free)", "(DOS)" or ""
  name: string
}

const h4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')
const addr = (seg: number, off: number) => ({ space: 'segmented', segment: '0x' + h4(seg), offset: '0x' + off.toString(16).toUpperCase().padStart(8, '0') })

const PAGE = 256

/** The MCBS listing: "   XXXX  <bytes>     PPPP (note)  NAME" per block. */
export function parseMCBS(text: string): Block[] {
  const out: Block[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([0-9A-Fa-f]{4})\s+(\d+)\s+([0-9A-Fa-f]{4})\s*(\(free\)|\(DOS\))?\s*(\S*)/.exec(line)
    if (m) out.push({ seg: parseInt(m[1], 16), bytes: Number(m[2]), psp: parseInt(m[3], 16), note: m[4] ?? '', name: m[5] })
  }
  return out
}

/** The text of a debugger.execute_command result, whichever shape it has. */
function commandText(r: unknown): string {
  const o = r as { raw_output?: string; output?: unknown; lines?: unknown }
  if (typeof o.raw_output === 'string') return o.raw_output
  const arr = (Array.isArray(o.output) ? o.output : Array.isArray(o.lines) ? o.lines : []) as unknown[]
  return arr.map((x) => (typeof x === 'string' ? x : (x as { message?: string; text?: string }).message ?? (x as { text?: string }).text ?? '')).join('\n')
}

export function MemoryPanel({ rpc, sessionId, stopped, regs }: Props) {
  const [seg, setSeg] = useState(0)
  const [off, setOff] = useState(0)
  const [segIn, setSegIn] = useState('0000')
  const [offIn, setOffIn] = useState('0000')
  const [data, setData] = useState<Uint8Array | null>(null)
  const [changed, setChanged] = useState<Set<number>>(new Set())
  const [blocks, setBlocks] = useState<Block[]>([])
  const [error, setError] = useState<string | null>(null)
  const prev = useRef<{ key: string; data: Uint8Array } | null>(null)
  const followed = useRef(false)

  const read = useCallback(async (s: number, o: number) => {
    const r = (await rpc('memory.read', { session_id: sessionId, address: addr(s, o), length: PAGE })) as { data_base64: string }
    const bytes = Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))
    const key = `${s}:${o}`
    const diff = new Set<number>()
    if (prev.current && prev.current.key === key) {
      prev.current.data.forEach((b, i) => { if (bytes[i] !== b) diff.add(i) })
    }
    prev.current = { key, data: bytes }
    setData(bytes)
    setChanged(diff)
  }, [rpc, sessionId])

  const go = useCallback((s: number, o: number) => {
    s &= 0xffff
    o &= 0xffff
    setSeg(s)
    setOff(o)
    setSegIn(h4(s))
    setOffIn(h4(o))
  }, [])

  // At the first stop, show DS:0000; afterwards re-read the same window
  // (and the MCB chain) at every stop.
  useEffect(() => {
    if (!regs) return
    if (!followed.current) {
      followed.current = true
      go(parseInt(regs.segments.ds, 16), 0)
    }
  }, [regs, go])

  useEffect(() => {
    if (!stopped) return
    setError(null)
    read(seg, off).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [stopped, seg, off, regs, read])

  useEffect(() => {
    if (!stopped) return
    rpc('debugger.execute_command', { session_id: sessionId, command: 'DOS MCBS' })
      .then((r) => setBlocks(parseMCBS(commandText(r))))
      .catch(() => setBlocks([]))
  }, [stopped, regs, rpc, sessionId])

  const jump = () => go(parseInt(segIn, 16) || 0, parseInt(offIn, 16) || 0)

  const poke = async (i: number) => {
    if (!data || !stopped) return
    const v = prompt(`${h4(seg)}:${h4(off + i)} = ${h2(data[i])}; new value (hex):`, h2(data[i]))
    if (v === null) return
    const n = parseInt(v, 16)
    if (Number.isNaN(n) || n < 0 || n > 255) return
    try {
      await rpc('memory.write', { session_id: sessionId, address: addr(seg, off + i), data_base64: btoa(String.fromCharCode(n)) })
      await read(seg, off)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Pointers into the window: SP, IP, SI/DI/BX in their usual segments.
  const ptrs = new Map<number, string>()
  if (regs) {
    const mark = (s: string | undefined, o: string | undefined, name: string) => {
      if (!s || !o) return
      if ((parseInt(s, 16) & 0xffff) !== seg) return
      const i = (parseInt(o, 16) & 0xffff) - off
      if (i >= 0 && i < PAGE) ptrs.set(i, name)
    }
    mark(regs.segments.ss, regs.general.esp, 'SP')
    mark(regs.segments.ss, regs.general.ebp, 'BP')
    mark(regs.segments.cs, regs.instruction_pointer, 'IP')
    mark(regs.segments.ds, regs.general.esi, 'SI')
    mark(regs.segments.es, regs.general.edi, 'DI')
    mark(regs.segments.ds, regs.general.ebx, 'BX')
  }

  const cs = regs ? parseInt(regs.segments.cs, 16) : -1
  const mine = (b: Block) => cs >= b.seg + 1 && cs < b.seg + 1 + (b.bytes >> 4)
  const cls = (b: Block) => (mine(b) ? 'me' : b.note === '(free)' ? 'free' : b.note === '(DOS)' ? 'dos' : 'prog')
  // The map: walk the first megabyte by address. MCB blocks (conventional
  // and upper, which DOSBox-X's chain continues past A000) are drawn where
  // they are; the gaps are what the address says: DOS below the first
  // block, free conventional memory, video memory, ROM.
  const MB = 0x100000
  const segs: { from: number; size: number; cls: string; title: string }[] = []
  const gap = (from: number, to: number) => {
    let at = from
    for (const [end, c, title] of [[0xa0000, 'free', 'free'], [0xc0000, 'video', 'A000-BFFF: video memory'], [MB, 'rom', 'C000-FFFF: ROM, adapters']] as [number, string, string][]) {
      if (at < end && to > at) {
        const stop = Math.min(to, end)
        segs.push({ from: at, size: stop - at, cls: at === 0 ? 'dos' : c, title: at === 0 ? 'DOS: interrupt vectors, BIOS data, kernel' : blocks.length || c !== 'free' ? title : 'conventional memory (MCB chain not read)' })
        at = stop
      }
    }
  }
  let last = 0
  for (const b of [...blocks].sort((a, b) => a.seg - b.seg)) {
    const from = (b.seg + 1) << 4
    if (from >= MB || from < last) continue
    if (from > last) gap(last, from)
    const size = Math.min(b.bytes, MB - from)
    const upper = from >= 0xa0000
    segs.push({ from, size, cls: cls(b) === 'free' && upper ? 'umb' : cls(b), title: `${upper ? 'UMB ' : ''}${h4(b.seg + 1)}: ${b.bytes} bytes ${b.note || b.name || `PSP ${h4(b.psp)}`}` })
    last = from + size
  }
  if (last < MB) gap(last, MB)

  return (
    <div className="mem">
      <div className="bar">
        <span className="muted small">Memory</span>
        <input value={segIn} onChange={(e) => setSegIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && jump()} maxLength={4} title="segment" />
        :
        <input value={offIn} onChange={(e) => setOffIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && jump()} maxLength={4} title="offset" />
        <button onClick={jump} disabled={!stopped}>Go</button>
        {regs && (
          <>
            <button onClick={() => go(parseInt(regs.segments.ds, 16), 0)} disabled={!stopped}>DS</button>
            <button onClick={() => go(parseInt(regs.segments.es, 16), 0)} disabled={!stopped}>ES</button>
            <button onClick={() => go(parseInt(regs.segments.ss, 16), (parseInt(regs.general.esp, 16) & 0xfff0) - 0x40)} disabled={!stopped}>SS:SP</button>
            <button onClick={() => go(parseInt(regs.segments.cs, 16), parseInt(regs.instruction_pointer, 16) & 0xfff0)} disabled={!stopped}>CS:IP</button>
          </>
        )}
        <button onClick={() => go(seg, off - PAGE)} disabled={!stopped} title="previous page">▲</button>
        <button onClick={() => go(seg, off + PAGE)} disabled={!stopped} title="next page">▼</button>
        <span className="muted small">click a byte to change it · red: changed since the last stop</span>
      </div>
      {error && <p className="auth-error small">{error}</p>}
      {data && (
        <div className="hexview">
          {Array.from({ length: PAGE / 16 }, (_, row) => (
            <div key={row}>
              <span className="a">{h4(seg)}:{h4(off + row * 16)}</span>{'  '}
              {Array.from({ length: 16 }, (_, c) => {
                const i = row * 16 + c
                const p = ptrs.get(i)
                return (
                  <span key={c} className={`b ${changed.has(i) ? 'chg' : ''} ${p ? 'ptr' : ''}`} title={p ? `${p} points here` : `${h4(seg)}:${h4(off + i)}`} onClick={() => poke(i)}>
                    {h2(data[i])}
                  </span>
                )
              }).flatMap((el, c) => (c === 8 ? [' ', el, ' '] : [el, ' ']))}
              {' '}
              <span className="t">{Array.from(data.slice(row * 16, row * 16 + 16), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}</span>
            </div>
          ))}
        </div>
      )}
      <div className="memmap">
        <div className="memmap-bar" title="the first megabyte">
          {segs.map((s, i) => (
            <span key={i} className={s.cls} style={{ width: `${(100 * s.size) / MB}%` }} title={s.title} />
          ))}
        </div>
        <div className="memmap-scale"><span>0000</span><span>256K</span><span>512K</span><span>640K</span><span>A000</span><span>C000</span><span>FFFF</span></div>
        {blocks.length > 0 && (
          <table>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.seg} className={mine(b) ? 'me' : ''}>
                  <td>{h4(b.seg + 1)}</td>
                  <td style={{ textAlign: 'right' }}>{b.bytes.toLocaleString()} B</td>
                  <td>{b.note || `PSP ${h4(b.psp)}`}</td>
                  <td>{b.name}{mine(b) ? ' ◀ CS' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
