import type { VarValue } from './symbols'
import type { DebugValues } from './values'

/**
 * The program's variables while it is stopped: the parameters and locals
 * of the chosen frame's function, and the globals, with values read from
 * the machine and printed by type; what changed since the last stop is lit.
 */
export function VariablesPanel({ values, stopped }: { values: DebugValues; stopped: boolean }) {
  const { frames, chosen, locals, enclosing, globals, note } = values
  const fn = frames[chosen]?.fn ?? null
  return (
    <div className="vars">
      {!stopped && <p className="muted small">running…</p>}
      {note && <p className="muted small">{note}</p>}
      <div className="vars-head">{fn ? `${fn}()` : 'program'}</div>
      <table className="vars-table"><tbody>{locals.map(row)}{locals.length === 0 && <tr><td className="muted" colSpan={3}>no locals here</td></tr>}</tbody></table>
      {enclosing.map((e) => (
        <div key={e.fn}>
          <div className="vars-head" title="the procedure this one is nested in: its variables are in scope here">{e.fn}() <span className="muted">· enclosing</span></div>
          <table className="vars-table"><tbody>{e.values.map(row)}{e.values.length === 0 && <tr><td className="muted" colSpan={3}>no locals</td></tr>}</tbody></table>
        </div>
      ))}
      <div className="vars-head">globals</div>
      <table className="vars-table"><tbody>{globals.map(row)}{globals.length === 0 && <tr><td className="muted" colSpan={3}>none</td></tr>}</tbody></table>
    </div>
  )
}

export const row = (v: VarValue) => (
  <tr key={v.name} className={v.changed ? 'changed' : ''} title={v.where}>
    <td className="var-name">{v.name}</td>
    <td className="var-type">{v.type}</td>
    <td className="var-value">{v.value}</td>
  </tr>
)
