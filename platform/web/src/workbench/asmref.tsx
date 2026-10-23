import { useEffect, useRef, useState, type ReactNode } from 'react'
import { findArticle, type Article } from './articles'

/**
 * The 8086 guide at a mnemonic, the same in every view that shows assembly (the editor, the Machine view's
 * instructions, the guide's own snippets): hovering it shows the instruction and its short description, clicking it
 * opens its article.
 */

/** The instruction article for a word in the mnemonic place ("MOV", "JZ" finds JE, "DB"), not a topic or a service. */
export function refFor(word: string): Article | undefined {
  if (!/^[A-Za-z]{2,7}$/.test(word)) return undefined
  const a = findArticle(word)
  return a && a.int === undefined && /^[A-Z]/.test(a.key) && a.key === a.key.toUpperCase() ? a : undefined
}

const PREFIX = /^(REP|REPE|REPZ|REPNE|REPNZ|LOCK)$/i
const DIRECTIVE = /^(DB|DW|DD|DQ|DT|PROC|ENDP|EQU|LABEL|STRUC|ENDS|SEGMENT|MACRO|ENDM)$/i

/** Where the mnemonics are in a line of assembly: after a label, after a REP prefix too, or a directive after a name. */
export function opsIn(line: string): { word: string; start: number; end: number }[] {
  // The comment does not count (a ; outside quotes).
  let code = line
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = '' } else if (c === '\'' || c === '"') quote = c
    else if (c === ';') { code = line.slice(0, i); break }
  }
  const words: { word: string; start: number; end: number }[] = []
  const re = /[A-Za-z_?@$][\w?@$]*:?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) && words.length < 3) words.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  let i = 0
  if (words[0]?.word.endsWith(':')) i = 1 // a label
  const out: typeof words = []
  const first = words[i]
  if (!first) return out
  if (words[i + 1] && DIRECTIVE.test(words[i + 1].word) && !refFor(first.word)) return [words[i + 1]] // NAME DB ...
  out.push(first)
  if (PREFIX.test(first.word) && words[i + 1]) out.push(words[i + 1])
  return out
}

// The card: one at a time, fixed to the viewport (the panels scroll and clip).
interface Card { a: Article; x: number; y: number; extra?: ReactNode }
let showCard: (c: Card | null) => void = () => undefined

/** The card's host: mounted once by the workspace. */
export function RefCardHost() {
  const [card, setCard] = useState<Card | null>(null)
  showCard = setCard
  // A scroll moves the mnemonic away from its card: the card goes.
  useEffect(() => {
    const hide = () => setCard(null)
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [])
  if (!card) return null
  const below = card.y < window.innerHeight - 180
  return (
    <div
      className="ref-card"
      style={{ left: Math.max(8, Math.min(card.x, window.innerWidth - 380)), ...(below ? { top: card.y + 6 } : { bottom: window.innerHeight - card.y + 26 }) }}
    >
      <div className="ref-card-head"><b>{card.a.title}</b> <span>{card.a.tagline}</span></div>
      <div className="ref-card-short">{card.a.short.replace(/`/g, '')}</div>
      {card.extra}
      <div className="ref-card-foot">click: the article in the guide</div>
    </div>
  )
}

/** A mnemonic that shows its card on hover and opens its article on click; plain text when the guide has none. */
export function AsmOp({ word, onOpen, extra, className }: { word: string; onOpen?: (key: string) => void; extra?: ReactNode; className?: string }) {
  const a = refFor(word)
  // A mnemonic that goes while hovered (the Machine view's list moves on every step) takes its card with it.
  const shown = useRef(false)
  useEffect(() => () => { if (shown.current) showCard(null) }, [])
  if (!a || !onOpen) return <span className={className}>{word}</span>
  return (
    <span
      className={`${className ?? ''} asm-op`}
      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); shown.current = true; showCard({ a, x: r.left, y: r.bottom, extra }) }}
      onMouseLeave={() => { shown.current = false; showCard(null) }}
      onClick={(e) => { e.stopPropagation(); shown.current = false; showCard(null); onOpen(a.key) }}
    >
      {word}
    </span>
  )
}

/** A line of assembly with its mnemonics as AsmOp; the rest through `rest` (a highlighter) or as it is. */
export function withOps(line: string, onOpen: ((key: string) => void) | undefined, rest: (text: string, key: number) => ReactNode = (t) => t, opClass?: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  let k = 0
  for (const op of opsIn(line)) {
    if (op.start > at) out.push(rest(line.slice(at, op.start), k++))
    out.push(<AsmOp key={k++} word={op.word} onOpen={onOpen} className={opClass} />)
    at = op.end
  }
  if (at < line.length) out.push(rest(line.slice(at), k++))
  return out
}

// Who opens an article: the workspace, for the editor's hover link and Ctrl+click (Monaco lives outside React).
let opener: ((key: string) => void) | null = null
export function setArticleOpener(fn: ((key: string) => void) | null) { opener = fn }
export function openArticleRef(key: string) { opener?.(key) }
