/**
 * Text mode, drawn by the browser from data instead of video: the box's
 * sidecar sends character cells, cursor, palette and the VGA font (see
 * stream/text.go for the wire format). This renderer reproduces the DOS look
 * exactly, pixel for pixel from the font; another renderer could draw the
 * same cells in any font or colour scheme (the codepage maps the bytes to
 * Unicode).
 */

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
    if (this.cols === 0 || this.font.length === 0) return
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

  /** Redraw the cursor's cell on the next draw (for blinking). */
  touchCursor() {
    this.dirtyRows.add(this.cursorY)
  }
}
