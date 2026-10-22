import { useEffect, useMemo, useRef, useState } from 'react'
import { lineForOffset, type LineMap } from './listing'
import { callStack, frameAt, globalsOf, readValues, type StackFrame, type VarValue } from './symbols'
import { lineMapFromTds, type Tds } from './tds'
import type { Debugger } from './useDebugger'

/**
 * The program's variables while it is stopped: the call stack (innermost
 * first, click a frame to look at it), the parameters and locals of the
 * chosen frame's function, and the globals, with values read from the
 * machine and printed by type; what changed since the last stop is lit.
 */

interface Props {
  dbg: Debugger
  tds: Tds
  source: string
  /** The values on show, for the editor's hover. */
  onValues?: (values: VarValue[]) => void
  /** The chosen frame's source line and address (null when none): the editor marks the line, Stop returns to the address. */
  onFrame?: (line: number | null, ip: number | null) => void
}

export function VariablesPanel({ dbg, tds, source, onValues, onFrame }: Props) {
  const { regs, ip, cs, entryCs, stopped } = dbg
  const lineMap: LineMap = useMemo(() => lineMapFromTds(tds), [tds])
  const [frames, setFrames] = useState<StackFrame[]>([])
  const [chosen, setChosen] = useState(0)
  const [locals, setLocals] = useState<VarValue[]>([])
  const [globals, setGlobals] = useState<VarValue[]>([])
  const [note, setNote] = useState('')
  const previous = useRef(new Map<string, string>())
  const globalSyms = useMemo(() => globalsOf(tds, source), [tds, source])
  const inProgram = !!regs && entryCs !== null && dbg.inProgram(parseInt(cs, 16) & 0xffff, regs)

  // A new stop: the stack from here (walked from BP even inside the runtime or DOS, since their frames link back
  // into the program's), the innermost frame of ours chosen.
  useEffect(() => {
    if (!stopped || !regs || ip === null || entryCs === null) return
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
    })()
    return () => { cancelled = true }
  }, [stopped, regs, ip, entryCs, inProgram, tds, dbg.readMemory]) // eslint-disable-line react-hooks/exhaustive-deps

  // The chosen frame's line, for the editor; none once the panel goes.
  useEffect(() => {
    const f = frames[chosen]
    if (f && f.fn !== null) onFrame?.(lineForOffset(lineMap, f.ip), f.ip)
    else onFrame?.(null, null)
  }, [frames, chosen, lineMap]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onFrame?.(null, null), []) // eslint-disable-line react-hooks/exhaustive-deps

  // The chosen frame's locals and the globals.
  useEffect(() => {
    if (!stopped || !regs || entryCs === null) return
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
      onValues?.([...l, ...g])
    })()
    return () => { cancelled = true }
  }, [stopped, regs, entryCs, frames, chosen, tds, globalSyms, dbg.readMemory]) // eslint-disable-line react-hooks/exhaustive-deps

  const lineOf = (addr: number) => lineForOffset(lineMap, addr)
  const row = (v: VarValue) => (
    <tr key={v.name} className={v.changed ? 'changed' : ''} title={v.where}>
      <td className="var-name">{v.name}</td>
      <td className="var-type">{v.type}</td>
      <td className="var-value">{v.value}</td>
    </tr>
  )
  const fn = frames[chosen]?.fn ?? null
  return (
    <div className="vars">
      {!stopped && <p className="muted small">running…</p>}
      {note && <p className="muted small">{note}</p>}
      {frames.length > 0 && (
        <>
          <div className="vars-head">calls</div>
          <div className="vars-calls">
            {frames.map((f, i) => {
              const line = lineOf(f.ip)
              return (
                <button key={i} className={`vars-frame ${i === chosen ? 'on' : ''}`} onClick={() => setChosen(i)} title={`${f.ip.toString(16).toUpperCase().padStart(4, '0')} · BP ${f.bp.toString(16).toUpperCase().padStart(4, '0')}`}>
                  {i > 0 && <span className="muted">← </span>}{f.fn ?? 'program'}{line !== null ? <span className="muted"> :{line}</span> : null}
                </button>
              )
            })}
          </div>
        </>
      )}
      <div className="vars-head">{fn ? `${fn}()` : 'program'}</div>
      <table className="vars-table"><tbody>{locals.map(row)}{locals.length === 0 && <tr><td className="muted" colSpan={3}>no locals here</td></tr>}</tbody></table>
      <div className="vars-head">globals</div>
      <table className="vars-table"><tbody>{globals.map(row)}{globals.length === 0 && <tr><td className="muted" colSpan={3}>none</td></tr>}</tbody></table>
    </div>
  )
}
