import { useCallback, useRef, useState } from 'react'
import type { RPC } from '../screens/DebugPanel'

/**
 * The debugger session as a hook, for the workbench: start a program at
 * its entry, step, continue, pause, stop; registers (and the previous
 * ones, to show what changed), a disassembly window around CS:IP, and
 * execution breakpoints by code offset. Same agent calls as DebugPanel.
 */

export interface Registers {
  general: Record<string, string>
  segments: Record<string, string>
  instruction_pointer: string
  flags: string
  cpu_mode?: string
}

export interface Session {
  session_id: string
  state: string
  stop_reason?: { kind: string; breakpoint_id?: string; address?: { segment?: string; offset?: string } }
}

export interface DisLine {
  offset: number
  bytes: string
  text: string
  size: number
}

export const hex = (s: string | undefined) => (s ?? '').replace(/^0x/i, '').toUpperCase()
const off8 = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(8, '0')
const seg4 = (s: string) => '0x' + hex(s).slice(-4).padStart(4, '0')
const WINDOW = 40

/** A window of memory read at a stop: `bytes` from seg:base. */
export interface MemWindow {
  seg: number
  base: number
  bytes: Uint8Array
  /** How many stops old this read is (0: this one). */
  stop: number
}

export interface Debugger {
  session: Session | null
  stopped: boolean
  regs: Registers | null
  prevRegs: Registers | null
  /** IP and CS while stopped. */
  ip: number | null
  cs: string
  lines: DisLine[]
  /** Breakpoint offsets in the code segment. */
  breakpoints: Set<number>
  busy: boolean
  error: string | null
  /** The data window (DS:base, `memSize` bytes) and the stack top (SS, around SP), read at every stop. */
  mem: MemWindow | null
  stack: MemWindow | null
  memBase: number
  memSize: number
  setMemWindow: (base: number, size: number) => void
  /** Stepping on its own at `playSpeed` steps per second. */
  playing: boolean
  play: (stepsPerSec: number) => void
  pausePlay: () => void
  start: (command: string) => Promise<void>
  step: (mode: 'into' | 'over') => Promise<void>
  cont: () => Promise<void>
  pause: () => Promise<void>
  stop: () => Promise<void>
  toggleBreakpoint: (offset: number) => Promise<void>
  runTo: (offset: number) => Promise<void>
}

export function useDebugger(rpc: RPC): Debugger {
  const [session, setSession] = useState<Session | null>(null)
  const [regs, setRegs] = useState<Registers | null>(null)
  const [prevRegs, setPrevRegs] = useState<Registers | null>(null)
  const [lines, setLines] = useState<DisLine[]>([])
  const [cs, setCs] = useState('')
  const [bps, setBps] = useState<Map<number, string>>(new Map()) // offset -> breakpoint_id
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const windowRef = useRef<{ seg: string; start: number; end: number; lines: DisLine[] } | null>(null)
  const [mem, setMem] = useState<MemWindow | null>(null)
  const [stack, setStack] = useState<MemWindow | null>(null)
  const [memBase, setMemBase] = useState(0)
  const [memSize, setMemSize] = useState(4096)
  const memCfg = useRef({ base: 0, size: 4096 })
  const stopCount = useRef(0)
  const [playing, setPlaying] = useState(false)
  const playRef = useRef<{ on: boolean; ms: number }>({ on: false, ms: 200 })

  const readWindow = useCallback(async (s: Session, seg: string, base: number, size: number): Promise<MemWindow> => {
    const r = (await rpc('memory.read', {
      session_id: s.session_id,
      address: { space: 'segmented', segment: seg4(seg), offset: off8(base) },
      length: size,
    })) as { data_base64: string }
    return { seg: parseInt(seg, 16), base, bytes: Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0)), stop: stopCount.current }
  }, [rpc])

  const disassemble = useCallback(async (s: Session, seg: string, start: number) => {
    const r = (await rpc('code.disassemble', {
      session_id: s.session_id,
      address: { space: 'segmented', segment: seg4(seg), offset: off8(start) },
      count: WINDOW,
    })) as { lines: { offset: string; bytes: string; text: string; size: number }[] }
    const ls = r.lines.map((l) => ({ offset: parseInt(l.offset, 16), bytes: l.bytes, text: l.text, size: l.size }))
    setLines(ls)
    setCs(seg)
    windowRef.current = ls.length ? { seg, start: ls[0].offset, end: ls[ls.length - 1].offset, lines: ls } : null
  }, [rpc])

  const refresh = useCallback(async (s: Session) => {
    const r = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers
    setRegs((old) => { setPrevRegs(old); return r })
    const ip = parseInt(r.instruction_pointer, 16)
    const seg = r.segments.cs
    const w = windowRef.current
    const inside = w && w.seg === seg && ip >= w.start && ip < w.end && w.lines.findIndex((l) => l.offset === ip) < w.lines.length - 8
    if (!inside) await disassemble(s, seg, ip)
    // Memory for the machine view: the data window and the stack top.
    stopCount.current++
    const { base, size } = memCfg.current
    const sp = parseInt(r.general.esp, 16) & 0xffff
    const stackBase = Math.max(0, (sp & ~0xf) - 128)
    const [m, st] = await Promise.all([
      readWindow(s, r.segments.ds, base, size).catch(() => null),
      readWindow(s, r.segments.ss, stackBase, Math.min(256, 0x10000 - stackBase)).catch(() => null),
    ])
    setMem(m)
    setStack(st)
  }, [rpc, disassemble, readWindow])

  const setMemWindow = useCallback((base: number, size: number) => {
    memCfg.current = { base, size }
    setMemBase(base)
    setMemSize(size)
    const s = sessionRef.current
    if (s && s.state === 'stopped' && regs) {
      readWindow(s, regs.segments.ds, base, size).then(setMem).catch(() => undefined)
    }
  }, [readWindow, regs])

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const waitOp = useCallback(async (s: Session, operation_id: string): Promise<Session> => {
    for (;;) {
      const r = (await rpc('execution.wait', { session_id: s.session_id, operation_id, timeout_ms: 3000 })) as
        { running: boolean; session?: Session; state?: string; stop_reason?: Session['stop_reason'] }
      if (!r.running) return { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? 'stopped', stop_reason: r.session?.stop_reason ?? r.stop_reason }
    }
  }, [rpc])

  const afterStop = useCallback(async (next: Session) => {
    setSession(next)
    if (next.state === 'stopped') await refresh(next)
  }, [refresh])

  const start = useCallback((command: string) => guard(async () => {
    const [cmd, ...args] = command.trim().split(/\s+/)
    const s = (await rpc('session.start', {
      target: { command: cmd, arguments: args },
      mounts: [{ drive: 'C', host_path: '/data/c' }],
      break_at: 'entry',
    })) as Session
    setSession(s)
    setPrevRegs(null)
    setBps(new Map())
    windowRef.current = null
    await refresh(s)
  }), [guard, rpc, refresh])

  const step = useCallback((mode: 'into' | 'over') => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    const r = (await rpc('execution.step', { session_id: s.session_id, mode })) as { session?: Session; state?: string; stop_reason?: Session['stop_reason'] }
    await afterStop({ ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason ?? s.stop_reason })
  }), [guard, rpc, afterStop])

  const cont = useCallback(() => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    await afterStop(await waitOp(s, op.operation_id))
  }), [guard, rpc, waitOp, afterStop])

  const pause = useCallback(() => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.pause', { session_id: s.session_id })) as { operation_id: string }
    await afterStop(await waitOp(s, op.operation_id))
  }), [guard, rpc, waitOp, afterStop])

  const stop = useCallback(() => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    if (s.state !== 'exited') {
      const op = (await rpc('session.stop', { session_id: s.session_id })) as { operation_id: string }
      await waitOp(s, op.operation_id)
    }
    playRef.current.on = false
    setPlaying(false)
    setSession(null)
    setRegs(null)
    setPrevRegs(null)
    setLines([])
    setBps(new Map())
    setMem(null)
    setStack(null)
    windowRef.current = null
  }), [guard, rpc, waitOp])

  const toggleBreakpoint = useCallback((offset: number) => guard(async () => {
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    const id = bps.get(offset)
    if (id) {
      await rpc('breakpoints.delete', { session_id: s.session_id, breakpoint_id: id })
      setBps((b) => { const n = new Map(b); n.delete(offset); return n })
    } else {
      const r = (await rpc('breakpoints.create', {
        session_id: s.session_id, kind: 'execution',
        address: { space: 'segmented', segment: seg4(cs), offset: off8(offset) },
      })) as { breakpoint_id: string }
      setBps((b) => new Map(b).set(offset, r.breakpoint_id))
    }
  }), [guard, rpc, bps, cs])

  const runTo = useCallback((offset: number) => guard(async () => {
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    await rpc('breakpoints.create', {
      session_id: s.session_id, kind: 'execution', once: true,
      address: { space: 'segmented', segment: seg4(cs), offset: off8(offset) },
    })
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    await afterStop(await waitOp(s, op.operation_id))
  }), [guard, rpc, cs, waitOp, afterStop])

  // Play: step on a timer until paused, a breakpoint, or the program ends.
  const pausePlay = useCallback(() => { playRef.current.on = false; setPlaying(false) }, [])
  const play = useCallback((stepsPerSec: number) => {
    playRef.current = { on: true, ms: Math.max(20, Math.round(1000 / stepsPerSec)) }
    setPlaying(true)
    const tick = async () => {
      if (!playRef.current.on) return
      const s = sessionRef.current
      if (!s || s.state !== 'stopped') { pausePlay(); return }
      const t0 = performance.now()
      try {
        const r = (await rpc('execution.step', { session_id: s.session_id, mode: 'into' })) as { session?: Session; state?: string; stop_reason?: Session['stop_reason'] }
        const next: Session = { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason ?? s.stop_reason }
        await afterStop(next)
        if (next.state !== 'stopped' || (next.stop_reason?.kind === 'breakpoint')) { pausePlay(); return }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        pausePlay()
        return
      }
      const wait = Math.max(0, playRef.current.ms - (performance.now() - t0))
      window.setTimeout(tick, wait)
    }
    tick()
  }, [rpc, afterStop, pausePlay])

  const stopped = session?.state === 'stopped'
  return {
    session, stopped, regs, prevRegs,
    ip: stopped && regs ? parseInt(regs.instruction_pointer, 16) : null,
    cs, lines, breakpoints: new Set(bps.keys()), busy, error,
    mem, stack, memBase, memSize, setMemWindow,
    playing, play, pausePlay,
    start, step, cont, pause, stop, toggleBreakpoint, runTo,
  }
}
