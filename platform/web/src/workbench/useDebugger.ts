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

/** One data access the target (or DOS/BIOS on its behalf) made during the last step or run. */
export interface MemAccess {
  address: number // linear
  size: number
  write: boolean
  cs: number
  ip: number
}

/** One executed instruction of a recording: the registers before it, and what it read and wrote. */
export interface Frame {
  seq: number
  cs: number
  ip: number
  text: string
  regs: Registers
  accesses: MemAccess[]
}

export interface Recording {
  frames: Frame[]
  /** Why the run ended: the trace filled up, a breakpoint, the program exited. */
  end: string
}

interface TraceEvent {
  sequence: number
  address: { segment?: string; offset?: string }
  instruction: string
  register_changes: Record<string, string>
  accesses?: { a: string; s: number; k: string }[]
}

const GENERAL = new Set(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'])
const SEGMENTS = new Set(['cs', 'ds', 'es', 'fs', 'gs', 'ss'])

/** Trace events carry only the registers that changed: roll them forward from the registers at the start. */
function framesOf(events: TraceEvent[], base: Registers | null, end: string): Recording {
  const general: Record<string, string> = { ...(base?.general ?? {}) }
  const segments: Record<string, string> = { ...(base?.segments ?? {}) }
  let flags = base?.flags ?? '0x0'
  const frames: Frame[] = []
  for (const e of events) {
    for (const [k, v] of Object.entries(e.register_changes)) {
      if (GENERAL.has(k)) general[k] = v
      else if (SEGMENTS.has(k)) segments[k] = v
      else if (k === 'flags' || k === 'eflags') flags = v
    }
    const ip = parseInt(e.address.offset ?? '0', 16)
    if (e.address.segment) segments.cs = e.address.segment
    const cs = parseInt(segments.cs ?? '0', 16) & 0xffff
    frames.push({
      seq: e.sequence, cs, ip, text: e.instruction.trim(),
      regs: { general: { ...general }, segments: { ...segments }, instruction_pointer: '0x' + ip.toString(16).padStart(8, '0'), flags },
      accesses: (e.accesses ?? []).map((a) => ({ address: parseInt(a.a, 16), size: a.s, write: a.k === 'w', cs, ip })),
    })
  }
  return { frames, end }
}

export interface Debugger {
  session: Session | null
  stopped: boolean
  regs: Registers | null
  prevRegs: Registers | null
  /** IP and CS while stopped. */
  ip: number | null
  cs: string
  /** CS at the program's entry: the load segment, which symbols and line maps are relative to. */
  entryCs: number | null
  /** Bytes of memory while stopped (segment:offset, real mode). */
  readMemory: (seg: number, offset: number, length: number) => Promise<Uint8Array>
  lines: DisLine[]
  /** Breakpoint offsets in the code segment. */
  breakpoints: Set<number>
  busy: boolean
  error: string | null
  /** The data window (DS:base, `memSize` bytes) and the stack top (SS, around SP), read at every stop. */
  mem: MemWindow | null
  stack: MemWindow | null
  /** What the last step or run read and wrote, from the emulator's log; null when the box cannot tell (plain image). */
  accesses: MemAccess[] | null
  accessesDropped: number
  /** A recorded run to replay in the machine view, until cleared. */
  recording: Recording | null
  /** Run n instructions recording every one with its accesses, then stop and fetch them. */
  record: (n: number) => Promise<void>
  clearRecording: () => void
  memBase: number
  memSize: number
  setMemWindow: (base: number, size: number) => void
  /** Stepping on its own at `playSpeed` steps per second. */
  playing: boolean
  play: (stepsPerSec: number) => void
  pausePlay: () => void
  start: (command: string) => Promise<void>
  step: (mode: 'into' | 'over') => Promise<void>
  /** Many instructions in one go, each decided before it runs; the view refreshes at the end. */
  stepUntil: (decide: (ip: number, cs: string, text: string) => 'into' | 'over' | 'stop', max?: number) => Promise<void>
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
  const [entryCs, setEntryCs] = useState<number | null>(null)
  const [bps, setBps] = useState<Map<number, string>>(new Map()) // offset -> breakpoint_id
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const regsRef = useRef<Registers | null>(null)
  regsRef.current = regs
  const bpsRef = useRef<Map<number, string>>(new Map())
  bpsRef.current = bps
  const csRef = useRef('')
  csRef.current = cs
  const windowRef = useRef<{ seg: string; start: number; end: number; lines: DisLine[] } | null>(null)
  const [mem, setMem] = useState<MemWindow | null>(null)
  const [stack, setStack] = useState<MemWindow | null>(null)
  const [accesses, setAccesses] = useState<MemAccess[] | null>(null)
  const [accessesDropped, setAccessesDropped] = useState(0)
  const accessLog = useRef(true) // false once the box says it has no memory.accesses
  const [recording, setRecording] = useState<Recording | null>(null)
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

  // The emulator's log of what the last step or run touched; a box without it answers once with an error.
  const readAccesses = useCallback(async (s: Session): Promise<{ list: MemAccess[]; dropped: number } | null> => {
    if (!accessLog.current) return null
    try {
      const r = (await rpc('memory.accesses', { session_id: s.session_id })) as
        { accesses: { address: string; size: number; kind: string; cs: string; ip: string }[]; dropped: number }
      return {
        list: r.accesses.map((a) => ({ address: parseInt(a.address, 16), size: a.size, write: a.kind === 'write', cs: parseInt(a.cs, 16), ip: parseInt(a.ip, 16) })),
        dropped: r.dropped ?? 0,
      }
    } catch {
      accessLog.current = false
      return null
    }
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
    const [m, st, acc] = await Promise.all([
      readWindow(s, r.segments.ds, base, size).catch(() => null),
      readWindow(s, r.segments.ss, stackBase, Math.min(256, 0x10000 - stackBase)).catch(() => null),
      readAccesses(s),
    ])
    setMem(m)
    setStack(st)
    if (acc) { setAccesses(acc.list); setAccessesDropped(acc.dropped) }
    else setAccesses(null)
  }, [rpc, disassemble, readWindow, readAccesses])

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

  // No session: everything the view showed goes.
  const clear = useCallback(() => {
    playRef.current.on = false
    setPlaying(false)
    setSession(null)
    setRegs(null)
    setPrevRegs(null)
    setLines([])
    setBps(new Map())
    setMem(null)
    setStack(null)
    setAccesses(null)
    setRecording(null)
    setEntryCs(null)
    windowRef.current = null
  }, [])

  const afterStop = useCallback(async (next: Session) => {
    if (next.state === 'exited') { clear(); return } // the program ended: nothing is left to look at
    setSession(next)
    if (next.state === 'stopped') await refresh(next)
  }, [refresh, clear])

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
    // The entry stop: CS is the load segment.
    const r0 = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers
    setEntryCs(parseInt(r0.segments.cs, 16) & 0xffff)
  }), [guard, rpc, refresh])

  const readMemory = useCallback(async (seg: number, offset: number, length: number): Promise<Uint8Array> => {
    const s = sessionRef.current
    if (!s) throw new Error('no session')
    const r = (await rpc('memory.read', {
      session_id: s.session_id,
      address: { space: 'segmented', segment: '0x' + (seg & 0xffff).toString(16).toUpperCase().padStart(4, '0'), offset: off8(offset & 0xffff) },
      length,
    })) as { data_base64: string }
    return Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))
  }, [rpc])

  const step = useCallback((mode: 'into' | 'over') => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    const r = (await rpc('execution.step', { session_id: s.session_id, mode })) as { session?: Session; state?: string; stop_reason?: Session['stop_reason'] }
    await afterStop({ ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason ?? s.stop_reason })
  }), [guard, rpc, afterStop])

  // Step instruction by instruction until `decide` says stop (or a breakpoint, the end, or `max`), refreshing
  // the view only at the end: a source line in one go. `decide` sees each instruction before it runs.
  const stepUntil = useCallback((decide: (ip: number, cs: string, text: string) => 'into' | 'over' | 'stop', max = 3000) => guard(async () => {
    const s = sessionRef.current
    const r0 = regsRef.current
    if (!s || s.state !== 'stopped' || !r0) return
    let next: Session = s
    let ip = parseInt(r0.instruction_pointer, 16), csNow = r0.segments.cs
    for (let i = 0; i < max; i++) {
      const dis = (await rpc('code.disassemble', {
        session_id: s.session_id, address: { space: 'segmented', segment: seg4(csNow), offset: off8(ip) }, count: 1,
      })) as { lines: { text: string }[] }
      const mode = decide(ip, csNow, dis.lines[0]?.text ?? '')
      if (mode === 'stop') break
      const r = (await rpc('execution.step', { session_id: s.session_id, mode })) as
        { session?: Session; state?: string; stop_reason?: Session['stop_reason']; registers?: Registers }
      next = { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason }
      if (next.state !== 'stopped' || !r.registers) break
      ip = parseInt(r.registers.instruction_pointer, 16); csNow = r.registers.segments.cs
      // A step over a call stops on the agent's own breakpoint after it; only the user's count as a stop here.
      if (bpsRef.current.has(ip) && csNow === cs) break
    }
    await afterStop(next)
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

  // Record: trace n instructions (each with its memory accesses), run until the trace is full, then fetch it.
  const record = useCallback((n: number) => guard(async () => {
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    const base = regs
    await rpc('trace.start', { session_id: s.session_id, detail: 'normal', instruction_count: n })
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    const next = await waitOp(s, op.operation_id)
    await afterStop(next)
    const events: TraceEvent[] = []
    let cursor: string | null = null
    for (;;) {
      const r = (await rpc('trace.read', { session_id: s.session_id, limit: 500, ...(cursor ? { cursor } : {}) })) as
        { events: TraceEvent[]; next_cursor: string | null }
      events.push(...r.events)
      cursor = r.next_cursor
      if (!cursor) break
    }
    try { await rpc('trace.stop', { session_id: s.session_id }) } catch { /* already complete */ }
    setRecording(framesOf(events, base, next.stop_reason?.kind ?? next.state))
  }), [guard, rpc, regs, waitOp, afterStop])
  const clearRecording = useCallback(() => setRecording(null), [])

  const stop = useCallback(() => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    if (s.state !== 'exited') {
      try {
        const op = (await rpc('session.stop', { session_id: s.session_id })) as { operation_id: string }
        await waitOp(s, op.operation_id)
      } catch { /* the session may already be gone (the program ended as it was stopped) */ }
    }
    clear()
  }), [guard, rpc, waitOp, clear])

  const toggleBreakpoint = useCallback((offset: number) => guard(async () => {
    // The live CS and breakpoints (refs): a caller may hold this function from before the session started.
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    const id = bpsRef.current.get(offset)
    if (id) {
      await rpc('breakpoints.delete', { session_id: s.session_id, breakpoint_id: id })
      setBps((b) => { const n = new Map(b); n.delete(offset); return n })
    } else {
      const r = (await rpc('breakpoints.create', {
        session_id: s.session_id, kind: 'execution',
        address: { space: 'segmented', segment: seg4(csRef.current), offset: off8(offset) },
      })) as { breakpoint_id: string }
      setBps((b) => new Map(b).set(offset, r.breakpoint_id))
      bpsRef.current = new Map(bpsRef.current).set(offset, r.breakpoint_id)
    }
  }), [guard, rpc])

  const runTo = useCallback((offset: number) => guard(async () => {
    const s = sessionRef.current
    if (!s || s.state !== 'stopped') return
    await rpc('breakpoints.create', {
      session_id: s.session_id, kind: 'execution', once: true,
      address: { space: 'segmented', segment: seg4(csRef.current), offset: off8(offset) },
    })
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    await afterStop(await waitOp(s, op.operation_id))
  }), [guard, rpc, waitOp, afterStop])

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
    cs, entryCs, readMemory, lines, breakpoints: new Set(bps.keys()), busy, error,
    mem, stack, accesses, accessesDropped, recording, record, clearRecording, memBase, memSize, setMemWindow,
    playing, play, pausePlay,
    start, step, stepUntil, cont, pause, stop, toggleBreakpoint, runTo,
  }
}
