import { lineForOffset } from './listing'
import type { DebugValues } from './values'

/**
 * The call stack while the program is stopped, innermost frame first; a
 * click chooses the frame whose locals the Variables panel shows and whose
 * line the editor marks.
 */
export function CallStackPanel({ values, stopped }: { values: DebugValues; stopped: boolean }) {
  const { frames, chosen, setChosen, lineMap, note } = values
  return (
    <div className="vars">
      {!stopped && <p className="muted small">running…</p>}
      {note && <p className="muted small">{note}</p>}
      {frames.length === 0 && stopped && <p className="muted small">no frames</p>}
      <div className="calls-list">
        {frames.map((f, i) => {
          const line = lineForOffset(lineMap, f.ip)
          return (
            <button key={i} className={`calls-frame ${i === chosen ? 'on' : ''}`} onClick={() => setChosen(i)} title={`${f.ip.toString(16).toUpperCase().padStart(4, '0')} · BP ${f.bp.toString(16).toUpperCase().padStart(4, '0')}`}>
              <span className="calls-depth muted">{i}</span>
              <span className="calls-fn">{f.fn ?? 'program'}</span>
              {line !== null ? <span className="muted">:{line}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
