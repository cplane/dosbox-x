import { Fragment, useState, type ReactNode } from 'react'
import { findArticle, type Block } from './articles'
import { exampleFile, wrapExample } from './guide'
import { Icon } from './icons'

/**
 * One article of the 8086 guide, in a tab beside the editor: the name and a few words, the short description,
 * then the article (paragraphs, tables and code snippets, each snippet with a copy button and, when it is a
 * complete example, "open in editor"), and the related articles.
 */
interface Props {
  articleKey: string
  /** Show another article (a "see also" link, a mnemonic in the text). */
  onNavigate: (key: string) => void
  /** Back to the article shown before, when there is one. */
  onBack?: () => void
  /** Put a complete example in the editor as a new file. */
  onOpen?: (file: string, code: string) => void
}

// A little colour for assembly: comments, strings, numbers, registers, the mnemonic.
const REGS = /^(AX|BX|CX|DX|AL|AH|BL|BH|CL|CH|DL|DH|SI|DI|BP|SP|CS|DS|ES|SS|IP)$/i
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = []
  // Split off the comment (a ; outside quotes).
  let code = line, comment = ''
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = '' } else if (c === '\'' || c === '"') quote = c
    else if (c === ';') { code = line.slice(0, i); comment = line.slice(i); break }
  }
  const re = /('[^']*'?|"[^"]*"?)|(\b[0-9][0-9A-F]*[hH]?\b)|([A-Za-z_?@$][A-Za-z0-9_?@$]*)|(\s+|[^\sA-Za-z0-9_'"]+)/gi
  // Until the mnemonic has been seen, a word is a label ("AGAIN:", or a name before DB / PROC / EQU...).
  let wantOp = true
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(code))) {
    const [t, str, num, word] = m
    const rest = code.slice(m.index + t.length)
    if (str) out.push(<span key={k++} className="hl-str">{t}</span>)
    else if (num) out.push(<span key={k++} className="hl-num">{t}</span>)
    else if (word) {
      if (wantOp && (/^:/.test(rest) || /^\s+(DB|DW|DD|DQ|DT|PROC|ENDP|EQU|LABEL|STRUC|ENDS|SEGMENT)\b/i.test(rest))) out.push(<span key={k++} className="hl-label">{t}</span>)
      else if (REGS.test(word)) out.push(<span key={k++} className="hl-reg">{t}</span>)
      else if (wantOp) { out.push(<span key={k++} className="hl-op">{t}</span>); wantOp = false }
      else out.push(<Fragment key={k++}>{t}</Fragment>)
    } else out.push(<Fragment key={k++}>{t}</Fragment>)
  }
  if (comment) out.push(<span key={k++} className="hl-comment">{comment}</span>)
  return out
}

// Paragraph text: `code` between backquotes, a known mnemonic in it a link (not the article's own).
function inline(text: string, onNavigate: (key: string) => void, self = ''): ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, i) => {
    if (!part.startsWith('`')) return <Fragment key={i}>{part}</Fragment>
    const code = part.slice(1, -1)
    const found = /^[A-Z]{2,7}$/.test(code) ? findArticle(code) : undefined
    const target = found && found.key !== self ? found : undefined
    return target
      ? <code key={i} className="article-link" onClick={() => onNavigate(target.key)} title={`${target.title}: ${target.tagline}`}>{code}</code>
      : <code key={i}>{code}</code>
  })
}

// Where a line's comment starts (a ; outside quotes), or -1.
function commentAt(line: string): number {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = '' } else if (c === '\'' || c === '"') quote = c
    else if (c === ';') return i
  }
  return -1
}

// A snippet's comments in one column: just past its longest commented line of code (at most column 36; a longer
// line keeps two spaces before its comment). Lines put together from shared helpers had their own columns.
function alignComments(lines: string[]): string[] {
  const parts = lines.map((l) => { const at = commentAt(l); return at > 0 && l.slice(0, at).trim() ? { code: l.slice(0, at).trimEnd(), comment: l.slice(at) } : null })
  const widest = Math.max(0, ...parts.map((p) => (p && p.code.length <= 36 ? p.code.length : 0)))
  const col = Math.min(36, widest + 2)
  return lines.map((l, i) => {
    const p = parts[i]
    return p ? `${p.code.padEnd(Math.max(col, p.code.length + 2))}${p.comment}` : l
  })
}

function Snippet({ block, title, articleKey, onOpen }: { block: Extract<Block, { code: string[] }>; title: string; articleKey: string; onOpen?: Props['onOpen'] }) {
  const [copied, setCopied] = useState(false)
  const text = alignComments([...block.code, ...(block.run && block.data?.length ? ['', ...block.data] : [])]).join('\n')
  const copy = async () => {
    try { await navigator.clipboard.writeText(text.replace(/\n/g, '\r\n')) } catch { /* no clipboard: nothing to say */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="article-code">
      <div className="article-code-bar">
        {block.note && <span className="muted">{block.note}</span>}
        {onOpen && block.run && (
          <button className="icon-btn" aria-label="Open in the editor" onClick={() => onOpen(exampleFile(articleKey), alignComments(wrapExample(title, block.code, block.data).split('\r\n')).join('\r\n'))} title="Open in the editor as a complete program, ready to Build & Run or debug">{Icon.openFile}</button>
        )}
        <button className={`icon-btn ${copied ? 'done' : ''}`} aria-label="Copy" onClick={copy} title={copied ? 'Copied' : 'Copy the snippet'}>{copied ? Icon.check : Icon.copy}</button>
      </div>
      <pre>{text.split('\n').map((l, i) => <div key={i}>{l ? highlight(l) : ' '}</div>)}</pre>
    </div>
  )
}

export function ArticleView({ articleKey, onNavigate, onBack, onOpen }: Props) {
  const a = findArticle(articleKey)
  if (!a) return <div className="article"><p className="muted">No article "{articleKey}".</p></div>
  return (
    <div className="article">
      <div className="article-top">
        {onBack && <button className="ghost" onClick={onBack} title="The article before">← back</button>}
        <span className="muted small">8086 guide · {a.group}</span>
      </div>
      <header className="article-head">
        <h2>{a.title}</h2>
        <div className="article-tagline">{a.tagline}</div>
      </header>
      <div className="article-facts">
        <div className="article-syntax">{a.syntax.map((s) => <code key={s}>{s}</code>)}</div>
        <div className="small"><span className="muted">flags:</span> {a.flags}</div>
      </div>
      <p className="article-short">{inline(a.short, onNavigate, a.key)}</p>
      <div className="article-body">
        {a.body.map((b, i) => {
          if ('p' in b) return <p key={i}>{inline(b.p, onNavigate, a.key)}</p>
          if ('h' in b) return <h3 key={i}>{b.h}</h3>
          if ('table' in b) {
            const [head, ...rows] = b.table
            return (
              <table key={i} className="article-table">
                <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, onNavigate, a.key)}</th>)}</tr></thead>
                <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c, onNavigate, a.key)}</td>)}</tr>)}</tbody>
              </table>
            )
          }
          return <Snippet key={i} block={b} title={a.title} articleKey={a.key} onOpen={onOpen} />
        })}
      </div>
      {a.see && a.see.length > 0 && (
        <div className="article-see">
          <span className="muted">see also</span>
          {a.see.map((k) => {
            const t = findArticle(k)
            return t ? <button key={k} className="ghost" onClick={() => onNavigate(t.key)} title={t.tagline}>{t.title}</button> : null
          })}
        </div>
      )}
    </div>
  )
}
