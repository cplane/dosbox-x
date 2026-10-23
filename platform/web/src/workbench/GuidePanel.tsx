import { useMemo, useState } from 'react'
import { PROGRAMS } from './guide'
import { ARTICLES, GROUPS } from './articles'

/**
 * The 8086 guide's index: every instruction (aliases with it: JE / JZ) and the topics around them (addressing,
 * registers, directives), grouped as the 8086 manuals group them, each a click away from its article in the tab
 * beside the editor; the ready programs on top; a filter box that searches names, aliases and descriptions.
 */
interface Props {
  /** Put a ready program in the editor as a new file. */
  onOpen?: (file: string, code: string) => void
  /** Show an article (its key). */
  onArticle?: (key: string) => void
  /** The article on show, marked in the list. */
  current?: string | null
}

export function GuidePanel({ onOpen, onArticle, current }: Props) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => GROUPS.map((g) => ({
    title: g,
    articles: ARTICLES.filter((a) => a.group === g && (!needle || `${a.title} ${(a.aka ?? []).join(' ')} ${a.tagline} ${a.short}`.toLowerCase().includes(needle))),
  })).filter((g) => g.articles.length > 0), [needle])
  const programs = needle ? PROGRAMS.filter((p) => `${p.name} ${p.what}`.toLowerCase().includes(needle)) : PROGRAMS

  return (
    <div className="guide">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find: mov, loop, stack, string, jz…" spellCheck={false} />
      <div className="guide-body">
        {programs.length > 0 && (
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
        )}
        {groups.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            {g.articles.map((a) => (
              <button
                key={a.key}
                className={`guide-index ${current === a.key ? 'on' : ''}`}
                onClick={() => onArticle?.(a.key)}
                title={a.short}
              >
                <b>{a.title}</b>
                <span>{a.tagline}</span>
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 && programs.length === 0 && <p className="guide-note">nothing matches</p>}
      </div>
    </div>
  )
}
