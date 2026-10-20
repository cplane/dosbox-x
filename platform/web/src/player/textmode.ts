/**
 * Text mode, drawn by the browser from data instead of video: the box's
 * sidecar sends character cells, cursor, palette and the VGA font (see
 * stream/text.go for the wire format). The "dos" style reproduces the DOS
 * look exactly, pixel for pixel from that font; any other TextStyle draws
 * the same cells with a web font and its own 16 colours (CP437 mapped to
 * Unicode), see textstyle.ts.
 */

import { CP437, DOS_STYLE, glyphHash, ROM_FONT_HASH, type TextStyle } from './textstyle'

const SEC_PALETTE = 1
const SEC_FONT = 2
const SEC_ROWS = 4

const FLAG_CURSOR_VISIBLE = 1 << 1
const FLAG_BLINK = 1 << 2
const FLAG_LINE_GRAPHICS = 1 << 3

/** Cursor blinks every 16 frames of 60 Hz, blinking characters every 32. */
const CURSOR_BLINK_MS = 267
const CHAR_BLINK_MS = 533

export class TextScreen {
  cols = 0
  rows = 0
  cellW = 8
  cellH = 16
  flags = 0
  cursorX = 0
  cursorY = 0
  cursorStart = 0
  cursorEnd = 0
  codepage = 437
  palette = new Uint32Array(16) // ABGR, ready for ImageData
  font = new Uint8Array(0)
  cells = new Uint8Array(0)

  private image: ImageData | null = null
  private dirtyRows = new Set<number>()
  private hasBlinking = false
  style: TextStyle = DOS_STYLE
  private custom = new Uint8Array(256) // 1: the glyph differs from the ROM font (see textstyle.ts)
  // The styled renderer's cell, from the font's metrics at the device pixel ratio.
  private metrics: { font: string; cellW: number; cellH: number; ascent: number; scaleX: number; scaleY: number; dpr: number } | null = null

  /** Switches the look; the next draw redraws everything. */
  setStyle(s: TextStyle) {
    this.style = s
    this.image = null
    this.metrics = null
    this.markAll()
  }

  /** Applies a text update; returns false if it isn't one. */
  apply(buf: ArrayBuffer): boolean {
    const dv = new DataView(buf)
    if (buf.byteLength < 21 || dv.getUint8(0) !== 0x54 /* T */ || dv.getUint8(1) !== 1) return false
    const cols = dv.getUint16(4, true)
    const rows = dv.getUint16(6, true)
    const cellW = dv.getUint16(8, true)
    const cellH = dv.getUint16(10, true)
    const resized = cols !== this.cols || rows !== this.rows || cellW !== this.cellW || cellH !== this.cellH
    const oldCursor = [this.cursorX, this.cursorY]
    this.flags = dv.getUint16(2, true)
    this.cols = cols
    this.rows = rows
    this.cellW = cellW
    this.cellH = cellH
    this.cursorX = dv.getUint16(12, true)
    this.cursorY = dv.getUint16(14, true)
    this.cursorStart = dv.getUint8(16)
    this.cursorEnd = dv.getUint8(17)
    this.codepage = dv.getUint16(18, true)
    const sections = dv.getUint8(20)
    if (resized) {
      this.cells = new Uint8Array(cols * rows * 2)
      this.image = null
    }
    let p = 21
    if (sections & SEC_PALETTE) {
      for (let i = 0; i < 16; i++, p += 3) {
        this.palette[i] = 0xff000000 | (dv.getUint8(p + 2) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p)
      }
      this.markAll()
    }
    if (sections & SEC_FONT) {
      this.font = new Uint8Array(buf.slice(p, p + 256 * cellH))
      p += 256 * cellH
      // Glyphs the program reshaped (vs the ROM font) are drawn as bitmaps
      // by the styled renderer; a font of another height is all "custom".
      for (let ch = 0; ch < 256; ch++) {
        this.custom[ch] = cellH !== 16 || glyphHash(this.font, ch, cellH) !== ROM_FONT_HASH[ch] ? 1 : 0
      }
      this.markAll()
    }
    if (sections & SEC_ROWS) {
      const n = dv.getUint16(p, true)
      p += 2
      const w = cols * 2
      for (let i = 0; i < n; i++) {
        const r = dv.getUint16(p, true)
        p += 2
        if (r < rows) {
          this.cells.set(new Uint8Array(buf, p, w), r * w)
          this.dirtyRows.add(r)
        }
        p += w
      }
    }
    if (resized) this.markAll()
    // The cursor moved: redraw the cell it left and the one it's on.
    if (oldCursor[1] !== this.cursorY || oldCursor[0] !== this.cursorX) this.dirtyRows.add(oldCursor[1])
    this.dirtyRows.add(this.cursorY)
    return true
  }

  private markAll() {
    for (let r = 0; r < this.rows; r++) this.dirtyRows.add(r)
  }

  get width() { return this.cols * this.cellW }
  get height() { return this.rows * this.cellH }

  /**
   * Draws what changed (or everything, after a resize) onto canvas, which is
   * sized to the text screen. Blinking (cursor and blink attribute) follows
   * the clock in `now`.
   */
  draw(canvas: HTMLCanvasElement, now: number) {
    if (this.cols === 0) return
    if (this.style.font) {
      this.drawStyled(canvas, now)
      return
    }
    if (this.font.length === 0) return
    if (canvas.width !== this.width || canvas.height !== this.height) {
      canvas.width = this.width
      canvas.height = this.height
      this.image = null
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (!this.image) {
      this.image = ctx.createImageData(this.width, this.height)
      this.markAll()
    }
    const cursorOn = Math.floor(now / CURSOR_BLINK_MS) % 2 === 0
    const charOn = Math.floor(now / CHAR_BLINK_MS) % 2 === 0
    if (this.hasBlinking) this.markAll() // cheap: a full 80×25 screen is 288k pixels
    if (this.dirtyRows.size === 0) return
    const px = new Uint32Array(this.image.data.buffer)
    const W = this.width
    const { cols, cellW, cellH, cells, font, palette } = this
    const blinkAttr = (this.flags & FLAG_BLINK) !== 0
    const lineGfx = (this.flags & FLAG_LINE_GRAPHICS) !== 0
    let blinking = false
    let top = this.rows
    let bottom = -1
    for (const r of this.dirtyRows) {
      if (r < 0 || r >= this.rows) continue
      top = Math.min(top, r)
      bottom = Math.max(bottom, r)
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 2
        const ch = cells[i]
        const attr = cells[i + 1]
        let fg = attr & 0x0f
        let bg = attr >> 4
        if (blinkAttr) {
          bg &= 7
          if (attr & 0x80) {
            blinking = true
            if (!charOn) fg = bg
          }
        }
        const fgc = palette[fg]
        const bgc = palette[bg]
        const cursorHere = r === this.cursorY && c === this.cursorX && cursorOn &&
          (this.flags & FLAG_CURSOR_VISIBLE) !== 0
        for (let line = 0; line < cellH; line++) {
          let bits = font[ch * cellH + line]
          let row = (r * cellH + line) * W + c * cellW
          const isCursorLine = cursorHere && line >= this.cursorStart && line <= this.cursorEnd
          for (let x = 0; x < 8; x++, bits <<= 1) px[row++] = isCursorLine || (bits & 0x80) ? fgc : bgc
          if (cellW === 9) { // the VGA cursor is 8 pixels wide, even in 9-pixel cells
            const ninth = lineGfx && ch >= 0xc0 && ch <= 0xdf && (font[ch * cellH + line] & 1)
            px[row] = ninth ? fgc : bgc
          }
        }
      }
    }
    this.hasBlinking = blinking
    this.dirtyRows.clear()
    if (bottom >= top) {
      ctx.putImageData(this.image, 0, 0, 0, top * cellH, W, (bottom - top + 1) * cellH)
    }
  }

  /**
   * The styled renderer: the same cells in a web font with the style's
   * colours. The cell comes from the font's line box (so box-drawing glyphs
   * join), drawn at the device pixel ratio for sharp text at any zoom.
   */
  private drawStyled(canvas: HTMLCanvasElement, now: number) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const s = this.style
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    if (!this.metrics || this.metrics.dpr !== dpr) {
      // Box-drawing glyphs fill the font's advance width and line box, so
      // the cell must be exactly that: the font size is adjusted until the
      // advance is a whole number of pixels, and the line box is stretched
      // (by a hair) to the rounded cell height.
      const base = Math.round((s.size ?? 16) * dpr)
      ctx.font = `${base}px ${s.font}`
      const ratio = ctx.measureText('M').width / base
      const cellW = Math.max(1, Math.round(base * ratio))
      const px = cellW / ratio
      const font = `${px.toFixed(2)}px ${s.font}`
      ctx.font = font
      // The ink of the full block █ is the font's own idea of a cell: box
      // and block glyphs reach exactly that far. Everything is drawn with
      // the transform that maps that ink box onto our cell, so lines meet
      // whatever the font's nominal line box says.
      const m = ctx.measureText('█')
      const inkAsc = m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || px * 0.95
      const inkH = inkAsc + (m.actualBoundingBoxDescent || m.fontBoundingBoxDescent || px * 0.25)
      const inkW = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || m.width
      const cellH = Math.max(1, Math.round(inkH * (s.lineHeight ?? 1)))
      const scaleX = inkW > 0 ? cellW / inkW : 1
      const scaleY = cellH / inkH
      this.metrics = { font, cellW, cellH, ascent: inkAsc, scaleX, scaleY, dpr }
      this.markAll()
    }
    const { font, cellW, cellH, ascent, scaleX, scaleY } = this.metrics
    const W = this.cols * cellW
    const H = this.rows * cellH
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
      this.markAll()
    }
    const cursorOn = Math.floor(now / CURSOR_BLINK_MS) % 2 === 0
    const charOn = Math.floor(now / CHAR_BLINK_MS) % 2 === 0
    if (this.hasBlinking) this.markAll()
    if (this.dirtyRows.size === 0) return
    const colors = s.colors ?? []
    const color = (i: number) => colors[i] ?? '#' + (this.palette[i] & 0xffffff).toString(16).padStart(6, '0').replace(/(..)(..)(..)/, '$3$2$1')
    const { cols, cells } = this
    const blinkAttr = (this.flags & FLAG_BLINK) !== 0
    const cursorVisible = (this.flags & FLAG_CURSOR_VISIBLE) !== 0 && cursorOn
    ctx.font = font
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    let blinking = false
    for (const r of this.dirtyRows) {
      if (r < 0 || r >= this.rows) continue
      const y = r * cellH
      // Backgrounds first, in runs of the same colour.
      let runStart = 0
      let runBg = -1
      const flush = (end: number) => {
        if (runBg < 0) return
        ctx.fillStyle = color(runBg)
        ctx.fillRect(runStart * cellW, y, (end - runStart) * cellW, cellH)
      }
      for (let c = 0; c <= cols; c++) {
        let bg = -1
        if (c < cols) {
          const attr = cells[(r * cols + c) * 2 + 1]
          bg = attr >> 4
          if (blinkAttr) bg &= 7
        }
        if (bg !== runBg) { flush(c); runStart = c; runBg = bg }
      }
      // Then the glyphs and the cursor.
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 2
        const ch = cells[i]
        const attr = cells[i + 1]
        let fg = attr & 0x0f
        let bg = attr >> 4
        if (blinkAttr) {
          bg &= 7
          if (attr & 0x80) {
            blinking = true
            if (!charOn) fg = bg
          }
        }
        const glyph = CP437[ch]
        if (fg !== bg && this.custom[ch] && this.font.length) {
          // A reshaped glyph: its VGA bitmap, scaled into the cell, runs of set bits as rects.
          ctx.fillStyle = color(fg)
          const sx = cellW / 8, sy = cellH / this.cellH
          for (let line = 0; line < this.cellH; line++) {
            const bits = this.font[ch * this.cellH + line]
            if (!bits) continue
            const ly = y + line * sy
            for (let x = 0; x < 8;) {
              if (!(bits & (0x80 >> x))) { x++; continue }
              let x1 = x
              while (x1 < 8 && bits & (0x80 >> x1)) x1++
              ctx.fillRect(c * cellW + x * sx, ly, (x1 - x) * sx, sy)
              x = x1
            }
          }
        } else if (glyph !== ' ' && fg !== bg) {
          ctx.fillStyle = color(fg)
          ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0) // the font's cell (█'s ink) mapped onto ours
          ctx.fillText(glyph, (c * cellW) / scaleX, y / scaleY + ascent)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
        }
        if (cursorVisible && r === this.cursorY && c === this.cursorX) {
          // The cursor keeps its DOS shape (underline, or a block in insert mode), scaled to the cell.
          const y0 = y + Math.round((this.cursorStart / this.cellH) * cellH)
          const y1 = y + Math.round(((this.cursorEnd + 1) / this.cellH) * cellH)
          ctx.fillStyle = color(fg)
          ctx.globalAlpha = 0.75
          ctx.fillRect(c * cellW, y0, cellW, Math.max(2, y1 - y0))
          ctx.globalAlpha = 1
        }
      }
    }
    this.hasBlinking = blinking
    this.dirtyRows.clear()
  }

  /** Redraw the cursor's cell on the next draw (for blinking). */
  touchCursor() {
    this.dirtyRows.add(this.cursorY)
  }
}
