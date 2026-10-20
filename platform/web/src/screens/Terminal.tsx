import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { typeText } from '../api/client'
import { CP437 } from '../player/textstyle'

/**
 * A terminal on the box's console stream: what DOS writes to CON arrives
 * over the player socket as it happens and goes into xterm.js (which
 * handles CR/LF, backspace and ANSI.SYS escapes). Keys go to the box the
 * same way the screen's do, so DOS echoes them; pasted text is typed.
 * Programs that draw on the screen directly (TUIs, games) don't show here
 * — the screen view has those.
 */

export interface TerminalHandle {
  /** Types a command line at the prompt (the output streams in). */
  run: (cmd: string) => Promise<void>
  focus: () => void
}

interface Props {
  boxId: string
  running: boolean
  /** Subscribes to console-stream chunks; returns the unsubscribe. */
  subscribe: (fn: (chunk: Uint8Array, lost: boolean) => void) => () => void
  /** Sends a key event to the box (the screen's keyboard path). */
  onKey: (e: KeyboardEvent, down: boolean) => void
}

// Bytes DOS's CON treats as controls; xterm does the same. The rest of
// 00-1F are glyphs on a DOS screen (☺ ► …), so they go through CP437.
const CONTROL = new Set([7, 8, 9, 10, 13, 27])

export function decodeCon(chunk: Uint8Array): string {
  let s = ''
  for (const b of chunk) s += CONTROL.has(b) ? String.fromCharCode(b) : CP437[b]
  return s
}

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ boxId, running, subscribe, onKey }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)

  useImperativeHandle(ref, () => ({
    async run(cmd) {
      await typeText(boxId, cmd + '\n')
      termRef.current?.focus()
    },
    focus() { termRef.current?.focus() },
  }), [boxId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 15,
      lineHeight: 1.1,
      cursorBlink: true,
      cursorStyle: 'underline',
      scrollback: 5000,
      allowProposedApi: true,
      // Paper: the workbench's look (styles.css --wb-*), ANSI colours muted to match.
      theme: {
        background: '#fcfcfa', foreground: '#35342f', cursor: '#35342f', cursorAccent: '#fcfcfa', selectionBackground: '#e2e0d8',
        black: '#35342f', blue: '#4b6a9b', green: '#577143', cyan: '#3f7f7a', red: '#a3493c', magenta: '#87588a', yellow: '#8a6f2e', white: '#8b8a83',
        brightBlack: '#6b6a62', brightBlue: '#3b63a8', brightGreen: '#4a7a2f', brightCyan: '#2f8a84', brightRed: '#b9553f', brightMagenta: '#9b66a0', brightYellow: '#a8862f', brightWhite: '#35342f',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    // Every key goes to DOS (it echoes); xterm itself types nothing.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' || e.type === 'keyup') onKey(e, e.type === 'keydown')
      return false
    })
    // What still reaches onData is a paste (or IME text): type it.
    const data = term.onData((text) => { typeText(boxId, text.replace(/\r\n?/g, '\n')).catch(() => undefined) })
    const unsubscribe = subscribe((chunk, lost) => {
      if (lost) term.write('\r\n\x1b[2m… (output lost) …\x1b[0m\r\n')
      term.write(decodeCon(chunk))
    })
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(host)
    term.focus()
    return () => {
      ro.disconnect()
      unsubscribe()
      data.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [boxId, subscribe, onKey])

  return (
    <div className={`terminal ${running ? '' : 'stopped'}`}>
      <div ref={hostRef} className="terminal-host" />
      {!running && <div className="overlay">The box is stopped.</div>}
    </div>
  )
})
