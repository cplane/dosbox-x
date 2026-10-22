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
  /** The program's memory block (hex paragraphs): code outside it is the runtime of DOS or the BIOS. */
  program?: { psp: string; paragraphs: string }
}

export interface Session {
  session_id: string
  state: string
  stop_reason?: { kind: string; breakpoint_id?: string; address?: { segment?: string; offset?: string } }
  /** Why the last operation faulted (a refused stop, say). */
  failure?: string
}

/** The program's memory block from a registers snapshot (an older agent has none). */
function blockOf(r: Registers): { psp: number; end: number } | null {
  if (!r.program) return null
  const psp = parseInt(r.program.psp, 16) & 0xffff
  return { psp, end: psp + (parseInt(r.program.paragraphs, 16) & 0xffff) }
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
  /** Whether a code segment lies in the program's own memory block (else: DOS, the BIOS). */
  inProgram: (cs: number, regs?: Registers) => boolean
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
  start: (command: string, nudge?: (attempt: number) => Promise<void>) => Promise<void>
  /** Ends a session this page does not know (left by a reload): true when there was one and it ended. */
  endOrphan: (nudge?: (attempt: number) => Promise<void>) => Promise<boolean>
  step: (mode: 'into' | 'over') => Promise<void>
  /** Many instructions in one go, each decided before it runs; the view refreshes at the end. */
  stepUntil: (decide: (ip: number, cs: string, text: string) => 'into' | 'over' | 'stop', max?: number) => Promise<void>
  cont: () => Promise<void>
  pause: () => Promise<void>
  /** Ends the program; `returnTo` is where in its own code to let it get back to first when it sits in DOS. */
  /** Ends the program. `returnTo`: the chosen frame's address to come back to first when paused outside the program;
   *  `nudge(attempt)`: gives a program waiting for input a key so it comes back (called a few times). */
  stop: (returnTo?: number, nudge?: (attempt: number) => Promise<void>) => Promise<void>
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
  const [program, setProgram] = useState<{ psp: number; end: number } | null>(null)
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
  const cancelRef = useRef(false) // pause pressed during a line step
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
    setProgram(blockOf(r))
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
      // A call that lost its target to a stop or an exit in the meantime is not an error worth showing.
      const msg = err instanceof Error ? err.message : String(err)
      if (sessionRef.current || !/has exited|not found|not known|TARGET_EXITED|SESSION_NOT_FOUND/i.test(msg)) setError(msg)
    } finally {
      setBusy(false)
    }
  }, [])

  const waitOp = useCallback(async (s: Session, operation_id: string): Promise<Session> => {
    for (;;) {
      const r = (await rpc('execution.wait', { session_id: s.session_id, operation_id, timeout_ms: 3000 })) as
        { running: boolean; session?: Session; state?: string; stop_reason?: Session['stop_reason']; failure?: string }
      if (!r.running) return { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? 'stopped', stop_reason: r.session?.stop_reason ?? r.stop_reason, failure: r.failure }
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
    setProgram(null)
    windowRef.current = null
  }, [])

  const afterStop = useCallback(async (next: Session) => {
    if (next.state === 'exited') { clear(); return } // the program ended: nothing is left to look at
    setSession(next)
    if (next.state === 'stopped') await refresh(next)
  }, [refresh, clear])

  const readMemoryOf = useCallback(async (s: Session, seg: number, offset: number, length: number): Promise<Uint8Array> => {
    const r = (await rpc('memory.read', {
      session_id: s.session_id,
      address: { space: 'segmented', segment: '0x' + (seg & 0xffff).toString(16).toUpperCase().padStart(4, '0'), offset: off8(offset & 0xffff) },
      length,
    })) as { data_base64: string }
    return Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))
  }, [rpc])

  const readMemory = useCallback((seg: number, offset: number, length: number): Promise<Uint8Array> => {
    const s = sessionRef.current
    if (!s) throw new Error('no session')
    return readMemoryOf(s, seg, offset, length)
  }, [readMemoryOf])

  // One instruction. A step over a call that does not come back within the agent's timeout (the program waits for
  // input inside it) leaves the target running: the session shows as running until it stops, polled through
  // session.status, which the agent answers while the step is still pending.
  const blockedRef = useRef(false)
  const stepOnce = useCallback(async (s: Session, mode: 'into' | 'over'): Promise<{ session: Session; registers?: Registers }> => {
    try {
      const r = (await rpc('execution.step', { session_id: s.session_id, mode })) as
        { session?: Session; state?: string; stop_reason?: Session['stop_reason']; registers?: Registers }
      return { session: { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? s.state, stop_reason: r.session?.stop_reason ?? r.stop_reason }, registers: r.registers }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/execution\.step to complete|still executing/i.test(msg)) throw err
      setSession({ ...s, state: 'running' })
      blockedRef.current = true
      try {
        for (;;) {
          await new Promise((f) => setTimeout(f, 500))
          const st = (await rpc('session.status', { session_id: s.session_id })) as { state: string }
          if (st.state === 'running') continue
          if (st.state !== 'stopped') return { session: { ...s, state: st.state } }
          const registers = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers
          return { session: { ...s, state: 'stopped' }, registers }
        }
      } finally {
        blockedRef.current = false
      }
    }
  }, [rpc])

  const step = useCallback((mode: 'into' | 'over') => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    await afterStop((await stepOnce(s, mode)).session)
  }), [guard, stepOnce, afterStop])

  // Step instruction by instruction until `decide` says stop (or a breakpoint, the end, or `max`), refreshing
  // the view only at the end: a source line in one go. `decide` sees each instruction before it runs.
  const stepUntil = useCallback((decide: (ip: number, cs: string, text: string) => 'into' | 'over' | 'stop', max = 3000) => guard(async () => {
    const s = sessionRef.current
    const r0 = regsRef.current
    if (!s || s.state !== 'stopped' || !r0) return
    let next: Session = s
    let ip = parseInt(r0.instruction_pointer, 16), csNow = r0.segments.cs
    // Instruction texts by cs:offset, from the window on show and whatever gets disassembled along the way.
    const known = new Map<string, string>()
    const w = windowRef.current
    if (w) for (const l of w.lines) known.set(`${w.seg}:${l.offset}`, l.text)
    const textAt = async (seg: string, off: number): Promise<string> => {
      const key = `${seg}:${off}`
      const hit = known.get(key)
      if (hit !== undefined) return hit
      const dis = (await rpc('code.disassemble', {
        session_id: s.session_id, address: { space: 'segmented', segment: seg4(seg), offset: off8(off) }, count: 24,
      })) as { lines: { offset: string; text: string }[] }
      for (const l of dis.lines) known.set(`${seg}:${parseInt(l.offset, 16)}`, l.text)
      return known.get(key) ?? ''
    }
    cancelRef.current = false
    for (let i = 0; i < max; i++) {
      if (cancelRef.current) break
      const mode = decide(ip, csNow, await textAt(csNow, ip))
      if (mode === 'stop') break
      const r = await stepOnce(s, mode)
      next = r.session
      if (next.state !== 'stopped' || !r.registers) break
      ip = parseInt(r.registers.instruction_pointer, 16); csNow = r.registers.segments.cs
      // A step over a call stops on the agent's own breakpoint after it; only the user's count as a stop here.
      if (bpsRef.current.has(ip) && csNow === cs) break
    }
    await afterStop(next)
  }), [guard, rpc, stepOnce, afterStop])

  const cont = useCallback(() => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
    setSession({ ...s, state: 'running' })
    await afterStop(await waitOp(s, op.operation_id))
  }), [guard, rpc, waitOp, afterStop])

  // Pause: halt a running program where it is; a line step in progress (many short runs) stops at its next instruction.
  const pause = useCallback(() => guard(async () => {
    cancelRef.current = true
    const s = sessionRef.current
    if (!s || s.state !== 'running') return
    if (blockedRef.current) throw new Error('the program waits for input inside a call it was stepped over: give it a key in the Screen view')
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

  // Waits for an operation up to a deadline; null when it is still running then.
  const waitOpFor = useCallback(async (s: Session, operation_id: string, ms: number): Promise<Session | null> => {
    const until = performance.now() + ms
    while (performance.now() < until) {
      const r = (await rpc('execution.wait', { session_id: s.session_id, operation_id, timeout_ms: Math.round(Math.max(100, Math.min(1000, until - performance.now()))) })) as
        { running: boolean; session?: Session; state?: string; stop_reason?: Session['stop_reason'] }
      if (!r.running) return { ...s, ...(r.session ?? {}), state: r.session?.state ?? r.state ?? 'stopped', stop_reason: r.session?.stop_reason ?? r.stop_reason }
    }
    return null
  }, [rpc])

  const inProgram = useCallback((seg: number, r?: Registers) => {
    const block = (r && blockOf(r)) ?? program
    if (block) return seg >= block.psp && seg < block.end
    return entryCs !== null && seg === entryCs
  }, [program, entryCs])

  // Ends a session's program. A running one is paused first; one paused inside DOS or the BIOS is brought back
  // into its own code (`returnTo`: the nearest frame's address from the call stack; else the interrupt return
  // frame on the stack whose CS is the program's; else the frame BP points at) so DOS is in a sane state when
  // the target is terminated. Throws when the program could not be ended: the session is then still there.
  const endSession = useCallback(async (s0: Session, returnTo?: number, nudge?: (attempt: number) => Promise<void>) => {
    let s = s0
    // The state once the target is at rest (a pause can take a moment to land).
    const settle = async (): Promise<Session> => {
      for (let i = 0; i < 30; i++) {
        const r = (await rpc('session.status', { session_id: s.session_id })) as { state: string }
        if (r.state !== 'running' && r.state !== 'starting') return { ...s, state: r.state }
        await new Promise((f) => setTimeout(f, 100))
      }
      return s
    }
    const atRest = () => s.state === 'stopped' || s.state === 'exited' // a closure: `s` changes under the narrowing
    const pauseNow = async () => {
      const op = (await rpc('execution.pause', { session_id: s.session_id })) as { operation_id: string }
      s = (await waitOpFor(s, op.operation_id, 3000)) ?? await settle()
    }
    if (s.state === 'running' || s.state === 'starting') {
      try { await pauseNow() } catch (err) { console.warn('stop: pause', err) }
      if (!atRest()) throw new Error('could not stop the program: it did not pause')
    }
    if (s.state === 'stopped') {
      try {
        const r = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers
        const cs = parseInt(r.segments.cs, 16) & 0xffff
        if (!inProgram(cs, r)) {
          let target = returnTo
          let targetCs = entryCs ?? cs
          const ss = parseInt(r.segments.ss, 16) & 0xffff
          if (target === undefined) {
            const sp = parseInt(r.general.esp, 16) & 0xffff
            const stack = await readMemoryOf(s, ss, sp, Math.min(512, 0x10000 - sp))
            // An IRET frame (IP, CS, FLAGS) whose CS is the program's and whose IP follows an INT instruction.
            for (let k = 0; k + 5 < stack.length; k += 2) {
              const ip = stack[k] | (stack[k + 1] << 8), seg = stack[k + 2] | (stack[k + 3] << 8), fl = stack[k + 4] | (stack[k + 5] << 8)
              if (!inProgram(seg, r) || !(fl & 0x0002) || ip < 2) continue
              const code = await readMemoryOf(s, seg, ip - 2, 2)
              if (code[0] === 0xcd) { target = ip; targetCs = seg; break }
            }
          }
          if (target === undefined) {
            const bp = parseInt(r.general.ebp, 16) & 0xffff
            const link = await readMemoryOf(s, ss, bp + 2, 2)
            target = link[0] | (link[1] << 8)
          }
          await rpc('breakpoints.create', {
            session_id: s.session_id, kind: 'execution', once: true,
            address: { space: 'segmented', segment: seg4('0x' + targetCs.toString(16)), offset: off8(target) },
          })
          const op = (await rpc('execution.continue', { session_id: s.session_id })) as { operation_id: string }
          let back = await waitOpFor(s, op.operation_id, 1500)
          // Not back: it waits for input inside DOS or the BIOS. A key or two (Enter, Escape) usually lets it return.
          for (let attempt = 0; !back && nudge && attempt < 3; attempt++) {
            try { await nudge(attempt) } catch { break }
            back = await waitOpFor(s, op.operation_id, 1000)
          }
          // Still inside: pause where it is; the stop below is refused there and says so.
          if (back) s = back
          else await pauseNow()
        }
      } catch (err) { console.warn('stop: return to the program', err) }
    }
    if (!atRest()) throw new Error('could not stop the program: it did not pause')
    if (s.state !== 'exited') {
      try {
        const op = (await rpc('session.stop', { session_id: s.session_id })) as { operation_id: string }
        const done = await waitOp(s, op.operation_id)
        if (done.state !== 'exited') throw new Error(done.failure ?? 'it did not end')
      } catch (err) {
        // The session may already be gone (the program ended as it was stopped): then it is fine to forget it.
        const msg = err instanceof Error ? err.message : String(err)
        if (!/not known|not found|SESSION_NOT_FOUND|has exited|TARGET_EXITED/i.test(msg)) throw new Error(`could not stop the program: ${msg}`)
      }
    }
  }, [rpc, waitOp, waitOpFor, entryCs, inProgram, readMemoryOf])

  const stop = useCallback((returnTo?: number, nudge?: (attempt: number) => Promise<void>) => guard(async () => {
    const s = sessionRef.current
    if (!s) return
    try {
      await endSession(s, returnTo, nudge)
    } catch (err) {
      // Still there: show it as the agent has it now.
      try { const r = (await rpc('session.status', { session_id: s.session_id })) as { state: string }; setSession({ ...s, state: r.state }) } catch { /* keep */ }
      throw err
    }
    clear()
  }), [guard, rpc, endSession, clear])

  const endOrphan = useCallback(async (nudge?: (attempt: number) => Promise<void>): Promise<boolean> => {
    let s: Session
    try {
      s = (await rpc('session.status', {})) as Session
    } catch { return false }
    if (s.state !== 'running' && s.state !== 'stopped' && s.state !== 'starting') return false
    await endSession(s, undefined, nudge)
    return true
  }, [rpc, endSession])

  // Start: the program at its entry. A session left behind (a reload mid-debugging) is ended first.
  const start = useCallback((command: string, nudge?: (attempt: number) => Promise<void>) => guard(async () => {
    const [cmd, ...args] = command.trim().split(/\s+/)
    const params = {
      target: { command: cmd, arguments: args },
      mounts: [{ drive: 'C', host_path: '/data/c' }],
      break_at: 'entry',
    }
    let s: Session
    try {
      s = (await rpc('session.start', params)) as Session
    } catch (err) {
      const data = (err as { data?: { reason?: string; session_id?: string; state?: string } }).data
      if (data?.reason !== 'SESSION_BUSY' || !data.session_id) throw err
      await endSession({ session_id: data.session_id, state: data.state ?? 'running' }, undefined, nudge)
      await new Promise((f) => setTimeout(f, 300))
      s = (await rpc('session.start', params)) as Session
    }
    setSession(s)
    setPrevRegs(null)
    setBps(new Map())
    windowRef.current = null
    await refresh(s)
    // The entry stop: CS is the load segment.
    const r0 = (await rpc('state.get_registers', { session_id: s.session_id })) as Registers
    setEntryCs(parseInt(r0.segments.cs, 16) & 0xffff)
    setProgram(blockOf(r0))
  }), [guard, rpc, refresh, endSession])

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
    cs, entryCs, inProgram, readMemory, lines, breakpoints: new Set(bps.keys()), busy, error,
    mem, stack, accesses, accessesDropped, recording, record, clearRecording, memBase, memSize, setMemWindow,
    playing, play, pausePlay,
    start, endOrphan, step, stepUntil, cont, pause, stop, toggleBreakpoint, runTo,
  }
}
