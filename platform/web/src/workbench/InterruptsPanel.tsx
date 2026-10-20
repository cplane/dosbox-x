import { useEffect, useMemo, useRef, useState } from 'react'
import { INTERRUPTS, h2 } from './interrupts'

/** The interrupt reference, filterable; `focus` scrolls to and highlights one function (from the machine view). */
interface Props {
  focus?: { int: number; ax: number } | null
}

export function InterruptsPanel({ focus }: Props) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const bodyRef = useRef<HTMLDivElement>(null)
  const vectors = useMemo(() => {
    if (!needle) return INTERRUPTS
    return INTERRUPTS.map((v) => ({
      ...v,
      fns: v.fns.filter((f) => `${h2(f.fn)} ${f.name} ${f.in ?? ''} ${f.out ?? ''} ${f.note ?? ''}`.toLowerCase().includes(needle)),
    })).filter((v) => v.fns.length > 0 || `int ${h2(v.int)} ${v.title}`.toLowerCase().includes(needle))
  }, [needle])

  useEffect(() => {
    if (!focus) return
    setQ('')
    const id = `int-${focus.int}-${focus.ax}`
    window.setTimeout(() => bodyRef.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'center' }), 50)
  }, [focus])

  const isFocus = (int: number, fn: { fn: number; ax?: boolean }) =>
    !!focus && focus.int === int && (fn.ax ? fn.fn === focus.ax : fn.fn === (focus.ax >> 8))

  return (
    <div className="guide ints">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find: print, file, cursor, 4C…" spellCheck={false} />
      <div className="guide-body" ref={bodyRef}>
        {vectors.map((v) => (
          <section key={v.int}>
            <h4>INT {h2(v.int)} · {v.title}</h4>
            {v.note && <p className="guide-note">{v.note}</p>}
            {v.fns.map((f) => (
              <div key={f.fn} data-id={`int-${v.int}-${f.ax ? f.fn : f.fn << 8}`} className={`guide-entry ${isFocus(v.int, f) ? 'focus' : ''}`}>
                <div className="guide-head"><b>{f.ax ? 'AX=' : 'AH='}{f.ax ? f.fn.toString(16).toUpperCase().padStart(4, '0') + 'h' : h2(f.fn)}</b> {f.name}</div>
                <div className="guide-desc">
                  {f.in && <div><span className="guide-k">in</span> {f.in}</div>}
                  {f.out && <div><span className="guide-k">out</span> {f.out}</div>}
                  {f.note && <div className="guide-flags">{f.note}</div>}
                </div>
              </div>
            ))}
          </section>
        ))}
        {vectors.length === 0 && <p className="guide-note">nothing matches</p>}
      </div>
    </div>
  )
}
