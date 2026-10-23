import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { REGIONS } from './MemoryMapPanel'
import { LiveHeat, type HeatTick } from './heat'
import { TILE, TILES, type MemUpdate } from './memfeed'
import { SymbolClass, TypeId, type Tds } from './tds'
import type { Debugger } from './useDebugger'

/**
 * The whole first megabyte as a map you zoom and pan like a satellite picture: 16 bands of 64 KB (a segment's
 * worth: 0000, 1000 … F000), each 16 squares of 4 KB, each square 64 bytes wide. Zoomed out it is terrain:
 * zeros are calm paper, text is sand, other data grey by value, with the regions named over it. Zoomed in the
 * bytes show their hex and characters and the program's variables their names. Bytes that change flash and fade,
 * live heat (reads blue, writes orange) glows where the program works, and pins mark CS:IP, SS:SP and DS.
 *
 * The bytes come live from the box (it mirrors its memory while someone watches; the tiles on screen arrive,
 * then each again when it changes), or, from a box without the mirror, read through the debugger at each stop.
 */

interface Props {
  dbg: Debugger
  symbols?: { tds: Tds; source: string } | null
  subscribeMem?: (fn: (u: MemUpdate) => void) => () => void
  setMemTiles?: (tiles: number[]) => void
  subscribeHeat?: (fn: (tick: HeatTick) => void) => () => void
  setHeat?: (on: boolean) => void
  /** What the box runs (its name for the program's memory block). */
  program?: string
}

const SIDE = 1024          // the map is SIDE × SIDE bytes
const SQ = 64              // a 4 KB tile is SQ × SQ bytes
const MAX_SCALE = 44       // screen px per byte at the closest
const HEX_AT = 15          // from this scale each byte shows its hex
const CHAR_AT = 30         // and from this one its character too
const FLASH_MS = 1400

// Address <-> map position: band (64 KB) by row of tiles, tile (4 KB) across, 64 bytes per row within a tile.
const posOf = (a: number) => ({ x: ((a >> 12) & 15) * SQ + (a & 63), y: (a >> 16) * SQ + ((a >> 6) & 63) })
const addrAt = (x: number, y: number) => ((y >> 6) << 16) | ((x >> 6) << 12) | ((y & 63) << 6) | (x & 63)
const h = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0')

// Terrain colours, as ABGR words for the image: zeros calm, text sand, 0xFF pale steel, the rest grey by value.
const LUT = (() => {
  const t = new Uint32Array(256)
  const rgb = (r: number, g: number, b: number) => (255 << 24) | (b << 16) | (g << 8) | r
  for (let v = 0; v < 256; v++) {
    if (v === 0) t[v] = rgb(241, 239, 233)
    else if (v === 0xff) t[v] = rgb(214, 220, 228)
    else if (v >= 0x20 && v < 0x7f) { const k = (v - 0x20) / 0x5f; t[v] = rgb(Math.round(226 - 40 * k), Math.round(203 - 45 * k), Math.round(152 - 50 * k)) }
    else { const g = Math.round(222 - 150 * (v / 255)); t[v] = rgb(g, g - 2, g - 6) }
  }
  return t
})()
const NOT_MIRRORED = (255 << 24) | (232 << 16) | (210 << 8) | 222 // a muted lilac: there, but not shown

function heatColor(r: number, w: number): string {
  const total = r + w
  const ws = w / total
  const c = [90 + (224 - 90) * ws, 143 + (120 - 143) * ws, 216 + (90 - 216) * ws].map(Math.round)
  return `rgba(${c[0]},${c[1]},${c[2]},${0.25 + 0.65 * Math.min(1, total / 6)})`
}

export function MemoryAtlas({ dbg, symbols, subscribeMem, setMemTiles, subscribeHeat, setHeat, program }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const miniRef = useRef<HTMLCanvasElement>(null)
  // The bytes, which tiles arrived (0 never, 1 mirrored, 2 not mirrored), and the map pictures built from them.
  const mem = useRef(new Uint8Array(SIDE * SIDE))
  const have = useRef(new Uint8Array(TILES))
  const base = useRef<HTMLCanvasElement | null>(null)
  const flash = useRef<HTMLCanvasElement | null>(null)
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const lastFlash = useRef(0)
  const liveHeat = useRef(new LiveHeat())
  const [heatOn, setHeatOn] = useState(false)
  const [source, setSource] = useState<'waiting' | 'live' | 'stops' | 'none'>('waiting')
  const [size, setSize] = useState({ w: 0, h: 0 })
  // The view: px per byte, and the map position at the top-left corner.
  const [view, setView] = useState({ s: 0, x: 0, y: 0 })
  const [hover, setHover] = useState<{ a: number; mx: number; my: number } | null>(null)
  const [goto, setGoto] = useState('')
  const [gotoErr, setGotoErr] = useState('')
  const [frame, setFrame] = useState(0) // bumps when the pictures change
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)

  if (!base.current && typeof document !== 'undefined') {
    for (const ref of [base, flash]) { const c = document.createElement('canvas'); c.width = SIDE; c.height = SIDE; ref.current = c }
    const s = document.createElement('canvas'); s.width = SQ; s.height = SQ; scratch.current = s
    const ctx = base.current!.getContext('2d')!
    ctx.fillStyle = '#ebe9e3'; ctx.fillRect(0, 0, SIDE, SIDE)
  }

  // The panel's size; the first time, the whole megabyte fits.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    // Measured at once and on window resizes too: a hidden page delivers no ResizeObserver callbacks.
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    const t = window.setInterval(measure, 1000)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); window.clearInterval(t) }
  }, [])
  const fit = size.w && size.h ? Math.min(size.w / SIDE, size.h / SIDE) : 0
  useEffect(() => {
    if (fit && !view.s) setView({ s: fit, x: (SIDE - size.w / fit) / 2, y: (SIDE - size.h / fit) / 2 })
  }, [fit]) // eslint-disable-line react-hooks/exhaustive-deps

  // A tile arrives: its bytes into memory, its pixels into the picture, its changed bytes into the flash layer.
  const absorb = useCallback((tile: number, bytes: Uint8Array, mirrored: boolean) => {
    const a0 = tile * TILE
    const was = have.current[tile]
    const old = mem.current.subarray(a0, a0 + TILE)
    const tx = (tile & 15) * SQ, ty = (tile >> 4) * SQ
    const fctx = flash.current!.getContext('2d')!
    if (was === 1 && mirrored) {
      const img = new ImageData(SQ, SQ)
      const px = new Uint32Array(img.data.buffer)
      let any = false
      for (let i = 0; i < TILE; i++) if (old[i] !== bytes[i]) { px[i] = (255 << 24) | (60 << 16) | (150 << 8) | 255; any = true }
      if (any) {
        scratch.current!.getContext('2d')!.putImageData(img, 0, 0)
        fctx.drawImage(scratch.current!, tx, ty)
        lastFlash.current = performance.now()
      }
    }
    old.set(bytes)
    have.current[tile] = mirrored ? 1 : 2
    const img = new ImageData(SQ, SQ)
    const px = new Uint32Array(img.data.buffer)
    if (mirrored) for (let i = 0; i < TILE; i++) px[i] = LUT[bytes[i]]
    else px.fill(NOT_MIRRORED)
    base.current!.getContext('2d')!.putImageData(img, tx, ty)
  }, [])

  // Live: the box's mirror.
  useEffect(() => {
    if (!subscribeMem) { setSource('none'); return }
    return subscribeMem((u) => {
      if (u.unavailable) { setSource((s) => (s === 'live' ? s : 'none')); return }
      for (const t of u.tiles) absorb(t.tile, t.bytes, t.mirrored)
      setSource('live')
      setFrame((f) => f + 1)
    })
  }, [subscribeMem, absorb])

  // The tiles on screen, nearest the middle first, for the box to send (all of them when the whole map shows).
  const visibleTiles = useMemo(() => {
    if (!view.s || !size.w) return [] as number[]
    const x0 = Math.max(0, Math.floor(view.x / SQ)), x1 = Math.min(15, Math.floor((view.x + size.w / view.s) / SQ))
    const y0 = Math.max(0, Math.floor(view.y / SQ)), y1 = Math.min(15, Math.floor((view.y + size.h / view.s) / SQ))
    const cx = view.x + size.w / view.s / 2, cy = view.y + size.h / view.s / 2
    const out: number[] = []
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push(ty * 16 + tx)
    return out.sort((a, b) => Math.hypot((a & 15) * SQ + 32 - cx, (a >> 4) * SQ + 32 - cy) - Math.hypot((b & 15) * SQ + 32 - cx, (b >> 4) * SQ + 32 - cy))
  }, [view, size])
  const tilesKey = visibleTiles.join(',')
  useEffect(() => {
    if (!setMemTiles) return
    const t = window.setTimeout(() => setMemTiles(visibleTiles), 120)
    return () => window.clearTimeout(t)
  }, [tilesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setMemTiles?.([]), [setMemTiles])
  // An older box says nothing at all to {mem}: no tiles within a few seconds means no mirror.
  useEffect(() => {
    if (source !== 'waiting' || !visibleTiles.length) return
    const t = window.setTimeout(() => setSource((s) => (s === 'waiting' ? 'none' : s)), 3000)
    return () => window.clearTimeout(t)
  }, [source, visibleTiles.length])

  // Without the mirror: the tiles on screen read through the debugger at each stop (a few dozen at most).
  const stopKey = dbg.stopped && dbg.regs ? `${dbg.regs.instruction_pointer}:${dbg.regs.segments.cs}:${dbg.regs.general.esp}` : ''
  useEffect(() => {
    if (source === 'live' || !stopKey || !dbg.session) return
    let cancelled = false
    ;(async () => {
      for (const t of visibleTiles.slice(0, 32)) {
        if (cancelled) return
        try { absorb(t, await dbg.readMemory(t << 8, 0, TILE), true) } catch { /* not readable */ }
      }
      if (!cancelled) { setSource('stops'); setFrame((f) => f + 1) }
    })()
    return () => { cancelled = true }
  }, [stopKey, source, tilesKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live heat, when switched on.
  useEffect(() => {
    if (!heatOn || !subscribeHeat) return
    setHeat?.(true)
    const off = subscribeHeat((t) => { liveHeat.current.apply(t); setFrame((f) => f + 1) })
    return () => { off(); setHeat?.(false); liveHeat.current.map.clear() }
  }, [heatOn, subscribeHeat, setHeat])

  // The flash layer fades: a frame loop while anything is still lit.
  useEffect(() => {
    let raf = 0
    const fade = () => {
      const age = performance.now() - lastFlash.current
      if (age > FLASH_MS) return
      const ctx = flash.current!.getContext('2d')!
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,0.07)'
      ctx.fillRect(0, 0, SIDE, SIDE)
      ctx.globalCompositeOperation = 'source-over'
      setFrame((f) => f + 1)
      raf = requestAnimationFrame(fade)
    }
    raf = requestAnimationFrame(fade)
    return () => cancelAnimationFrame(raf)
  }, [lastFlash.current]) // eslint-disable-line react-hooks/exhaustive-deps

  // Where the registers point, and the program's variables (globals: their bytes, by name).
  const regs = dbg.regs
  const pins = useMemo(() => {
    if (!regs) return [] as { a: number; label: string; color: string }[]
    const r = (k: string) => parseInt(regs.general[k] ?? regs.segments[k] ?? '0', 16) & 0xffff
    const cs = r('cs'), ss = r('ss'), ds = r('ds')
    const ip = parseInt(regs.instruction_pointer, 16) & 0xffff
    return [
      { a: ((cs << 4) + ip) & 0xfffff, label: 'IP', color: '#3b63a8' },
      { a: ((ss << 4) + r('esp')) & 0xfffff, label: 'SP', color: '#5f5a4e' },
      { a: (ds << 4) & 0xfffff, label: 'DS', color: '#7a6a9c' },
    ]
  }, [regs])
  // The debugged program's own memory: its PSP and all the paragraphs DOS gave it (the registers say).
  const block = useMemo(() => {
    const pr = regs?.program
    if (!pr) return null
    const psp = parseInt(pr.psp, 16) & 0xffff, paras = parseInt(pr.paragraphs, 16) & 0xffff
    if (!paras) return null
    const name = program && program.toUpperCase() !== 'COMMAND' ? program.toUpperCase() : 'your program'
    return { from: psp << 4, to: Math.min(0xfffff, ((psp + paras) << 4) - 1), psp, name }
  }, [regs, program])
  const vars = useMemo(() => {
    const tds = symbols?.tds
    if (!tds || dbg.entryCs === null) return [] as { a: number; n: number; name: string }[]
    const out: { a: number; n: number; name: string }[] = []
    for (const s of tds.symbols) {
      if (s.cls !== SymbolClass.Static || s.seg === 0) continue
      const t = tds.types[s.type - 1]
      if (!t || t.id === TypeId.Function || !t.size) continue
      out.push({ a: (((dbg.entryCs + s.seg) & 0xffff) << 4) + s.offset, n: Math.min(t.size, 4096), name: s.name.replace(/^_/, '') })
    }
    return out
  }, [symbols, dbg.entryCs])

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !view.s || !size.w) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) { canvas.width = Math.round(size.w * dpr); canvas.height = Math.round(size.h * dpr) }
    const ctx = canvas.getContext('2d')!
    const { s, x: vx, y: vy } = view
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#f7f5f0'
    ctx.fillRect(0, 0, size.w, size.h)
    // Map space -> screen: (mx - vx) * s.
    ctx.save()
    ctx.setTransform(dpr * s, 0, 0, dpr * s, -vx * s * dpr, -vy * s * dpr)
    ctx.imageSmoothingEnabled = s < 1
    ctx.drawImage(base.current!, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(flash.current!, 0, 0)
    // Heat: a paragraph is 16 bytes across; at least a couple of screen px so it shows zoomed out.
    if (heatOn) {
      const minW = 2 / s
      for (const [p, ht] of liveHeat.current.map) {
        const { x, y } = posOf(p << 4)
        if (x + 16 < vx || y + 1 < vy || x > vx + size.w / s || y > vy + size.h / s) continue
        ctx.fillStyle = heatColor(ht.r, ht.w)
        ctx.fillRect(x, y, Math.max(16, minW), Math.max(1, minW))
      }
    }
    ctx.restore()
    const sx = (mx: number) => (mx - vx) * s, sy = (my: number) => (my - vy) * s

    // Tiles never received yet: hatched.
    const tilePx = SQ * s
    ctx.strokeStyle = 'rgba(80,76,66,0.18)'
    ctx.lineWidth = 1
    for (let t = 0; t < TILES; t++) {
      if (have.current[t]) continue
      const x = sx((t & 15) * SQ), y = sy((t >> 4) * SQ)
      if (x > size.w || y > size.h || x + tilePx < 0 || y + tilePx < 0) continue
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, tilePx, tilePx); ctx.clip()
      for (let d = -tilePx; d < tilePx; d += 7) { ctx.moveTo(x + d, y); ctx.lineTo(x + d + tilePx, y + tilePx) }
      ctx.stroke(); ctx.restore()
    }
    // Tile lines when tiles are big enough to tell apart; band lines always.
    if (tilePx >= 18) {
      ctx.strokeStyle = 'rgba(80,76,66,0.16)'
      ctx.beginPath()
      for (let i = 0; i <= 16; i++) { ctx.moveTo(sx(i * SQ), sy(0)); ctx.lineTo(sx(i * SQ), sy(SIDE)) }
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(80,76,66,0.35)'
    ctx.beginPath()
    for (let i = 0; i <= 16; i++) { ctx.moveTo(sx(0), sy(i * SQ)); ctx.lineTo(sx(SIDE), sy(i * SQ)) }
    ctx.stroke()

    // Bytes up close: hex, then the character too.
    if (s >= HEX_AT) {
      const x0 = Math.max(0, Math.floor(vx)), x1 = Math.min(SIDE - 1, Math.ceil(vx + size.w / s))
      const y0 = Math.max(0, Math.floor(vy)), y1 = Math.min(SIDE - 1, Math.ceil(vy + size.h / s))
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const big = s >= CHAR_AT
      ctx.font = `${Math.min(13, Math.round(s * 0.38))}px "JetBrains Mono", ui-monospace, monospace`
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const a = addrAt(x, y)
          if (have.current[a >> 12] !== 1) continue
          const v = mem.current[a]
          ctx.fillStyle = v === 0 ? 'rgba(53,52,47,0.28)' : v > 0x90 ? '#f7f5f0' : '#35342f'
          ctx.fillText(h(v, 2), sx(x + 0.5), sy(y + (big ? 0.36 : 0.5)))
          if (big && v >= 0x20 && v < 0x7f) {
            ctx.fillStyle = v > 0x90 ? '#f7f5f0' : '#7a5b2e'
            ctx.fillText(String.fromCharCode(v), sx(x + 0.5), sy(y + 0.74))
          }
        }
      }
    }

    // The program's variables: outlined, named when there is room.
    if (s >= 3) {
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      for (const v of vars) {
        let named = false
        for (let a = v.a; a < v.a + v.n;) {
          const { x, y } = posOf(a)
          const run = Math.min(v.a + v.n - a, 64 - (a & 63))
          const X = sx(x), Y = sy(y), W = run * s, H = s
          if (X < size.w && Y < size.h && X + W > 0 && Y + H > 0) {
            ctx.strokeStyle = '#2e7d5b'; ctx.lineWidth = 1.5
            ctx.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1)
            if (!named && s >= 6) {
              const tw = ctx.measureText(v.name).width
              ctx.fillStyle = 'rgba(46,125,91,0.92)'; ctx.fillRect(X, Y - 14, tw + 8, 14)
              ctx.fillStyle = '#fff'; ctx.fillText(v.name, X + 4, Y - 1)
              named = true
            }
          }
          a += run
        }
      }
    }

    // The program's block: outlined tile by tile on each band it covers, named where it starts.
    if (block) {
      ctx.save()
      ctx.setLineDash([5, 3]); ctx.strokeStyle = '#2e7d5b'; ctx.lineWidth = 1.5
      for (let b = block.from >> 16; b <= block.to >> 16; b++) {
        const lo = Math.max(block.from, b << 16), hi = Math.min(block.to, (b << 16) + 0xffff)
        const t0 = (lo >> 12) & 15, t1 = (hi >> 12) & 15
        ctx.strokeRect(sx(t0 * SQ) + 1, sy(b * SQ) + 1, (t1 - t0 + 1) * SQ * s - 2, SQ * s - 2)
      }
      ctx.restore()
      const { x, y } = posOf(block.from)
      const label = `${block.name} · PSP ${h(block.psp, 4)}`
      ctx.font = 'bold 11px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      const tw = ctx.measureText(label).width
      const X = Math.max(2, sx(x)), Y = Math.max(14, sy(y))
      ctx.fillStyle = 'rgba(46,125,91,0.92)'; ctx.fillRect(X, Y - 14, tw + 8, 14)
      ctx.fillStyle = '#fff'; ctx.fillText(label, X + 4, Y - 1)
    }
    // Region names on the bands they start in, while they fit.
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.font = '11px "JetBrains Mono", ui-monospace, monospace'
    for (const r of REGIONS) {
      const { x, y } = posOf(r.from)
      const X = sx(x) + 3, Y = sy(y) + 2
      if (X > size.w || Y > size.h || Y < -12) continue
      const label = `${h(r.from >> 4, 4)} ${r.name}`
      const tw = ctx.measureText(label).width
      if (tilePx * 16 < tw + 10 && s < 2) continue
      ctx.fillStyle = 'rgba(247,245,240,0.82)'; ctx.fillRect(X - 2, Y - 1, tw + 4, 14)
      ctx.fillStyle = '#5c584e'; ctx.fillText(label, X, Y)
    }
    // Segment labels down the left edge.
    ctx.fillStyle = 'rgba(92,88,78,0.85)'
    for (let b = 0; b < 16; b++) {
      const Y = sy(b * SQ) + 2
      if (Y < -12 || Y > size.h) continue
      if (tilePx < 12 && b % 4) continue
      ctx.fillText(h(b << 12, 4), Math.max(2, sx(0) - 34), Y)
    }

    // Pins.
    for (const p of pins) {
      const { x, y } = posOf(p.a)
      const X = sx(x + 0.5), Y = sy(y + 0.5)
      if (X < -20 || Y < -20 || X > size.w + 20 || Y > size.h + 20) continue
      // A square around the byte (at least 6 px when zoomed out): white inside, the pin's colour just outside.
      const half = Math.max(3, s / 2)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#fff'; ctx.strokeRect(X - half + 0.75, Y - half + 0.75, half * 2 - 1.5, half * 2 - 1.5)
      ctx.strokeStyle = p.color; ctx.strokeRect(X - half - 0.75, Y - half - 0.75, half * 2 + 1.5, half * 2 + 1.5)
      ctx.fillStyle = p.color
      ctx.font = 'bold 11px "JetBrains Mono", ui-monospace, monospace'
      ctx.fillText(p.label, X + half + 4, Y - half)
    }
  }, [view, size, frame, heatOn, pins, vars, block])

  // The minimap while zoomed in: the whole megabyte and where the view is.
  const zoomedIn = view.s > fit * 2.2
  useEffect(() => {
    const m = miniRef.current
    if (!m || !zoomedIn) return
    const ctx = m.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.clearRect(0, 0, m.width, m.height)
    ctx.drawImage(base.current!, 0, 0, m.width, m.height)
    const k = m.width / SIDE
    ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1.5
    ctx.strokeRect(view.x * k, view.y * k, Math.max(2, (size.w / view.s) * k), Math.max(2, (size.h / view.s) * k))
  }, [zoomedIn, view, size, frame])

  // Zoom around a screen point, within the limits; pan within the map (a margin of half the panel).
  const setScaleAt = (s: number, px: number, py: number) => setView((v) => {
    const ns = Math.max(fit * 0.9, Math.min(MAX_SCALE, s))
    const mx = v.x + px / v.s, my = v.y + py / v.s
    return clampView({ s: ns, x: mx - px / ns, y: my - py / ns })
  })
  const clampView = (v: { s: number; x: number; y: number }) => {
    const vw = size.w / v.s, vh = size.h / v.s
    return { s: v.s, x: Math.max(-vw / 2, Math.min(SIDE - vw / 2, v.x)), y: Math.max(-vh / 2, Math.min(SIDE - vh / 2, v.y)) }
  }
  const centerOn = (a: number, s = Math.max(view.s, 20)) => {
    const { x, y } = posOf(a)
    const ns = Math.max(fit, Math.min(MAX_SCALE, s))
    setView(clampView({ s: ns, x: x + 0.5 - size.w / ns / 2, y: y + 0.5 - size.h / ns / 2 }))
  }
  // Wheel zoom (passive listeners cannot prevent the page from scrolling, so it is added by hand).
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      setView((v) => {
        const ns = Math.max(fit * 0.9, Math.min(MAX_SCALE, v.s * Math.pow(1.0018, -e.deltaY)))
        const px = e.clientX - r.left, py = e.clientY - r.top
        const mx = v.x + px / v.s, my = v.y + py / v.s
        return clampView({ s: ns, x: mx - px / ns, y: my - py / ns })
      })
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [fit, size]) // eslint-disable-line react-hooks/exhaustive-deps

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left, py = e.clientY - r.top
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      if (d.moved) { setView((v) => clampView({ s: v.s, x: d.vx - dx / v.s, y: d.vy - dy / v.s })); setHover(null); return }
    }
    const mx = Math.floor(view.x + px / view.s), my = Math.floor(view.y + py / view.s)
    if (mx < 0 || my < 0 || mx >= SIDE || my >= SIDE) { setHover(null); return }
    setHover({ a: addrAt(mx, my), mx: px, my: py })
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    drag.current = null
    // A click without a drag zooms in there (shift: out).
    if (d && !d.moved) {
      const r = e.currentTarget.getBoundingClientRect()
      setScaleAt(view.s * (e.shiftKey ? 1 / 3 : 3), e.clientX - r.left, e.clientY - r.top)
    }
  }
  const onMini = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * SIDE, y = ((e.clientY - r.top) / r.height) * SIDE
    setView((v) => clampView({ s: v.s, x: x - size.w / v.s / 2, y: y - size.h / v.s / 2 }))
  }

  // Go to: an address (B8000, B800:0000), a register (IP, SP, DS), a variable's name.
  const go = (text: string) => {
    const t = text.trim()
    if (!t) return
    setGotoErr('')
    const so = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(t)
    if (so) { centerOn(((parseInt(so[1], 16) << 4) + parseInt(so[2], 16)) & 0xfffff); return }
    const pin = pins.find((p) => p.label.toLowerCase() === t.toLowerCase())
    if (pin) { centerOn(pin.a); return }
    const v = vars.find((x) => x.name.toLowerCase() === t.toLowerCase())
    if (v) { centerOn(v.a); return }
    if (/^[0-9a-f]{1,5}h?$/i.test(t)) { centerOn(parseInt(t.replace(/h$/i, ''), 16) & 0xfffff); return }
    setGotoErr(`no ${t}: an address (B8000, B800:0000), IP / SP / DS, or a variable`)
  }

  const tag = (() => {
    if (!hover) return ''
    const a = hover.a
    const tile = have.current[a >> 12]
    // Inside the program's block, its name, not the fixed table's guess (DOS ends lower than 64 KB here).
    const inBlock = !!block && a >= block.from && a <= block.to
    const region = inBlock ? { name: a < block!.from + 256 ? `${block!.name}'s PSP` : `${block!.name}'s memory` } : REGIONS.find((r) => a >= r.from && a <= r.to)
    const where = `${h(a, 5)} · ${h(a >> 4, 4)}:${h(a & 15, 4)}`
    if (!tile) return `${where} · not seen yet${region ? ` · ${region.name}` : ''}`
    if (tile === 2) return `${where} · not mirrored (video memory in a graphics mode, or nothing there)`
    const v = mem.current[a]
    const varHere = vars.find((x) => a >= x.a && a < x.a + x.n)
    const hp = liveHeat.current.map.get(a >> 4)
    return `${where} = ${h(v, 2)} (${v})${v >= 0x20 && v < 0x7f ? ` '${String.fromCharCode(v)}'` : ''}${varHere ? ` · ${varHere.name}${a > varHere.a ? `+${a - varHere.a}` : ''}` : ''}${region ? ` · ${region.name}` : ''}${hp ? ` · heat r${hp.r.toFixed(0)} w${hp.w.toFixed(0)}` : ''}`
  })()
  const hoverBox = hover && view.s >= 4 ? (() => { const { x, y } = posOf(hover.a); return { left: (x - view.x) * view.s, top: (y - view.y) * view.s, width: view.s, height: view.s } })() : null
  const scaleText = !view.s ? '' : view.s >= 1 ? `${view.s.toFixed(view.s < 10 ? 1 : 0)} px per byte` : `${(1 / view.s).toFixed(1)} bytes per px`
  const sourceText = source === 'live' ? 'live from the box' : source === 'stops' ? 'read at each stop (this box has no live mirror)' : source === 'none' ? 'no live memory on this box: restart it onto the current image (or debug, and memory shows at stops)' : 'waiting for the box…'

  return (
    <div className="atlas">
      <div className="atlas-bar">
        <button className="ghost" onClick={() => setView(clampView({ s: fit, x: (SIDE - size.w / fit) / 2, y: (SIDE - size.h / fit) / 2 }))} title="The whole megabyte">⤢ 1 MB</button>
        <button className="ghost" onClick={() => setScaleAt(view.s / 2, size.w / 2, size.h / 2)} title="Zoom out (wheel, or shift+click)">−</button>
        <button className="ghost" onClick={() => setScaleAt(view.s * 2, size.w / 2, size.h / 2)} title="Zoom in (wheel, or click)">+</button>
        {pins.map((p) => <button key={p.label} className="ghost" onClick={() => centerOn(p.a)} title={`Go to ${p.label}: ${h(p.a, 5)}`}>{p.label}</button>)}
        <button className="ghost" onClick={() => centerOn(0xb8000, Math.max(view.s, 6))} title="The text screen, B800:0000">screen</button>
        <form onSubmit={(e) => { e.preventDefault(); go(goto) }}>
          <input className="mono" value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="go to: B800:0000, IP, a variable" title={gotoErr || 'an address (B8000, B800:0000), IP / SP / DS, or a variable of the program being debugged'} />
        </form>
        {subscribeHeat && (
          <button className={`ghost atlas-heat ${heatOn ? 'on' : ''}`} onClick={() => setHeatOn((v) => !v)} title="Live heat: the box counts every read and write while the program runs (slows it a little)">{heatOn ? '● heat' : '○ heat'}</button>
        )}
        <span className="muted small atlas-scale">{scaleText}</span>
      </div>
      {gotoErr && <div className="atlas-err small">{gotoErr}</div>}
      <div className="atlas-view" ref={wrapRef}>
        <canvas
          ref={canvasRef} className="atlas-canvas"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { if (!drag.current) setHover(null) }}
        />
        {hoverBox && <div className="atlas-hoverbox" style={hoverBox} />}
        {hover && tag && (
          <div className="atlas-tag" style={{ left: hover.mx + (hover.mx > size.w * 0.55 ? -12 : 12), top: hover.my + 14, transform: hover.mx > size.w * 0.55 ? 'translateX(-100%)' : undefined }}>{tag}</div>
        )}
        {zoomedIn && <canvas ref={miniRef} className="atlas-mini" width={128} height={128} onClick={onMini} title="The whole megabyte: click to go there" />}
      </div>
      <div className="atlas-legend small">
        <span><i style={{ background: 'rgb(241,239,233)' }} />0</span>
        <span><i style={{ background: 'rgb(206,180,127)' }} />text</span>
        <span><i style={{ background: 'rgb(150,148,142)' }} />data, darker = larger</span>
        <span><i style={{ background: 'rgb(255,150,60)' }} />just changed</span>
        <span><i style={{ background: 'rgb(214,220,228)' }} />FF</span>
        <span><i style={{ background: 'rgb(222,210,232)' }} />not mirrored</span>
        {vars.length > 0 && <span><i style={{ background: '#2e7d5b' }} />variables</span>}
        <span className="muted">· {sourceText}</span>
      </div>
    </div>
  )
}
