import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { VarValue } from './symbols'
import type { DebugValues } from './values'

/**
 * Watch expressions: names from the chosen frame or the globals, with
 * `.field`, `->field`, `[index]`, `^` or a leading `*` to follow pointers
 * (`a[i]`, `Cursor.X`, `p->next`, `node^.value`), re-read at every stop;
 * what changed is lit. The list is kept per box.
 */
export function WatchPanel({ values, stopped, boxId }: { values: DebugValues; stopped: boolean; boxId: string }) {
  const key = `dosbox.watch.${boxId}`
  const [exprs, setExprs] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[] } catch { return [] } })
  const [results, setResults] = useState<Map<string, VarValue>>(new Map())
  const [draft, setDraft] = useState('')
  const previous = useRef(new Map<string, string>())
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(exprs)) } catch { /* private mode */ } }, [exprs, key])

  // Every stop (and every change of frame or list): all expressions again.
  useEffect(() => {
    if (!stopped) return
    let cancelled = false
    ;(async () => {
      const out = new Map<string, VarValue>()
      for (const e of exprs) {
        const v = await values.evaluate(e)
        const was = previous.current.get(e)
        out.set(e, { ...v, changed: was !== undefined && was !== v.value })
      }
      if (cancelled) return
      previous.current = new Map([...out].map(([k, v]) => [k, v.value]))
      setResults(out)
    })()
    return () => { cancelled = true }
  }, [stopped, exprs, values.stopSeq, values.chosen, values.evaluate]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = (e: FormEvent) => {
    e.preventDefault()
    const t = draft.trim()
    if (t && !exprs.includes(t)) setExprs([...exprs, t])
    setDraft('')
  }
  return (
    <div className="vars">
      <form className="watch-add" onSubmit={add}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="a[i], Cursor.X, p->next, node^.value" spellCheck={false} />
        <button type="submit" disabled={!draft.trim()}>add</button>
      </form>
      {!stopped && exprs.length > 0 && <p className="muted small">running…</p>}
      <table className="vars-table"><tbody>
        {exprs.map((e) => {
          const v = results.get(e)
          return (
            <tr key={e} className={v?.changed ? 'changed' : ''} title={v?.where}>
              <td className="var-name">{e}</td>
              <td className="var-type">{v?.type ?? ''}</td>
              <td className="var-value">{v?.value ?? ''}</td>
              <td className="watch-x"><button className="watch-remove" title="Remove" onClick={() => setExprs(exprs.filter((x) => x !== e))}>×</button></td>
            </tr>
          )
        })}
        {exprs.length === 0 && <tr><td className="muted" colSpan={4}>no watches: type an expression above</td></tr>}
      </tbody></table>
    </div>
  )
}
