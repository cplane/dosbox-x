import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The debugger front end for DOSBox-X's RPC agent (the box must run the
 * debug image): start a program stopped at its entry, step, continue, read
 * registers, and a disassembly window around CS:IP with breakpoints in the
 * gutter and run-to-cursor. Everything goes through `rpc`, a JSON-RPC 2.0
 * call over the player's WebSocket.
 *
 * The protocol (docs/rpc-agent-usage.md in the DOSBox-X tree) gives every
 * number as a hex string, addresses as tagged objects, and continue/pause/
 * stop as operations to wait on. code.disassemble is ours: the debugger's
 * own disassembler, so 8086 through 386 opcodes come out right.
 */

export type RPC = (method: string, params?: Record<string, unknown>) => Promise<unknown>

interface Registers {
  general: Record<string, string>
  segments: Record<string, string>
  instruction_pointer: string
  flags: string
  cpu_mode?: string
}

interface Session {
  session_id: string
  state: string
  state_revision?: number
  stop_reason?: { kind: string; breakpoint_id?: string; address?: { segment?: string; offset?: string } }
}

interface Line {
  offset: number
  bytes: string
  text: string
  size: number
}

interface Props {
  rpc: RPC
  available: boolean | null
}

const hex = (s: string | undefined) => (s ?? '').replace(/^0x/i, '').toUpperCase()
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
const off8 = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(8, '0')
const seg4 = (s: string) => '0x' + hex(s).slice(-4).padStart(4, '0')

/** How many instructions the window shows, and how far back it starts. */
const WINDOW = 40

export function DebugPanel({ rpc, available }: Props) {
  const [program, setProgram] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [regs, setRegs] = useState<Registers | null>(null)
  const [prevRegs, setPrevRegs] = useState<Registers | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [codeSeg, setCodeSeg] = useState('')
  // breakpoints by "SEG:OFF8" -> breakpoint_id
  const [bps, setBps] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const windowRef = useRef<{ seg: string; start: number; end: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const note = (s: string) => setLog((l) => [...l.slice(-30), s])

  const disassemble = useCallback(async (s: Session, seg: string, start: number) => {
    const r = (await rpc('code.disassemble', {
      session_id: s.session_id,
      address: { space: 'segmented', segment: seg4(seg), offset: off8(start) },
      count: WINDOW,
    })) as { lines: { offset: string; bytes: string; text: string; size: number }[] }
    const ls = r.lines.map((l) => ({ offset: parseInt(l.offset, 16), bytes: l.bytes, text: l.text, size: l.size }))
    setLines(ls)
    setCodeSeg(seg)
    windowRef.current = ls.length ? { seg, start: ls[0].offset, end: ls[ls.length - 1].offset } : null
  }, [rpc])

  const refresh = useCallback(async (s: Session) => {
    const r = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers & { session_id: string }
    setPrevRegs((p) => (p === null ? r : p))
    setRegs((old) => { setPrevRegs(old); return r })
    const ip = parseInt(r.instruction_pointer, 16)
    const seg = r.segments.cs
    // Keep the window while IP stays inside it (and not in its last lines);
    // otherwise start a new one at IP.
    const w = windowRef.current
    const inside = w && w.seg === seg && ip >= w.start && ip < w.end && lines.findIndex((l) => l.offset === ip) < lines.length - 8
    if (!inside) await disassemble(s, seg, ip)
  }, [rpc, disassemble, lines])

  // Scroll the current instruction into view when it changes.
  useEffect(() => {
    const el = listRef.current?.querySelector('tr.ip') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [regs, lines])

  const run = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      note(`${label}: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  // continue/pause/stop return an operation; wait for its end.
  async function waitOp(s: Session, operation_id: string): Promise<Session> {
    for (;;) {
      const r = (await rpc('execution.wait', { session_id: s.session_id, operation_id, timeout_ms: 3000 })) as
        { running: boolean; session?: Session; state?: string; stop_reason?: Session['stop_reason'] }
      if (!r.running) {
        const next: Session = { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? 'stopped', stop_reason: r.session?.stop_reason ?? r.stop_reason }
        return next
      }
    }
  }

  const start = run('start', async () => {
    const name = program.trim().toUpperCase()
    if (!name) throw new Error('enter a program on C:, e.g. HELLO.COM')
    const [command, ...args] = name.split(/\s+/)
    const s = (await rpc('session.start', {
      target: { command, arguments: args },
      mounts: [{ drive: 'C', host_path: '/data/c' }],
      break_at: 'entry',
    })) as Session
    setSession(s)
    setPrevRegs(null)
    setBps({})
    windowRef.current = null
    note(`started ${command}: ${s.state} (${s.stop_reason?.kind ?? ''})`)
    await refresh(s)
  })

  const afterStop = async (next: Session) => {
    setSession(next)
    if (next.state === 'stopped') await refresh(next)
    else note(`${next.state} ${next.stop_reason?.kind ?? ''}`)
  }

  const step = (mode: 'into' | 'over') => run(`step ${mode}`, async () => {
    const s = sessionRef.current
    if (!s) return
    const r = (await rpc('execution.step', { session_id: s.session_id, mode })) as { session?: Session; state?: string; registers?: Registers; stop_reason?: Session['stop_reason'] }
    await afterStop({ ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason ?? s.stop_reason })
  })

  const cont = run('continue', async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    const next = await waitOp(s, op.operation_id)
    note(`stopped: ${next.stop_reason?.kind ?? next.state}`)
    await afterStop(next)
  })

  const pause = run('pause', async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.pause', { session_id: s.session_id })) as { operation_id: string }
    await afterStop(await waitOp(s, op.operation_id))
  })

  const stop = run('stop', async () => {
    const s = sessionRef.current
    if (!s) return
    if (s.state !== 'exited') {
      const op = (await rpc('session.stop', { session_id: s.session_id })) as { operation_id: string }
      const next = await waitOp(s, op.operation_id)
      note(`session ${next.state}`)
    }
    setSession(null)
    setRegs(null)
    setLines([])
    setBps({})
    windowRef.current = null
  })

  const bpKey = (seg: string, off: number) => `${hex(seg).slice(-4)}:${off8(off)}`

  const toggleBp = (off: number) => run('breakpoint', async () => {
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    const key = bpKey(codeSeg, off)
    const id = bps[key]
    if (id) {
      await rpc('breakpoints.delete', { session_id: s.session_id, breakpoint_id: id })
      setBps((b) => { const { [key]: _gone, ...rest } = b; return rest })
    } else {
      const r = (await rpc('breakpoints.create', {
        session_id: s.session_id,
        kind: 'execution',
        address: { space: 'segmented', segment: seg4(codeSeg), offset: off8(off) },
      })) as { breakpoint_id: string }
      setBps((b) => ({ ...b, [key]: r.breakpoint_id }))
    }
  })()

  // Run to cursor: a one-shot breakpoint there, then continue.
  const runTo = (off: number) => run('run to', async () => {
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    await rpc('breakpoints.create', {
      session_id: s.session_id,
      kind: 'execution',
      once: true,
      address: { space: 'segmented', segment: seg4(codeSeg), offset: off8(off) },
    })
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    await afterStop(await waitOp(s, op.operation_id))
  })()

  const scrollWindow = (dir: -1 | 1) => run('scroll', async () => {
    const s = sessionRef.current
    const w = windowRef.current
    if (!s || !w || s.state !== 'stopped') return
    // Back: start earlier (instruction boundaries are a guess; 16 bytes
    // back usually resynchronises within a few instructions).
    const start = dir < 0 ? Math.max(0, w.start - 16) : lines[Math.min(lines.length - 1, WINDOW / 2)].offset
    await disassemble(s, w.seg, start)
  })()

  const onKey = (e: React.KeyboardEvent) => {
    if (!session || busy) return
    const stopped = session.state === 'stopped'
    if (e.key === 'F7' && stopped) { e.preventDefault(); step('into')() }
    else if (e.key === 'F8' && stopped) { e.preventDefault(); step('over')() }
    else if (e.key === 'F9' && stopped) { e.preventDefault(); cont() }
    else if (e.key === 'F9' && session.state === 'running') { e.preventDefault(); pause() }
  }

  useEffect(() => () => { sessionRef.current = null }, [])

  if (available === false) {
    return <div className="debug muted small">This box runs the plain image; the debugger agent needs the debug image (dosbox-x-debug).</div>
  }

  const stopped = session?.state === 'stopped'
  const ip = regs ? parseInt(regs.instruction_pointer, 16) : -1
  const changed = (k: string, v: string) => prevRegs && regs && prevRegs !== regs &&
    ((prevRegs.general[k] ?? prevRegs.segments[k]) !== v) ? 'changed' : ''
  return (
    <div className="debug" onKeyDown={onKey}>
      <div className="bar">
        <input value={program} onChange={(e) => setProgram(e.target.value)} placeholder="program on C:, e.g. HELLO.COM" disabled={!!session} />
        {!session && <button className="primary" onClick={start} disabled={busy}>Start at entry</button>}
        {session && (
          <>
            <span className={`state ${session.state}`}>{session.state}{session.stop_reason ? ` · ${session.stop_reason.kind}` : ''}</span>
            <button onClick={step('into')} disabled={busy || !stopped} title="F7">Step into</button>
            <button onClick={step('over')} disabled={busy || !stopped} title="F8">Step over</button>
            <button onClick={cont} disabled={busy || !stopped} title="F9">Continue</button>
            <button onClick={pause} disabled={busy || session.state !== 'running'}>Pause</button>
            <button className="danger" onClick={stop} disabled={busy}>{session.state === 'exited' ? 'Close' : 'Stop'}</button>
          </>
        )}
      </div>
      {error && <p className="auth-error small">{error}</p>}
      {regs && (
        <div className="debug-grid">
          <div className="regs">
            {['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'].map((k) => (
              <span key={k} className={changed(k, regs.general[k])}><b>{k.slice(1).toUpperCase()}</b> {hex(regs.general[k]).slice(-4)}</span>
            ))}
            {['cs', 'ds', 'es', 'ss', 'fs', 'gs'].filter((k) => regs.segments[k] !== undefined).map((k) => (
              <span key={k} className={changed(k, regs.segments[k])}><b>{k.toUpperCase()}</b> {hex(regs.segments[k])}</span>
            ))}
            <span className={prevRegs && prevRegs !== regs && prevRegs.instruction_pointer !== regs.instruction_pointer ? 'changed' : ''}>
              <b>IP</b> {hex(regs.instruction_pointer).slice(-4)}
            </span>
            <span><b>FL</b> {hex(regs.flags).slice(-4)} {flagNames(regs.flags)}</span>
            {regs.cpu_mode && <span className="muted">{regs.cpu_mode}</span>}
          </div>
          <div className="disasm" ref={listRef} tabIndex={0}>
            <div className="hint">
              <button className="small" onClick={() => scrollWindow(-1)} disabled={busy || !stopped}>▲</button>{' '}
              <button className="small" onClick={() => scrollWindow(1)} disabled={busy || !stopped}>▼</button>{' '}
              gutter: breakpoint · address: run to it · F7 step into · F8 step over · F9 continue
            </div>
            <table>
              <tbody>
                {lines.map((l) => {
                  const key = bpKey(codeSeg, l.offset)
                  return (
                    <tr key={l.offset} className={l.offset === ip ? 'ip' : ''}>
                      <td className={`gutter ${bps[key] ? 'bp' : ''}`} onClick={() => toggleBp(l.offset)} title="Toggle breakpoint">{l.offset === ip ? '' : bps[key] ? '●' : '·'}</td>
                      <td className="addr" onClick={() => runTo(l.offset)} title="Run to here">{hex(codeSeg).slice(-4)}:{hex4(l.offset)}</td>
                      <td className="bytes">{l.bytes.replace(/(..)/g, '$1 ').trim()}</td>
                      <td>{l.text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {log.length > 0 && <pre className="debug-log small">{log.join('\n')}</pre>}
    </div>
  )
}

function flagNames(flags: string): string {
  const f = parseInt(flags, 16)
  if (Number.isNaN(f)) return ''
  const names: [number, string][] = [[0x800, 'OF'], [0x400, 'DF'], [0x200, 'IF'], [0x100, 'TF'], [0x80, 'SF'], [0x40, 'ZF'], [0x10, 'AF'], [0x4, 'PF'], [0x1, 'CF']]
  return names.filter(([bit]) => f & bit).map(([, n]) => n).join(' ')
}
