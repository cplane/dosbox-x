import { useMemo, useState } from 'react'
import { GUIDE } from './guide'

/** The 8086 guide: sections, one line per instruction, a filter box. */
export function GuidePanel() {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const sections = useMemo(() => {
    if (!needle) return GUIDE
    return GUIDE.map((s) => ({
      ...s,
      entries: s.entries.filter((e) => `${e.m} ${e.s} ${e.d} ${e.f ?? ''}`.toLowerCase().includes(needle)),
    })).filter((s) => s.entries.length > 0)
  }, [needle])
  return (
    <div className="guide">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find: mov, loop, int 21…" spellCheck={false} />
      <div className="guide-body">
        {sections.map((s) => (
          <section key={s.title}>
            <h4>{s.title}</h4>
            {s.note && <p className="guide-note">{s.note}</p>}
            {s.entries.map((e) => (
              <div key={e.m} className="guide-entry">
                <div className="guide-head"><b>{e.m}</b> <code>{e.s}</code></div>
                {e.d && <div className="guide-desc">{e.d}{e.f && <span className="guide-flags"> · flags: {e.f}</span>}</div>}
              </div>
            ))}
          </section>
        ))}
        {sections.length === 0 && <p className="guide-note">nothing matches</p>}
      </div>
    </div>
  )
}
