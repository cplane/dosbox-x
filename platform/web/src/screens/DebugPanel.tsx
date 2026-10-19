import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A bare-bones front end for DOSBox-X's RPC debugger agent (the box must
 * run the debug image): start a program stopped at its entry, step,
 * continue, read registers and the bytes at CS:IP. Everything goes through
 * `rpc`, a JSON-RPC 2.0 call over the player's WebSocket.
 *
 * The protocol (docs/rpc-agent-usage.md in the DOSBox-X tree) gives every
 * number as a hex string, addresses as tagged objects, and continue/pause/
 * stop as operations to wait on.
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
  stop_reason?: { kind: string; address?: { segment?: string; offset?: string } }
}

interface Props {
  rpc: RPC
  available: boolean | null
}

const hex = (s: string | undefined) => (s ?? '').replace(/^0x/i, '').toUpperCase()

export function DebugPanel({ rpc, available }: Props) {
  const [program, setProgram] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [regs, setRegs] = useState<Registers | null>(null)
  const [prevRegs, setPrevRegs] = useState<Registers | null>(null)
  const [code, setCode] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session

  const note = (s: string) => setLog((l) => [...l.slice(-30), s])

  const refresh = useCallback(async (s: Session) => {
    const r = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers & { session_id: string }
    setPrevRegs((p) => (p === null ? r : p))
    setRegs((old) => { setPrevRegs(old); return r })
    const mem = (await rpc('memory.read', {
      session_id: s.session_id,
      address: { space: 'segmented', segment: r.segments.cs, offset: r.instruction_pointer },
      length: 32,
    })) as { data_base64: string }
    setCode(atob(mem.data_base64).split('').map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ').toUpperCase())
  }, [rpc])

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
    note(`started ${command}: ${s.state} (${s.stop_reason?.kind ?? ''})`)
    await refresh(s)
  })

  const step = (mode: 'into' | 'over') => run(`step ${mode}`, async () => {
    const s = sessionRef.current
    if (!s) return
    const r = (await rpc('execution.step', { session_id: s.session_id, mode })) as { session?: Session; state?: string; registers?: Registers; stop_reason?: Session['stop_reason'] }
    const next: Session = { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason ?? s.stop_reason }
    setSession(next)
    if (next.state === 'stopped') await refresh(next)
    else note(`after step: ${next.state} ${next.stop_reason?.kind ?? ''}`)
  })

  const cont = run('continue', async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    const next = await waitOp(s, op.operation_id)
    setSession(next)
    note(`stopped: ${next.stop_reason?.kind ?? next.state}`)
    if (next.state === 'stopped') await refresh(next)
  })

  const pause = run('pause', async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.pause', { session_id: s.session_id })) as { operation_id: string }
    const next = await waitOp(s, op.operation_id)
    setSession(next)
    if (next.state === 'stopped') await refresh(next)
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
    setCode('')
  })

  useEffect(() => () => { sessionRef.current = null }, [])

  if (available === false) {
    return <div className="debug muted small">This box runs the plain image; the debugger agent needs the debug image (dosbox-x-debug).</div>
  }

  const stopped = session?.state === 'stopped'
  const changed = (k: string, v: string) => prevRegs && regs && prevRegs !== regs &&
    ((prevRegs.general[k] ?? prevRegs.segments[k]) !== v) ? 'changed' : ''
  return (
    <div className="debug">
      <div className="bar">
        <input value={program} onChange={(e) => setProgram(e.target.value)} placeholder="program on C:, e.g. HELLO.COM" disabled={!!session} />
        {!session && <button className="primary" onClick={start} disabled={busy}>Start at entry</button>}
        {session && (
          <>
            <span className={`state ${session.state}`}>{session.state}{session.stop_reason ? ` · ${session.stop_reason.kind}` : ''}</span>
            <button onClick={step('into')} disabled={busy || !stopped} title="F7">Step into</button>
            <button onClick={step('over')} disabled={busy || !stopped} title="F8">Step over</button>
            <button onClick={cont} disabled={busy || !stopped}>Continue</button>
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
          <div className="mono small">
            <span className="muted">{hex(regs.segments.cs)}:{hex(regs.instruction_pointer).slice(-4)}</span>  {code}
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
