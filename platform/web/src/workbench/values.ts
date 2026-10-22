import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lineForOffset, type LineMap } from './listing'
import { callStack, enclosingAt, frameAt, globalsOf, readValues, registersOf, typeName, type Machine, type StackFrame, type VarValue } from './symbols'
import { evaluate as evaluateWatch } from './expr'
import { lineMapFromTds, SymbolClass, type Tds, type TdsSymbol } from './tds'
import type { Debugger, Registers } from './useDebugger'

/**
 * What the debug panels share while the program is stopped: the call stack
 * (innermost first) with the chosen frame, that frame's parameters and
 * locals, the program's globals, and an evaluator for watch expressions,
 * all read from the machine at each stop.
 */

export interface DebugValues {
  frames: StackFrame[]
  chosen: number
  setChosen: (i: number) => void
  locals: VarValue[]
  /** A Pascal nested procedure's enclosing procedures (innermost first) with their variables. */
  enclosing: { fn: string; values: VarValue[] }[]
  globals: VarValue[]
  /** Why the frames are not where the program stopped (paused in the runtime or DOS). */
  note: string
  lineMap: LineMap
  /** The chosen frame's source line and address, null when none. */
  frameLine: number | null
  frameIp: number | null
  /** A watch expression's value in the chosen frame, at the current stop. */
  evaluate: (expr: string) => Promise<VarValue>
  /** Bumps at every stop, so watchers re-evaluate. */
  stopSeq: number
}

const u16 = (b: Uint8Array, o = 0) => b[o] | (b[o + 1] << 8)

const EMPTY: LineMap = { lineOf: new Map(), offsetOf: new Map() }

/**
 * The enclosing procedures of a Pascal nested procedure at ip, each with its frame: Turbo Pascal passes the
 * enclosing procedure's BP (the static link) as the last parameter, at [BP+4] of the nested one's frame.
 */
async function enclosingFrames(tds: Tds, m: Machine, ip: number, bp: number): Promise<{ fn: string; locals: TdsSymbol[]; bp: number }[]> {
  const levels = enclosingAt(tds, ip)
  const out: { fn: string; locals: TdsSymbol[]; bp: number }[] = []
  const ss = parseInt(m.regs.segments.ss, 16) & 0xffff
  let cur = bp
  for (const level of levels) {
    let link: Uint8Array
    try { link = await m.read(ss, (cur + 4) & 0xffff, 2) } catch { break }
    cur = u16(link)
    out.push({ ...level, bp: cur })
  }
  return out
}

export function useDebugValues(dbg: Debugger, symbols: { tds: Tds; source: string } | null): DebugValues {
  const { regs, ip, cs, entryCs, stopped } = dbg
  const tds = symbols?.tds ?? null
  const lineMap: LineMap = useMemo(() => (tds ? lineMapFromTds(tds) : EMPTY), [tds])
  const [frames, setFrames] = useState<StackFrame[]>([])
  const [chosen, setChosen] = useState(0)
  const [locals, setLocals] = useState<VarValue[]>([])
  const [enclosing, setEnclosing] = useState<{ fn: string; values: VarValue[] }[]>([])
  const [globals, setGlobals] = useState<VarValue[]>([])
  const [note, setNote] = useState('')
  const [stopSeq, setStopSeq] = useState(0)
  const previous = useRef(new Map<string, string>())
  const shownFrame = useRef('') // the frame (function:BP) whose variables are on show
  const contextCache = useRef<{ key: string; value: Promise<{ outer: { fn: string; locals: TdsSymbol[]; bp: number }[]; regs: Registers }> } | null>(null)
  const globalSyms = useMemo(() => (tds && symbols ? globalsOf(tds, symbols.source) : []), [tds, symbols])
  const inProgram = !!regs && entryCs !== null && dbg.inProgram(parseInt(cs, 16) & 0xffff, regs)

  // A new stop: the stack from here (walked from BP even inside the runtime or DOS, since their frames link back
  // into the program's), the innermost frame of ours chosen.
  useEffect(() => {
    if (!tds || !stopped || !regs || ip === null || entryCs === null) { if (!dbg.session) { setFrames([]); setLocals([]); setEnclosing([]); setGlobals([]); previous.current = new Map(); shownFrame.current = '' } return }
    let cancelled = false
    const bp = parseInt(regs.general.ebp, 16) & 0xffff
    const m = { regs, entryCs, read: dbg.readMemory }
    ;(async () => {
      const stack = await callStack(tds, m, inProgram ? ip : -1, bp)
      if (cancelled) return
      setFrames(stack)
      const first = stack.findIndex((f) => f.fn !== null)
      setChosen(first < 0 ? 0 : first)
      setNote(inProgram ? '' : 'paused outside the program (the runtime, DOS or the BIOS): the nearest frame of yours is shown')
      setStopSeq((n) => n + 1)
    })()
    return () => { cancelled = true }
  }, [tds, stopped, regs, ip, entryCs, inProgram, dbg.readMemory, dbg.session]) // eslint-disable-line react-hooks/exhaustive-deps

  // For the chosen frame: the enclosing procedures' frames (Pascal) and the registers as that frame had them,
  // worked out once per stop and frame (the panel and every watch share it).
  type Context = { outer: { fn: string; locals: TdsSymbol[]; bp: number }[]; regs: Registers }
  const frameContext = (m: Machine, frame: StackFrame | undefined): Promise<Context> => {
    const key = `${m.regs.instruction_pointer}:${m.regs.general.esp}:${chosen}:${frame?.at}:${frame?.bp}`
    if (contextCache.current?.key !== key) {
      contextCache.current = {
        key,
        value: (async () => ({
          outer: frame && tds ? await enclosingFrames(tds, m, frame.at, frame.bp).catch(() => []) : [],
          regs: tds && chosen > 0 ? await registersOf(tds, m, frames, chosen).catch(() => m.regs) : m.regs,
        }))(),
      }
    }
    return contextCache.current.value
  }

  // The chosen frame's locals and the globals.
  useEffect(() => {
    if (!tds || !stopped || !regs || entryCs === null) return
    const frame = frames[chosen]
    const scope = frame ? frameAt(tds, frame.at) : { fn: null, fnOffset: null, locals: [] }
    const bp = frame ? frame.bp : parseInt(regs.general.ebp, 16) & 0xffff
    const m = { regs, entryCs, read: dbg.readMemory }
    let cancelled = false
    // Another frame than before (a call, a return, a frame picked in the stack): its variables at once, with
    // their values to come, so the panel never shows the previous frame's under the new one's name. The same
    // frame keeps its values on show until the new ones are read (no flicker while stepping).
    const frameKey = `${scope.fn}:${bp}`
    if (frameKey !== shownFrame.current) {
      shownFrame.current = frameKey
      const placeholder = (s: TdsSymbol): VarValue => ({ name: s.name.replace(/^_/, ''), type: typeName(tds, s.type), value: '…', where: '', changed: false })
      setLocals(scope.locals.map(placeholder))
      setEnclosing((frame ? enclosingAt(tds, frame.at) : []).map((e) => ({ fn: e.fn, values: e.locals.filter((s) => s.cls !== SymbolClass.Register).map(placeholder) })))
    }
    ;(async () => {
      const prev = previous.current
      const { outer, regs: frameRegs } = await frameContext(m, frame)
      const mf = { ...m, regs: frameRegs } // a caller's register variables: from the slots its callees saved them in
      const [l, g, ...o] = await Promise.all([
        readValues(tds, scope.locals, mf, bp, prev), readValues(tds, globalSyms, m, bp, prev),
        ...outer.map((x) => readValues(tds, x.locals.filter((s) => s.cls !== SymbolClass.Register), m, x.bp, prev)),
      ])
      if (cancelled) return
      const next = new Map<string, string>()
      for (const v of [...l, ...g, ...o.flat()]) next.set(v.name, v.value)
      previous.current = next
      setLocals(l); setGlobals(g)
      setEnclosing(outer.map((x, i) => ({ fn: x.fn, values: o[i] })))
    })()
    return () => { cancelled = true }
  }, [tds, stopped, regs, entryCs, frames, chosen, globalSyms, dbg.readMemory]) // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = useCallback(async (expr: string): Promise<VarValue> => {
    if (!tds || !stopped || !regs || entryCs === null) return { name: expr, type: '', value: '', where: '', changed: false }
    const frame = frames[chosen]
    const scope = frame ? frameAt(tds, frame.at) : { fn: null, fnOffset: null, locals: [] }
    const bp = frame ? frame.bp : parseInt(regs.general.ebp, 16) & 0xffff
    const m = { regs, entryCs, read: dbg.readMemory }
    const { outer, regs: frameRegs } = await frameContext(m, frame)
    return evaluateWatch(tds, { ...m, regs: frameRegs }, { locals: scope.locals, bp, enclosing: outer }, expr)
  }, [tds, stopped, regs, entryCs, frames, chosen, dbg.readMemory]) // eslint-disable-line react-hooks/exhaustive-deps

  const f = frames[chosen]
  const frameIp = f ? f.ip : null // the main block has no function but a line all the same
  const frameLine = f ? lineForOffset(lineMap, f.at) : null
  return { frames, chosen, setChosen, locals, enclosing, globals, note, lineMap, frameLine, frameIp, evaluate, stopSeq }
}
