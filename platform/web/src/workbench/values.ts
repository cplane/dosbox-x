import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lineForOffset, type LineMap } from './listing'
import { callStack, format, frameAt, globalsOf, readValues, typeName, type Machine, type StackFrame, type VarValue } from './symbols'
import { lineMapFromTds, SymbolClass, TypeId, type Tds, type TdsSymbol } from './tds'
import type { Debugger } from './useDebugger'

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

const h4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0')
const u16 = (b: Uint8Array, o = 0) => b[o] | (b[o + 1] << 8)

interface Place { seg: number; off: number }

/** The byte-packed members of a struct, union or object type, with their offsets. */
export function membersOf(tds: Tds, t: Tds['types'][number]): { name: string; type: number; off: number }[] {
  const first = t.member
  const next = Math.min(...tds.types.filter((x) => (x.id === TypeId.Struct || x.id === TypeId.Union || x.id === TypeId.Object) && x.member > first).map((x) => x.member), tds.members.length + 1)
  const out: { name: string; type: number; off: number }[] = []
  let off = 0
  for (let i = first; i < next; i++) {
    const mem = tds.members[i - 1]
    if (!mem) break
    if (t.id !== TypeId.Union && t.size && off >= t.size) break // the next type's members start here
    out.push({ name: mem.name, type: mem.type, off })
    if (t.id !== TypeId.Union) off += tds.types[mem.type - 1]?.size ?? 0
  }
  return out
}

/**
 * A watch expression: a name, then any of `.field`, `->field`, `[index]`, a trailing `^` (Pascal) or a leading
 * `*` (C) to follow a pointer. Names are the chosen frame's locals first, then the program's globals.
 */
export async function evaluateExpression(tds: Tds, m: Machine, locals: TdsSymbol[], bp: number, expr: string): Promise<VarValue> {
  const src = expr.trim()
  const fail = (value: string): VarValue => ({ name: expr, type: '', value, where: '', changed: false })
  let s = src
  let derefFirst = 0
  while (s.startsWith('*')) { derefFirst++; s = s.slice(1).trim() }
  const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s)
  if (!head) return fail('? (a name, then .field, [index], ^ or *)')
  const name = head[0]
  let rest = s.slice(name.length)

  // The name: a local of the chosen frame, else a global of the program (any static symbol by that name).
  const lc = name.toLowerCase()
  const sym = locals.find((x) => x.name.toLowerCase() === lc || x.name.replace(/^_/, '').toLowerCase() === lc)
    ?? tds.symbols.find((x) => x.cls === SymbolClass.Static && x.seg !== 0 && (x.name.toLowerCase() === lc || x.name.replace(/^_/, '').toLowerCase() === lc))
  if (!sym) return fail('? (no such variable here)')
  let type = sym.type
  let place: Place | null = null
  let registerDeref = false // the pointer in the register is already followed: the first -> or ^ is done
  const ss = parseInt(m.regs.segments.ss, 16) & 0xffff
  const off = sym.offset > 0x7fff ? sym.offset - 0x10000 : sym.offset
  if (sym.cls === SymbolClass.Register) {
    const REG16 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']
    const reg = REG16[sym.offset & 7]
    const v = parseInt(m.regs.general[reg] ?? '0', 16) & 0xffff
    const rt = tds.types[type - 1]
    if (rest.trim() || derefFirst) {
      // A register holding a near pointer: what it points at is in memory, so fields and elements can follow.
      if (!rt || (rt.id !== TypeId.Near && rt.id !== TypeId.NRef)) return fail(`? (${name} lives in ${reg.slice(1).toUpperCase()}: no fields or elements to follow)`)
      if (!v) return fail('null')
      place = { seg: parseInt(m.regs.segments.ds, 16) & 0xffff, off: v }
      type = rt.member
      registerDeref = true
    } else {
      const size = rt?.size ?? 2
      return { name: expr, type: typeName(tds, type), value: await format(tds, type, Uint8Array.from([v & 0xff, v >> 8]).subarray(0, Math.max(1, Math.min(size, 2))), m), where: reg.slice(1).toUpperCase(), changed: false }
    }
  } else if (sym.cls === SymbolClass.Auto) {
    place = { seg: ss, off: (bp + off) & 0xffff }
  } else if (sym.cls === SymbolClass.PascalVar) {
    const p = await m.read(ss, (bp + off) & 0xffff, 4)
    place = { seg: u16(p, 2), off: u16(p) }
  } else if (sym.cls === SymbolClass.Static) {
    place = { seg: (m.entryCs + sym.seg) & 0xffff, off: sym.offset }
  } else {
    return fail('? (not a variable)')
  }

  const deref = async (): Promise<string | null> => {
    const t = tds.types[type - 1]
    if (!t || !place) return '? (not a pointer)'
    if (t.id === TypeId.Near || t.id === TypeId.NRef) {
      const b = await m.read(place.seg, place.off, 2)
      place = { seg: parseInt(m.regs.segments.ds, 16) & 0xffff, off: u16(b) }
    } else if (t.id === TypeId.Far || t.id === TypeId.FRef) {
      const b = await m.read(place.seg, place.off, 4)
      place = { seg: u16(b, 2), off: u16(b) }
    } else return `? (${typeName(tds, type)} is not a pointer)`
    if (!place.seg && !place.off) return 'nil'
    type = t.member
    return null
  }

  // The accessors, left to right.
  const ops: string[] = []
  while (rest.trim()) {
    rest = rest.trim()
    let mm: RegExpExecArray | null
    if ((mm = /^(?:\.|->)([A-Za-z_][A-Za-z0-9_]*)/.exec(rest))) { ops.push(rest.startsWith('->') ? `>${mm[1]}` : `.${mm[1]}`); rest = rest.slice(mm[0].length) }
    else if ((mm = /^\[\s*(-?\d+)\s*\]/.exec(rest))) { ops.push(`[${mm[1]}`); rest = rest.slice(mm[0].length) }
    else if (rest.startsWith('^')) { ops.push('^'); rest = rest.slice(1) }
    else return fail(`? (cannot read "${rest}")`)
  }
  for (let i = 0; i < derefFirst; i++) ops.push('^')
  if (registerDeref && ops.length && (ops[0] === '^' || ops[0].startsWith('>'))) ops[0] = ops[0] === '^' ? '' : '.' + ops[0].slice(1)
  try {
    for (const op of ops) {
      if (op === '') continue
      if (op === '^' || op.startsWith('>')) { const e = await deref(); if (e) return fail(e) }
      const t = tds.types[type - 1]
      if (!t || !place) return fail('?')
      if (op.startsWith('.') || op.startsWith('>')) {
        const field = op.slice(1).toLowerCase()
        if (t.id !== TypeId.Struct && t.id !== TypeId.Union && t.id !== TypeId.Object) return fail(`? (${typeName(tds, type)} has no fields)`)
        const mem = membersOf(tds, t).find((x) => x.name.toLowerCase() === field)
        if (!mem) return fail(`? (no field ${op.slice(1)} in ${typeName(tds, type)})`)
        place = { seg: place.seg, off: (place.off + mem.off) & 0xffff }
        type = mem.type
      } else if (op.startsWith('[')) {
        const index = parseInt(op.slice(1), 10)
        if (t.id === TypeId.Near || t.id === TypeId.NRef || t.id === TypeId.Far || t.id === TypeId.FRef) { const e = await deref(); if (e) return fail(e) }
        const at = tds.types[type - 1]
        if (!at || at.id !== TypeId.Array) return fail(`? (${typeName(tds, type)} is not an array)`)
        const el = tds.types[at.member - 1]
        if (!el || !el.size) return fail('? (unknown element size)')
        place = { seg: place!.seg, off: (place!.off + index * el.size) & 0xffff }
        type = at.member
      }
    }
    const t = tds.types[type - 1]
    const size = t?.size ?? 2
    const bytes = await m.read(place!.seg, place!.off, Math.max(1, Math.min(size, 256)))
    return { name: expr, type: typeName(tds, type), value: await format(tds, type, bytes, m), where: `${h4(place!.seg)}:${h4(place!.off)}`, changed: false }
  } catch (err) {
    return fail(`? (${err instanceof Error ? err.message : String(err)})`)
  }
}

const EMPTY: LineMap = { lineOf: new Map(), offsetOf: new Map() }

export function useDebugValues(dbg: Debugger, symbols: { tds: Tds; source: string } | null): DebugValues {
  const { regs, ip, cs, entryCs, stopped } = dbg
  const tds = symbols?.tds ?? null
  const lineMap: LineMap = useMemo(() => (tds ? lineMapFromTds(tds) : EMPTY), [tds])
  const [frames, setFrames] = useState<StackFrame[]>([])
  const [chosen, setChosen] = useState(0)
  const [locals, setLocals] = useState<VarValue[]>([])
  const [globals, setGlobals] = useState<VarValue[]>([])
  const [note, setNote] = useState('')
  const [stopSeq, setStopSeq] = useState(0)
  const previous = useRef(new Map<string, string>())
  const globalSyms = useMemo(() => (tds && symbols ? globalsOf(tds, symbols.source) : []), [tds, symbols])
  const inProgram = !!regs && entryCs !== null && dbg.inProgram(parseInt(cs, 16) & 0xffff, regs)

  // A new stop: the stack from here (walked from BP even inside the runtime or DOS, since their frames link back
  // into the program's), the innermost frame of ours chosen.
  useEffect(() => {
    if (!tds || !stopped || !regs || ip === null || entryCs === null) { if (!dbg.session) { setFrames([]); setLocals([]); setGlobals([]); previous.current = new Map() } return }
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

  // The chosen frame's locals and the globals.
  useEffect(() => {
    if (!tds || !stopped || !regs || entryCs === null) return
    const frame = frames[chosen]
    const scope = frame ? frameAt(tds, frame.ip) : { fn: null, fnOffset: null, locals: [] }
    const bp = frame ? frame.bp : parseInt(regs.general.ebp, 16) & 0xffff
    const m = { regs, entryCs, read: dbg.readMemory }
    let cancelled = false
    ;(async () => {
      const prev = previous.current
      const [l, g] = await Promise.all([readValues(tds, scope.locals, m, bp, prev), readValues(tds, globalSyms, m, bp, prev)])
      if (cancelled) return
      const next = new Map<string, string>()
      for (const v of [...l, ...g]) next.set(v.name, v.value)
      previous.current = next
      setLocals(l); setGlobals(g)
    })()
    return () => { cancelled = true }
  }, [tds, stopped, regs, entryCs, frames, chosen, globalSyms, dbg.readMemory]) // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = useCallback(async (expr: string): Promise<VarValue> => {
    if (!tds || !stopped || !regs || entryCs === null) return { name: expr, type: '', value: '', where: '', changed: false }
    const frame = frames[chosen]
    const scope = frame ? frameAt(tds, frame.ip) : { fn: null, fnOffset: null, locals: [] }
    const bp = frame ? frame.bp : parseInt(regs.general.ebp, 16) & 0xffff
    return evaluateExpression(tds, { regs, entryCs, read: dbg.readMemory }, scope.locals, bp, expr)
  }, [tds, stopped, regs, entryCs, frames, chosen, dbg.readMemory])

  const f = frames[chosen]
  const frameIp = f ? f.ip : null // the main block has no function but a line all the same
  const frameLine = frameIp !== null ? lineForOffset(lineMap, frameIp) : null
  return { frames, chosen, setChosen, locals, globals, note, lineMap, frameLine, frameIp, evaluate, stopSeq }
}
