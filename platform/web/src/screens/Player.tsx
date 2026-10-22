import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { getBox, NeedsSignIn, screenText, snapshotURL, startBox, stopBox, typeText, wsURL, type Box } from '../api/client'
import { scancodeFor, SHIFT } from '../player/keys'
import { TextScreen } from '../player/textmode'
import { fontReady, loadTextStyle, saveTextStyle, TEXT_STYLES, type TextStyle } from '../player/textstyle'
import { DebugPanel, type RPC } from './DebugPanel'
import { Console, type ConsoleHandle, type Step } from './Console'
import type { TerminalHandle } from './Terminal'
import { useDebugger } from '../workbench/useDebugger'
import { Workspace, type WorkbenchHandoff } from '../workbench/Workspace'
import { breakProgram, ideByProgram, ideFor, leaveIde, openInIde } from '../workbench/handoff'
import type { HeatTick } from '../workbench/heat'

/** Screen: the DOS screen with panels under it (as it was). Workbench: editor + terminal on paper, the screen put away. */
type View = 'screen' | 'workbench'
const loadView = (): View => { try { return localStorage.getItem('dosbox.view') === 'workbench' ? 'workbench' : 'screen' } catch { return 'screen' } }

// Monaco is big; it loads the first time the editor opens.
const Editor = lazy(() => import('./Editor').then((m) => ({ default: m.Editor })))

interface Props {
  boxId: string
  onBack: () => void
  onFiles: () => void
  onSignedOut: () => void
}

interface Meta {
  w: number
  h: number
  parX: number
  parY: number
  program: string
}

interface Latency {
  rtt: number // ms, ping -> pong over the same socket as the frames
  encodeMs: number // server JPEG encode time
  serverFps: number
}

/**
 * The box's screen: JPEG frames from the box's stream sidecar over the
 * gateway's WebSocket, keyboard (physical keys via KeyboardEvent.code) and
 * the mouse back.
 *
 * Mouse: by default the browser's own arrow is the cursor and its position
 * goes to DOS as an absolute point (the DOS cursor is placed exactly there),
 * so pointing and clicking don't wait for frames. "Capture mouse" switches to
 * pointer-locked relative motion for programs that need it.
 *
 * Frames are acked once drawn (or skipped), which lets the sidecar keep only
 * a few in flight: a slow link shows the newest frame late, not a backlog.
 */
export function Player({ boxId, onBack, onFiles, onSignedOut }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<(msg: object) => void>(() => undefined)
  const releaseRef = useRef<() => void>(() => undefined)
  const [box, setBox] = useState<Box | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [fps, setFps] = useState(0)
  const [latency, setLatency] = useState<Latency | null>(null)
  const [textMode, setTextMode] = useState(false)
  const [textStyle, setTextStyle] = useState<TextStyle>(() => loadTextStyle())
  const [textSize, setTextSize] = useState({ w: 720, h: 400 }) // the styled canvas, for the aspect ratio
  const textRef = useRef<TextScreen | null>(null)
  const textStyleRef = useRef(textStyle)
  textStyleRef.current = textStyle
  const [showDebug, setShowDebug] = useState(false)
  const [showConsole, setShowConsole] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const consoleRef = useRef<ConsoleHandle>(null)
  const [view, setView] = useState<View>(loadView)
  const viewRef = useRef(view)
  viewRef.current = view
  const metaRef = useRef<Meta | null>(null)
  const handoffRef = useRef<WorkbenchHandoff | null>(null)
  // A line in the bar about the last view handoff, for a few seconds.
  const [notice, setNotice] = useState<string | null>(null)
  const say = useCallback((m: string | null) => {
    setNotice(m)
    if (m) window.setTimeout(() => setNotice((n) => (n === m ? null : n)), 8000)
  }, [])
  const terminalRef = useRef<TerminalHandle>(null)
  // The console stream (hello con) fans out to whoever listens (the terminal).
  const conSubs = useRef(new Set<(chunk: Uint8Array, lost: boolean) => void>())
  const subscribeCon = useCallback((fn: (chunk: Uint8Array, lost: boolean) => void) => {
    conSubs.current.add(fn)
    return () => { conSubs.current.delete(fn) }
  }, [])
  // Live heat ticks ("H") fan out the same way; the box counts only while asked ({heat:1}).
  const heatSubs = useRef(new Set<(tick: HeatTick) => void>())
  const subscribeHeat = useCallback((fn: (tick: HeatTick) => void) => {
    heatSubs.current.add(fn)
    return () => { heatSubs.current.delete(fn) }
  }, [])
  const setHeat = useCallback((on: boolean) => { sendRef.current({ heat: on ? 1 : 0 }) }, [])
  // The screen's key path, for the terminal to send keys the same way.
  const keyRef = useRef<(e: KeyboardEvent, down: boolean) => void>(() => undefined)
  const onTermKey = useCallback((e: KeyboardEvent, down: boolean) => keyRef.current(e, down), [])

  // The editor's Build & Run: open the console (mounting it if needed) and
  // run the steps there, so the output lands where commands are typed.
  const runSteps = useCallback(async (steps: Step[]) => {
    if (viewRef.current === 'workbench') {
      // The terminal shows the output as it streams; the batch prints its own verdict.
      for (const s of steps) await terminalRef.current?.run(s.cmd)
      return true
    }
    setShowConsole(true)
    for (let i = 0; i < 20 && !consoleRef.current; i++) await new Promise((r) => setTimeout(r, 50))
    return consoleRef.current?.run(steps) ?? false
  }, [])
  const [agentAvailable, setAgentAvailable] = useState<boolean | null>(null)
  // JSON-RPC calls to the debugger agent ride the player socket: id -> settler.
  const rpcWaiters = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>())
  // Request ids start at a random point: the agent remembers ids with their payloads, so a reload must not reuse old ones.
  const rpcSeq = useRef(Math.floor(Math.random() * 0x40000000))
  const [captured, setCaptured] = useState(false)
  const [focused, setFocused] = useState(false)
  const [generation, setGeneration] = useState(0) // bump to restart polling/connecting

  // Poll the box until it runs; reconnect the socket while it does.
  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let timer: number | undefined
    let backoff = 500
    let frames = 0
    let decoding = false
    const queue: ArrayBuffer[] = []
    const down = new Set<number>()
    const synth = new Set<number>()

    const send = (msg: object) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }
    sendRef.current = send
    releaseRef.current = () => {
      for (const sc of down) send({ k: sc, d: false })
      if (synth.size) send({ k: SHIFT, d: false })
      down.clear()
      synth.clear()
      send({ b: 0 })
    }

    // A binary message is a strip update (see the sidecar's hub.go):
    //   "S" 1 count:u16 frameW:u16 frameH:u16, then count × (y:u16 h:u16 len:u32 jpeg)
    // Updates carry only changed strips, so none may be skipped: they are
    // drawn in order (the sidecar keeps at most a few in flight) and each is
    // acked once drawn.
    //
    // In text modes the sidecar sends text updates ("T", see textmode.ts)
    // instead, which the browser draws itself.
    const text = new TextScreen()
    textRef.current = text
    text.setStyle(textStyleRef.current)
    let inText = false
    let lastSize = ''
    async function drawUpdate(buf: ArrayBuffer) {
      const dv = new DataView(buf)
      if (buf.byteLength > 0 && dv.getUint8(0) === 0x54) {
        if (!text.apply(buf)) return
        if (!inText) { inText = true; setTextMode(true) }
        const canvas = canvasRef.current
        if (canvas) {
          text.draw(canvas, performance.now())
          const size = `${canvas.width}x${canvas.height}`
          if (size !== lastSize) { lastSize = size; setTextSize({ w: canvas.width, h: canvas.height }) }
        }
        return
      }
      if (buf.byteLength < 8 || dv.getUint8(0) !== 0x53) return
      if (inText) { inText = false; setTextMode(false) }
      const n = dv.getUint16(2, true)
      const w = dv.getUint16(4, true)
      const h = dv.getUint16(6, true)
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const parts: { y: number; blob: Blob }[] = []
      for (let i = 0, p = 8; i < n && p + 8 <= buf.byteLength; i++) {
        const y = dv.getUint16(p, true)
        const len = dv.getUint32(p + 4, true)
        parts.push({ y, blob: new Blob([new Uint8Array(buf, p + 8, len)], { type: 'image/jpeg' }) })
        p += 8 + len
      }
      const bmps = await Promise.all(parts.map((s) => createImageBitmap(s.blob)))
      const ctx = canvas.getContext('2d')
      bmps.forEach((b, i) => { ctx?.drawImage(b, 0, parts[i].y); b.close() })
    }
    async function draw(buf: ArrayBuffer) {
      queue.push(buf)
      if (decoding) return
      decoding = true
      while (queue.length) {
        try {
          await drawUpdate(queue.shift()!)
          frames++
        } catch { /* a bad update */ }
        send({ ack: 1 })
      }
      decoding = false
    }

    async function poll() {
      if (cancelled) return
      try {
        const b = await getBox(boxId)
        if (cancelled) return
        setBox(b)
        setError(null)
        if (b.state === 'running') { connect(); return }
        if (b.state === 'starting' || b.state === 'stopping') timer = window.setTimeout(poll, 1500)
      } catch (err) {
        if (err instanceof NeedsSignIn) { onSignedOut(); return }
        setError(err instanceof Error ? err.message : String(err))
        timer = window.setTimeout(poll, 3000)
      }
    }

    function connect() {
      ws = new WebSocket(wsURL(boxId))
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => { backoff = 500; setConnected(true); send({ hello: { text: 1, con: 1 } }) }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const m = JSON.parse(ev.data)
          if (m.type === 'meta') {
            const canvas = canvasRef.current
            if (canvas && (canvas.width !== m.w || canvas.height !== m.h)) { canvas.width = m.w; canvas.height = m.h }
            setMeta(m)
          } else if (m.type === 'rpc') {
            const resp = m.response ?? {}
            const w = rpcWaiters.current.get(Number(resp.id))
            if (w) {
              rpcWaiters.current.delete(Number(resp.id))
              if (resp.error) w.reject(Object.assign(new Error(resp.error.message ?? 'rpc error'), { data: resp.error.data }))
              else w.resolve(resp.result)
            }
          } else if (m.type === 'pong') {
            setLatency({ rtt: performance.now() - m.t, encodeMs: m.encodeMs ?? 0, serverFps: m.fps ?? 0 })
          }
        } else if (new Uint8Array(ev.data, 0, 1)[0] === 0x43) { // "C": console stream chunk
          const lost = new Uint8Array(ev.data, 2, 1)[0] === 1
          const chunk = new Uint8Array(ev.data, 3)
          for (const fn of conSubs.current) fn(chunk, lost)
        } else if (new Uint8Array(ev.data, 0, 1)[0] === 0x48) { // "H": live heat tick (paragraph, reads, writes)×n
          const fresh = new Uint8Array(ev.data, 2, 1)[0] === 1
          const n = new DataView(ev.data).getUint32(3, true)
          const tick: HeatTick = { fresh, entries: new Uint16Array(ev.data.slice(7, 7 + n * 6)) }
          for (const fn of heatSubs.current) fn(tick)
        } else draw(ev.data)
      }
      ws.onclose = () => {
        setConnected(false)
        for (const w of rpcWaiters.current.values()) w.reject(new Error('disconnected'))
        rpcWaiters.current.clear()
        queue.length = 0
        down.clear()
        synth.clear()
        ws = null
        if (cancelled) return
        // Re-check the box: it may have been stopped (idle, disk limit).
        timer = window.setTimeout(poll, backoff)
        backoff = Math.min(backoff * 2, 8000)
      }
    }

    const fpsTimer = window.setInterval(() => {
      setFps(frames)
      frames = 0
      send({ ping: performance.now() })
    }, 1000)
    // Text mode blinks locally (cursor, blink attribute): no traffic for it.
    const blinkTimer = window.setInterval(() => {
      const canvas = canvasRef.current
      if (!inText || !canvas) return
      text.touchCursor()
      text.draw(canvas, performance.now())
    }, 133)

    // Keyboard, while the screen has focus.
    const wrap = wrapRef.current!
    const key = (e: KeyboardEvent, isDown: boolean) => {
      const hit = scancodeFor(e)
      if (!hit) return
      const [sc, shift] = hit
      e.preventDefault()
      if (isDown && e.repeat) return // DOS does its own typematic repeat
      if (isDown) {
        // e.g. ":" from a code-less event with no Shift key event before it
        if (shift && !down.has(0x2a) && !down.has(0x36)) { send({ k: SHIFT, d: true }); synth.add(sc) }
        down.add(sc)
        send({ k: sc, d: true })
      } else {
        down.delete(sc)
        send({ k: sc, d: false })
        if (synth.delete(sc) && !synth.size) send({ k: SHIFT, d: false })
      }
    }
    keyRef.current = key
    const onKeyDown = (e: KeyboardEvent) => key(e, true)
    const onKeyUp = (e: KeyboardEvent) => key(e, false)
    const onBlur = () => releaseRef.current()
    wrap.addEventListener('keydown', onKeyDown)
    wrap.addEventListener('keyup', onKeyUp)
    wrap.addEventListener('blur', onBlur)

    // Mouse. Native cursor (default): the position over the screen, 0..1,
    // sent as it changes (at most every 8 ms, the last one always). Captured:
    // relative motion via pointer lock, sent as it comes.
    const canvas = canvasRef.current!
    const locked = () => document.pointerLockElement === canvas
    let held = 0 // buttons pressed on the screen (native mode)
    let lastSent = 0, trailing = 0, lastPos: [number, number] | null = null
    const position = (e: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      const clamp = (v: number) => Math.min(1, Math.max(0, v))
      return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)]
    }
    const sendPos = (p: [number, number]) => {
      lastPos = p
      const now = performance.now()
      window.clearTimeout(trailing)
      if (now - lastSent >= 8) {
        lastSent = now
        send({ a: p })
      } else {
        trailing = window.setTimeout(() => { lastSent = performance.now(); send({ a: lastPos }) }, 8)
      }
    }
    const onLock = () => {
      setCaptured(locked())
      if (locked()) wrap.focus(); else send({ b: 0 })
    }
    const onMove = (e: MouseEvent) => {
      if (locked()) {
        if (e.movementX || e.movementY) send({ m: [e.movementX, e.movementY] })
        return
      }
      // Over the screen, or dragging that started on it (a selection box).
      if (e.target === canvas || held) sendPos(position(e))
    }
    const onDown = (e: MouseEvent) => {
      if (locked()) { e.preventDefault(); send({ b: e.buttons & 7 }); return }
      if (e.target !== canvas) return
      e.preventDefault()
      wrap.focus()
      window.clearTimeout(trailing)
      lastSent = performance.now()
      send({ a: position(e) }) // the click lands exactly here
      held = e.buttons & 7
      send({ b: held })
    }
    const onUp = (e: MouseEvent) => {
      if (locked()) { e.preventDefault(); send({ b: e.buttons & 7 }); return }
      if (!held) return
      window.clearTimeout(trailing)
      lastSent = performance.now()
      send({ a: position(e) })
      held = e.buttons & 7
      send({ b: held })
    }
    document.addEventListener('pointerlockchange', onLock)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('mouseup', onUp)

    poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(fpsTimer)
      window.clearInterval(blinkTimer)
      ws?.close()
      wrap.removeEventListener('keydown', onKeyDown)
      wrap.removeEventListener('keyup', onKeyUp)
      wrap.removeEventListener('blur', onBlur)
      window.clearTimeout(trailing)
      document.removeEventListener('pointerlockchange', onLock)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseup', onUp)
      if (locked()) document.exitPointerLock()
    }
  }, [boxId, onSignedOut, generation])

  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      setError(null)
      await fn()
    } catch (err) {
      if (err instanceof NeedsSignIn) onSignedOut()
      else setError(err instanceof Error ? err.message : String(err))
    }
  }

  const start = act(async () => {
    setBox(await startBox(boxId))
    setGeneration((g) => g + 1) // the stopped box ended the poll loop; start it again
  })
  const stop = act(async () => setBox(await stopBox(boxId)))
  const typePrompt = act(async () => {
    const text = window.prompt('Text to type into the box (\\n in the text = Enter):')
    if (text) await typeText(boxId, text.replace(/\\n/g, '\n'))
    wrapRef.current?.focus()
  })
  const copyText = act(async () => {
    await navigator.clipboard.writeText(await screenText(boxId))
    wrapRef.current?.focus()
  })
  // One JSON-RPC call to the debugger agent over the player socket.
  const rpc: RPC = useCallback((method, params = {}) => new Promise((resolve, reject) => {
    const id = ++rpcSeq.current
    rpcWaiters.current.set(id, { resolve, reject })
    sendRef.current({ rpc: { jsonrpc: '2.0', id, method, params } })
    window.setTimeout(() => { if (rpcWaiters.current.delete(id)) reject(new Error(`: no answer`)) }, 65000)
  }), [])
  // The workbench's debugger (the Screen view's Debug panel keeps its own session).
  const dbg = useDebugger(rpc)
  useEffect(() => {
    if (!(showDebug || view === 'workbench') || !connected) return
    rpc('agent.capabilities').then(() => setAgentAvailable(true)).catch((e: Error) => setAgentAvailable(!/no debugger agent/.test(e.message)))
  }, [showDebug, view, connected, rpc])

  const ctrlAltDel = () => {
    const send = sendRef.current
    for (const sc of [0x1d, 0x38, 0xd3]) send({ k: sc, d: true })
    window.setTimeout(() => { for (const sc of [0xd3, 0x38, 0x1d]) send({ k: sc, d: false }) }, 100)
    wrapRef.current?.focus()
  }

  // The style applies to the live screen at once (and when its font arrives).
  useEffect(() => {
    const apply = () => {
      const canvas = canvasRef.current
      textRef.current?.setStyle(textStyle)
      if (canvas && textRef.current) {
        textRef.current.draw(canvas, performance.now())
        setTextSize({ w: canvas.width, h: canvas.height })
      }
    }
    apply()
    let live = true
    fontReady(textStyle).then(() => { if (live) apply() })
    return () => { live = false }
  }, [textStyle])

  const running = box?.state === 'running'
  const styled = textMode && !!textStyle.font
  metaRef.current = meta

  // Switching views hands the file over. To the screen: the editor's file opens in its IDE on the box (unless
  // the box is busy with a session or a program). To the workbench: an IDE on the box is saved and quit and
  // its file comes to the editor; another program gets Ctrl+Break, so the workbench's build and debug work.
  const switchView = useCallback(async (v: View) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const program = metaRef.current?.program
    const busy = !!dbg.session || (!!program && program !== 'COMMAND')
    if (v === 'screen') {
      const path = handoffRef.current?.path() ?? null
      const saved = path && !busy ? await handoffRef.current?.save() : false
      setView(v)
      try { localStorage.setItem('dosbox.view', v) } catch { /* private mode */ }
      if (!path || busy || !saved || !running) return
      const err = await openInIde(boxId, path)
      say(err ?? `${path.split('/').pop()} is open in ${ideFor(path)?.program}`)
      return
    }
    setView(v)
    try { localStorage.setItem('dosbox.view', v) } catch { /* private mode */ }
    if (!running || dbg.session) return
    const ide = ideByProgram(program)
    if (ide) {
      say(`leaving ${ide.program}…`)
      try {
        const file = await leaveIde(boxId, ide)
        say(file ? `${file.split('/').pop()} came along from ${ide.program}` : null)
        if (file) {
          for (let i = 0; i < 30 && !handoffRef.current?.ready(); i++) await wait(100)
          handoffRef.current?.open(file)
        }
      } catch (err) {
        say(err instanceof Error ? err.message : String(err))
      }
    } else if (program && program !== 'COMMAND') {
      say((await breakProgram(boxId)) ? null : `${program} keeps the keyboard: quit it in the Screen view`)
    }
  }, [boxId, running, dbg.session, say])

  // The workbench is the whole window on paper (html.paper recolours the app's tokens).
  const paper = view === 'workbench' && running
  useEffect(() => {
    document.documentElement.classList.toggle('paper', paper)
    return () => document.documentElement.classList.remove('paper')
  }, [paper])
  const dispH = meta ? (meta.h * (meta.parY || 1)) / (meta.parX || 1) : 400
  return (
    <div className={`player ${paper ? 'wb' : ''}`}>
      <div className="bar">
        <button onClick={onBack}>← Boxes</button>
        <strong>{box?.name ?? '…'}</strong>
        <span className={`dot ${connected ? 'on' : ''}`} />
        <span className="muted">{connected ? 'connected' : box ? box.state : 'loading'}</span>
        {meta?.program && <span className="muted">▶ {meta.program}</span>}
        {notice && <span className="muted">· {notice}</span>}
        {meta && <span className="muted" title={textMode ? "Text mode: drawn by your browser from the screen data" : "Graphics: video from the box"}>{textMode ? "text" : `${meta.w}×${meta.h}`}</span>}
        {running && (
          <select
            className="view-select"
            value={view}
            onChange={(e) => { switchView(e.target.value as View) }}
            title="Screen: the DOS screen with panels. Workbench: editor and terminal, the screen put away"
          >
            <option value="screen">Screen</option>
            <option value="workbench">Workbench</option>
          </select>
        )}
        {textMode && view === 'screen' && (
          <select
            className="style"
            value={textStyle.id}
            onChange={(e) => { const s = TEXT_STYLES.find((x) => x.id === e.target.value); if (s) { setTextStyle(s); saveTextStyle(s) } }}
            title="How the text screen is drawn: the VGA font pixel for pixel, or a web font with a colour theme"
          >
            {TEXT_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}
        {connected && (
          <span
            className={`muted ${latency && latency.rtt > 150 ? 'lag' : ''}`}
            title={latency
              ? `Round trip ${latency.rtt.toFixed(0)} ms · server encodes a frame in ${latency.encodeMs.toFixed(1)} ms and sent ${latency.serverFps} fps · you drew ${fps} fps`
              : 'measuring…'}
          >
            {fps} fps{latency ? ` · ${latency.rtt.toFixed(0)} ms` : ''}
          </span>
        )}
        <span className="spacer" />
        {running && (
          <>
            <button
              onClick={() => canvasRef.current?.requestPointerLock()}
              title="Relative mouse for programs that need it; normally your own arrow is the DOS cursor"
            >
              {captured ? 'Mouse captured (Esc)' : 'Capture mouse'}
            </button>
            <button onClick={typePrompt}>Type text…</button>
            <button onClick={ctrlAltDel}>Ctrl+Alt+Del</button>
            <button onClick={() => { releaseRef.current(); wrapRef.current?.focus() }}>Release keys</button>
            {textMode && <button onClick={copyText} title="Copy the screen's text to the clipboard">Copy text</button>}
            <a className="button" href={snapshotURL(boxId)} target="_blank" rel="noreferrer">Snapshot</a>
          </>
        )}
        <button onClick={onFiles}>Files</button>
        {running && view === 'screen' && <button className={showEditor ? 'on' : ''} onClick={() => setShowEditor(!showEditor)}>Editor</button>}
        {running && view === 'screen' && <button className={showConsole ? 'on' : ''} onClick={() => setShowConsole(!showConsole)}>Console</button>}
        {running && <button className={showDebug ? 'on' : ''} onClick={() => setShowDebug(!showDebug)}>Debug</button>}
        {running || box?.state === 'starting'
          ? <button className="danger" onClick={stop}>Stop</button>
          : box && box.state !== 'stopping' && <button className="primary" onClick={start}>Start</button>}
      </div>
      {error && <p className="auth-error">{error}</p>}
      {box?.reason && !running && <p className="muted">{box.reason}</p>}
      <div
        ref={wrapRef}
        className={`screen-wrap ${focused ? 'focused' : ''} ${view === 'workbench' && running ? 'hidden' : ''}`}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <canvas
          ref={canvasRef}
          className={styled ? 'styled' : ''}
          width={720}
          height={400}
          style={{ aspectRatio: styled ? `${textSize.w} / ${textSize.h}` : `${meta?.w ?? 720} / ${dispH}` }}
          onClick={() => wrapRef.current?.focus()}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!running && (
          <div className="overlay">
            {box?.state === 'starting' ? 'Starting the box…' : box?.state === 'stopping' ? 'Stopping…' : 'This box is stopped.'}
          </div>
        )}
        {running && !focused && (
          <div className="hint">Click the screen to type · your arrow is the DOS mouse · Capture mouse for relative motion (Esc releases)</div>
        )}
      </div>
      {view === 'workbench' && running && (
        <Workspace
          boxId={boxId} running={running} program={meta?.program} rpc={rpc} dbg={dbg} available={agentAvailable}
          onRun={runSteps} terminalRef={terminalRef} subscribeCon={subscribeCon} onTermKey={onTermKey}
          subscribeHeat={subscribeHeat} setHeat={setHeat} handoff={handoffRef}
        />
      )}
      {view === 'screen' && showEditor && running && (
        <Suspense fallback={<p className="muted">Loading the editor…</p>}>
          <Editor boxId={boxId} running={running} onRun={runSteps} program={meta?.program} />
        </Suspense>
      )}
      {view === 'screen' && showConsole && running && <Console ref={consoleRef} boxId={boxId} running={running} />}
      {showDebug && running && <DebugPanel rpc={rpc} available={agentAvailable} />}
    </div>
  )
}
