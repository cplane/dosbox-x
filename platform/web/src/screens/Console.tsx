import { useCallback, useEffect, useRef, useState } from 'react'
import { runCommand, type RunResult } from '../api/client'

/**
 * A command console for the box: typing and history are local, Enter runs
 * the line at the DOS prompt through the sidecar's /run and the output comes
 * back as text. Nothing here round-trips per keystroke.
 */

interface Entry {
  prompt: string
  cmd: string
  output?: string
  error?: string
  errorlevel?: number
  timedOut?: boolean
  running?: boolean
}

interface Props {
  boxId: string
  running: boolean
}

export function Console({ boxId, running }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [line, setLine] = useState('')
  const [history, setHistory] = useState<string[]>(() => loadHistory(boxId))
  const [histPos, setHistPos] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('C:\\>')
  const outRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { outRef.current?.scrollTo(0, outRef.current.scrollHeight) }, [entries])

  const submit = useCallback(async () => {
    const cmd = line.trim()
    if (!cmd || busy) return
    setLine('')
    setHistPos(-1)
    const next = [cmd, ...history.filter((h) => h !== cmd)].slice(0, 100)
    setHistory(next)
    saveHistory(boxId, next)
    if (cmd.toLowerCase() === 'cls') { setEntries([]); return }
    setBusy(true)
    setEntries((es) => [...es, { prompt, cmd, running: true }])
    try {
      const r: RunResult = await runCommand(boxId, cmd)
      setPrompt(r.prompt || prompt)
      setEntries((es) => es.map((e, i) => (i === es.length - 1 ? { ...e, running: false, output: r.output, errorlevel: r.errorlevel, timedOut: r.timed_out } : e)))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setEntries((es) => es.map((e, i) => (i === es.length - 1 ? { ...e, running: false, error: msg } : e)))
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }, [line, busy, history, boxId, prompt])

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const p = Math.min(histPos + 1, history.length - 1)
      if (p >= 0) { setHistPos(p); setLine(history[p]) }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const p = histPos - 1
      setHistPos(p)
      setLine(p >= 0 ? history[p] : '')
    } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); setEntries([]) }
  }

  return (
    <div className="console">
      <pre ref={outRef} className="console-out">
        {entries.length === 0 && <span className="muted">Commands run at the DOS prompt; the output appears here. ↑/↓ history, cls or Ctrl+L clears.{'\n'}</span>}
        {entries.map((e, i) => (
          <span key={i}>
            <span className="console-prompt">{e.prompt}</span>{e.cmd}{'\n'}
            {e.running && <span className="muted">…{'\n'}</span>}
            {e.output}
            {e.error && <span className="auth-error">{e.error}{'\n'}</span>}
            {e.timedOut && <span className="muted">(still running; use the screen){'\n'}</span>}
          </span>
        ))}
      </pre>
      <div className="console-in">
        <span className="console-prompt">{prompt}</span>
        <input
          ref={inputRef}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={onKey}
          disabled={!running || busy}
          placeholder={running ? (busy ? 'running…' : 'command') : 'the box is stopped'}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
      </div>
    </div>
  )
}

function loadHistory(boxId: string): string[] {
  try {
    const raw = localStorage.getItem(`dosbox.console.${boxId}`)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function saveHistory(boxId: string, h: string[]) {
  try { localStorage.setItem(`dosbox.console.${boxId}`, JSON.stringify(h)) } catch { /* private mode */ }
}
