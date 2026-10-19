import { useCallback, useEffect, useRef, useState } from 'react'
import { getBox, NeedsSignIn, screenText, snapshotURL, startBox, stopBox, typeText, wsURL, type Box } from '../api/client'
import { scancodeFor, SHIFT } from '../player/keys'
import { TextScreen } from '../player/textmode'
import { DebugPanel, type RPC } from './DebugPanel'

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
  const [showDebug, setShowDebug] = useState(false)
  const [agentAvailable, setAgentAvailable] = useState<boolean | null>(null)
  // JSON-RPC calls to the debugger agent ride the player socket: id -> settler.
  const rpcWaiters = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>())
  const rpcSeq = useRef(0)
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
    let inText = false
    async function drawUpdate(buf: ArrayBuffer) {
      const dv = new DataView(buf)
      if (buf.byteLength > 0 && dv.getUint8(0) === 0x54) {
        if (!text.apply(buf)) return
        if (!inText) { inText = true; setTextMode(true) }
        const canvas = canvasRef.current
        if (canvas) text.draw(canvas, performance.now())
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
      ws.onopen = () => { backoff = 500; setConnected(true); send({ hello: { text: 1 } }) }
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
              if (resp.error) w.reject(new Error(resp.error.message ?? 'rpc error'))
              else w.resolve(resp.result)
            }
          } else if (m.type === 'pong') {
            setLatency({ rtt: performance.now() - m.t, encodeMs: m.encodeMs ?? 0, serverFps: m.fps ?? 0 })
          }
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
  useEffect(() => {
    if (!showDebug || !connected) return
    rpc('agent.capabilities').then(() => setAgentAvailable(true)).catch((e: Error) => setAgentAvailable(!/no debugger agent/.test(e.message)))
  }, [showDebug, connected, rpc])

  const ctrlAltDel = () => {
    const send = sendRef.current
    for (const sc of [0x1d, 0x38, 0xd3]) send({ k: sc, d: true })
    window.setTimeout(() => { for (const sc of [0xd3, 0x38, 0x1d]) send({ k: sc, d: false }) }, 100)
    wrapRef.current?.focus()
  }

  const running = box?.state === 'running'
  const dispH = meta ? (meta.h * (meta.parY || 1)) / (meta.parX || 1) : 400
  return (
    <div className="player">
      <div className="bar">
        <button onClick={onBack}>← Boxes</button>
        <strong>{box?.name ?? '…'}</strong>
        <span className={`dot ${connected ? 'on' : ''}`} />
        <span className="muted">{connected ? 'connected' : box ? box.state : 'loading'}</span>
        {meta?.program && <span className="muted">▶ {meta.program}</span>}
        {meta && <span className="muted" title={textMode ? "Text mode: drawn by your browser from the screen data" : "Graphics: video from the box"}>{textMode ? "text" : `${meta.w}×${meta.h}`}</span>}
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
        {running && <button className={showDebug ? 'on' : ''} onClick={() => setShowDebug(!showDebug)}>Debug</button>}
        {running || box?.state === 'starting'
          ? <button className="danger" onClick={stop}>Stop</button>
          : box && box.state !== 'stopping' && <button className="primary" onClick={start}>Start</button>}
      </div>
      {error && <p className="auth-error">{error}</p>}
      {box?.reason && !running && <p className="muted">{box.reason}</p>}
      <div
        ref={wrapRef}
        className={`screen-wrap ${focused ? 'focused' : ''}`}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <canvas
          ref={canvasRef}
          width={720}
          height={400}
          style={{ aspectRatio: `${meta?.w ?? 720} / ${dispH}` }}
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
      {showDebug && running && <DebugPanel rpc={rpc} available={agentAvailable} />}
    </div>
  )
}
