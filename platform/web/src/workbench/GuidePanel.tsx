import { useMemo, useState } from 'react'
import { exampleFile, GUIDE, PROGRAMS, wrapExample } from './guide'

/**
 * The 8086 guide: sections, one entry per instruction with a runnable
 * example, and ready programs; a filter box. "open in editor" hands the
 * code to the workspace, which puts it in the editor as a new file.
 */
interface Props {
  onOpen?: (file: string, code: string) => void
}

export function GuidePanel({ onOpen }: Props) {
  const [q, setQ] = useState('')
  const [shown, setShown] = useState<string | null>(null) // the entry whose example is unfolded
  const needle = q.trim().toLowerCase()
  const sections = useMemo(() => {
    if (!needle) return GUIDE
    return GUIDE.map((s) => ({
      ...s,
      entries: s.entries.filter((e) => `${e.m} ${e.s} ${e.d} ${e.f ?? ''}`.toLowerCase().includes(needle)),
    })).filter((s) => s.entries.length > 0)
  }, [needle])
  const programs = needle ? PROGRAMS.filter((p) => `${p.name} ${p.what}`.toLowerCase().includes(needle)) : PROGRAMS

  return (
    <div className="guide">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find: mov, loop, stack, string…" spellCheck={false} />
      <div className="guide-body">
        <section>
          <h4>Programs</h4>
          <p className="guide-note">Complete programs to open, build and step through.</p>
          {programs.map((p) => (
            <div key={p.file} className="guide-entry">
              <div className="guide-head">
                <b>{p.name}</b>
                {onOpen
                  ? <button className="ghost guide-file" title="Open in the editor" onClick={() => onOpen(p.file, p.code)}>{p.file}</button>
                  : <code>{p.file}</code>}
              </div>
              <div className="guide-desc">{p.what}</div>
            </div>
          ))}
        </section>
        {sections.map((s) => (
          <section key={s.title}>
            <h4>{s.title}</h4>
            {s.note && <p className="guide-note">{s.note}</p>}
            {s.entries.map((e) => {
              const key = `${s.title}/${e.m}`
              const open = shown === key
              return (
                <div key={e.m} className="guide-entry">
                  <div className="guide-head">
                    <b>{e.m}</b> <code>{e.s}</code>
                    {e.ex && <button className="ghost guide-open" onClick={() => setShown(open ? null : key)}>{open ? 'hide example' : 'example'}</button>}
                  </div>
                  {e.d && <div className="guide-desc">{e.d}{e.f && <span className="guide-flags"> · flags: {e.f}</span>}</div>}
                  {open && e.ex && (
                    <div className="guide-example">
                      <pre>{[...e.ex, ...(e.data ?? [])].join('\n')}</pre>
                      {onOpen && <button className="ghost guide-file" title="Open in the editor" onClick={() => onOpen(exampleFile(e.m), wrapExample(e.m, e.ex!, e.data))}>{exampleFile(e.m)}</button>}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))}
        {sections.length === 0 && programs.length === 0 && <p className="guide-note">nothing matches</p>}
      </div>
    </div>
  )
}
