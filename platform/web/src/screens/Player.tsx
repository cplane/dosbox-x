import { useEffect, useRef, useState } from 'react'
import { getBox, NeedsSignIn, snapshotURL, startBox, stopBox, typeText, wsURL, type Box } from '../api/client'
import { scancodeFor, SHIFT } from '../player/keys'

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

/**
 * The box's screen: JPEG frames from the box's stream sidecar over the
 * gateway's WebSocket, keyboard (physical keys via KeyboardEvent.code) and
 * pointer-locked relative mouse back.
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
    let pending: ArrayBuffer | null = null
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

    async function draw(buf: ArrayBuffer) {
      if (decoding) { pending = buf; return } // keep only the newest frame
      decoding = true
      try {
        const canvas = canvasRef.current
        const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }))
        canvas?.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
        bmp.close()
        frames++
      } catch { /* a bad frame */ }
      decoding = false
      if (pending) { const p = pending; pending = null; draw(p) }
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
      ws.onopen = () => { backoff = 500; setConnected(true) }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const m = JSON.parse(ev.data)
          if (m.type === 'meta') {
            const canvas = canvasRef.current
            if (canvas && (canvas.width !== m.w || canvas.height !== m.h)) { canvas.width = m.w; canvas.height = m.h }
            setMeta(m)
          }
        } else draw(ev.data)
      }
      ws.onclose = () => {
        setConnected(false)
        down.clear()
        synth.clear()
        ws = null
        if (cancelled) return
        // Re-check the box: it may have been stopped (idle, disk limit).
        timer = window.setTimeout(poll, backoff)
        backoff = Math.min(backoff * 2, 8000)
      }
    }

    const fpsTimer = window.setInterval(() => { setFps(frames); frames = 0 }, 1000)

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

    // Mouse: relative motion via pointer lock, batched per animation frame.
    const canvas = canvasRef.current!
    let mdx = 0, mdy = 0, raf = 0
    const locked = () => document.pointerLockElement === canvas
    const onLock = () => {
      setCaptured(locked())
      if (locked()) wrap.focus(); else send({ b: 0 })
    }
    const onMove = (e: MouseEvent) => {
      if (!locked()) return
      mdx += e.movementX
      mdy += e.movementY
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          if (mdx || mdy) send({ m: [mdx, mdy] })
          mdx = mdy = 0
        })
      }
    }
    const onButtons = (e: MouseEvent) => { if (locked()) { e.preventDefault(); send({ b: e.buttons & 7 }) } }
    document.addEventListener('pointerlockchange', onLock)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mousedown', onButtons)
    document.addEventListener('mouseup', onButtons)

    poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(fpsTimer)
      ws?.close()
      wrap.removeEventListener('keydown', onKeyDown)
      wrap.removeEventListener('keyup', onKeyUp)
      wrap.removeEventListener('blur', onBlur)
      document.removeEventListener('pointerlockchange', onLock)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mousedown', onButtons)
      document.removeEventListener('mouseup', onButtons)
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
        {meta && <span className="muted">{meta.w}×{meta.h}</span>}
        {connected && <span className="muted">{fps} fps</span>}
        <span className="spacer" />
        {running && (
          <>
            <button onClick={() => canvasRef.current?.requestPointerLock()}>
              {captured ? 'Mouse captured (Esc)' : 'Capture mouse'}
            </button>
            <button onClick={typePrompt}>Type text…</button>
            <button onClick={ctrlAltDel}>Ctrl+Alt+Del</button>
            <button onClick={() => { releaseRef.current(); wrapRef.current?.focus() }}>Release keys</button>
            <a className="button" href={snapshotURL(boxId)} target="_blank" rel="noreferrer">Snapshot</a>
          </>
        )}
        <button onClick={onFiles}>Files</button>
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
          <div className="hint">Click the screen to type · Capture mouse for DOS mouse input · Esc releases the mouse</div>
        )}
      </div>
    </div>
  )
}
